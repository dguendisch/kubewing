// Package blame maps the lines of an object's YAML to the field managers
// that own the fields on them (from metadata.managedFields), like
// kubectl-blame: which controller, user or apply set each line. Pure.
//
// It walks the YAML text as shown (a viewer's, or the editor's as typed)
// together with each manager's fieldsV1 set, so the lines are the text's
// own and nothing has to be mapped between two renderings.
package blame

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	yaml "go.yaml.in/yaml/v3"
)

// Entry is one metadata.managedFields item.
type Entry struct {
	Manager     string          `json:"manager"`
	Operation   string          `json:"operation"`
	Subresource string          `json:"subresource,omitempty"`
	Time        string          `json:"time,omitempty"`
	FieldsType  string          `json:"fieldsType,omitempty"`
	FieldsV1    json.RawMessage `json:"fieldsV1,omitempty"`
}

// Owner is one manager owning a field on a line.
type Owner struct {
	Manager     string `json:"manager"`
	Operation   string `json:"operation"` // Apply or Update
	Subresource string `json:"subresource,omitempty"`
	// Time is when the manager last wrote any of its fields (RFC 3339; "" unknown).
	Time string `json:"time,omitempty"`
}

// Line is the blame of one line (0-based) that has an owner. Owners are
// ordered most recent first: the first is the one shown.
type Line struct {
	Line   int     `json:"line"`
	Owners []Owner `json:"owners"`
}

// Entries reads metadata.managedFields of an object ("" or absent: none).
func Entries(obj map[string]any) ([]Entry, error) {
	md, _ := obj["metadata"].(map[string]any)
	raw, ok := md["managedFields"]
	if !ok || raw == nil {
		return nil, nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var out []Entry
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("managedFields: %w", err)
	}
	return out, nil
}

// set is a fieldsV1 tree: children by their encoded key ("f:name",
// "k:{...}", "v:...", "i:3"); self is the "." marker (the node itself
// is owned, for a map or list value).
type set struct {
	self     bool
	children map[string]*set
}

func parseSet(raw json.RawMessage) (*set, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	s := &set{children: map[string]*set{}}
	for k, v := range m {
		if k == "." {
			s.self = true
			continue
		}
		c, err := parseSet(v)
		if err != nil {
			return nil, err
		}
		s.children[k] = c
	}
	return s, nil
}

// manager is an entry with its parsed set.
type manager struct {
	owner Owner
	at    time.Time
	set   *set
}

// Lines blames each line of text (an object's YAML) on the managers in
// entries owning a field that starts there: a scalar's key line, a list
// item's first line, a map or list owned as a whole. Lines without an
// owner are left out. Entries with an unknown fieldsType are skipped.
func Lines(text string, entries []Entry) ([]Line, error) {
	var mgrs []manager
	for _, e := range entries {
		if len(e.FieldsV1) == 0 || (e.FieldsType != "" && e.FieldsType != "FieldsV1") {
			continue
		}
		s, err := parseSet(e.FieldsV1)
		if err != nil {
			return nil, fmt.Errorf("managedFields of %s: %w", e.Manager, err)
		}
		at, _ := time.Parse(time.RFC3339, e.Time)
		mgrs = append(mgrs, manager{owner: Owner{Manager: e.Manager, Operation: e.Operation, Subresource: e.Subresource, Time: e.Time}, at: at, set: s})
	}
	// most recent first: the owner shown on a line shared by several
	sort.SliceStable(mgrs, func(i, j int) bool { return mgrs[i].at.After(mgrs[j].at) })

	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return nil, err
	}
	if len(doc.Content) == 0 {
		return nil, errors.New("empty document")
	}
	byLine := map[int][]int{} // line (1-based) → manager indexes, each once
	add := func(line int, owned []int) {
		for _, i := range owned {
			if !contains(byLine[line], i) {
				byLine[line] = append(byLine[line], i)
			}
		}
	}
	sets := make([]*set, len(mgrs))
	for i, m := range mgrs {
		sets[i] = m.set
	}
	walk(doc.Content[0], sets, add)

	out := make([]Line, 0, len(byLine))
	for line, idx := range byLine {
		sort.Ints(idx)
		l := Line{Line: line - 1}
		for _, i := range idx {
			l.Owners = append(l.Owners, mgrs[i].owner)
		}
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Line < out[j].Line })
	return out, nil
}

func contains(l []int, x int) bool {
	for _, y := range l {
		if y == x {
			return true
		}
	}
	return false
}

// walk descends n with the managers' sets at it (nil: that manager owns
// nothing below), reporting owners per line.
func walk(n *yaml.Node, sets []*set, add func(line int, owned []int)) {
	if n.Kind == yaml.AliasNode && n.Alias != nil {
		n = n.Alias
	}
	switch n.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			child := step(sets, func(s *set) *set { return s.children["f:"+k.Value] })
			field(k.Line, v, child, add)
		}
	case yaml.SequenceNode:
		var items []any
		_ = n.Decode(&items)
		for i, it := range n.Content {
			var val any
			if i < len(items) {
				val = items[i]
			}
			child := step(sets, func(s *set) *set { return listChild(s, i, val) })
			field(it.Line, it, child, add)
		}
	}
}

// field reports a field (a map entry or a list item) starting on line
// with value v: a scalar is owned by every manager that has it; a map or
// list by those that own it as a whole ("."), and its children by theirs.
func field(line int, v *yaml.Node, sets []*set, add func(line int, owned []int)) {
	if v.Kind == yaml.AliasNode && v.Alias != nil {
		v = v.Alias
	}
	var owned []int
	for i, s := range sets {
		if s == nil {
			continue
		}
		// a scalar: the leaf is in the set; a map or list item without children
		// in the set (an empty map, `k:{...}: {}`) is owned as a whole too
		if v.Kind == yaml.ScalarNode || s.self || len(s.children) == 0 {
			owned = append(owned, i)
		}
	}
	add(line, owned)
	if v.Kind == yaml.MappingNode || v.Kind == yaml.SequenceNode {
		walk(v, sets, add)
	}
}

// step is each manager's set one level down (nil where it owns nothing).
func step(sets []*set, down func(*set) *set) []*set {
	out := make([]*set, len(sets))
	for i, s := range sets {
		if s != nil {
			out[i] = down(s)
		}
	}
	return out
}

// listChild finds list item i (decoded value val) in a set: by its key
// fields (`k:{"name":"app"}`: every key field equal), by value for a set
// of scalars (`v:"a"`), or by index (`i:0`).
func listChild(s *set, i int, val any) *set {
	if c, ok := s.children["i:"+strconv.Itoa(i)]; ok {
		return c
	}
	for k, c := range s.children {
		switch {
		case strings.HasPrefix(k, "k:"):
			var keys map[string]any
			if json.Unmarshal([]byte(k[2:]), &keys) != nil {
				continue
			}
			m, ok := val.(map[string]any)
			if !ok || len(keys) == 0 {
				continue
			}
			match := true
			for kf, kv := range keys {
				if !sameValue(m[kf], kv) {
					match = false
					break
				}
			}
			if match {
				return c
			}
		case strings.HasPrefix(k, "v:"):
			var v any
			if json.Unmarshal([]byte(k[2:]), &v) == nil && sameValue(val, v) {
				return c
			}
		}
	}
	return nil
}

// sameValue compares a YAML-decoded value with a JSON-decoded one: numbers
// by value (int vs float64), everything else by its JSON form.
func sameValue(a, b any) bool {
	ja, err1 := json.Marshal(norm(a))
	jb, err2 := json.Marshal(norm(b))
	return err1 == nil && err2 == nil && string(ja) == string(jb)
}

func norm(v any) any {
	switch x := v.(type) {
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = norm(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = norm(e)
		}
		return out
	}
	return v
}
