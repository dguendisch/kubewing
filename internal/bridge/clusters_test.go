package bridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/gardener"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
)

type fixedClock struct{ t time.Time }

func (c fixedClock) Now() time.Time { return c.t }

// The clusters dialog's backend on the test garden (testdata/garden, its
// objects in the tapes): a dashboard URL matches, resolves to a shoot
// kubeconfig of its own and is remembered; a gardenctl session's target is
// listed until it is opened.
func TestClusters(t *testing.T) {
	root, _ := filepath.Abs("../..")
	t.Chdir(root) // the test garden's kubeconfig path is relative to the repository
	op := &tape.Opener{Tapes: map[string]*tape.Tape{}}
	for _, n := range []string{"garden-shoots", "garden-projects", "garden-cas", "e2e-static"} {
		tp, err := tape.Load("testdata/tapes/" + n + ".yaml")
		if err != nil {
			t.Fatal(err)
		}
		op.Tapes[n] = tp
		op.Tapes[tp.Pipeline.Source.Resource] = tp
	}
	cfg := config.Defaults("")
	cfg.Config.Contexts = []config.ContextRule{{Match: "tape-garden/*", Label: "TG", ReadOnly: true}}
	at := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	state := t.TempDir()
	svc := New(source.NewRegistry(op), &eventLog{events: map[string][]any{}}, Options{
		Actor: op, Config: &cfg, Clock: fixedClock{at},
		Clusters: config.OpenClusters(state),
		Gardener: &Gardener{Paths: gardener.Paths{Config: "testdata/garden/gardenctl-v2.yaml", Sessions: "testdata/garden/sessions"}, Lookup: op},
	})

	l := svc.Clusters()
	if len(l.Errors) != 0 || len(l.Gardens) != 2 || l.Gardens[1].Disabled == "" {
		t.Fatalf("gardens: %+v %v", l.Gardens, l.Errors)
	}
	if len(l.Recent) != 1 || l.Recent[0].From != "gardenctl" || l.Recent[0].Shoot != "old" || l.Recent[0].Name != "tape-garden/shoot--foo--old" || l.Recent[0].Rule.Label != "TG" {
		t.Fatalf("recent: %+v", l.Recent)
	}
	// a shoot is one entry: its control plane, never used, is its alt
	if a := l.Recent[0].Alt; a == nil || !a.ControlPlane || a.Shoot != "old" || !a.Used.IsZero() || a.From != "gardenctl" {
		t.Fatalf("recent alt: %+v", a)
	}

	m, err := svc.MatchTarget("https://dashboard.tape.example/namespace/garden-foo/shoots/bar")
	if err != nil || len(m) != 1 || m[0].Name != "tape-garden/shoot--foo--bar" || m[0].Alt == nil || !m[0].Alt.ControlPlane || m[0].Rule.Label != "TG" {
		t.Fatalf("match: %+v %v", m, err)
	}
	if m, _ := svc.MatchTarget("missing/x"); len(m) != 1 || !strings.Contains(m[0].Disabled, "not found") || m[0].Alt == nil || m[0].Alt.Disabled == "" {
		t.Errorf("missing kubeconfig: %+v", m)
	}
	o, err := svc.OpenCluster(m[0])
	if err != nil {
		t.Fatal(err)
	}
	if ref, ctx := source.SplitCluster(o.Cluster); ref == "" || ctx != "tape-garden/shoot--foo--bar" || o.Namespace != "" {
		t.Fatalf("opened: %+v", o)
	}
	l = svc.Clusters()
	if len(l.Recent) != 2 || l.Recent[0].From != "recent" || l.Recent[0].Shoot != "bar" || l.Recent[0].Name != "tape-garden/shoot--foo--bar" || !l.Recent[0].Used.Equal(at) {
		t.Fatalf("recorded: %+v", l.Recent)
	}
	if b, _ := os.ReadFile(filepath.Join(state, config.ClustersFile)); !strings.Contains(string(b), "shoot: bar") {
		t.Errorf("clusters.yaml: %s", b)
	}
	// a shoot's control plane: its seed isn't in the tapes
	if _, err := svc.OpenCluster(*m[0].Alt); err == nil || !strings.Contains(err.Error(), "soil") {
		t.Errorf("control plane: %v", err)
	}
	// ⌘⇧P on the shoot's pane: its control plane, resolved as a pick (the seed isn't in the tapes either)
	if _, err := svc.OtherPlane(o.Cluster, "kube-system"); err == nil || !strings.Contains(err.Error(), "soil") {
		t.Errorf("other plane: %v", err)
	}
	if _, err := svc.OtherPlane("@99/elsewhere", ""); err == nil || !strings.Contains(err.Error(), "⌘P") {
		t.Errorf("other plane of a cluster ⌘P didn't open: %v", err)
	}
	// both planes opened: one entry at the latest one's place, the other its alt; forgotten together
	_ = svc.opts.Clusters.Add(config.Cluster{Garden: "tape-garden", Namespace: "garden-foo", Shoot: "bar", ControlPlane: true, Used: at.Add(-time.Hour)})
	l = svc.Clusters()
	if len(l.Recent) != 2 || l.Recent[0].ControlPlane || l.Recent[0].Alt == nil || !l.Recent[0].Alt.ControlPlane || !l.Recent[0].Alt.Used.Equal(at.Add(-time.Hour)) {
		t.Fatalf("paired: %+v", l.Recent)
	}
	if err := svc.ForgetCluster(l.Recent[0]); err != nil || len(svc.Clusters().Recent) != 1 || len(svc.opts.Clusters.List()) != 0 {
		t.Errorf("forget: %v %+v", err, svc.Clusters().Recent)
	}

	// a kubeconfig file: registered, remembered once a pane opened on it
	kc := filepath.Join(t.TempDir(), "kc")
	if err := os.WriteFile(kc, []byte("apiVersion: v1\nkind: Config\ncurrent-context: a\nclusters: [{name: c, cluster: {server: \"https://127.0.0.1:1\"}}]\nusers: [{name: u, user: {}}]\ncontexts: [{name: a, context: {cluster: c, user: u, namespace: ns-a}}]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, err = svc.OpenCluster(ClusterEntry{Cluster: config.Cluster{Kubeconfig: []string{kc}}})
	if err != nil || !strings.HasSuffix(o.Cluster, "/a") || o.Namespace != "ns-a" {
		t.Fatalf("kubeconfig: %+v %v", o, err)
	}
	svc.recordCluster(o.Cluster, "a")
	if r := svc.Clusters().Recent[0]; r.Context != "a" || len(r.Kubeconfig) != 1 || r.Kubeconfig[0] != kc {
		t.Errorf("kubeconfig recorded: %+v", r)
	}
	if _, err := svc.OpenCluster(ClusterEntry{Cluster: config.Cluster{Kubeconfig: []string{kc}, Context: "nope"}}); err == nil {
		t.Error("unknown context opened")
	}
	if _, err := svc.OpenCluster(ClusterEntry{Cluster: config.Cluster{Kubeconfig: []string{"relative"}}}); err == nil {
		t.Error("relative path opened")
	}
}
