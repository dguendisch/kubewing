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

// ⌘J's clusters: a shoot row of a garden ⌘P opened leads to the shoot and
// its control plane, a seed row to the seed (a managed one: its shoot's
// kubeconfig, which is also the control planes' connection there), a managed
// seed row also to its shoot's control plane. Rows of other clusters and
// kinds have none.
func TestClusterJumps(t *testing.T) {
	root, _ := filepath.Abs("../..")
	t.Chdir(root)
	op := &tape.Opener{Tapes: map[string]*tape.Tape{}}
	for _, n := range []string{"garden-shoots", "garden-projects", "garden-cas", "garden-seeds", "garden-managedseeds", "e2e-static"} {
		tp, err := tape.Load("testdata/tapes/" + n + ".yaml")
		if err != nil {
			t.Fatal(err)
		}
		op.Tapes[n] = tp
		op.Tapes[tp.Pipeline.Source.Resource] = tp
	}
	cfg := config.Defaults("")
	cfg.Config.Contexts = []config.ContextRule{{Match: "tape-garden/*", Label: "TG"}}
	svc := New(source.NewRegistry(op), &eventLog{events: map[string][]any{}}, Options{
		Actor: op, Config: &cfg, Clock: fixedClock{time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)},
		Clusters: config.OpenClusters(""),
		Gardener: &Gardener{Paths: gardener.Paths{Config: "testdata/garden/gardenctl-v2.yaml"}, Lookup: op},
	})
	g, err := svc.OpenCluster(ClusterEntry{Cluster: config.Cluster{Garden: "tape-garden"}})
	if err != nil {
		t.Fatal(err)
	}
	jumps := func(resource, key string, n int) []ClusterJump {
		t.Helper()
		res := openSynced(t, svc, "source: {cluster: \""+g.Cluster+"\", resource: "+resource+"}", n)
		rel, err := svc.Relations(res.Pane, key)
		if err != nil {
			t.Fatal(err)
		}
		return rel.Clusters
	}

	shoot := jumps("shoots", "shoot-baz", 3)
	if len(shoot) != 2 || shoot[0].Label != "shoot baz" || shoot[0].Entry.Name != "tape-garden/shoot--foo--baz" || shoot[0].Entry.Rule.Label != "TG" || shoot[0].Entry.From != "jump" ||
		shoot[1].Label != "control plane of baz" || !shoot[1].Entry.ControlPlane || shoot[1].Entry.Namespace != "garden-foo" {
		t.Fatalf("shoot: %+v", shoot)
	}
	cp, err := svc.OpenCluster(shoot[1].Entry)
	if _, ctx := source.SplitCluster(cp.Cluster); err != nil || ctx != "tape-garden/seed--loam" || cp.Namespace != "shoot--foo--baz" {
		t.Fatalf("control plane: %+v %v", cp, err)
	}
	// ⌘⇧P works on what ⌘J opened, as on a ⌘P pick
	if o, err := svc.OtherPlane(cp.Cluster, cp.Namespace); err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/shoot--foo--baz") {
		t.Errorf("other plane: %+v %v", o, err)
	}
	// the control plane's pane moved to another shoot's namespace on the seed: that shoot
	if _, err := svc.OtherPlane(cp.Cluster, "shoot--foo--bar"); err != nil {
		t.Errorf("other plane of another namespace: %v", err)
	}
	// no shoot's namespace (nodes, all namespaces): the control plane opened there last
	for _, ns := range []string{"", "kube-system"} {
		if o, err := svc.OtherPlane(cp.Cluster, ns); err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/shoot--foo--baz") {
			t.Errorf("other plane in %q: %+v %v", ns, o, err)
		}
	}

	seed := jumps("seeds", "seed-loam", 2)
	if len(seed) != 1 || seed[0].Label != "seed loam" || seed[0].Entry.Seed != "loam" || seed[0].Entry.Name != "tape-garden/seed--loam" {
		t.Fatalf("seed: %+v", seed)
	}
	o, err := svc.OpenCluster(seed[0].Entry)
	if err != nil || o.Cluster != cp.Cluster || o.Namespace != "" {
		t.Fatalf("seed opened: %+v %v (control plane %s)", o, err, cp.Cluster)
	}
	// remembered, and ⌘P lists it by its name
	if l := svc.Clusters(); len(l.Recent) == 0 || l.Recent[0].Seed != "loam" || l.Recent[0].Name != "tape-garden/seed--loam" {
		t.Errorf("recent: %+v", l.Recent)
	}
	// on a seed's cluster, a shoot's namespace names its shoot; other namespaces none
	if _, err := svc.OtherPlane(o.Cluster, ""); err == nil || !strings.Contains(err.Error(), "seed loam") {
		t.Errorf("other plane of a seed: %v", err)
	}
	if o, err := svc.OtherPlane(o.Cluster, "shoot--foo--baz"); err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/shoot--foo--baz") {
		t.Errorf("other plane on the seed's cluster: %+v %v", o, err)
	}
	if _, err := svc.OpenCluster(jumps("seeds", "seed-soil", 2)[0].Entry); err == nil || !strings.Contains(err.Error(), "no login secret") {
		t.Errorf("seed soil: %v", err)
	}

	ms := jumps("managedseeds", "ms-loam", 1)
	if len(ms) != 2 || ms[0].Entry.Seed != "loam" || ms[1].Label != "control plane of shoot loam" || ms[1].Entry.Shoot != "loam" || ms[1].Entry.Namespace != "garden" || !ms[1].Entry.ControlPlane {
		t.Fatalf("managed seed: %+v", ms)
	}

	// not a garden: nothing (tape's own cluster), nor other kinds
	res := openSynced(t, svc, "source: {resource: shoots}", 3)
	if rel, _ := svc.Relations(res.Pane, "shoot-baz"); rel.Clusters != nil {
		t.Errorf("not a garden: %+v", rel.Clusters)
	}
	res = openSynced(t, svc, "source: {cluster: \""+g.Cluster+"\", resource: projects}", 1)
	if rel, _ := svc.Relations(res.Pane, "project-foo"); rel.Clusters != nil {
		t.Errorf("a project: %+v", rel.Clusters)
	}
}

func TestSameServer(t *testing.T) {
	for _, c := range [][2]string{{"https://api.x", "https://API.x/"}, {"https://api.x:443", "https://api.x"}} {
		if !sameServer(c[0], c[1]) {
			t.Errorf("%s ≠ %s", c[0], c[1])
		}
	}
	if sameServer("https://api.x", "https://api.y") {
		t.Error("api.x = api.y")
	}
}

// ⌘⇧P on clusters kubewing didn't resolve (a terminal's gardenctl
// kubeconfig, handed over at launch): the kubeconfig says what it is. A
// control plane's context (gardenlogin for the seed's shoot, the shoot's
// namespace) goes to the shoot of the pane's namespace, else the context's;
// a shoot's context to its control plane.
func TestOtherPlaneFromKubeconfig(t *testing.T) {
	root, _ := filepath.Abs("../..")
	t.Chdir(root)
	op := &tape.Opener{Tapes: map[string]*tape.Tape{}}
	for _, n := range []string{"garden-shoots", "garden-projects", "garden-cas", "garden-managedseeds", "e2e-static"} {
		tp, err := tape.Load("testdata/tapes/" + n + ".yaml")
		if err != nil {
			t.Fatal(err)
		}
		op.Tapes[n] = tp
		op.Tapes[tp.Pipeline.Source.Resource] = tp
	}
	cfg := config.Defaults("")
	svc := New(source.NewRegistry(op), &eventLog{events: map[string][]any{}}, Options{
		Actor: op, Config: &cfg, Clock: fixedClock{time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)},
		Clusters: config.OpenClusters(""),
		Gardener: &Gardener{Paths: gardener.Paths{Config: "testdata/garden/gardenctl-v2.yaml"}, Lookup: op},
	})
	// as gardenctl writes them: gardenlogin with the cluster extension
	kubeconfig := func(ctx, ns, shootNs, shoot string) string {
		kc := filepath.Join(t.TempDir(), "kubeconfig.yaml")
		nsLine := ""
		if ns != "" {
			nsLine = ", namespace: " + ns
		}
		body := `apiVersion: v1
kind: Config
current-context: ` + ctx + `
clusters:
- name: c
  cluster:
    server: https://api.example
    extensions:
    - name: client.authentication.k8s.io/exec
      extension: {shootRef: {namespace: ` + shootNs + `, name: ` + shoot + `}, gardenClusterIdentity: tape-garden}
users: [{name: u, user: {exec: {command: kubectl-gardenlogin, args: [get-client-certificate], apiVersion: client.authentication.k8s.io/v1, provideClusterInfo: true}}}]
contexts: [{name: ` + ctx + `, context: {cluster: c, user: u` + nsLine + `}}]
`
		if err := os.WriteFile(kc, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return source.JoinCluster(source.RegisterKubeconfig([]string{kc}), ctx)
	}

	// in any namespace (the seed's kube-system, all, a cluster-scoped list): the context's is the shoot's
	cp := kubeconfig("garden--loam-external", "shoot--foo--baz", "garden", "loam")
	for _, ns := range []string{"shoot--foo--baz", "", "kube-system"} {
		o, err := svc.OtherPlane(cp, ns)
		if err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/shoot--foo--baz") {
			t.Errorf("control plane in %q: %+v %v", ns, o, err)
		}
	}

	shoot := kubeconfig("shoot--foo--baz", "", "garden-foo", "baz")
	if o, err := svc.OtherPlane(shoot, "kube-system"); err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/seed--loam") || o.Namespace != "shoot--foo--baz" {
		t.Errorf("shoot: %+v %v", o, err)
	}

	// a seed by kubewing's name for it (a login secret's kubeconfig has no gardenlogin)
	plain := filepath.Join(t.TempDir(), "kc")
	if err := os.WriteFile(plain, []byte("apiVersion: v1\nkind: Config\ncurrent-context: tape-garden/seed--soil\nclusters: [{name: c, cluster: {server: \"https://127.0.0.1:1\"}}]\nusers: [{name: u, user: {}}]\ncontexts: [{name: tape-garden/seed--soil, context: {cluster: c, user: u}}, {name: other, context: {cluster: c, user: u}}]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ref := source.RegisterKubeconfig([]string{plain})
	if o, err := svc.OtherPlane(source.JoinCluster(ref, "tape-garden/seed--soil"), "shoot--foo--bar"); err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/shoot--foo--bar") {
		t.Errorf("seed by name: %+v %v", o, err)
	}
	if _, err := svc.OtherPlane(source.JoinCluster(ref, "tape-garden/seed--soil"), "kube-system"); err == nil || !strings.Contains(err.Error(), "shoot's namespace") {
		t.Errorf("seed, no shoot's namespace: %v", err)
	}
	// a managed seed as kubewing builds it: gardenlogin for its shoot garden/loam, named for the seed
	ms := kubeconfig("tape-garden/seed--loam", "", "garden", "loam")
	if o, err := svc.OtherPlane(ms, "shoot--foo--baz"); err != nil || !strings.HasSuffix(o.Cluster, "/tape-garden/shoot--foo--baz") {
		t.Errorf("managed seed by name: %+v %v", o, err)
	}
	if _, err := svc.OtherPlane(source.JoinCluster(ref, "other"), "shoot--foo--bar"); err == nil || !strings.Contains(err.Error(), "gardenlogin") {
		t.Errorf("not Gardener: %v", err)
	}
}
