package source

import (
	"os"
	"path/filepath"
	"testing"
)

func TestContextsNamespaces(t *testing.T) {
	kc := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(kc, []byte(`apiVersion: v1
kind: Config
current-context: dev
clusters: [{name: c, cluster: {server: "https://127.0.0.1:1"}}]
users: [{name: u, user: {}}]
contexts:
- {name: dev, context: {cluster: c, user: u, namespace: shoot--foo}}
- {name: all, context: {cluster: c, user: u}}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", kc)
	names, cur, ns, err := Contexts("")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || cur != "dev" {
		t.Fatalf("names=%v current=%q", names, cur)
	}
	if len(ns) != 1 || ns["dev"] != "shoot--foo" {
		t.Fatalf("namespaces = %v", ns)
	}
}
