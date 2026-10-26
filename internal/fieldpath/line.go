package fieldpath

import (
	"fmt"

	yaml "go.yaml.in/yaml/v3"
)

// AtLine resolves a line (0-based) of a YAML rendering of obj to the field
// path there: the deepest key or list item starting on that line. List items
// are named as Diff names them (by a key field, else by index), so the path
// matches recorded changes. obj is the object the YAML shows (its decoded
// form), used to pick the list keys.
func AtLine(text string, line int, obj map[string]any) (Path, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return nil, err
	}
	if len(doc.Content) == 0 {
		return nil, fmt.Errorf("empty document")
	}
	line++ // yaml.v3 counts from 1
	var found Path
	var walk func(n *yaml.Node, v any, p Path)
	walk = func(n *yaml.Node, v any, p Path) {
		switch n.Kind {
		case yaml.MappingNode:
			m, _ := v.(map[string]any)
			for i := 0; i+1 < len(n.Content); i += 2 {
				k, val := n.Content[i], n.Content[i+1]
				q := appendStep(p, Step{Key: k.Value})
				if k.Line == line {
					found = q
				}
				// a value further down (a nested map or list) may hold a deeper match
				if val.Line <= line {
					walk(val, m[k.Value], q)
				}
			}
		case yaml.SequenceNode:
			l, _ := v.([]any)
			by := keyField(l, l)
			for i, it := range n.Content {
				if it.Line > line {
					break
				}
				s := Step{List: true, Index: i}
				if by != "" && i < len(l) {
					s = Step{By: by, Val: keyOf(l[i], by)}
				}
				q := appendStep(p, s)
				if it.Line == line && (it.Kind == yaml.ScalarNode || found == nil || len(found) < len(q)) {
					found = q
				}
				if i < len(l) {
					walk(it, l[i], q)
				}
			}
		}
	}
	walk(doc.Content[0], obj, nil)
	if found == nil {
		return nil, fmt.Errorf("no field on line %d", line)
	}
	return found, nil
}
