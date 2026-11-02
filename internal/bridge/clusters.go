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
		e := s.entry(cfg, targetCluster(t), "match")
		if t.Seed != "" && t.Shoot == "" && e.Disabled == "" {
			e.Disabled = "seed targets aren't supported yet"
		}
		out = append(out, e)
	}
	// a broken pattern of one garden doesn't keep the others' matches back
	if len(out) > 0 {
		err = nil
	}
	return out, err
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
	t := gardener.Target{Garden: e.Garden, Project: e.Project, Namespace: e.Namespace, Shoot: e.Shoot, ControlPlane: e.ControlPlane}
	o, err := r.Resolve(ctx, t)
	var amb *gardener.Ambiguous
	if errors.As(err, &amb) {
		out := ClusterOpen{}
		for _, c := range amb.Choices {
			out.Choices = append(out.Choices, s.entry(cfg, targetCluster(c), "match"))
		}
		return out, nil
	}
	if err != nil {
		return ClusterOpen{}, err
	}
	c := targetCluster(o.Target)
	_, c.Context = source.SplitCluster(o.Cluster)
	c.Used = s.opts.Clock.Now()
	_ = s.opts.Clusters.Add(c)
	return ClusterOpen{Cluster: o.Cluster, Namespace: o.Namespace}, nil
}

// ForgetCluster removes a cluster from the recent ones.
func (s *Service) ForgetCluster(e ClusterEntry) error {
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

// predictedName is the context name a target will get, before it's
// resolved: a shoot's technical id is shoot--<project>--<name> (for all
// but very old shoots); a control plane's seed isn't known yet.
func predictedName(c config.Cluster) string {
	switch {
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

func targetCluster(t gardener.Target) config.Cluster {
	return config.Cluster{Garden: t.Garden, Project: t.Project, Namespace: t.Namespace, Shoot: t.Shoot, ControlPlane: t.ControlPlane}
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[1:])
		}
	}
	return p
}
