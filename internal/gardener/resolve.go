package gardener

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"

	"github.com/dguendisch/kubewing/internal/source"
)

// Lookup reads objects of a cluster (a garden's), by resource name.
type Lookup interface {
	GetObject(ctx context.Context, cluster, resource, namespace, name string) (*unstructured.Unstructured, error)
	ListObjects(ctx context.Context, cluster, resource, namespace, fieldSel string) ([]*unstructured.Unstructured, error)
}

// Resource names of Gardener's API, qualified (a seed's own API may serve
// other "projects" or "shoots").
const (
	shoots       = "shoots.core.gardener.cloud"
	projects     = "projects.core.gardener.cloud"
	managedSeeds = "managedseeds.seedmanagement.gardener.cloud"
)

// Opened is a resolved target: a kubewing cluster (an "@n/<context>"
// reference to a kubeconfig built in memory) and the namespace to start in
// ("" = all).
type Opened struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace,omitempty"`
	// Target is what was resolved, completed (project, namespace, shoot's seed).
	Target Target `json:"target"`
	// Seed is the seed it runs on (a shoot, a control plane) or is (a seed),
	// as far as resolving learned it: a shoot's only by name.
	Seed Seed `json:"seed"`
	// IsSeed: a shoot that is a managed seed's (project garden), that seed.
	IsSeed string `json:"isSeed,omitempty"`
}

// Seed is what resolving learned of a seed: whether it's a managed seed (a
// shoot of project garden, whose control plane runs on another seed) or an
// unmanaged one (registered with a kubeconfig of its own). Looked up only
// where opening needs it anyway (a seed's or control plane's connection).
type Seed struct {
	Name string `json:"name,omitempty"`
	// Known: Managed was looked up.
	Known   bool `json:"known,omitempty"`
	Managed bool `json:"managed,omitempty"`
	// Shoot is a managed seed's shoot (project garden), Host the seed that shoot runs on.
	Shoot string `json:"shoot,omitempty"`
	Host  string `json:"host,omitempty"`
}

// Ambiguous is a shoot name found in several projects: the choices.
type Ambiguous struct {
	Choices []Target
}

func (a *Ambiguous) Error() string {
	var p []string
	for _, c := range a.Choices {
		p = append(p, c.ProjectName())
	}
	return fmt.Sprintf("shoot %s exists in several projects: %s", a.Choices[0].Shoot, strings.Join(p, ", "))
}

// Resolver turns targets into clusters kubewing can open.
type Resolver struct {
	Config Config
	Lookup Lookup
	// Register makes a kubeconfig built in memory a cluster ("@n"); default source.RegisterConfig.
	Register func(key string, raw *clientcmdapi.Config) string
}

func (r *Resolver) register(key string, raw *clientcmdapi.Config) string {
	if r.Register != nil {
		return r.Register(key, raw)
	}
	return source.RegisterConfig(key, raw)
}

// GardenCluster is the garden's cluster: its kubeconfig's context (the
// configured one, else the current), registered under the garden's name,
// so gardens, projects and lookups share one connection (one login).
func (r *Resolver) GardenCluster(name string) (string, Garden, error) {
	g, ok := r.Config.Garden(name)
	if !ok {
		return "", g, fmt.Errorf("garden %q isn't in gardenctl-v2.yaml", name)
	}
	if p := g.Problem(); p != "" {
		return "", g, fmt.Errorf("garden %s: %s", g.Identity, p)
	}
	raw, err := clientcmd.LoadFromFile(g.Kubeconfig)
	if err != nil {
		return "", g, fmt.Errorf("garden %s: %w", g.Identity, err)
	}
	c, err := single(raw, g.Context, g.Identity)
	if err != nil {
		return "", g, fmt.Errorf("garden %s: kubeconfig %s: %w", g.Identity, g.Kubeconfig, err)
	}
	return source.JoinCluster(r.register("garden:"+g.Identity, c), g.Identity), g, nil
}

// Resolve looks a target up in its garden and returns the cluster to open.
// It connects to the garden (an exec plugin may ask to log in).
func (r *Resolver) Resolve(ctx context.Context, t Target) (Opened, error) {
	garden, g, err := r.GardenCluster(t.Garden)
	if err != nil {
		return Opened{}, err
	}
	t.Garden = g.Identity
	if t.Seed != "" && t.Shoot == "" {
		// a seed: its cluster, all namespaces (a project's namespace means nothing there)
		t.Project, t.Namespace, t.ControlPlane = "", "", false
		cluster, seed, err := r.seed(ctx, garden, g, t.Seed)
		if err != nil {
			return Opened{}, err
		}
		return Opened{Cluster: cluster, Target: t, Seed: seed}, nil
	}
	if t.Project != "" && t.Namespace == "" {
		p, err := r.Lookup.GetObject(ctx, garden, projects, "", t.Project)
		if err != nil {
			return Opened{}, fmt.Errorf("project %s: %w", t.Project, err)
		}
		if t.Namespace, _, _ = unstructured.NestedString(p.Object, "spec", "namespace"); t.Namespace == "" {
			return Opened{}, fmt.Errorf("project %s has no namespace yet", t.Project)
		}
	}
	if t.Shoot == "" {
		// the garden, or a project of it
		return Opened{Cluster: garden, Namespace: t.Namespace, Target: t}, nil
	}
	shoot, err := r.findShoot(ctx, garden, t)
	if err != nil {
		return Opened{}, err
	}
	t.Namespace = shoot.GetNamespace()
	if t.Project == "" {
		t.Project = t.ProjectName()
	}
	if t.ControlPlane {
		return r.controlPlane(ctx, garden, g, shoot, t)
	}
	ctxName := g.Identity + "/" + technicalID(shoot)
	level := g.accessLevel(false)
	raw, err := r.shootKubeconfig(ctx, garden, g, shoot, ctxName, level)
	if err != nil {
		return Opened{}, err
	}
	ref := r.register("shoot:"+g.Identity+"/"+t.Namespace+"/"+t.Shoot+"/"+level, raw)
	seedName, _, _ := unstructured.NestedString(shoot.Object, "spec", "seedName")
	return Opened{Cluster: source.JoinCluster(ref, ctxName), Target: t, Seed: Seed{Name: seedName}, IsSeed: r.managedSeedOf(ctx, garden, shoot)}, nil
}

// managedSeedOf is the managed seed a shoot of project garden is ("" = none,
// or it can't be told: managed seeds are an operator's to read).
func (r *Resolver) managedSeedOf(ctx context.Context, garden string, shoot *unstructured.Unstructured) string {
	if shoot.GetNamespace() != "garden" {
		return ""
	}
	list, err := r.Lookup.ListObjects(ctx, garden, managedSeeds, "garden", "")
	if err != nil {
		return ""
	}
	for _, ms := range list {
		name, _, _ := unstructured.NestedString(ms.Object, "spec", "shoot", "name")
		if name == shoot.GetName() {
			return ms.GetName()
		}
	}
	return ""
}

// findShoot reads the target's shoot: in its namespace, else by name in
// all of them (once only a shoot name is known).
func (r *Resolver) findShoot(ctx context.Context, garden string, t Target) (*unstructured.Unstructured, error) {
	if t.Namespace != "" {
		s, err := r.Lookup.GetObject(ctx, garden, shoots, t.Namespace, t.Shoot)
		if err != nil {
			return nil, fmt.Errorf("shoot %s/%s: %w", t.Namespace, t.Shoot, err)
		}
		return s, nil
	}
	list, err := r.Lookup.ListObjects(ctx, garden, shoots, "", "metadata.name="+t.Shoot)
	if err != nil {
		return nil, fmt.Errorf("shoot %s: %w", t.Shoot, err)
	}
	switch len(list) {
	case 0:
		return nil, fmt.Errorf("no shoot %s in garden %s", t.Shoot, t.Garden)
	case 1:
		return list[0], nil
	}
	amb := &Ambiguous{}
	for _, s := range list {
		c := t
		c.Namespace, c.Project = s.GetNamespace(), ""
		amb.Choices = append(amb.Choices, c)
	}
	slices.SortFunc(amb.Choices, func(a, b Target) int { return strings.Compare(a.Namespace, b.Namespace) })
	return nil, amb
}

// shootKubeconfig builds a shoot's gardenlogin kubeconfig, its context
// named ctxName.
func (r *Resolver) shootKubeconfig(ctx context.Context, garden string, g Garden, shoot *unstructured.Unstructured, ctxName, accessLevel string) (*clientcmdapi.Config, error) {
	ns, name := shoot.GetNamespace(), shoot.GetName()
	cm, err := r.Lookup.GetObject(ctx, garden, "configmaps", ns, name+".ca-cluster")
	if err != nil {
		return nil, fmt.Errorf("CA of shoot %s/%s: %w", ns, name, err)
	}
	ca, _, _ := unstructured.NestedString(cm.Object, "data", "ca.crt")
	if ca == "" {
		return nil, fmt.Errorf("CA of shoot %s/%s: config map %s.ca-cluster has no ca.crt", ns, name, name)
	}
	return shootKubeconfig(ctxName, ns, name, g.Identity, accessLevel, addresses(shoot), []byte(ca))
}

// controlPlane opens the shoot's seed in the shoot's namespace there.
func (r *Resolver) controlPlane(ctx context.Context, garden string, g Garden, shoot *unstructured.Unstructured, t Target) (Opened, error) {
	seed, _, _ := unstructured.NestedString(shoot.Object, "spec", "seedName")
	tid, _, _ := unstructured.NestedString(shoot.Object, "status", "technicalID")
	if seed == "" || tid == "" {
		return Opened{}, fmt.Errorf("shoot %s/%s isn't scheduled to a seed yet", shoot.GetNamespace(), shoot.GetName())
	}
	t.Seed = seed
	cluster, info, err := r.seed(ctx, garden, g, seed)
	if err != nil {
		return Opened{}, err
	}
	return Opened{Cluster: cluster, Namespace: tid, Target: t, Seed: info}, nil
}

// seed is a seed's cluster: a managed seed by its shoot's kubeconfig
// (project garden), another one by its login secret, as gardenctl does.
// Named <garden>/seed--<seed>, so its control planes and the seed itself
// share one connection. What its lookups learned of the seed comes with it.
func (r *Resolver) seed(ctx context.Context, garden string, g Garden, seed string) (string, Seed, error) {
	ctxName := g.Identity + "/seed--" + seed
	ms, err := r.Lookup.GetObject(ctx, garden, managedSeeds, "garden", seed)
	switch {
	case err == nil:
		name, _, _ := unstructured.NestedString(ms.Object, "spec", "shoot", "name")
		if name == "" {
			name = seed
		}
		s, err := r.Lookup.GetObject(ctx, garden, shoots, "garden", name)
		if err != nil {
			return "", Seed{}, fmt.Errorf("shoot garden/%s of managed seed %s: %w", name, seed, err)
		}
		// named for the seed, not its shoot: safety rules can tell seeds apart
		raw, err := r.shootKubeconfig(ctx, garden, g, s, ctxName, g.accessLevel(true))
		if err != nil {
			return "", Seed{}, err
		}
		host, _, _ := unstructured.NestedString(s.Object, "spec", "seedName")
		info := Seed{Name: seed, Known: true, Managed: true, Shoot: name, Host: host}
		return source.JoinCluster(r.register("seed:"+g.Identity+"/"+seed, raw), ctxName), info, nil
	case apierrors.IsNotFound(err):
		raw, err := r.seedLogin(ctx, garden, seed)
		if err != nil {
			return "", Seed{}, err
		}
		c, err := single(raw, "", ctxName)
		if err != nil {
			return "", Seed{}, fmt.Errorf("seed %s: %w", seed, err)
		}
		return source.JoinCluster(r.register("seed:"+g.Identity+"/"+seed, c), ctxName), Seed{Name: seed, Known: true}, nil
	default:
		return "", Seed{}, fmt.Errorf("managed seed %s: %w", seed, err)
	}
}

// seedLogin is a seed's kubeconfig from its secret garden/<seed>.login (else .oidc).
func (r *Resolver) seedLogin(ctx context.Context, garden, seed string) (*clientcmdapi.Config, error) {
	var errs []error
	for _, suffix := range []string{".login", ".oidc"} {
		s, err := r.Lookup.GetObject(ctx, garden, "secrets", "garden", seed+suffix)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		enc, _, _ := unstructured.NestedString(s.Object, "data", "kubeconfig")
		b, err := base64.StdEncoding.DecodeString(enc)
		if err != nil || len(b) == 0 {
			errs = append(errs, fmt.Errorf("secret garden/%s%s has no kubeconfig", seed, suffix))
			continue
		}
		raw, err := clientcmd.Load(b)
		if err != nil {
			return nil, fmt.Errorf("seed %s: kubeconfig of secret garden/%s%s: %w", seed, seed, suffix, err)
		}
		return raw, nil
	}
	return nil, fmt.Errorf("seed %s: no login secret: %w", seed, errors.Join(errs...))
}

// ShootOfNamespace is the project and name of the shoot a control plane
// namespace on a seed belongs to: its technical id shoot--<project>--<name>
// (project names have no "--"). Not one: ok false.
func ShootOfNamespace(namespace string) (project, shoot string, ok bool) {
	rest, ok := strings.CutPrefix(namespace, "shoot--")
	if !ok {
		return "", "", false
	}
	project, shoot, ok = strings.Cut(rest, "--")
	if !ok || project == "" || shoot == "" {
		return "", "", false
	}
	return project, shoot, true
}

func technicalID(shoot *unstructured.Unstructured) string {
	if tid, _, _ := unstructured.NestedString(shoot.Object, "status", "technicalID"); tid != "" {
		return tid
	}
	ns, name := shoot.GetNamespace(), shoot.GetName()
	return "shoot--" + strings.TrimPrefix(strings.TrimPrefix(ns, "garden-"), "garden") + "--" + name
}

// addresses are the shoot's advertised addresses, external first.
func addresses(shoot *unstructured.Unstructured) []Address {
	list, _, _ := unstructured.NestedSlice(shoot.Object, "status", "advertisedAddresses")
	var out []Address
	for _, it := range list {
		m, _ := it.(map[string]any)
		name, _ := m["name"].(string)
		u, _ := m["url"].(string)
		out = append(out, Address{Name: name, URL: u})
	}
	order := map[string]int{"external": 0, "internal": 1, "unmanaged": 2}
	slices.SortStableFunc(out, func(a, b Address) int {
		oa, ok := order[a.Name]
		if !ok {
			oa = 3
		}
		ob, ok := order[b.Name]
		if !ok {
			ob = 3
		}
		return oa - ob
	})
	return out
}

func (g Garden) accessLevel(seed bool) string {
	if g.AccessLevels == nil {
		return ""
	}
	if seed {
		return g.AccessLevels.Seeds
	}
	return g.AccessLevels.Shoots
}
