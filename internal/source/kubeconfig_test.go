package source

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
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

// A kubeconfig built in memory (a Gardener target's) is a reference too: the
// same one for the same key, its config replaced; its contexts list and
// connect from memory, it has no files.
func TestRegisterConfig(t *testing.T) {
	raw := clientcmdapi.NewConfig()
	raw.Clusters["c"] = &clientcmdapi.Cluster{Server: "https://127.0.0.1:1"}
	raw.AuthInfos["u"] = &clientcmdapi.AuthInfo{}
	raw.Contexts["g/shoot--p--s"] = &clientcmdapi.Context{Cluster: "c", AuthInfo: "u"}
	raw.CurrentContext = "g/shoot--p--s"
	ref := RegisterConfig("shoot:g/p/s", raw)
	if again := RegisterConfig("shoot:g/p/s", raw); again != ref {
		t.Fatalf("same key: %q, %q", ref, again)
	}
	if other := RegisterConfig("shoot:g/p/t", raw); other == ref {
		t.Fatalf("other key: %q", other)
	}
	raw.CurrentContext = "changed after registering"
	if ConfigKey(ref+"/x") != "shoot:g/p/s" || ConfigKey("dev") != "" {
		t.Errorf("ConfigKey: %q", ConfigKey(ref+"/x"))
	}
	if _, files, err := Kubeconfig(ref + "/"); err != nil || len(files) != 0 {
		t.Errorf("Kubeconfig: %v %v", files, err)
	}
	names, cur, _, err := Contexts(JoinCluster(ref, ""))
	if err != nil || cur != "g/shoot--p--s" || !slices.Equal(names, []string{"g/shoot--p--s"}) {
		t.Errorf("Contexts: %v %q %v", names, cur, err)
	}
	for _, cl := range []string{ref + "/g/shoot--p--s", ref + "/"} {
		c, err := Connect(cl)
		if err != nil || c.Context != "g/shoot--p--s" || c.Kubeconfig != ref || c.Config.Host != "https://127.0.0.1:1" {
			t.Errorf("Connect(%q): %+v, %v", cl, c, err)
		}
	}
	if _, err := Connect(ref + "/nope"); err == nil {
		t.Error("unknown context connected")
	}
}
