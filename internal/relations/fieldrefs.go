package relations

import (
	_ "embed"
	"errors"
	"fmt"
	"path"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"

	yaml "go.yaml.in/yaml/v3"
	sigsyaml "sigs.k8s.io/yaml"
)

// Field references: rules saying where an object names another object
// by a field (a pod's volume → its secret, a binding → its role). They
// drive the jump menu's field section (the references at the cursor of a
// YAML view) and the table's direct references; transitive ones (a pod's
// claims → their volumes → attachments) stay in References.

// Rule is one field reference rule (refs.yaml, or the built-in ones).
type Rule struct {
	ID string `json:"id"`
	// Kinds the rule applies to: "Pod" (core), "apps/Deployment", globs
	// ("*.gardener.cloud/*"); "*" or none: any kind.
	Kinds []string `json:"kinds,omitempty"`
	// Path to the field holding the reference: keys separated by dots,
	// `[*]` any list item, `[kind=ServiceAccount]` the items whose field
	// has that value, `["a.b"]` a key with dots, `*` any key (a glob within
	// a key: `*SecretRef`), `**` any depth.
	Path string `json:"path"`
	// Name is the field (relative to Path, dotted) holding the name; ""
	// takes the value at Path itself.
	Name string `json:"name,omitempty"`
	// Target is the kind referred to: "Secret" (core v1), "v1/Secret",
	// "storage.k8s.io/StorageClass" (the preferred version) or
	// "storage.k8s.io/v1/StorageClass". The fields below override parts of
	// it (it may be empty with KindField).
	Target string `json:"target,omitempty"`
	// KindField, GroupField ("rbac.authorization.k8s.io": the preferred
	// version), APIVersionField and NamespaceField are fields relative to
	// Path; a field that's missing or empty keeps the default (a namespace:
	// the object's own; cluster-scoped kinds have none).
	KindField       string `json:"kindField,omitempty"`
	GroupField      string `json:"groupField,omitempty"`
	APIVersionField string `json:"apiVersionField,omitempty"`
	NamespaceField  string `json:"namespaceField,omitempty"`
}

// RulesFile is refs.yaml: rules of one's own (before the built-in ones; a
// rule with a built-in's id replaces it) and built-in ones turned off.
type RulesFile struct {
	Rules   []Rule   `json:"rules,omitempty"`
	Disable []string `json:"disable,omitempty"`
}

// Rules is a compiled rule set, user rules first.
type Rules struct{ list []*compiled }

// Equal reports whether both sets have the same rules in the same order
// (go-cmp compares by it: the compiled parts are unexported).
func (rs *Rules) Equal(o *Rules) bool {
	if rs == nil || o == nil {
		return rs == o
	}
	if len(rs.list) != len(o.list) {
		return false
	}
	for i := range rs.list {
		if !reflect.DeepEqual(rs.list[i].Rule, o.list[i].Rule) {
			return false
		}
	}
	return true
}

type compiled struct {
	Rule
	steps                    []step
	name, kindF, groupF, avF []string
	nsF                      []string
	group, version, kind     string
	anyKind                  bool
}

//go:embed refs.yaml
var builtinYAML []byte

var builtin = func() []Rule {
	var f RulesFile
	if err := sigsyaml.UnmarshalStrict(builtinYAML, &f); err != nil {
		panic("relations: refs.yaml: " + err.Error())
	}
	return f.Rules
}()

// Builtin are the built-in rules.
func Builtin() []Rule { return append([]Rule(nil), builtin...) }

// DefaultRules is the built-in rule set.
var DefaultRules = func() *Rules {
	r, errs := Compile(RulesFile{})
	if len(errs) > 0 {
		panic(fmt.Sprintf("relations: built-in refs: %v", errs))
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
	var err error
	if c.steps, err = parsePath(r.Path); err != nil {
		return nil, fmt.Errorf("path: %w", err)
	}
	for _, k := range r.Kinds {
		if k == "*" {
			c.anyKind = true
		} else if _, err := path.Match(k, ""); err != nil {
			return nil, fmt.Errorf("kinds: %q: %w", k, err)
		}
	}
	c.anyKind = c.anyKind || len(r.Kinds) == 0
	for _, f := range []struct {
		name string
		val  string
		to   *[]string
	}{{"name", r.Name, &c.name}, {"kindField", r.KindField, &c.kindF}, {"groupField", r.GroupField, &c.groupF}, {"apiVersionField", r.APIVersionField, &c.avF}, {"namespaceField", r.NamespaceField, &c.nsF}} {
		if f.val == "" {
			continue
		}
		keys := strings.Split(f.val, ".")
		if slices.Contains(keys, "") {
			return nil, fmt.Errorf("%s: %q is not a dotted field", f.name, f.val)
		}
		*f.to = keys
	}
	if r.Target == "" {
		if r.KindField == "" {
			return nil, errors.New("target or kindField is required")
		}
		c.version = "v1"
		return c, nil
	}
	parts := strings.Split(r.Target, "/")
	switch len(parts) {
	case 1:
		c.version, c.kind = "v1", parts[0]
	case 2:
		if isVersion(parts[0]) {
			c.version, c.kind = parts[0], parts[1]
		} else {
			c.group, c.kind = parts[0], parts[1]
		}
	case 3:
		c.group, c.version, c.kind = parts[0], parts[1], parts[2]
	default:
		return nil, fmt.Errorf("target %q: want Kind, group/Kind or group/version/Kind", r.Target)
	}
	if c.kind == "" || !unicode.IsUpper(rune(c.kind[0])) {
		return nil, fmt.Errorf("target %q: a kind starts upper case", r.Target)
	}
	return c, nil
}

var versionRE = regexp.MustCompile(`^v[0-9]+((alpha|beta)[0-9]+)?$`)

func isVersion(s string) bool { return versionRE.MatchString(s) }

type stepKind int

const (
	keyStep stepKind = iota
	itemStep
	anyDepth
)

type step struct {
	kind stepKind
	// keyStep: a glob, or (exact) a literal key
	key   string
	exact bool
	// itemStep: the items whose field by is val ("" = any item)
	by, val string
}

// parsePath parses a rule's path (see Rule.Path).
func parsePath(p string) ([]step, error) {
	if p == "" {
		return nil, errors.New("is required")
	}
	var out []step
	for i := 0; i < len(p); {
		switch p[i] {
		case '.':
			if i == 0 || i+1 == len(p) || p[i+1] == '.' {
				return nil, fmt.Errorf("%q: empty segment", p)
			}
			i++
		case '[':
			j := strings.IndexByte(p[i:], ']')
			if j < 0 {
				return nil, fmt.Errorf("%q: [ without ]", p)
			}
			inner := p[i+1 : i+j]
			switch {
			case inner == "*":
				out = append(out, step{kind: itemStep})
			case strings.HasPrefix(inner, `"`):
				k, err := strconv.Unquote(inner)
				if err != nil {
					return nil, fmt.Errorf("%q: key %s: %w", p, inner, err)
				}
				out = append(out, step{kind: keyStep, key: k, exact: true})
			default:
				by, val, ok := strings.Cut(inner, "=")
				if !ok || by == "" {
					return nil, fmt.Errorf("%q: [%s]: want [*], [field=value] or [\"key\"]", p, inner)
				}
				out = append(out, step{kind: itemStep, by: by, val: val})
			}
			i += j + 1
		default:
			j := strings.IndexAny(p[i:], ".[")
			if j < 0 {
				j = len(p) - i
			}
			seg := p[i : i+j]
			if seg == "**" {
				out = append(out, step{kind: anyDepth})
			} else {
				if _, err := path.Match(seg, ""); err != nil {
					return nil, fmt.Errorf("%q: %q: %w", p, seg, err)
				}
				out = append(out, step{kind: keyStep, key: seg})
			}
			i += j
		}
	}
	if out[len(out)-1].kind == anyDepth {
		return nil, fmt.Errorf("%q: ends in **", p)
	}
	return out, nil
}

func (s step) matchKey(k string) bool {
	if s.exact {
		return k == s.key
	}
	ok, _ := path.Match(s.key, k)
	return ok
}

// FieldRef is one place an object refers to another (Ref.Rule: the rule
// that found it).
type FieldRef struct {
	Ref
	// Line (0-based) and columns (1-based, end exclusive) of the name's
	// value in the YAML, to mark it.
	Line, Col, EndCol int
	// Start..End are the lines (0-based) of the field holding the reference.
	Start, End int
}

// Key identifies the object a reference points to (by group, not
// version): the same object found twice is one jump.
func (r Ref) Key() string {
	return GroupOf(r.APIVersion) + "/" + r.Kind + "/" + r.Namespace + "/" + r.Name
}

// GroupOf is an apiVersion's group ("" for core "v1", "apps" for "apps/v1"
// and for "apps/", which asks for the preferred version).
func GroupOf(apiVersion string) string {
	g, _, ok := strings.Cut(apiVersion, "/")
	if !ok {
		return ""
	}
	return g
}

// ParseYAML parses a YAML text for Match.
func ParseYAML(text string) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return nil, err
	}
	if len(doc.Content) == 0 {
		return nil, errors.New("empty document")
	}
	return doc.Content[0], nil
}

// ObjectNode is an object as a YAML node tree, rendered as the YAML view
// shows it (keys sorted), so Match lists in the order seen there.
func ObjectNode(obj map[string]any) (*yaml.Node, error) {
	b, err := sigsyaml.Marshal(obj)
	if err != nil {
		return nil, err
	}
	return ParseYAML(string(b))
}

// Match lists the references in root, an object of group and kind in
// namespace ("" cluster-scoped), in document order. A field two rules
// match refers once (the first rule wins: user rules come first).
func (rs *Rules) Match(root *yaml.Node, group, kind, namespace string) []FieldRef {
	if rs == nil || root == nil {
		return nil
	}
	gk := kind
	if group != "" {
		gk = group + "/" + kind
	}
	type at struct {
		n    *yaml.Node
		kind string
	}
	seen := map[at]bool{}
	var out []FieldRef
	for _, c := range rs.list {
		if !c.applies(gk) {
			continue
		}
		walk(root, c.steps, root.Line, func(n *yaml.Node, start int) {
			fr, nameNode, ok := c.ref(n, namespace)
			if !ok {
				return
			}
			k := at{nameNode, GroupOf(fr.APIVersion) + "/" + fr.Kind}
			if seen[k] {
				return
			}
			seen[k] = true
			fr.Line = nameNode.Line - 1
			fr.Col = nameNode.Column
			fr.EndCol = nameNode.Column + len([]rune(nameNode.Value))
			if nameNode.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle) != 0 {
				fr.EndCol += 2
			}
			fr.Start, fr.End = start-1, endLine(n)-1
			out = append(out, fr)
		})
	}
	// document order: the menu and the marks follow the text
	sortRefs(out)
	return out
}

func sortRefs(l []FieldRef) {
	sort.SliceStable(l, func(i, j int) bool { return l[i].Line < l[j].Line || l[i].Line == l[j].Line && l[i].Col < l[j].Col })
}

func (c *compiled) applies(gk string) bool {
	if c.anyKind {
		return true
	}
	for _, k := range c.Kinds {
		if ok, _ := path.Match(k, gk); ok {
			return true
		}
	}
	return false
}

// ref reads the reference at n (the node the path matched).
func (c *compiled) ref(n *yaml.Node, namespace string) (FieldRef, *yaml.Node, bool) {
	nameNode := n
	if c.name != nil {
		nameNode = child(n, c.name)
	}
	if nameNode == nil || nameNode.Kind != yaml.ScalarNode || nameNode.Tag == "!!null" || strings.TrimSpace(nameNode.Value) == "" {
		return FieldRef{}, nil, false
	}
	group, version, kind := c.group, c.version, c.kind
	if v := scalarAt(n, c.kindF); v != "" {
		kind = v
	}
	if v := scalarAt(n, c.groupF); c.groupF != nil && child(n, c.groupF) != nil {
		group, version = v, ""
		if v == "" {
			version = "v1"
		}
	}
	if v := scalarAt(n, c.avF); v != "" {
		if g, ver, ok := strings.Cut(v, "/"); ok {
			group, version = g, ver
		} else {
			group, version = "", v
		}
	}
	if kind == "" {
		return FieldRef{}, nil, false
	}
	if v := scalarAt(n, c.nsF); v != "" {
		namespace = v
	}
	av := version
	if group != "" {
		av = group + "/" + version
	}
	return FieldRef{Ref: Ref{APIVersion: av, Kind: kind, Namespace: namespace, Name: nameNode.Value, Rule: c.ID}}, nameNode, true
}

// walk calls emit for each node the steps lead to from n; start is the
// line where n's field begins (its key, or its list item).
func walk(n *yaml.Node, steps []step, start int, emit func(*yaml.Node, int)) {
	if n.Kind == yaml.AliasNode && n.Alias != nil {
		n = n.Alias
	}
	if len(steps) == 0 {
		emit(n, start)
		return
	}
	s := steps[0]
	switch s.kind {
	case anyDepth:
		walk(n, steps[1:], start, emit)
		switch n.Kind {
		case yaml.MappingNode:
			for i := 0; i+1 < len(n.Content); i += 2 {
				walk(n.Content[i+1], steps, n.Content[i].Line, emit)
			}
		case yaml.SequenceNode:
			for _, it := range n.Content {
				walk(it, steps, it.Line, emit)
			}
		}
	case keyStep:
		if n.Kind != yaml.MappingNode {
			return
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			if s.matchKey(n.Content[i].Value) {
				walk(n.Content[i+1], steps[1:], n.Content[i].Line, emit)
			}
		}
	case itemStep:
		if n.Kind != yaml.SequenceNode {
			return
		}
		for _, it := range n.Content {
			if s.by == "" || scalarAt(it, []string{s.by}) == s.val {
				walk(it, steps[1:], it.Line, emit)
			}
		}
	}
}

// child is the node at keys below a mapping node (nil if absent).
func child(n *yaml.Node, keys []string) *yaml.Node {
	for _, k := range keys {
		if n.Kind != yaml.MappingNode {
			return nil
		}
		var next *yaml.Node
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == k {
				next = n.Content[i+1]
				break
			}
		}
		if next == nil {
			return nil
		}
		n = next
	}
	return n
}

// scalarAt is the scalar at keys below n ("" if absent or not a scalar).
func scalarAt(n *yaml.Node, keys []string) string {
	if keys == nil {
		return ""
	}
	c := child(n, keys)
	if c == nil || c.Kind != yaml.ScalarNode || c.Tag == "!!null" {
		return ""
	}
	return c.Value
}

// endLine is the last line (1-based) n spans.
func endLine(n *yaml.Node) int {
	end := n.Line
	for _, c := range n.Content {
		if e := endLine(c); e > end {
			end = e
		}
	}
	return end
}

// FieldSpan is the field at a line (0-based) of a YAML text: the widest
// key or list item starting there (on `- name: certs`, the whole volume),
// as lines (0-based). ok is false on a line without one.
func FieldSpan(root *yaml.Node, line int) (start, end int, ok bool) {
	line++
	best := -1
	var visit func(n *yaml.Node)
	visit = func(n *yaml.Node) {
		consider := func(s int, v *yaml.Node) {
			if s == line {
				if e := endLine(v); e > best {
					best = e
				}
			}
		}
		switch n.Kind {
		case yaml.MappingNode:
			for i := 0; i+1 < len(n.Content); i += 2 {
				k, v := n.Content[i], n.Content[i+1]
				consider(k.Line, v)
				if k.Line <= line && endLine(v) >= line {
					visit(v)
				}
			}
		case yaml.SequenceNode:
			for _, it := range n.Content {
				consider(it.Line, it)
				if it.Line <= line && endLine(it) >= line {
					visit(it)
				}
			}
		}
	}
	visit(root)
	if best < 0 {
		return 0, 0, false
	}
	return line - 1, best - 1, true
}

// Under keeps the references within or around the field at line (see
// FieldSpan): on a value, its reference; on a list item or a map, all
// those inside.
func Under(refs []FieldRef, root *yaml.Node, line int) []FieldRef {
	s, e, ok := FieldSpan(root, line)
	if !ok {
		return nil
	}
	var out []FieldRef
	for _, r := range refs {
		if r.Start <= e && s <= r.End {
			out = append(out, r)
		}
	}
	return out
}
