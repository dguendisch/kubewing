package fieldpath

import (
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

func TestAtLine(t *testing.T) {
	obj := map[string]any{
		"metadata": map[string]any{"name": "web", "labels": map[string]any{"app.kubernetes.io/name": "web"}},
		"spec": map[string]any{
			"args":       []any{"a", "b"},
			"containers": []any{map[string]any{"name": "app", "image": "web:1"}, map[string]any{"name": "side", "image": "s:1"}},
		},
		"status": map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True", "message": "line one\nline two"}}},
	}
	b, err := yaml.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	lines := strings.Split(text, "\n")
	at := func(want string) int {
		for i, l := range lines {
			if strings.TrimSpace(l) == want {
				return i
			}
		}
		t.Fatalf("no line %q in\n%s", want, text)
		return -1
	}
	for _, tc := range []struct{ line, want string }{
		{"name: web", "metadata.name"},
		{"app.kubernetes.io/name: web", `metadata.labels["app.kubernetes.io/name"]`},
		{"labels:", "metadata.labels"},
		{"- a", "spec.args[0]"},
		{"- b", "spec.args[1]"},
		{"- image: s:1", "spec.containers[name=side].image"},
		{"- image: web:1", "spec.containers[name=app].image"},
		{"type: Ready", "status.conditions[type=Ready].type"},
		{"status: \"True\"", "status.conditions[type=Ready].status"},
		{"containers:", "spec.containers"},
	} {
		p, err := AtLine(text, at(tc.line), obj)
		if err != nil || p.String() != tc.want {
			t.Errorf("%q: %v (%v), want %s", tc.line, p, err, tc.want)
		}
	}
	// a line inside a multi-line string belongs to its key
	for i, l := range lines {
		if strings.TrimSpace(l) == "line two" {
			if p, err := AtLine(text, i, obj); err == nil {
				t.Errorf("inside a block string: %v", p)
			}
		}
	}
}
