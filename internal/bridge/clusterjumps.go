package bridge

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/gardener"
	"github.com/dguendisch/kubewing/internal/source"
)

// ClusterJump is a jump menu entry to another cluster: a Gardener object's
// shoot, control plane or seed, opened as a pick in the clusters dialog
// (OpenCluster), only once chosen: resolving it may ask to log in.
type ClusterJump struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Type is the start of Label naming the kind of cluster ("shoot", "control plane", "seed").
	Type  string       `json:"type,omitempty"`
	Entry ClusterEntry `json:"entry"`
}

// clusterJumps are the clusters a Gardener object of a garden leads to: a
// shoot's own and its control plane, a seed's (and a managed seed's shoot's
// control plane too). Nothing for other kinds or clusters that aren't a
// garden of gardenctl's config. Connects nowhere: OpenCluster resolves them.
func (s *Service) clusterJumps(cluster string, obj *unstructured.Unstructured, kind, group string) []ClusterJump {
	if g, _, ok := strings.Cut(obj.GetAPIVersion(), "/"); ok {
		group = g
	}
	var seed string
	switch {
	case kind == "Shoot" && group == "core.gardener.cloud":
	case kind == "Seed" && group == "core.gardener.cloud":
		seed = obj.GetName()
	case kind == "ManagedSeed" && group == "seedmanagement.gardener.cloud":
		seed = obj.GetName()
	default:
		return nil
	}
	cfg, err := s.gardenConfig()
	if err != nil {
		return nil
	}
	g, ok := s.gardenOf(cfg, cluster)
	if !ok {
		return nil
	}
	shoot := func(namespace, name string, cp bool, typ, label string) ClusterJump {
		t := gardener.Target{Garden: g.Identity, Namespace: namespace, Shoot: name, ControlPlane: cp}
		id := "cluster:shoot"
		if cp {
			id = "cluster:controlPlane"
		}
		return ClusterJump{ID: id, Label: typ + label, Type: typ, Entry: s.entry(cfg, targetCluster(t), "jump")}
	}
	if seed == "" {
		return []ClusterJump{
			shoot(obj.GetNamespace(), obj.GetName(), false, "shoot", " "+obj.GetName()),
			shoot(obj.GetNamespace(), obj.GetName(), true, "control plane", " of "+obj.GetName()),
		}
	}
	t := gardener.Target{Garden: g.Identity, Seed: seed}
	out := []ClusterJump{{ID: "cluster:seed", Label: "seed " + seed, Type: "seed", Entry: s.entry(cfg, targetCluster(t), "jump")}}
	// a managed seed is a shoot (in project garden), whose control plane is on another seed
	if kind == "ManagedSeed" {
		name, _, _ := unstructured.NestedString(obj.Object, "spec", "shoot", "name")
		if name == "" {
			name = seed
		}
		out = append(out, shoot(obj.GetNamespace(), name, true, "control plane", " of shoot "+name))
	}
	return out
}

// gardenOf is the garden of gardenctl's config a cluster is: the one ⌘⇧O
// opened (registered by its identity), else the one whose kubeconfig points
// at the same API server (a garden opened from a kubeconfig of its own).
func (s *Service) gardenOf(cfg gardener.Config, cluster string) (gardener.Garden, bool) {
	if s.opts.Gardener == nil {
		return gardener.Garden{}, false
	}
	if id, ok := strings.CutPrefix(source.ConfigKey(cluster), "garden:"); ok {
		return cfg.Garden(id)
	}
	server, err := source.Server(cluster)
	if err != nil || server == "" {
		return gardener.Garden{}, false
	}
	for _, g := range cfg.Gardens {
		if g.Problem() != "" {
			continue
		}
		if gs, err := g.Server(); err == nil && sameServer(gs, server) {
			return g, true
		}
	}
	return gardener.Garden{}, false
}

// sameServer compares API server URLs, a default port and a trailing slash aside.
func sameServer(a, b string) bool {
	norm := func(u string) string {
		u = strings.TrimSuffix(strings.ToLower(u), "/")
		return strings.TrimSuffix(u, ":443")
	}
	return norm(a) == norm(b)
}
