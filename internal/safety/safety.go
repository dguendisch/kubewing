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
)

// Mutating actions are refused on read-only contexts.
var mutating = []string{Delete, Exec, Debug, OpsPod}

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
// is writable and only delete needs confirmation; delete always does.
func (p *Policy) For(context string) Rule {
	r := Rule{Context: context, Confirm: []string{Delete}}
	for _, cr := range p.rules {
		if ok, _ := path.Match(cr.Match, context); !ok {
			continue
		}
		r.Label, r.Color, r.ReadOnly, r.Strict = cr.Label, cr.Color, cr.ReadOnly, cr.Strict
		if len(cr.Confirm) > 0 {
			r.Confirm = slices.Clone(cr.Confirm)
			if !slices.Contains(r.Confirm, Delete) {
				r.Confirm = append(r.Confirm, Delete)
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

func ctxName(r Rule) string {
	if r.Label != "" {
		return fmt.Sprintf("%q (%s)", r.Context, r.Label)
	}
	return fmt.Sprintf("%q", r.Context)
}

func summary(a Action) string {
	if a.Kind == OpsPod {
		return fmt.Sprintf("node shell on node %s on %s", a.Name, orCurrent(a.Context))
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
