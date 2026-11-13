package safety

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"github.com/dguendisch/kubewing/internal/config"
)

var rules = []config.ContextRule{
	{Match: "*prod*", Label: "PROD", Color: "prod", ReadOnly: true},
	{Match: "live-*", Label: "LIVE", Confirm: []string{"exec"}, Strict: true},
	{Match: "*", Label: "any"},
}

func TestPolicyFor(t *testing.T) {
	p := NewPolicy(rules)
	for _, tc := range []struct {
		ctx  string
		want Rule
	}{
		{"garden-prod-eu", Rule{Context: "garden-prod-eu", Label: "PROD", Color: "prod", ReadOnly: true, Confirm: []string{"delete", "restart"}}},
		// delete and restart always confirm, even if a rule lists only other actions
		{"live-1", Rule{Context: "live-1", Label: "LIVE", Confirm: []string{"exec", "delete", "restart"}, Strict: true}},
		{"kind", Rule{Context: "kind", Label: "any", Confirm: []string{"delete", "restart"}}},
	} {
		if diff := cmp.Diff(tc.want, p.For(tc.ctx)); diff != "" {
			t.Errorf("%s: %s", tc.ctx, diff)
		}
	}
	if diff := cmp.Diff(Rule{Context: "x", Confirm: []string{"delete", "restart"}}, NewPolicy(nil).For("x")); diff != "" {
		t.Errorf("no rules: %s", diff)
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func del(ctx, name string) Action {
	return Action{Kind: Delete, Context: ctx, Resource: "pods", Namespace: "ns", Name: name, UID: "u-" + name}
}

func TestReadOnlyRefusesMutations(t *testing.T) {
	g := NewGuard(NewPolicy(rules), time.Now)
	for _, kind := range []string{Delete, Exec, Edit, Terminal, Restart} {
		_, err := g.Prepare(Action{Kind: kind, Context: "garden-prod-eu", Resource: "pods", Name: "a"}, nil)
		if !errors.Is(err, ErrReadOnly) || !strings.Contains(err.Error(), "PROD") {
			t.Errorf("%s: %v", kind, err)
		}
	}
	if _, err := g.Prepare(Action{Kind: "reboot"}, nil); err == nil {
		t.Error("unknown action kinds must be refused")
	}
}

func TestPendingConfirmation(t *testing.T) {
	g := NewGuard(NewPolicy(rules), time.Now)
	p, err := g.Prepare(del("kind", "a"), "target")
	if err != nil {
		t.Fatal(err)
	}
	if !p.NeedsConfirm || p.TypeToConfirm != "" || p.Summary != "delete pods/a -n ns on kind" || p.Rule.Label != "any" {
		t.Errorf("pending: %+v", p)
	}
	p, _ = g.Prepare(del("live-1", "b"), nil)
	if p.TypeToConfirm != "b" {
		t.Errorf("strict: %+v", p)
	}
	p, _ = g.Prepare(Action{Kind: Exec, Context: "kind", Resource: "pods", Name: "c"}, nil)
	if p.NeedsConfirm {
		t.Errorf("exec on a context without exec confirmation: %+v", p)
	}
}

func TestTokens(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	g := NewGuard(NewPolicy(rules), c.now)

	p, _ := g.Prepare(del("kind", "a"), "target-a")
	a, target, err := g.Redeem(p.Token, Delete)
	if err != nil || a != del("kind", "a") || target != "target-a" {
		t.Fatalf("redeem: %v %v %v", a, target, err)
	}
	if _, _, err := g.Redeem(p.Token, Delete); err == nil {
		t.Error("tokens are single-use")
	}
	if _, _, err := g.Redeem("forged", Delete); err == nil {
		t.Error("unknown tokens must be refused")
	}

	p, _ = g.Prepare(Action{Kind: Exec, Context: "kind", Name: "a"}, nil)
	if _, _, err := g.Redeem(p.Token, Delete); err == nil || !strings.Contains(err.Error(), "issued for exec") {
		t.Errorf("kind mismatch: %v", err)
	}
	if _, _, err := g.Redeem(p.Token, Exec); err == nil {
		t.Error("a mismatched redeem still consumes the token")
	}

	p, _ = g.Prepare(del("kind", "a"), nil)
	c.t = c.t.Add(TokenTTL + time.Second)
	if _, _, err := g.Redeem(p.Token, Delete); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expiry: %v", err)
	}
}

// A config reload drops outstanding tokens: they were checked under the old rules.
func TestPolicyChangeInvalidatesTokens(t *testing.T) {
	g := NewGuard(NewPolicy(nil), time.Now)
	p, err := g.Prepare(del("garden-prod-eu", "a"), nil)
	if err != nil {
		t.Fatal(err)
	}
	g.SetPolicy(NewPolicy(rules))
	if _, _, err := g.Redeem(p.Token, Delete); err == nil {
		t.Error("token survived a policy change")
	}
	if r := g.Rule("garden-prod-eu"); !r.ReadOnly {
		t.Errorf("rule after reload: %+v", r)
	}
}

func TestPrepareBatch(t *testing.T) {
	g := NewGuard(NewPolicy(rules), time.Now)
	as := []Action{del("kind", "a"), del("kind", "b"), del("kind", "c")}
	b, err := g.PrepareBatch(as, []any{"ta", "tb", "tc"})
	if err != nil {
		t.Fatal(err)
	}
	if b.Summary != "delete 3 pods -n ns on kind" || !b.NeedsConfirm || b.TypeToConfirm != "" || len(b.Pending) != 3 {
		t.Fatalf("batch: %+v", b)
	}
	// each token is bound to its own object
	for i, p := range b.Pending {
		a, target, err := g.Redeem(p.Token, Delete)
		if err != nil || a != as[i] || target != []any{"ta", "tb", "tc"}[i] {
			t.Errorf("token %d: %v %v %v", i, a, target, err)
		}
	}

	// strict rules type the count, not a name
	live := []Action{del("live-1", "a"), del("live-1", "b")}
	if b, _ := g.PrepareBatch(live, []any{nil, nil}); b.TypeToConfirm != "2" {
		t.Errorf("strict: %+v", b)
	}
	// a big delete types the count anyway; a big exec on a plain context doesn't confirm at all
	var big, execs []Action
	for i := range TypeCountAbove + 1 {
		big = append(big, del("kind", fmt.Sprint(i)))
		e := del("kind", fmt.Sprint(i))
		e.Kind = Exec
		execs = append(execs, e)
	}
	targets := make([]any, len(big))
	if b, _ := g.PrepareBatch(big, targets); b.TypeToConfirm != fmt.Sprint(TypeCountAbove+1) {
		t.Errorf("big delete: %+v", b)
	}
	if b, _ := g.PrepareBatch(execs, targets); b.NeedsConfirm || b.TypeToConfirm != "" {
		t.Errorf("big exec: %+v", b)
	}

	// mixed resources and namespaces
	mixed := []Action{del("kind", "a"), {Kind: Delete, Context: "kind", Resource: "secrets", Namespace: "other", Name: "s"}}
	if b, _ := g.PrepareBatch(mixed, []any{nil, nil}); b.Summary != "delete 2 objects in 2 namespaces on kind" {
		t.Errorf("mixed: %q", b.Summary)
	}

	// read-only: refused whole, no token left behind
	g = NewGuard(NewPolicy(rules), time.Now)
	if _, err := g.PrepareBatch([]Action{del("garden-prod-eu", "a"), del("garden-prod-eu", "b")}, []any{nil, nil}); !errors.Is(err, ErrReadOnly) {
		t.Errorf("read-only: %v", err)
	}
	if _, err := g.PrepareBatch([]Action{del("kind", "a"), del("other", "b")}, []any{nil, nil}); err == nil {
		t.Error("two contexts in one batch must be refused")
	}
	if n := len(g.pending); n != 0 {
		t.Errorf("%d tokens left behind", n)
	}
}

// A rule for a landscape covers its Gardener clusters as kubewing names
// them; a rule for one of them, placed before it, still wins. The guard
// enforces it, not only the badge.
func TestPolicyForLandscape(t *testing.T) {
	p := NewPolicy([]config.ContextRule{
		{Match: "*-live/shoot--ops--*", Label: "OPS"},
		{Match: "*-live", Label: "LIVE", ReadOnly: true},
		{Match: "*/seed--*", Label: "SEED"},
	})
	for ctx, label := range map[string]string{
		"sap-landscape-live":                         "LIVE", // the garden itself, by its name
		"sap-landscape-live/shoot--core--cicd":       "LIVE",
		"sap-landscape-live/seed--gcp-ha-eu2":        "LIVE", // the first matching rule: the landscape's
		"sap-landscape-live/shoot--ops--monitoring":  "OPS",
		"sap-landscape-dev/seed--aws":                "SEED",
		"sap-landscape-dev/shoot--core--cicd":        "",
		"sap-landscape-live/other":                   "", // not a name kubewing gives
		"shoot--core--cicd":                          "", // gardenctl's context name: no landscape in it
		"sap-landscape-live/shoot--core--cicd/extra": "",
	} {
		if r := p.For(ctx); r.Label != label {
			t.Errorf("%s: label %q, want %q", ctx, r.Label, label)
		}
	}
	// by the landscape, or by the name (the garden's own, a cluster's rule): which, for safety.label: landscape
	for ctx, by := range map[string]bool{"sap-landscape-live/seed--gcp-ha-eu2": true, "sap-landscape-live/shoot--ops--monitoring": false} {
		if r := p.For(ctx); r.ByLandscape != by {
			t.Errorf("%s: byLandscape %v", ctx, r.ByLandscape)
		}
	}
	g := NewGuard(p, time.Now)
	if _, err := g.Prepare(del("sap-landscape-live/seed--gcp-ha-eu2", "a"), nil); !errors.Is(err, ErrReadOnly) {
		t.Errorf("a live landscape's seed: %v, want read-only", err)
	}
}

func TestLandscape(t *testing.T) {
	for ctx, want := range map[string]string{
		"live/shoot--p--s": "live", "live/seed--s": "live", "live": "", "/shoot--p--s": "", "live/garden": "", "a/b/shoot--p--s": "",
	} {
		if got := Landscape(ctx); got != want {
			t.Errorf("Landscape(%q) = %q, want %q", ctx, got, want)
		}
	}
}

// A context gardenctl named (no landscape in it) matches the landscape it's
// known to be in, for the badge and the guard alike.
func TestPolicyForInLandscape(t *testing.T) {
	p := NewPolicy([]config.ContextRule{{Match: "*-live", Label: "LIVE", ReadOnly: true}})
	if r := p.ForIn("garden--gcp-ha-eu2-external", "sap-landscape-live"); r.Label != "LIVE" || !r.ByLandscape {
		t.Errorf("gardenctl's seed context: %+v", r)
	}
	// the garden: its name is its landscape
	if r := p.ForIn("sap-landscape-live", "sap-landscape-live"); !r.ByLandscape {
		t.Errorf("the garden: %+v", r)
	}
	if r := p.ForIn("garden--gcp-ha-eu2-external", ""); r.Label != "" {
		t.Errorf("without a landscape: %+v", r)
	}
	g := NewGuard(p, time.Now)
	a := del("shoot--core--cicdes", "a")
	if _, err := g.Prepare(a, nil); err != nil {
		t.Errorf("by name alone: %v", err)
	}
	a.Landscape = "sap-landscape-live"
	if _, err := g.Prepare(a, nil); !errors.Is(err, ErrReadOnly) {
		t.Errorf("in a live landscape: %v, want read-only", err)
	}
}
