package fieldpath

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"pgregory.net/rapid"
)

func obj(t testing.TB, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func strs(cs []Change) string {
	var out []string
	for _, c := range cs {
		out = append(out, c.String())
	}
	return strings.Join(out, "\n")
}

func TestDiff(t *testing.T) {
	for _, tc := range []struct{ name, a, b, want string }{
		{"equal", `{"a":1,"b":{"c":[1,2]}}`, `{"a":1,"b":{"c":[1,2]}}`, ""},
		{"scalar", `{"a":1}`, `{"a":2}`, "a: 1 → 2"},
		{"added and removed fields", `{"a":1,"b":2}`, `{"b":2,"c":3}`, "a: 1 → ∅\nc: ∅ → 3"},
		{"nested", `{"spec":{"replicas":1,"x":"y"}}`, `{"spec":{"replicas":3,"x":"y"}}`, "spec.replicas: 1 → 3"},
		{"condition by type",
			`{"status":{"conditions":[{"type":"Ready","status":"True"},{"type":"Synced","status":"True"}]}}`,
			`{"status":{"conditions":[{"type":"Ready","status":"False"},{"type":"Synced","status":"True"}]}}`,
			`status.conditions[type=Ready].status: "True" → "False"`},
		{"container by name, item added",
			`{"spec":{"containers":[{"name":"app","image":"a:1"}]}}`,
			`{"spec":{"containers":[{"name":"app","image":"a:2"},{"name":"side","image":"s:1"}]}}`,
			"spec.containers[name=app].image: \"a:1\" → \"a:2\"\nspec.containers[name=side]: ∅ → {\"image\":\"s:1\",\"name\":\"side\"}"},
		{"keyed item removed", `{"l":[{"name":"a"},{"name":"b"}]}`, `{"l":[{"name":"b"}]}`, `l[name=a]: {"name":"a"} → ∅`},
		{"reorder replaces the list", `{"l":[{"name":"a"},{"name":"b"}]}`, `{"l":[{"name":"b"},{"name":"a"}]}`,
			`l: [{"name":"a"},{"name":"b"}] → [{"name":"b"},{"name":"a"}]`},
		{"unkeyed list by index", `{"args":["a","b"]}`, `{"args":["a","c"]}`, `args[1]: "b" → "c"`},
		{"unkeyed list length change replaces it", `{"f":["a","b"]}`, `{"f":["a"]}`, `f: ["a","b"] → ["a"]`},
		{"key with dots is quoted", `{"metadata":{"labels":{"app.kubernetes.io/name":"x"}}}`, `{"metadata":{"labels":{"app.kubernetes.io/name":"y"}}}`,
			`metadata.labels["app.kubernetes.io/name"]: "x" → "y"`},
		{"type change", `{"a":{"b":1}}`, `{"a":"s"}`, `a: {"b":1} → "s"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := strs(Diff(obj(t, tc.a), obj(t, tc.b))); got != tc.want {
				t.Errorf("got\n%s\nwant\n%s", got, tc.want)
			}
		})
	}
}

// int64 (as the apiserver decodes) and float64 (re-decoded JSON) are the same number
func TestDiffNumbers(t *testing.T) {
	if cs := Diff(map[string]any{"a": int64(3)}, map[string]any{"a": float64(3)}); len(cs) != 0 {
		t.Fatalf("got %v", cs)
	}
}

// Changes carry copies into the object they're applied to: changing that
// object afterwards leaves the changes (the history) alone.
func TestApplyCopies(t *testing.T) {
	a, b := obj(t, `{"spec":{}}`), obj(t, `{"spec":{"x":{"y":1}}}`)
	cs := Diff(a, b)
	Apply(a, cs)
	a["spec"].(map[string]any)["x"].(map[string]any)["y"] = 2
	if got := cs[0].New.(map[string]any)["y"]; got != float64(1) {
		t.Fatalf("change aliased into the object: %v", got)
	}
}

// For any two objects: Apply(a, Diff(a, b)) = b and Revert(b, Diff(a, b)) = a.
func TestRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		a := genObject(t, "a", 3)
		b := mutate(t, a, 3)
		cs := Diff(a, b)
		fwd := Copy(a).(map[string]any)
		if err := Apply(fwd, cs); err != nil {
			t.Fatalf("apply: %v\n%s", err, strs(cs))
		}
		if !reflect.DeepEqual(fwd, b) {
			t.Fatalf("apply:\n got %s\nwant %s\n%s", js(fwd), js(b), strs(cs))
		}
		back := Copy(b).(map[string]any)
		if err := Revert(back, cs); err != nil {
			t.Fatalf("revert: %v\n%s", err, strs(cs))
		}
		if !reflect.DeepEqual(back, a) {
			t.Fatalf("revert:\n got %s\nwant %s\n%s", js(back), js(a), strs(cs))
		}
		if len(Diff(a, a)) != 0 {
			t.Fatal("diff of an object with itself")
		}
	})
}

func js(v any) string { b, _ := json.Marshal(v); return string(b) }

var fieldNames = []string{"a", "b", "c", "x.y", "name", "type"}

func genValue(t *rapid.T, label string, depth int) any {
	kind := rapid.IntRange(0, 4).Draw(t, label+"kind")
	if depth <= 0 {
		kind = rapid.IntRange(0, 1).Draw(t, label+"kind")
	}
	switch kind {
	case 0:
		return float64(rapid.IntRange(0, 3).Draw(t, label+"num"))
	case 1:
		return rapid.SampledFrom([]string{"", "p", "q"}).Draw(t, label+"str")
	case 2:
		return genObject(t, label, depth-1)
	case 3:
		return genKeyed(t, label, depth-1)
	default:
		n := rapid.IntRange(0, 3).Draw(t, label+"len")
		l := make([]any, n)
		for i := range l {
			l[i] = genValue(t, fmt.Sprintf("%s[%d]", label, i), depth-1)
		}
		return l
	}
}

func genObject(t *rapid.T, label string, depth int) map[string]any {
	m := map[string]any{}
	for _, k := range rapid.SliceOfDistinct(rapid.SampledFrom(fieldNames), rapid.ID[string]).Draw(t, label+"keys") {
		m[k] = genValue(t, label+"."+k, depth)
	}
	return m
}

// genKeyed makes a list of items with unique names (like containers).
func genKeyed(t *rapid.T, label string, depth int) []any {
	names := rapid.SliceOfDistinct(rapid.SampledFrom([]string{"n1", "n2", "n3", "n4"}), rapid.ID[string]).Draw(t, label+"names")
	l := make([]any, len(names))
	for i, n := range names {
		it := genObject(t, fmt.Sprintf("%s[%s]", label, n), max(depth, 0))
		delete(it, "type") // a second unique key field would compete with name
		it["name"] = n
		l[i] = it
	}
	return l
}

// mutate returns a changed deep copy of v: fields added/removed/replaced,
// keyed list items added/removed/reordered.
func mutate(t *rapid.T, v map[string]any, depth int) map[string]any {
	out := Copy(v).(map[string]any)
	for _, k := range fieldNames {
		label := "m." + k
		cur, ok := out[k]
		switch rapid.IntRange(0, 4).Draw(t, label) {
		case 0:
			delete(out, k)
		case 1:
			out[k] = genValue(t, label+"new", depth)
		case 2:
			if !ok {
				continue
			}
			switch c := cur.(type) {
			case map[string]any:
				out[k] = mutate(t, c, depth-1)
			case []any:
				out[k] = mutateList(t, label, c, depth-1)
			}
		}
	}
	return out
}

func mutateList(t *rapid.T, label string, l []any, depth int) []any {
	out := make([]any, 0, len(l)+1)
	for i, it := range l {
		switch rapid.IntRange(0, 3).Draw(t, fmt.Sprintf("%s[%d]", label, i)) {
		case 0: // removed
		case 1:
			if m, ok := it.(map[string]any); ok {
				n := mutate(t, m, depth)
				if name, ok := m["name"]; ok {
					n["name"] = name
				}
				out = append(out, n)
				continue
			}
			out = append(out, it)
		default:
			out = append(out, it)
		}
	}
	if rapid.Bool().Draw(t, label+"shuffle") && len(out) > 1 {
		out[0], out[len(out)-1] = out[len(out)-1], out[0]
	}
	if rapid.Bool().Draw(t, label+"add") {
		at := rapid.IntRange(0, len(out)).Draw(t, label+"at")
		out = append(out[:at:at], append([]any{map[string]any{"name": "n9", "a": 1.0}}, out[at:]...)...)
	}
	return out
}
