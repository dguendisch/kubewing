package view

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"

	"github.com/dguendisch/kubewing/internal/source"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func b64br(t *testing.T, s string) string {
	t.Helper()
	var buf bytes.Buffer
	w := brotli.NewWriter(&buf)
	_, _ = w.Write([]byte(s))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

const kubeconfig = "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster:\n      server: https://api.example.com\n      certificate-authority-data: " +
	"Y2VydGlmaWNhdGU=\n"

func secret(uid string, data map[string]any) source.Item {
	return item(map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": map[string]any{"name": "s", "namespace": "ns", "uid": uid},
		"type":     "Opaque",
		"data":     data,
	})
}

// lineOf is the 0-based line of text starting (after indentation) with prefix.
func lineOf(t *testing.T, text, prefix string) int {
	t.Helper()
	for i, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), prefix) {
			return i
		}
	}
	t.Fatalf("no line %q in\n%s", prefix, text)
	return -1
}

func TestDecodeLevels(t *testing.T) {
	v, _ := recView(t, false)
	manifests := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: two\ndata:\n  kubeconfig: " + b64(kubeconfig) + "\n"
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{secret("s1", map[string]any{"data.yaml.br": b64br(t, manifests), "plain": b64("hello")})}}, t0)
	d, _ := v.Object("s1")

	// level 1: the managed resource secret's value, by its line in the YAML
	r, err := v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: []DecodeLevel{{Line: lineOf(t, d.YAML, "data.yaml.br:")}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.Steps, ",") != "base64,brotli" || r.Kind != "yaml" || r.Language != "yaml" || r.Text != manifests {
		t.Fatalf("level 1: %+v", r)
	}
	if r.Path != `data["data.yaml.br"]` || r.Levels[0].Path.String() != `data["data.yaml.br"]` {
		t.Fatalf("path %q, levels %+v", r.Path, r.Levels)
	}

	// level 2: the kubeconfig in its second document
	l2 := DecodeLevel{Line: lineOf(t, r.Text, "kubeconfig:")}
	r2, err := v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: append(r.Levels, l2)})
	if err != nil {
		t.Fatal(err)
	}
	if r2.Kind != "yaml" || !strings.Contains(r2.Text, "server: https://api.example.com") || r2.Levels[1].Doc != 1 {
		t.Fatalf("level 2: %+v", r2)
	}
	if r2.Path != `data["data.yaml.br"] → doc 2: data.kubeconfig` {
		t.Fatalf("path %q", r2.Path)
	}

	// level 3: inside the kubeconfig, a list item's field
	r3, err := v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: append(r2.Levels, DecodeLevel{Line: lineOf(t, r2.Text, "certificate-authority-data:")})})
	if err != nil {
		t.Fatal(err)
	}
	if r3.Text != "certificate" || !strings.HasSuffix(r3.Path, "clusters[name=c].cluster.certificate-authority-data") {
		t.Fatalf("level 3: %+v", r3)
	}

	// steps toggled: base64 only, raw → the brotli bytes as a hex dump
	r, err = v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: []DecodeLevel{{Path: r.Levels[0].Path, Steps: []string{"base64"}, Raw: true}}})
	if err != nil || r.Kind != "binary" || !strings.HasPrefix(r.Text, "# binary,") {
		t.Fatalf("raw: %+v %v", r, err)
	}

	// secret data is base64 by definition: a short value decodes too
	r, err = v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: []DecodeLevel{{Line: lineOf(t, d.YAML, "plain:")}}})
	if err != nil || r.Text != "hello" {
		t.Fatalf("plain: %+v %v", r, err)
	}

	// what doesn't decode says why
	for _, tc := range []struct{ line, want string }{
		{"type: Opaque", "type is plain text: nothing to decode"},
		{"kind: Secret", "kind is plain text"},
		{"data:", "data is a map: put the cursor on one of its values"},
	} {
		r, err := v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: []DecodeLevel{{Line: lineOf(t, d.YAML, tc.line)}}})
		if err != nil || !strings.Contains(r.Refused, tc.want) || r.Text != "" {
			t.Errorf("%s: %+v %v, want refused %q", tc.line, r, err, tc.want)
		}
	}
	// a plain-text level can't go deeper
	r, err = v.Decode(DecodeRequest{Key: "s1", Which: "yaml", Levels: []DecodeLevel{{Line: lineOf(t, d.YAML, "plain:")}, {Line: 0}}})
	if err != nil || !strings.Contains(r.Refused, "isn't YAML") {
		t.Fatalf("deeper into text: %+v %v", r, err)
	}
	// JSON stays JSON (a docker config), and goes deeper by its lines
	auth := b64("user:pass")
	v.Apply(source.Event{Type: source.Added, Item: secret("s2", map[string]any{".dockerconfigjson": b64(`{"auths":{"r.io":{"auth":"` + auth + `"}}}`)})}, t0)
	d2, _ := v.Object("s2")
	r, err = v.Decode(DecodeRequest{Key: "s2", Which: "yaml", Levels: []DecodeLevel{{Line: lineOf(t, d2.YAML, ".dockerconfigjson:")}}})
	if err != nil || r.Kind != "json" || r.Language != "json" || !strings.Contains(r.Text, `"auth": "`+auth+`"`) {
		t.Fatalf("json: %+v %v", r, err)
	}
	r, err = v.Decode(DecodeRequest{Key: "s2", Which: "yaml", Levels: append(r.Levels, DecodeLevel{Line: lineOf(t, r.Text, `"auth":`)})})
	if err != nil || r.Text != "user:pass" || !strings.HasSuffix(r.Path, `auths["r.io"].auth`) {
		t.Fatalf("deeper into json: %+v %v", r, err)
	}
	// a request that can't be served is an error
	if _, err := v.Decode(DecodeRequest{Key: "nope", Levels: []DecodeLevel{{}}}); err == nil {
		t.Fatal("unknown object: no error")
	}
}

// The decoded diff: the field in two versions with the same chain; a
// version without it diffs against empty.
func TestDecodeDiff(t *testing.T) {
	v, r := recView(t, true)
	at := func(n int) time.Time { return t0.Add(time.Duration(n) * time.Second) }
	put := func(n int, data map[string]any) {
		typ := source.Modified
		if n == 0 {
			typ = source.Added
		}
		v.Apply(source.Event{Type: typ, Item: r.item(secret("s1", data), at(n))}, at(n))
	}
	v.Apply(source.Event{Type: source.Relist}, t0)
	put(0, map[string]any{"other": b64("x")})
	put(1, map[string]any{"other": b64("x"), "data.yaml.br": b64br(t, "replicas: 1\n")})
	put(2, map[string]any{"other": b64("x"), "data.yaml.br": b64br(t, "replicas: 2\n")})

	d, _ := v.Object("s1")
	req := DecodeRequest{Key: "s1", Which: "norm", Diff: true, Levels: []DecodeLevel{{Line: lineOf(t, d.CurNorm, "data.yaml.br:")}}}
	got, err := v.Decode(req)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "replicas: 2\n" || got.Prev == nil || got.Prev.Text != "replicas: 1\n" || got.Diff == nil || got.Diff.To != 3 {
		t.Fatalf("newest: %+v prev %+v", got, got.Prev)
	}
	// an older version, by the path the first answer resolved
	req.Levels, req.To = got.Levels, 2
	got, err = v.Decode(req)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "replicas: 1\n" || got.Prev == nil || !got.Prev.Absent {
		t.Fatalf("v2: %+v prev %+v", got, got.Prev)
	}
	// the first version: no field there at all, and nothing before it
	req.To = 1
	got, err = v.Decode(req)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Absent || got.Prev != nil {
		t.Fatalf("v1: %+v", got)
	}
}

func TestSplitDocs(t *testing.T) {
	docs := splitDocs("a: 1\n---\nb: 2\nc: 3\n--- # x\nd: 4")
	if len(docs) != 3 || docs[1].start != 2 || docs[1].text != "b: 2\nc: 3" || docs[2].start != 5 {
		t.Fatalf("%+v", docs)
	}
	for _, tc := range []struct{ line, doc, in int }{{0, 0, 0}, {1, -1, 0}, {3, 1, 1}, {4, -1, 0}, {5, 2, 0}} {
		if d, in := docAt(docs, tc.line); d != tc.doc || (d >= 0 && in != tc.in) {
			t.Errorf("line %d: doc %d line %d, want %d %d", tc.line, d, in, tc.doc, tc.in)
		}
	}
}
