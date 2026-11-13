package bridge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/gardener"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
)

// Gardener is where gardenctl's config and sessions are, and how gardens
// are looked into (kubewing's own connections).
type Gardener struct {
	Paths  gardener.Paths
	Lookup gardener.Lookup
	// ShellSessions is where local terminals' gardenctl sessions go: gardenctl's
	// sessions directory (Paths.Sessions), a directory of their own in tests.
	ShellSessions string
}

// resolveTimeout bounds resolving a target: the garden's login (a browser
// for OIDC) included.
const resolveTimeout = 3 * time.Minute

// ClusterEntry is a cluster the clusters dialog offers: a kubeconfig's
// context or a Gardener target.
type ClusterEntry struct {
	config.Cluster
	// From: "recent" (clusters.yaml), "gardenctl" (a gardenctl session's
	// target), "match" (a gardenctl pattern matched the text), "garden".
	From string `json:"from"`
	// Name is the context name kubewing gives it (safety rules match on
	// it), as far as known before it's opened.
	Name string      `json:"name,omitempty"`
	Rule safety.Rule `json:"rule"`
	// Disabled says why it can't be opened ("" = it can).
	Disabled string `json:"disabled,omitempty"`
	// Alt is a shoot's other plane (its control plane, or the shoot of a
	// control plane): the dialog lists a shoot once and toggles between them.
	Alt *ClusterEntry `json:"alt,omitempty"`
}

// ClusterList is the clusters dialog's list.
type ClusterList struct {
	// Recent: clusters opened before and gardenctl sessions' targets, the latest first.
	Recent  []ClusterEntry `json:"recent"`
	Gardens []ClusterEntry `json:"gardens"`
	// Errors: gardenctl-v2.yaml can't be read, a pattern doesn't compile.
	Errors []string `json:"errors,omitempty"`
}

// ClusterOpen is where an opened cluster starts, or (Choices) the targets
// to choose from (a shoot name in several projects).
type ClusterOpen struct {
	Cluster   string         `json:"cluster"`
	Namespace string         `json:"namespace,omitempty"`
	Choices   []ClusterEntry `json:"choices,omitempty"`
}

func (s *Service) gardenConfig() (gardener.Config, error) {
	if s.opts.Gardener == nil {
		return gardener.Config{}, nil
	}
	return gardener.LoadConfig(s.opts.Gardener.Paths.Config)
}

// Clusters lists the clusters to pick from: recently opened ones merged
// with gardenctl sessions' targets (at most config.MaxClusters), and the
// gardens of gardenctl-v2.yaml. Read anew on every call; connects nowhere.
func (s *Service) Clusters() ClusterList {
	out := ClusterList{Recent: []ClusterEntry{}, Gardens: []ClusterEntry{}}
	cfg, err := s.gardenConfig()
	if err != nil {
		out.Errors = append(out.Errors, err.Error())
	}
	recent := s.opts.Clusters.List()
	for _, c := range recent {
		out.Recent = append(out.Recent, s.entry(cfg, c, "recent"))
	}
	if s.opts.Gardener != nil {
		for _, st := range gardener.Sessions(s.opts.Gardener.Paths.Sessions) {
			c := targetCluster(st.Target)
			c.Used = st.Set
			if !slices.ContainsFunc(recent, c.Same) {
				out.Recent = append(out.Recent, s.entry(cfg, c, "gardenctl"))
			}
		}
	}
	slices.SortStableFunc(out.Recent, func(a, b ClusterEntry) int { return b.Used.Compare(a.Used) })
	out.Recent = s.pair(cfg, out.Recent)
	if len(out.Recent) > config.MaxClusters {
		out.Recent = out.Recent[:config.MaxClusters]
	}
	for _, g := range cfg.Gardens {
		out.Gardens = append(out.Gardens, s.entry(cfg, config.Cluster{Garden: g.Identity}, "garden"))
	}
	return out
}

// MatchTarget returns the targets gardenctl's patterns make of text (a
// dashboard URL, an API server host, shoot--project--name …). Connects nowhere.
func (s *Service) MatchTarget(text string) ([]ClusterEntry, error) {
	cfg, err := s.gardenConfig()
	if err != nil {
		return nil, err
	}
	ts, err := cfg.Match(text)
	out := []ClusterEntry{}
	for _, t := range ts {
		out = append(out, s.entry(cfg, targetCluster(t), "match"))
	}
	// a broken pattern of one garden doesn't keep the others' matches back
	if len(out) > 0 {
		err = nil
	}
	return s.pair(cfg, out), err
}

// OpenCluster makes an entry a cluster panes can open: a kubeconfig's
// context (registered as a kubeconfig of its own unless it's kubewing's),
// or a Gardener target, looked up in its garden (which may ask to log in).
func (s *Service) OpenCluster(e ClusterEntry) (ClusterOpen, error) {
	if e.Garden == "" {
		return s.openKubeconfig(e.Cluster)
	}
	cfg, err := s.gardenConfig()
	if err != nil {
		return ClusterOpen{}, err
	}
	if s.opts.Gardener == nil || s.opts.Gardener.Lookup == nil {
		return ClusterOpen{}, errors.New("no Gardener support")
	}
	r := gardener.Resolver{Config: cfg, Lookup: s.opts.Gardener.Lookup}
	ctx, cancel := context.WithTimeout(context.Background(), resolveTimeout)
	defer cancel()
	t := gardener.Target{Garden: e.Garden, Project: e.Project, Namespace: e.Namespace, Shoot: e.Shoot, ControlPlane: e.ControlPlane, Seed: e.Seed}
	o, err := r.Resolve(ctx, t)
	var amb *gardener.Ambiguous
	if errors.As(err, &amb) {
		out := ClusterOpen{}
		for _, c := range amb.Choices {
			out.Choices = append(out.Choices, s.entry(cfg, targetCluster(c), "match"))
		}
		out.Choices = s.pair(cfg, out.Choices)
		return out, nil
	}
	if err != nil {
		return ClusterOpen{}, err
	}
	c := targetCluster(o.Target)
	_, c.Context = source.SplitCluster(o.Cluster)
	c.Used = s.opts.Clock.Now()
	_ = s.opts.Clusters.Add(c)
	s.mu.Lock()
	s.opened[openedKey(o.Cluster, o.Namespace, o.Target.ControlPlane)] = o.Target
	if o.Target.ControlPlane {
		// its seed's cluster: ⌘⇧P from any shoot's namespace there finds that shoot,
		// from another namespace (nodes, all namespaces) this one, the last opened there
		s.opened[openedKey(o.Cluster, "", false)] = gardener.Target{Garden: o.Target.Garden, Seed: o.Target.Seed, Project: o.Target.Project, Namespace: o.Target.Namespace, Shoot: o.Target.Shoot}
	}
	if o.Seed.Known {
		s.seeds[o.Target.Garden+"/"+o.Seed.Name] = o.Seed
	}
	if o.Target.Shoot != "" && !o.Target.ControlPlane {
		s.shoots[o.Cluster] = shootInfo{seed: o.Seed.Name, isSeed: o.IsSeed}
	}
	s.mu.Unlock()
	// picked explicitly: the connection is wanted, so ⌘O completes on it before a pane lists anything
	if s.opts.Catalog != nil {
		s.opts.Catalog.Track(o.Cluster)
	}
	return ClusterOpen{Cluster: o.Cluster, Namespace: o.Namespace}, nil
}

// OtherPlane is the shoot of a control plane, or the control plane of a
// shoot, a pane shows (cluster and namespace as its spec has them): a target
// OpenCluster resolved before, opened as one picked in the dialog is. On a
// seed's cluster (a seed opened, or the seed of a control plane opened) a
// shoot's namespace there names the shoot (its technical id).
func (s *Service) OtherPlane(cluster, namespace string) (ClusterOpen, error) {
	s.mu.Lock()
	// a control plane first: its seed's cluster is known by the cluster alone too
	t, ok := s.opened[openedKey(cluster, namespace, true)]
	if !ok {
		t, ok = s.opened[openedKey(cluster, "", false)]
	}
	s.mu.Unlock()
	if !ok {
		// opened otherwise (from a terminal: gardenctl's kubeconfig): what the kubeconfig says
		t, ok = targetOfKubeconfig(cluster)
	}
	if !ok {
		return ClusterOpen{}, errors.New("not a Gardener shoot or control plane: neither opened with ⌘⇧O or ⌘J nor a gardenlogin kubeconfig")
	}
	switch {
	case t.Seed == "" || t.ControlPlane:
		// a shoot, or the control plane remembered for this namespace
		t.ControlPlane = !t.ControlPlane
	default:
		// a seed's cluster: the shoot of the pane's namespace, else of the context's (gardenctl's),
		// else the control plane opened there last
		_, _, ok := gardener.ShootOfNamespace(namespace)
		if gl, isGl := source.GardenloginOf(cluster); !ok && isGl {
			namespace = gl.Namespace
			_, _, ok = gardener.ShootOfNamespace(namespace)
		}
		switch project, shoot, _ := gardener.ShootOfNamespace(namespace); {
		case ok:
			t = gardener.Target{Garden: t.Garden, Project: project, Shoot: shoot}
		case t.Shoot != "":
			t = gardener.Target{Garden: t.Garden, Project: t.Project, Namespace: t.Namespace, Shoot: t.Shoot}
		default:
			return ClusterOpen{}, errors.New("seed " + t.Seed + ": ⌘⇧P switches from a shoot's namespace here (shoot--<project>--<name>) to the shoot")
		}
	}
	t.Seed = ""
	o, err := s.OpenCluster(ClusterEntry{Cluster: targetCluster(t)})
	if err == nil && len(o.Choices) > 0 {
		// the target was resolved before: its project is known
		err = errors.New("shoot " + t.Shoot + " exists in several projects")
	}
	return o, err
}

// targetOfKubeconfig is the Gardener target a cluster kubewing didn't
// resolve is, by its kubeconfig: a gardenlogin context whose namespace is a
// shoot's control plane (gardenctl's control plane kubeconfig) is that
// shoot's seed (a seed target: ⌘⇧P goes to the shoot of the pane's
// namespace), one without a shoot whose own it is; else a context named as
// kubewing names seeds (<garden>/seed--<seed>, a seed's login kubeconfig).
func targetOfKubeconfig(cluster string) (gardener.Target, bool) {
	// kubewing's seeds first: a managed seed's has gardenlogin for its shoot, but is the seed
	_, ctx := source.SplitCluster(cluster)
	if garden, seed, ok := strings.Cut(ctx, "/seed--"); ok && garden != "" && seed != "" && !strings.Contains(seed, "/") {
		return gardener.Target{Garden: garden, Seed: seed}, true
	}
	if gl, ok := source.GardenloginOf(cluster); ok {
		if _, _, cp := gardener.ShootOfNamespace(gl.Namespace); cp {
			return gardener.Target{Garden: gl.Garden, Seed: gl.Shoot}, true
		}
		return gardener.Target{Garden: gl.Garden, Namespace: gl.ShootNamespace, Shoot: gl.Shoot}, true
	}
	return gardener.Target{}, false
}

// openedKey is where a resolved target is found again: a shoot by its
// cluster (its kubeconfig is its own), a control plane by its seed's cluster
// and the shoot's namespace there (control planes on one seed share it).
func openedKey(cluster, namespace string, controlPlane bool) string {
	if !controlPlane {
		return cluster
	}
	return cluster + "\x00" + namespace
}

// ForgetCluster removes a cluster from the recent ones: a shoot with its
// other plane (one line in the dialog).
func (s *Service) ForgetCluster(e ClusterEntry) error {
	if e.Alt != nil {
		if err := s.opts.Clusters.Remove(e.Alt.Cluster); err != nil {
			return err
		}
	}
	return s.opts.Clusters.Remove(e.Cluster)
}

func (s *Service) openKubeconfig(c config.Cluster) (ClusterOpen, error) {
	files := make([]string, 0, len(c.Kubeconfig))
	for _, f := range c.Kubeconfig {
		f = expandHome(f)
		if !filepath.IsAbs(f) {
			return ClusterOpen{}, fmt.Errorf("kubeconfig %s: not an absolute path", f)
		}
		files = append(files, filepath.Clean(f))
	}
	if len(files) == 0 {
		files = source.KubeconfigFiles("", "")
	}
	for _, f := range files {
		if _, err := os.Stat(f); err != nil {
			return ClusterOpen{}, fmt.Errorf("kubeconfig %s: %w", f, err)
		}
	}
	ref := source.RegisterKubeconfig(files)
	names, cur, ns, err := source.Contexts(source.JoinCluster(ref, ""))
	if err != nil {
		return ClusterOpen{}, err
	}
	ctx := c.Context
	if ctx == "" {
		ctx = cur
	}
	if ctx == "" {
		return ClusterOpen{}, fmt.Errorf("kubeconfig %s has no current context", strings.Join(files, ", "))
	}
	if !slices.Contains(names, ctx) {
		return ClusterOpen{}, fmt.Errorf("no context %q in %s", ctx, strings.Join(files, ", "))
	}
	// recorded once a pane opened on it (OpenPipeline)
	return ClusterOpen{Cluster: source.JoinCluster(ref, ctx), Namespace: ns[ctx]}, nil
}

// recordCluster notes a kubeconfig context a pane opened on as recently
// used. Gardener targets are noted when they're resolved (OpenCluster):
// their kubeconfigs are built in memory and aren't one to open again.
func (s *Service) recordCluster(cluster, ctxName string) {
	if ctxName == "" || source.ConfigKey(cluster) != "" {
		return
	}
	_, files, err := source.Kubeconfig(cluster)
	if err != nil || len(files) == 0 {
		return
	}
	_ = s.opts.Clusters.Add(config.Cluster{Kubeconfig: files, Context: ctxName, Used: s.opts.Clock.Now()})
}

// entry describes c for the dialog: its name (as far as known), safety
// rule, and why it can't be opened.
func (s *Service) entry(cfg gardener.Config, c config.Cluster, from string) ClusterEntry {
	e := ClusterEntry{Cluster: c, From: from, Name: c.Context}
	if c.Garden != "" {
		g, ok := cfg.Garden(c.Garden)
		switch {
		case !ok:
			e.Disabled = "garden " + c.Garden + " isn't in gardenctl-v2.yaml"
		default:
			e.Disabled = g.Problem()
		}
		if e.Name == "" {
			e.Name = predictedName(c)
		}
	} else if len(c.Kubeconfig) > 0 {
		for _, f := range c.Kubeconfig {
			if _, err := os.Stat(f); err != nil {
				e.Disabled = "kubeconfig " + f + " not found"
				break
			}
		}
	}
	if e.Name != "" {
		e.Rule = s.guard.Rule(e.Name)
	}
	return e
}

// pair makes a shoot and its control plane one entry, kept at the earlier
// one's place (the list's order: the latest first), the other one its Alt.
// A shoot whose other plane isn't in the list gets it made up (never used,
// from the same source), so the dialog can toggle on every shoot.
func (s *Service) pair(cfg gardener.Config, list []ClusterEntry) []ClusterEntry {
	out := make([]ClusterEntry, 0, len(list))
	for _, e := range list {
		if e.Shoot == "" {
			out = append(out, e)
			continue
		}
		other := e.Cluster
		other.ControlPlane = !other.ControlPlane
		if i := slices.IndexFunc(out, func(o ClusterEntry) bool { return o.Alt == nil && o.Cluster.Same(other) }); i >= 0 {
			out[i].Alt = &e
			continue
		}
		out = append(out, e)
	}
	for i, e := range out {
		if e.Shoot != "" && e.Alt == nil {
			other := e.Cluster
			other.ControlPlane, other.Used = !other.ControlPlane, time.Time{}
			alt := s.entry(cfg, other, e.From)
			out[i].Alt = &alt
		}
	}
	return out
}

// predictedName is the context name a target will get, before it's
// resolved: a shoot's technical id is shoot--<project>--<name> (for all
// but very old shoots); a control plane's seed isn't known yet.
func predictedName(c config.Cluster) string {
	switch {
	case c.Shoot == "" && c.Seed != "":
		return c.Garden + "/seed--" + c.Seed
	case c.Shoot == "":
		return c.Garden
	case c.ControlPlane:
		return ""
	}
	p := gardener.Target{Project: c.Project, Namespace: c.Namespace}.ProjectName()
	if p == "" {
		return ""
	}
	return c.Garden + "/shoot--" + p + "--" + c.Shoot
}

// targetCluster is a target as remembered: a control plane's seed is
// looked up anew, only a seed target keeps it.
func targetCluster(t gardener.Target) config.Cluster {
	c := config.Cluster{Garden: t.Garden, Project: t.Project, Namespace: t.Namespace, Shoot: t.Shoot, ControlPlane: t.ControlPlane}
	if t.Shoot == "" {
		c.Seed = t.Seed
	}
	return c
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[1:])
		}
	}
	return p
}
