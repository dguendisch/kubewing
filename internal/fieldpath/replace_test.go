package fieldpath

import (
	"strings"
	"testing"

	sigsyaml "sigs.k8s.io/yaml"
)

func TestReplace(t *testing.T) {
	k := func(keys ...string) Path {
		var p Path
		for _, s := range keys {
			p = append(p, Step{Key: s})
		}
		return p
	}
	tests := []struct {
		name  string
		text  string
		path  Path
		value string
		lang  string
		want  string
	}{
		{
			name: "plain, the rest untouched (comments, order, other values)",
			text: "# head\nkind: Secret\ndata:\n  b: Zm9v # foo\n  a: YmFy\n",
			path: k("data", "b"), value: "YmF6",
			want: "# head\nkind: Secret\ndata:\n  b: YmF6 # foo\n  a: YmFy\n",
		},
		{
			name: "a value that needs quotes gets them",
			text: "a: x\nb: y\n", path: k("a"), value: "true",
			want: "a: \"true\"\nb: y\n",
		},
		{
			name: "double-quoted stays double-quoted",
			text: "a: \"x \\\" y\"\nb: 1\n", path: k("a"), value: "z",
			want: "a: \"z\"\nb: 1\n",
		},
		{
			name: "single-quoted stays single-quoted",
			text: "a: 'it''s'\n", path: k("a"), value: "it's new",
			want: "a: 'it''s new'\n",
		},
		{
			name: "quoted key",
			text: "data:\n  \"data.yaml.br\": abc\n  x: y\n", path: k("data", "data.yaml.br"), value: "def",
			want: "data:\n  \"data.yaml.br\": def\n  x: y\n",
		},
		{
			name: "a multi-line value becomes a literal block",
			text: "data:\n  config: a\n  next: b\n", path: k("data", "config"), value: "x: 1\ny: 2\n",
			want: "data:\n  config: |\n    x: 1\n    y: 2\n  next: b\n",
		},
		{
			name: "a literal block replaced, its indentation kept",
			text: "data:\n  config: |\n      x: 1\n      y: 2\n\n  next: b\n", path: k("data", "config"), value: "x: 3\n",
			want: "data:\n  config: |\n      x: 3\n\n  next: b\n",
		},
		{
			name: "a block without a final line break: |-",
			text: "a: |\n  x\nb: c\n", path: k("a"), value: "y\nz",
			want: "a: |-\n  y\n  z\nb: c\n",
		},
		{
			name: "a block at the end of the text",
			text: "a: |\n  x\n  y\n", path: k("a"), value: "z\n",
			want: "a: |\n  z\n",
		},
		{
			name: "a first line with leading spaces gets an indentation indicator",
			text: "a: x\n", path: k("a"), value: "  indented\nnot\n",
			want: "a: |2\n    indented\n  not\n",
		},
		{
			name: "list item by key",
			text: "spec:\n  containers:\n  - name: a\n    image: x:1\n  - name: b\n    image: y:1\n",
			path: Path{{Key: "spec"}, {Key: "containers"}, {By: "name", Val: "b"}, {Key: "image"}}, value: "y:2",
			want: "spec:\n  containers:\n  - name: a\n    image: x:1\n  - name: b\n    image: y:2\n",
		},
		{
			name: "list item by index, a block under it",
			text: "args:\n- one\n- two\n", path: Path{{Key: "args"}, {List: true, Index: 1}}, value: "a\nb\n",
			want: "args:\n- one\n- |\n  a\n  b\n",
		},
		{
			name: "in a flow map: quoted",
			text: "m: {a: x, b: y}\n", path: k("m", "a"), value: "new, value",
			want: "m: {a: \"new, value\", b: y}\n",
		},
		{
			name: "a plain value folded over lines",
			text: "a: one\n  two\nb: c\n", path: k("a"), value: "z",
			want: "a: z\nb: c\n",
		},
		{
			name: "json: a JSON string",
			text: "{\n  \"a\": \"x\",\n  \"b\": {\"c\": \"d\"}\n}\n", path: k("b", "c"), value: "line\n\"q\"", lang: "json",
			want: "{\n  \"a\": \"x\",\n  \"b\": {\"c\": \"line\\n\\\"q\\\"\"}\n}\n",
		},
		{
			name: "a multi-byte key before the value",
			text: "ä: x\n", path: k("ä"), value: "ü",
			want: "ä: ü\n",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Replace(tc.text, tc.path, tc.value, tc.lang)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("got\n%s\nwant\n%s", got, tc.want)
			}
			// whatever the style, the text reads back with the value set
			var obj map[string]any
			if err := sigsyaml.Unmarshal([]byte(got), &obj); err != nil {
				t.Fatalf("result doesn't parse: %v", err)
			}
			if v, _ := Lookup(obj, tc.path); v != tc.value {
				t.Errorf("reads back %q, want %q", v, tc.value)
			}
		})
	}
}

func TestReplaceRefuses(t *testing.T) {
	for _, tc := range []struct {
		text string
		path Path
		want string
	}{
		{"a: 1\n", Path{{Key: "a"}}, "isn't a string"},
		{"a: {b: c}\n", Path{{Key: "a"}}, "isn't a string"},
		{"a: x\n", Path{{Key: "b"}}, "not found"},
		{"a: [x\n", Path{{Key: "a"}}, "doesn't parse"},
	} {
		if _, err := Replace(tc.text, tc.path, "v", ""); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%q: got %v, want %q", tc.text, err, tc.want)
		}
	}
}
