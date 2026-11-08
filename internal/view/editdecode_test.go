package view

import (
	"strings"
	"testing"

	sigsyaml "sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/fieldpath"
)

// An object's secret: data.yaml.br → doc 2's kubeconfig → server edited,
// encoded back level by level; the object's other lines stay as they were.
func TestEditDecodeEncodeLevels(t *testing.T) {
	kubeconfig := "apiVersion: v1\nclusters:\n- name: c\n  cluster:\n    server: https://old.example.com\n"
	manifests := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: two\ndata:\n  kubeconfig: " + b64(kubeconfig) + "\n"
	object := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: mr # a comment stays\n  namespace: shoot\ndata:\n  data.yaml.br: " + b64br(t, manifests) + "\n  other: " + b64("x") + "\ntype: Opaque\n"

	// level 1: the object's data.yaml.br
	l1 := EditDecode(EditDecodeRequest{Text: object, Language: "yaml", Line: lineOf(t, object, "data.yaml.br:"), Object: true})
	if l1.Refused != "" || strings.Join(l1.Steps, ",") != "base64,brotli" || l1.Text != manifests || l1.Lang != "yaml" || l1.Label != `data["data.yaml.br"]` {
		t.Fatalf("level 1: %+v", l1)
	}
	// level 2: doc 2's kubeconfig
	l2 := EditDecode(EditDecodeRequest{Text: l1.Text, Language: l1.Lang, Line: lineOf(t, l1.Text, "kubeconfig:")})
	if l2.Refused != "" || l2.Doc != 1 || l2.Text != kubeconfig || l2.Label != "doc 2: data.kubeconfig" {
		t.Fatalf("level 2: %+v", l2)
	}
	edited := strings.Replace(l2.Text, "old.example.com", "new.example.com", 1)

	// back up: the kubeconfig into the manifests, the manifests into the object
	m2, err := EditEncode(EditEncodeRequest{Text: l1.Text, Opened: l1.Text, Language: l1.Lang, Path: l2.Path, Doc: l2.Doc, Steps: l2.Steps, Value: edited})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(m2, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n---\n") || !strings.Contains(m2, "kubeconfig: "+b64(edited)) {
		t.Fatalf("manifests:\n%s", m2)
	}
	obj2, err := EditEncode(EditEncodeRequest{Text: object, Opened: object, Language: "yaml", Path: l1.Path, Steps: l1.Steps, Object: true, Value: m2})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(obj2, "name: mr # a comment stays") || !strings.Contains(obj2, "other: "+b64("x")) || obj2 == object {
		t.Fatalf("object:\n%s", obj2)
	}
	// decoded again, the edit is there
	again := EditDecode(EditDecodeRequest{Text: obj2, Language: "yaml", Path: l1.Path, Steps: l1.Steps, Object: true})
	if again.Text != m2 {
		t.Fatalf("decoded again:\n%s", again.Text)
	}
}

// A level put back after the text above was edited meanwhile: the value
// comes from the text as opened, goes into the text as it is now.
func TestEditEncodeIntoChangedText(t *testing.T) {
	opened := "kind: Secret\ndata:\n  pw: " + b64("old") + "\n"
	now := "kind: Secret\nmetadata:\n  labels: {a: b}\ndata:\n  pw: " + b64("old") + "\n"
	got, err := EditEncode(EditEncodeRequest{Text: now, Opened: opened, Language: "yaml", Path: fieldpath.Path{{Key: "data"}, {Key: "pw"}}, Steps: []string{"base64"}, Object: true, Value: "new"})
	if err != nil {
		t.Fatal(err)
	}
	if got != "kind: Secret\nmetadata:\n  labels: {a: b}\ndata:\n  pw: "+b64("new")+"\n" {
		t.Fatalf("got\n%s", got)
	}
	// unchanged: the text as it is now, untouched
	same, err := EditEncode(EditEncodeRequest{Text: now, Opened: opened, Language: "yaml", Path: fieldpath.Path{{Key: "data"}, {Key: "pw"}}, Steps: []string{"base64"}, Object: true, Value: "old"})
	if err != nil || same != now {
		t.Fatalf("unchanged: %q, %v", same, err)
	}
}

func TestEditDecodeRefuses(t *testing.T) {
	object := "kind: ConfigMap\ndata:\n  plain: hello\n  n: \"1\"\n  m:\n    x: y\n  config.yaml: |\n    a: 1\n    b: [x]\n"
	for _, tc := range []struct{ line, want string }{
		{"plain:", "plain text"},
		{"m:", "is a map"},
		{"kind:", "plain text"},
	} {
		r := EditDecode(EditDecodeRequest{Text: object, Language: "yaml", Line: lineOf(t, object, tc.line), Object: true})
		if !strings.Contains(r.Refused, tc.want) {
			t.Errorf("%s: %+v, want %q", tc.line, r, tc.want)
		}
	}
	// a YAML string with no steps is edited as YAML, and goes back as a block
	r := EditDecode(EditDecodeRequest{Text: object, Language: "yaml", Line: lineOf(t, object, "config.yaml:"), Object: true})
	if r.Refused != "" || r.Lang != "yaml" || len(r.Steps) != 0 {
		t.Fatalf("config.yaml: %+v", r)
	}
	out, err := EditEncode(EditEncodeRequest{Text: object, Opened: object, Language: "yaml", Path: r.Path, Steps: r.Steps, Object: true, Value: "a: 2\nb: [x]\n"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := sigsyaml.Unmarshal([]byte(out), &m); err != nil || m["data"].(map[string]any)["config.yaml"] != "a: 2\nb: [x]\n" || !strings.Contains(out, "  config.yaml: |\n    a: 2\n") {
		t.Fatalf("got\n%s (%v)", out, err)
	}
	// text that doesn't parse says so
	if r := EditDecode(EditDecodeRequest{Text: "a: [x\n", Language: "yaml", Line: 0}); !strings.Contains(r.Refused, "doesn't parse") {
		t.Errorf("broken: %+v", r)
	}
}
