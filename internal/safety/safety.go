// Package safety decides which actions are allowed on a context and makes
// mutations two-phase: Prepare checks the policy and issues a single-use
// token bound to the action; the mutating call redeems it. The frontend
// only displays decisions, so no caller (UI, palette, AI, multi-cluster)
// can skip a check.
package safety

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"slices"
	"sync"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
)

// Action kinds.
const (
	Delete = "delete"
	Exec   = "exec"
	// Debug adds an ephemeral container to a pod (it stays in the pod spec
	// for the pod's lifetime) and attaches to it.
	Debug = "debug"
	// OpsPod creates a privileged pod on a node (host PID, optionally the
	// host's root file system and network) and opens a shell in it.
	OpsPod = "opspod"
	// Edit patches an object with what was changed in the editor (like
	// kubectl edit). Not confirmed by default: its diff preview is the review.
	Edit = "edit"
	// Terminal opens a local shell with the context's kubeconfig: whatever
	// it runs (kubectl delete …) is beyond kubewing's checks.
	Terminal = "terminal"
	// Label and Annotate set or remove labels / annotations (kubectl label,
	// kubectl annotate). A label change can move pods in or out of a
	// service or a workload's selector.
	Label    = "label"
	Annotate = "annotate"
	// Scale sets a workload's replicas through its scale subresource.
	Scale = "scale"
	// Restart rolls a workload's pods (kubectl rollout restart): every pod
	// is replaced. It has no dialog, so it always asks, as delete does.
	Restart = "restart"
)

// Mutating actions are refused on read-only contexts.
var mutating = []string{Delete, Exec, Debug, OpsPod, Edit, Terminal, Label, Annotate, Scale, Restart}

// always need confirmation, whatever the rule lists.
var always = []string{Delete, Restart}

// Rule is the effective safety rule for one context.
type Rule struct {
	Context  string   `json:"context"`
	Label    string   `json:"label,omitempty"`
	Color    string   `json:"color,omitempty"`
	ReadOnly bool     `json:"readOnly,omitempty"`
	Confirm  []string `json:"confirm"`
	Strict   bool     `json:"strict,omitempty"`
}

// Policy maps contexts to rules (first matching config rule wins).
type Policy struct {
	rules []config.ContextRule
}

// NewPolicy builds a policy from config rules (validated by config.Load).
func NewPolicy(rules []config.ContextRule) *Policy { return &Policy{rules: rules} }

// For returns the rule for a context. Without a matching rule the context
// is writable and only delete and restart need confirmation; they always do.
func (p *Policy) For(context string) Rule {
	r := Rule{Context: context, Confirm: slices.Clone(always)}
	for _, cr := range p.rules {
		if ok, _ := path.Match(cr.Match, context); !ok {
			continue
		}
		r.Label, r.Color, r.ReadOnly, r.Strict = cr.Label, cr.Color, cr.ReadOnly, cr.Strict
		if len(cr.Confirm) > 0 {
			r.Confirm = slices.Clone(cr.Confirm)
			for _, k := range always {
				if !slices.Contains(r.Confirm, k) {
					r.Confirm = append(r.Confirm, k)
				}
			}
		}
		break
	}
	return r
}

// Action identifies one mutation precisely: a token is only valid for the
// exact action it was issued for.
type Action struct {
	Kind      string `json:"kind"`
	Context   string `json:"context"`
	Resource  string `json:"resource"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	UID       string `json:"uid,omitempty"`
}

// Pending is a prepared action awaiting execution.
type Pending struct {
	Token string `json:"token"`
	// Summary is shown in the confirmation dialog.
	Summary      string `json:"summary"`
	Action       Action `json:"action"`
	Rule         Rule   `json:"rule"`
	NeedsConfirm bool   `json:"needsConfirm"`
	// TypeToConfirm is the text the user must type (strict mode), or "".
	TypeToConfirm string `json:"typeToConfirm,omitempty"`
}

// ErrReadOnly is returned when a context's rule forbids mutations.
var ErrReadOnly = errors.New("read-only context")

// TokenTTL is how long a prepared action stays valid.
const TokenTTL = 60 * time.Second

// Guard issues and redeems tokens.
type Guard struct {
	now func() time.Time

	mu      sync.Mutex
	policy  *Policy
	pending map[string]issued
}

type issued struct {
	action Action
	target any
	expiry time.Time
}

// NewGuard creates a guard; now is the clock (time.Now in production).
func NewGuard(p *Policy, now func() time.Time) *Guard {
	return &Guard{now: now, policy: p, pending: map[string]issued{}}
}

// SetPolicy replaces the policy (config reload). Outstanding tokens are
// dropped: they were issued under rules that may no longer apply.
func (g *Guard) SetPolicy(p *Policy) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.policy = p
	g.pending = map[string]issued{}
}

// Rule returns the rule for a context.
func (g *Guard) Rule(context string) Rule {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.policy.For(context)
}

// Prepare checks a against the policy and issues a token for it. target is
// opaque caller data needed to execute the action; Redeem returns it.
func (g *Guard) Prepare(a Action, target any) (Pending, error) {
	if !slices.Contains(mutating, a.Kind) {
		return Pending{}, fmt.Errorf("unknown action %q", a.Kind)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	r := g.policy.For(a.Context)
	if r.ReadOnly {
		return Pending{}, fmt.Errorf("%s %s/%s: %w %s", a.Kind, a.Resource, a.Name, ErrReadOnly, ctxName(r))
	}
	now := g.now()
	for t, is := range g.pending {
		if now.After(is.expiry) {
			delete(g.pending, t)
		}
	}
	tok := newToken()
	g.pending[tok] = issued{action: a, target: target, expiry: now.Add(TokenTTL)}
	p := Pending{Token: tok, Summary: summary(a), Action: a, Rule: r, NeedsConfirm: slices.Contains(r.Confirm, a.Kind)}
	if p.NeedsConfirm && r.Strict {
		p.TypeToConfirm = a.Name
	}
	return p, nil
}

// Redeem consumes a token for an action of the given kind and returns the
// action and target it was issued for. Tokens are single-use, expire after
// TokenTTL and are invalidated by policy changes.
func (g *Guard) Redeem(token, kind string) (Action, any, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	is, ok := g.pending[token]
	if !ok {
		return Action{}, nil, errors.New("no prepared action for this token (expired, used or never issued)")
	}
	delete(g.pending, token)
	if is.action.Kind != kind {
		return Action{}, nil, fmt.Errorf("token was issued for %s, not %s", is.action.Kind, kind)
	}
	if g.now().After(is.expiry) {
		return Action{}, nil, errors.New("prepared action expired; try again")
	}
	// defense in depth: SetPolicy drops tokens, but re-check anyway
	if r := g.policy.For(is.action.Context); r.ReadOnly {
		return Action{}, nil, fmt.Errorf("%w %s", ErrReadOnly, ctxName(r))
	}
	return is.action, is.target, nil
}

// TypeCountAbove: a delete of more objects than this asks for their count
// to be typed, whatever the rule says.
const TypeCountAbove = 20

// Batch is one action prepared for many objects: a token each (bound to
// its object, redeemed by the single-object calls), under one decision.
type Batch struct {
	// Pending holds the tokens, in the order of the actions.
	Pending []Pending `json:"pending"`
	// Summary is shown in the confirmation dialog.
	Summary      string `json:"summary"`
	Kind         string `json:"kind"`
	Context      string `json:"context"`
	Rule         Rule   `json:"rule"`
	NeedsConfirm bool   `json:"needsConfirm"`
	// TypeToConfirm is the count of objects to type (strict mode, big deletes), or "".
	TypeToConfirm string `json:"typeToConfirm,omitempty"`
}

// PrepareBatch checks actions of one kind on one context (a pane's marked
// rows) and issues a token for each; targets are their Prepare targets.
// It's all or nothing: a refusal issues no token.
func (g *Guard) PrepareBatch(as []Action, targets []any) (Batch, error) {
	if len(as) == 0 || len(as) != len(targets) {
		return Batch{}, errors.New("nothing to prepare")
	}
	kind, ctx := as[0].Kind, as[0].Context
	for _, a := range as[1:] {
		if a.Kind != kind || a.Context != ctx {
			return Batch{}, errors.New("a batch is one action on one context")
		}
	}
	if len(as) == 1 {
		p, err := g.Prepare(as[0], targets[0])
		if err != nil {
			return Batch{}, err
		}
		return Batch{Pending: []Pending{p}, Summary: p.Summary, Kind: kind, Context: ctx, Rule: p.Rule, NeedsConfirm: p.NeedsConfirm, TypeToConfirm: p.TypeToConfirm}, nil
	}
	b := Batch{Kind: kind, Context: ctx, Summary: batchSummary(as)}
	for i, a := range as {
		p, err := g.Prepare(a, targets[i])
		if err != nil {
			g.drop(b.Pending)
			return Batch{}, err
		}
		b.Pending = append(b.Pending, p)
	}
	b.Rule, b.NeedsConfirm = b.Pending[0].Rule, b.Pending[0].NeedsConfirm
	if b.NeedsConfirm && (b.Rule.Strict || kind == Delete && len(as) > TypeCountAbove) {
		b.TypeToConfirm = fmt.Sprint(len(as))
	}
	return b, nil
}

// drop withdraws issued tokens (a batch that couldn't be prepared whole).
func (g *Guard) drop(ps []Pending) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, p := range ps {
		delete(g.pending, p.Token)
	}
}

// batchSummary: "delete 5 pods -n ns on ctx"; mixed resources count as
// objects, mixed namespaces are counted.
func batchSummary(as []Action) string {
	res, ns := map[string]bool{}, map[string]bool{}
	for _, a := range as {
		res[a.Resource], ns[a.Namespace] = true, true
	}
	what := "objects"
	if len(res) == 1 {
		what = as[0].Resource
	}
	where := ""
	switch {
	case len(ns) > 1:
		where = fmt.Sprintf(" in %d namespaces", len(ns))
	case as[0].Namespace != "":
		where = " -n " + as[0].Namespace
	}
	return fmt.Sprintf("%s %d %s%s on %s", as[0].Kind, len(as), what, where, orCurrent(as[0].Context))
}

func ctxName(r Rule) string {
	if r.Label != "" {
		return fmt.Sprintf("%q (%s)", r.Context, r.Label)
	}
	return fmt.Sprintf("%q", r.Context)
}

func summary(a Action) string {
	switch a.Kind {
	case OpsPod:
		return fmt.Sprintf("node shell on node %s on %s", a.Name, orCurrent(a.Context))
	case Terminal:
		if a.Namespace != "" {
			return fmt.Sprintf("local terminal on %s, namespace %s", orCurrent(a.Context), a.Namespace)
		}
		return fmt.Sprintf("local terminal on %s", orCurrent(a.Context))
	}
	obj := a.Resource + "/" + a.Name
	if a.Namespace != "" {
		obj += " -n " + a.Namespace
	}
	return fmt.Sprintf("%s %s on %s", a.Kind, obj, orCurrent(a.Context))
}

func orCurrent(ctx string) string {
	if ctx == "" {
		return "(current context)"
	}
	return ctx
}

func newToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
