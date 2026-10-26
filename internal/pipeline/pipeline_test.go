package pipeline

import (
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestParseRoundTrip(t *testing.T) {
	in := `
source:
  cluster: kind-kind
  resource: pods
  namespace: kube-system
  labelSelector: app=etcd
stages:
  - filter: 'o.status.phase != "Running"'
  - grep: oom
  - hideHealthy: true
  - sort: [-restarts, name]
render:
  columns:
    - {name: NAME, path: metadata.name}
    - {name: RESTARTS, expr: 'o.status.containerStatuses.map(c, c.restartCount).sum()', type: number}
    - {name: AGE, path: metadata.creationTimestamp, type: age}
`
	p, err := Parse([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	if d := cmp.Diff(p, p2); d != "" {
		t.Fatalf("round trip mismatch (-want +got):\n%s", d)
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]string{
		"missing resource": `source: {namespace: x}`,
		"unknown field":    `source: {resource: pods, bogus: 1}`,
		"empty stage":      "source: {resource: pods}\nstages: [{}]",
		"two kinds":        "source: {resource: pods}\nstages: [{grep: a, filter: 'true'}]",
		"hide and grep":    "source: {resource: pods}\nstages: [{grep: a, hideHealthy: true}]",
		"hide false":       "source: {resource: pods}\nstages: [{hideHealthy: false}]",
		"path and expr":    "source: {resource: pods}\nrender: {columns: [{name: A, path: a, expr: b}]}",
		"bad type":         "source: {resource: pods}\nrender: {columns: [{name: A, path: a, type: wat}]}",
		"duplicate column": "source: {resource: pods}\nrender: {columns: [{name: A, path: a}, {name: a, path: b}]}",
		"typed server col": "source: {resource: pods}\nrender: {columns: [{name: IP, type: number}]}",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(in)); err == nil {
				t.Fatalf("expected error for %q", strings.TrimSpace(in))
			}
		})
	}
}

func TestServerColumnRef(t *testing.T) {
	p, err := Parse([]byte("source: {resource: pods}\nrender: {columns: [{name: IP}, {name: X, path: a}]}"))
	if err != nil {
		t.Fatal(err)
	}
	if !p.Render.Columns[0].Server() || p.Render.Columns[1].Server() {
		t.Fatalf("Server(): %+v", p.Render.Columns)
	}
}
