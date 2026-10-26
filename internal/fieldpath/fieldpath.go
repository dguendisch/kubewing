// Package fieldpath diffs two JSON-like objects into field-path changes
// (`status.conditions[type=Ready].status: True → False`) and applies them
// forward or in reverse. Pure; the history store and, later, the "what
// changed" views build on it.
package fieldpath

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// Step is one segment of a path: a map key, a list item matched by a key
// field (containers by name, conditions by type), or a list index.
type Step struct {
	Key string `json:"key,omitempty"`
	// By/Val: the list item whose field By equals Val
	By  string `json:"by,omitempty"`
	Val string `json:"val,omitempty"`
	// Index: the list position (List set); for a keyed item added or
	// removed, where it goes when the change puts it (back) in
	Index int  `json:"index,omitempty"`
	List  bool `json:"list,omitempty"`
}

// Path is a sequence of steps from the object root.
type Path []Step

// String renders a path as `status.conditions[type=Ready].status`;
// keys that aren't plain identifiers are quoted (`labels["app.kubernetes.io/name"]`).
func (p Path) String() string {
	var b strings.Builder
	for _, s := range p {
		switch {
		case s.By != "":
			fmt.Fprintf(&b, "[%s=%s]", s.By, s.Val)
		case s.List:
			fmt.Fprintf(&b, "[%d]", s.Index)
		case plain(s.Key):
			if b.Len() > 0 {
				b.WriteByte('.')
			}
			b.WriteString(s.Key)
		default:
			fmt.Fprintf(&b, "[%s]", strconv.Quote(s.Key))
		}
	}
	return b.String()
}

func plain(k string) bool {
	if k == "" {
		return false
	}
	for i, r := range k {
		if r != '_' && r != '-' && !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// Change is one field that differs. Old is absent (HasOld false) for an
// added field, New for a removed one; both are kept so a change applies in
// either direction.
type Change struct {
	Path   Path `json:"path"`
	Old    any  `json:"old,omitempty"`
	New    any  `json:"new,omitempty"`
	HasOld bool `json:"hasOld,omitempty"`
	HasNew bool `json:"hasNew,omitempty"`
}

// String renders a change as `path: old → new` (`∅` for absent).
func (c Change) String() string {
	return fmt.Sprintf("%s: %s → %s", c.Path, show(c.Old, c.HasOld), show(c.New, c.HasNew))
}

func show(v any, ok bool) string {
	if !ok {
		return "∅"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// listKeys are the fields list items are matched by, in order of preference
// (Kubernetes' common x-kubernetes-list-map-keys). A list is matched by the
// first one every item has as a unique string; otherwise by index.
var listKeys = []string{"name", "type", "containerPort", "port", "ip", "key", "devicePath", "mountPath"}

// Diff returns the changes that turn old into new, in a deterministic
// order (map keys sorted) that Apply and Revert rely on. Maps are compared
// key by key, keyed lists item by item; anything else (scalars, unkeyed
// lists that changed length, type changes) is replaced as a whole.
func Diff(old, new map[string]any) []Change {
	var out []Change
	diffMap(nil, old, new, &out)
	return out
}

func diffMap(p Path, a, b map[string]any, out *[]Change) {
	keys := make([]string, 0, len(a)+len(b))
	for k := range a {
		keys = append(keys, k)
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		av, inA := a[k]
		bv, inB := b[k]
		q := appendStep(p, Step{Key: k})
		switch {
		case !inB:
			*out = append(*out, Change{Path: q, Old: av, HasOld: true})
		case !inA:
			*out = append(*out, Change{Path: q, New: bv, HasNew: true})
		default:
			diffValue(q, av, bv, out)
		}
	}
}

func diffValue(p Path, a, b any, out *[]Change) {
	switch av := a.(type) {
	case map[string]any:
		if bv, ok := b.(map[string]any); ok {
			diffMap(p, av, bv, out)
			return
		}
	case []any:
		if bv, ok := b.([]any); ok {
			diffList(p, av, bv, out)
			return
		}
	}
	if !equal(a, b) {
		*out = append(*out, Change{Path: p, Old: a, New: b, HasOld: true, HasNew: true})
	}
}

// diffList matches keyed lists item by item. Removals come first (from the
// last old position down), then changed items, then additions (from the
// first new position up): applied in this order the list ends up exactly in
// new's order, and reverted in reverse order exactly in old's.
func diffList(p Path, a, b []any, out *[]Change) {
	if by := keyField(a, b); by != "" {
		// the item order is part of the value: a reorder replaces the list
		if !sameOrder(a, b, by) {
			*out = append(*out, Change{Path: p, Old: a, New: b, HasOld: true, HasNew: true})
			return
		}
		ai, bi := index(a, by), index(b, by)
		for i := len(a) - 1; i >= 0; i-- {
			if v := keyOf(a[i], by); bi[v] == nil {
				*out = append(*out, Change{Path: appendStep(p, Step{By: by, Val: v, Index: i}), Old: a[i], HasOld: true})
			}
		}
		for _, y := range b {
			v := keyOf(y, by)
			if x, ok := ai[v]; ok {
				diffValue(appendStep(p, Step{By: by, Val: v}), x, y, out)
			}
		}
		for i, y := range b {
			if v := keyOf(y, by); ai[v] == nil {
				*out = append(*out, Change{Path: appendStep(p, Step{By: by, Val: v, Index: i}), New: y, HasNew: true})
			}
		}
		return
	}
	if len(a) != len(b) {
		*out = append(*out, Change{Path: p, Old: a, New: b, HasOld: true, HasNew: true})
		return
	}
	for i := range a {
		diffValue(appendStep(p, Step{List: true, Index: i}), a[i], b[i], out)
	}
}

// sameOrder reports whether the items both lists share appear in the same
// relative order (additions and removals anywhere are fine).
func sameOrder(a, b []any, by string) bool {
	inB := index(b, by)
	pos := make(map[string]int, len(b))
	for i, it := range b {
		pos[keyOf(it, by)] = i
	}
	last := -1
	for _, it := range a {
		v := keyOf(it, by)
		if _, ok := inB[v]; !ok {
			continue
		}
		if pos[v] < last {
			return false
		}
		last = pos[v]
	}
	return true
}

// keyField picks the field both lists' items are matched by ("" = none).
func keyField(a, b []any) string {
	if len(a) == 0 && len(b) == 0 {
		return ""
	}
	for _, k := range listKeys {
		if uniqueKey(a, k) && uniqueKey(b, k) {
			return k
		}
	}
	return ""
}

func uniqueKey(l []any, k string) bool {
	seen := make(map[string]bool, len(l))
	for _, it := range l {
		v := keyOf(it, k)
		if v == "" || seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}

// keyOf returns item[k] as a string ("" if absent or not a string/number).
func keyOf(it any, k string) string {
	m, ok := it.(map[string]any)
	if !ok {
		return ""
	}
	switch v := m[k].(type) {
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	}
	return ""
}

func index(l []any, by string) map[string]any {
	m := make(map[string]any, len(l))
	for _, it := range l {
		m[keyOf(it, by)] = it
	}
	return m
}

func appendStep(p Path, s Step) Path {
	q := make(Path, len(p), len(p)+1)
	copy(q, p)
	return append(q, s)
}

// equal compares decoded JSON values; numbers compare by value (an int64
// from the apiserver equals the float64 of a re-decoded copy).
func equal(a, b any) bool {
	if x, ok := num(a); ok {
		if y, ok := num(b); ok {
			return x == y
		}
	}
	return reflect.DeepEqual(a, b)
}

func num(v any) (float64, bool) {
	switch n := v.(type) {
	case int64:
		return float64(n), true
	case int:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

// Apply applies changes forward (old → new) to obj in place.
func Apply(obj map[string]any, changes []Change) error {
	for _, c := range changes {
		if err := set(obj, c.Path, c.New, c.HasNew); err != nil {
			return fmt.Errorf("%s: %w", c.Path, err)
		}
	}
	return nil
}

// Revert applies changes in reverse (new → old) to obj in place.
func Revert(obj map[string]any, changes []Change) error {
	for i := len(changes) - 1; i >= 0; i-- {
		c := changes[i]
		if err := set(obj, c.Path, c.Old, c.HasOld); err != nil {
			return fmt.Errorf("%s: %w", c.Path, err)
		}
	}
	return nil
}

// set writes a copy of v at p (present) or removes the field there
// (!present). The copy keeps the change's own values out of obj, which the
// caller goes on changing. The parent must exist: changes come from Diff,
// which only reports a path whose parent is in both versions.
func set(root map[string]any, p Path, v any, present bool) error {
	return put(root, p, Copy(v), present)
}

func put(root map[string]any, p Path, v any, present bool) error {
	if len(p) == 0 {
		return fmt.Errorf("empty path")
	}
	var parent any = root
	for _, s := range p[:len(p)-1] {
		next, err := child(parent, s)
		if err != nil {
			return err
		}
		parent = next
	}
	last := p[len(p)-1]
	switch pv := parent.(type) {
	case map[string]any:
		if last.By != "" || last.List {
			return fmt.Errorf("list step into a map")
		}
		if present {
			pv[last.Key] = v
		} else {
			delete(pv, last.Key)
		}
		return nil
	case []any:
		return putInList(root, p[:len(p)-1], pv, last, v, present)
	}
	return fmt.Errorf("parent is %T", parent)
}

// putInList changes a list item. Adding or removing an item changes the
// list's length, so the list is written back into its own parent.
func putInList(root map[string]any, lp Path, l []any, s Step, v any, present bool) error {
	i := -1
	switch {
	case s.By != "":
		for j, it := range l {
			if keyOf(it, s.By) == s.Val {
				i = j
				break
			}
		}
	case s.List:
		if s.Index < len(l) {
			i = s.Index
		}
	default:
		return fmt.Errorf("map step into a list")
	}
	switch {
	case present && i >= 0:
		l[i] = v
		return nil
	case !present && i < 0:
		return nil
	case present:
		at := min(max(s.Index, 0), len(l))
		l = append(l[:at:at], append([]any{v}, l[at:]...)...)
	default:
		l = append(l[:i:i], l[i+1:]...)
	}
	return put(root, lp, l, true)
}

// Copy deep-copies a decoded JSON value (maps, lists, scalars).
func Copy(v any) any {
	switch x := v.(type) {
	case map[string]any:
		m := make(map[string]any, len(x))
		for k, c := range x {
			m[k] = Copy(c)
		}
		return m
	case []any:
		l := make([]any, len(x))
		for i, c := range x {
			l[i] = Copy(c)
		}
		return l
	}
	return v
}

func child(n any, s Step) (any, error) {
	switch v := n.(type) {
	case map[string]any:
		if s.By != "" || s.List {
			return nil, fmt.Errorf("list step into a map")
		}
		c, ok := v[s.Key]
		if !ok {
			return nil, fmt.Errorf("no field %q", s.Key)
		}
		return c, nil
	case []any:
		for j, it := range v {
			if (s.By != "" && keyOf(it, s.By) == s.Val) || (s.List && j == s.Index) {
				return it, nil
			}
		}
		return nil, fmt.Errorf("no list item %s", Path{s})
	}
	return nil, fmt.Errorf("%T has no children", n)
}
