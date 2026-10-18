package safety

import (
	"errors"
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
		{"garden-prod-eu", Rule{Context: "garden-prod-eu", Label: "PROD", Color: "prod", ReadOnly: true, Confirm: []string{"delete"}}},
		// delete always confirms, even if a rule lists only other actions
		{"live-1", Rule{Context: "live-1", Label: "LIVE", Confirm: []string{"exec", "delete"}, Strict: true}},
		{"kind", Rule{Context: "kind", Label: "any", Confirm: []string{"delete"}}},
	} {
		if diff := cmp.Diff(tc.want, p.For(tc.ctx)); diff != "" {
			t.Errorf("%s: %s", tc.ctx, diff)
		}
	}
	if diff := cmp.Diff(Rule{Context: "x", Confirm: []string{"delete"}}, NewPolicy(nil).For("x")); diff != "" {
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
	for _, kind := range []string{Delete, Exec} {
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
