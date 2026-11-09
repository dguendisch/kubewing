// Package health decides which objects "hide healthy" hides: rules by kind
// (health.yaml, embedded, extended by the user's health.yaml), each a mix
// of a Go check (pods, workloads), status conditions, the observed
// generation and a CEL expression. Pure.
package health

import (
	_ "embed"
	"errors"
	"fmt"
	"path"
	"reflect"
	"slices"
	"strings"
	"sync"

	sigsyaml "sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/expr"
)

// Rule is one health rule (health.yaml, or the built-in ones). An object
// its kinds match is healthy when every check the rule sets holds.
type Rule struct {
	ID string `json:"id"`
	// Kinds the rule applies to: "Pod" (core), "apps/Deployment", globs
	// ("extensions.gardener.cloud/*"). Required.
	Kinds []string `json:"kinds"`
	// Title says what's hidden ("pods that are Running …"): the checkbox's
	// tooltip. "{kinds}" is the pane's kind, lower case, plural.
	Title string `json:"title,omitempty"`
	// Builtin names a check in Go: pod, workload, replicaset, daemonset.
	Builtin string `json:"builtin,omitempty"`
	// Generation: status.observedGeneration is at least metadata.generation
	// (the controller has seen the latest spec).
	Generation bool `json:"generation,omitempty"`
	// Conditions maps a status condition's type to the status it must have
	// ("True", "False"); a condition that's missing fails.
	Conditions map[string]string `json:"conditions,omitempty"`
	// CEL is an expression over the object `o` that must be true; a missing
	// field fails.
	CEL string `json:"cel,omitempty"`
}

// RulesFile is health.yaml: rules of one's own (before the built-in ones;
// a rule with a built-in's id replaces it) and built-in ones turned off.
type RulesFile struct {
	Rules   []Rule   `json:"rules,omitempty"`
	Disable []string `json:"disable,omitempty"`
}

// Rules is a compiled rule set, user rules first. Safe for concurrent use.
type Rules struct {
	list []*compiled
	// byKind caches the rule deciding each group/Kind (nil: none)
	byKind sync.Map
}

type compiled struct {
	Rule
	check func(obj map[string]any) bool
	cel   *expr.Program
}

// Equal reports whether both sets have the same rules in the same order
// (go-cmp compares by it: the compiled parts are unexported).
func (rs *Rules) Equal(o *Rules) bool {
	if rs == nil || o == nil {
		return rs == o
	}
	return slices.EqualFunc(rs.list, o.list, func(a, b *compiled) bool { return reflect.DeepEqual(a.Rule, b.Rule) })
}

//go:embed health.yaml
var builtinYAML []byte

var builtin = func() []Rule {
	var f RulesFile
	if err := sigsyaml.UnmarshalStrict(builtinYAML, &f); err != nil {
		panic("health: health.yaml: " + err.Error())
	}
	return f.Rules
}()

// Builtin are the built-in rules.
func Builtin() []Rule { return append([]Rule(nil), builtin...) }

// Default is the built-in rule set.
var Default = func() *Rules {
	r, errs := Compile(RulesFile{})
	if len(errs) > 0 {
		panic(fmt.Sprintf("health: built-in rules: %v", errs))
	}
	return r
}()

// Compile checks f's rules and puts them before the built-in ones (minus
// the disabled ones and those a user rule replaces). Invalid rules are left
// out and reported.
func Compile(f RulesFile) (*Rules, []error) {
	var errs []error
	out := &Rules{}
	seen := map[string]bool{}
	for i, r := range f.Rules {
		if r.ID == "" {
			errs = append(errs, fmt.Errorf("rules[%d]: id is required", i))
			continue
		}
		if seen[r.ID] {
			errs = append(errs, fmt.Errorf("rules[%d]: id %q twice", i, r.ID))
			continue
		}
		c, err := compile(r)
		if err != nil {
			errs = append(errs, fmt.Errorf("rules[%d] (%s): %w", i, r.ID, err))
			continue
		}
		seen[r.ID] = true
		out.list = append(out.list, c)
	}
	known := map[string]bool{}
	for _, r := range builtin {
		known[r.ID] = true
	}
	off := map[string]bool{}
	for _, id := range f.Disable {
		if !known[id] {
			errs = append(errs, fmt.Errorf("disable: no built-in rule %q", id))
		}
		off[id] = true
	}
	for _, r := range builtin {
		if off[r.ID] || seen[r.ID] {
			continue
		}
		c, err := compile(r)
		if err != nil {
			errs = append(errs, fmt.Errorf("built-in %s: %w", r.ID, err))
			continue
		}
		out.list = append(out.list, c)
	}
	return out, errs
}

func compile(r Rule) (*compiled, error) {
	c := &compiled{Rule: r}
	if len(r.Kinds) == 0 {
		return nil, errors.New("kinds is required")
	}
	for _, k := range r.Kinds {
		if _, err := path.Match(k, ""); err != nil {
			return nil, fmt.Errorf("kinds: %q: %w", k, err)
		}
	}
	if r.Builtin != "" {
		if c.check = builtins[r.Builtin]; c.check == nil {
			return nil, fmt.Errorf("builtin: no check %q (pod, workload, replicaset, daemonset)", r.Builtin)
		}
	}
	for t, s := range r.Conditions {
		if t == "" || s == "" {
			return nil, fmt.Errorf("conditions: type and status are required (got %q: %q)", t, s)
		}
	}
	if r.CEL != "" {
		prg, err := expr.Compile(r.CEL)
		if err != nil {
			return nil, fmt.Errorf("cel: %w", err)
		}
		if t := prg.OutputType(); t != "bool" && t != "dyn" {
			return nil, fmt.Errorf("cel: result is %s, not bool", t)
		}
		c.cel = prg
	}
	if c.check == nil && !r.Generation && len(r.Conditions) == 0 && c.cel == nil {
		return nil, errors.New("nothing to check: set builtin, generation, conditions or cel")
	}
	return c, nil
}

func (c *compiled) applies(gk string) bool {
	for _, k := range c.Kinds {
		if ok, _ := path.Match(k, gk); ok {
			return true
		}
	}
	return false
}

// healthy runs the rule's checks (all must hold).
func (c *compiled) healthy(obj map[string]any) bool {
	meta, _ := obj["metadata"].(map[string]any)
	status, _ := obj["status"].(map[string]any)
	if c.check != nil && !c.check(obj) {
		return false
	}
	if c.Generation && number(status["observedGeneration"]) < number(meta["generation"]) {
		return false
	}
	if len(c.Conditions) > 0 {
		have := map[string]any{}
		l, _ := status["conditions"].([]any)
		for _, x := range l {
			m, _ := x.(map[string]any)
			if t, ok := m["type"].(string); ok {
				have[t] = m["status"]
			}
		}
		for t, want := range c.Conditions {
			if have[t] != want {
				return false
			}
		}
	}
	if c.cel != nil {
		if ok, err := c.cel.Bool(obj); err != nil || !ok {
			return false
		}
	}
	return true
}

// rule is the rule deciding group/kind ("" group: core), nil if none.
func (rs *Rules) rule(group, kind string) *compiled {
	gk := kind
	if group != "" {
		gk = group + "/" + kind
	}
	if c, ok := rs.byKind.Load(gk); ok {
		return c.(*compiled)
	}
	var found *compiled
	for _, c := range rs.list {
		if c.applies(gk) {
			found = c
			break
		}
	}
	rs.byKind.Store(gk, found)
	return found
}

// Title is what hiding healthy objects of group/kind hides (the rule's
// title, "{kinds}" filled in), "" if no rule decides the kind. A rule
// without a title says "healthy <kinds>".
func (rs *Rules) Title(group, kind string) string {
	if rs == nil || kind == "" {
		return ""
	}
	c := rs.rule(group, kind)
	if c == nil {
		return ""
	}
	t := c.Title
	if t == "" {
		t = "healthy {kinds}"
	}
	return strings.ReplaceAll(t, "{kinds}", strings.ToLower(kind)+"s")
}

// Healthy reports whether obj has nothing to look at: not being deleted,
// and the rule for its kind (by its apiVersion and kind) holds. Kinds
// without a rule are never healthy, so never hidden.
func (rs *Rules) Healthy(obj map[string]any) bool {
	if rs == nil {
		return false
	}
	meta, _ := obj["metadata"].(map[string]any)
	if meta["deletionTimestamp"] != nil {
		return false
	}
	kind, _ := obj["kind"].(string)
	if kind == "" {
		return false
	}
	av, _ := obj["apiVersion"].(string)
	group, _, ok := strings.Cut(av, "/")
	if !ok {
		group = ""
	}
	c := rs.rule(group, kind)
	return c != nil && c.healthy(obj)
}
