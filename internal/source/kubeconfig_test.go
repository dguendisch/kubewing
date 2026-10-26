package source

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func writeKubeconfig(t *testing.T, path, current string, contexts ...string) {
	t.Helper()
	s := "apiVersion: v1\nkind: Config\ncurrent-context: " + current + "\nclusters: [{name: c, cluster: {server: \"https://127.0.0.1:1\"}}]\nusers: [{name: u, user: {}}]\ncontexts:\n"
	for _, c := range contexts {
		s += "- {name: " + c + ", context: {cluster: c, user: u, namespace: ns-" + c + "}}\n"
	}
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

// $KUBECONFIG as kubectl reads it: relative to the terminal's directory,
// repeats once, unset or empty is ~/.kube/config.
func TestKubeconfigFiles(t *testing.T) {
	got := KubeconfigFiles("a:/b/c::a:./d/../e", "/home/x")
	if want := []string{"/home/x/a", "/b/c", "/home/x/e"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if got := KubeconfigFiles("", "/home/x"); len(got) != 1 || filepath.Base(got[0]) != "config" {
		t.Errorf("unset: %v", got)
	}
}

func TestSplitCluster(t *testing.T) {
	for in, want := range map[string][2]string{
		"":          {"", ""},
		"dev":       {"", "dev"},
		"@1/dev":    {"@1", "dev"},
		"@12/":      {"@12", ""},
		"@1/a/b":    {"@1", "a/b"}, // context names may hold slashes
		"@x/dev":    {"", "@x/dev"},
		"@/dev":     {"", "@/dev"},
		"arn:a/b@c": {"", "arn:a/b@c"},
	} {
		ref, ctx := SplitCluster(in)
		if ref != want[0] || ctx != want[1] {
			t.Errorf("SplitCluster(%q) = %q, %q; want %q, %q", in, ref, ctx, want[0], want[1])
		}
		if want[0] != "" || in != "" {
			if back := JoinCluster(ref, ctx); back != in {
				t.Errorf("JoinCluster(SplitCluster(%q)) = %q", in, back)
			}
		}
	}
}

// Another terminal's kubeconfig gets a reference of its own (the same one
// again for the same files); its contexts are listed and connected from its
// files, not kubewing's $KUBECONFIG; kubewing's own files are no reference.
func TestRegisterKubeconfig(t *testing.T) {
	dir := t.TempDir()
	own, other := filepath.Join(dir, "own"), filepath.Join(dir, "other")
	writeKubeconfig(t, own, "a", "a")
	writeKubeconfig(t, other, "garden", "garden", "shoot")
	t.Setenv("KUBECONFIG", own)

	if ref := RegisterKubeconfig([]string{own}); ref != "" {
		t.Errorf("own kubeconfig: %q", ref)
	}
	ref := RegisterKubeconfig([]string{other})
	if ref == "" || RegisterKubeconfig([]string{other}) != ref {
		t.Fatalf("other kubeconfig: %q, again %q", ref, RegisterKubeconfig([]string{other}))
	}
	if _, files, err := Kubeconfig(ref + "/shoot"); err != nil || !slices.Equal(files, []string{other}) {
		t.Errorf("Kubeconfig: %v, %v", files, err)
	}
	names, cur, ns, err := Contexts(JoinCluster(ref, ""))
	slices.Sort(names)
	if err != nil || cur != "garden" || !slices.Equal(names, []string{"garden", "shoot"}) || ns["shoot"] != "ns-shoot" {
		t.Errorf("Contexts: %v %q %v %v", names, cur, ns, err)
	}
	c, err := Connect(ref + "/shoot")
	if err != nil || c.Context != "shoot" || c.Kubeconfig != ref {
		t.Fatalf("Connect: %+v, %v", c, err)
	}
	if !c.is(ref+"/shoot") || c.is("shoot") || c.is(ref+"/") {
		t.Error("is: a connection must match its own kubeconfig's context by name only")
	}
	if c, err := Connect(JoinCluster(ref, "")); err != nil || c.Context != "garden" {
		t.Errorf("current context: %+v, %v", c, err)
	}
	if _, err := Connect("@999/x"); err == nil {
		t.Error("unknown reference connected")
	}
}
