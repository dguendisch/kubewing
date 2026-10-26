package app

import (
	"os"
	"path/filepath"
	"testing"
)

// One kubewing per config directory: the same directory however it's
// written, a different one is a kubewing of its own.
func TestInstanceID(t *testing.T) {
	dir := t.TempDir()
	id := InstanceID(dir)
	if got := InstanceID(dir + "/"); got != id {
		t.Errorf("trailing slash: %s, want %s", got, id)
	}
	if got := InstanceID(filepath.Join(dir, "x", "..")); got != id {
		t.Errorf("x/..: %s, want %s", got, id)
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if rel, err := filepath.Rel(wd, dir); err == nil {
		if got := InstanceID(rel); got != id {
			t.Errorf("relative %s: %s, want %s", rel, got, id)
		}
	}
	if InstanceID(filepath.Join(dir, "other")) == id {
		t.Error("another config directory shares the instance")
	}
	if InstanceID("") == id {
		t.Error("no config directory shares the instance")
	}
}

// A launch's tab starts at its terminal's current context and namespace,
// from that terminal's kubeconfig; with kubewing's own, a plain context name.
func TestResolveLaunch(t *testing.T) {
	dir := t.TempDir()
	own, other := filepath.Join(dir, "own"), filepath.Join(dir, "other")
	write := func(path, cur, ns string) {
		s := "apiVersion: v1\nkind: Config\ncurrent-context: " + cur + "\nclusters: [{name: c, cluster: {server: \"https://127.0.0.1:1\"}}]\nusers: [{name: u, user: {}}]\ncontexts:\n- {name: " + cur + ", context: {cluster: c, user: u, namespace: " + ns + "}}\n"
		if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(own, "local", "default")
	write(other, "shoot--p--s", "kube-system")
	t.Setenv("KUBECONFIG", own)

	if l := ResolveLaunch(own, true, "/"); l.Cluster != "local" || l.Namespace != "default" || l.Error != "" {
		t.Errorf("own kubeconfig: %+v", l)
	}
	l := ResolveLaunch("other", true, dir) // relative to the terminal's directory
	if l.Cluster == "" || l.Cluster[0] != '@' || l.Namespace != "kube-system" || l.Error != "" {
		t.Fatalf("other kubeconfig: %+v", l)
	}
	list, err := KubeContexts(l.Cluster)
	if err != nil || list.Current != l.Cluster || len(list.Contexts) != 1 || list.Contexts[0] != l.Cluster || list.Namespaces[l.Cluster] != "kube-system" || len(list.Kubeconfig) != 1 {
		t.Errorf("KubeContexts(%s): %+v, %v", l.Cluster, list, err)
	}
	if l := ResolveLaunch(filepath.Join(dir, "missing"), true, "/"); l.Error == "" {
		t.Errorf("unreadable kubeconfig: %+v", l)
	}
}

// Launches on one config directory share one key, created once (0600).
func TestInstanceKey(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "kw")
	a, err := instanceKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := instanceKey(dir)
	if err != nil || a != b || a == ([32]byte{}) {
		t.Errorf("second read: %x vs %x, %v", b, a, err)
	}
	fi, err := os.Stat(filepath.Join(dir, KeyFile))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("key file: %v, %v", fi, err)
	}
	if _, err := instanceKey(""); err == nil {
		t.Error("no config directory: a key anyway")
	}
}
