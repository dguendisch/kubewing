package bridge

import (
	"strings"

	"github.com/dguendisch/kubewing/internal/gardener"
)

// Location is where a pane is, for its header: a Gardener cluster's
// landscape (garden), the plane the pane shows and the seed beneath it.
// Plane "" is any other cluster (the header shows its context name).
type Location struct {
	Garden string `json:"garden,omitempty"`
	// Plane: "shoot", "controlPlane", "seed" or "garden".
	Plane   string `json:"plane,omitempty"`
	Project string `json:"project,omitempty"`
	Shoot   string `json:"shoot,omitempty"`
	// Seed is the seed a shoot or control plane runs on, or the seed shown.
	Seed string `json:"seed,omitempty"`
	// SeedKind: "managed" (a shoot of project garden: SeedShoot, running on
	// SeedHost), "unmanaged" (registered with a kubeconfig of its own), ""
	// not known (resolving didn't look it up: a shoot's seed, a cluster
	// opened from a terminal's kubeconfig).
	SeedKind  string `json:"seedKind,omitempty"`
	SeedShoot string `json:"seedShoot,omitempty"`
	SeedHost  string `json:"seedHost,omitempty"`
	// IsSeed: the shoot shown is this managed seed's.
	IsSeed string `json:"isSeed,omitempty"`
}

// shootInfo is what resolving a shoot learned beyond its target.
type shootInfo struct {
	seed, isSeed string
}

// Location says where a pane (its cluster and namespace, as its spec has
// them) is, as far as kubewing knows without asking anyone: the targets
// ⌘⇧O and ⌘J resolved, else the cluster's kubeconfig (gardenctl's), else a
// garden by its API server. On a seed's cluster the pane's namespace
// decides: a shoot's (shoot--<project>--<name>) is that shoot's control
// plane, any other (or all) the seed. Connects nowhere.
func (s *Service) Location(cluster, namespace string) Location {
	s.mu.Lock()
	t, ok := s.opened[openedKey(cluster, namespace, true)]
	if !ok {
		t, ok = s.opened[openedKey(cluster, "", false)]
	}
	sh := s.shoots[cluster]
	s.mu.Unlock()
	if !ok {
		t, ok = targetOfKubeconfig(cluster)
	}
	if !ok {
		cfg, err := s.gardenConfig()
		if err != nil {
			return Location{}
		}
		g, isGarden := s.gardenOf(cfg, cluster)
		if !isGarden {
			return Location{}
		}
		t = gardener.Target{Garden: g.Identity}
	}
	seed := func(l Location) Location {
		s.mu.Lock()
		info := s.seeds[t.Garden+"/"+l.Seed]
		s.mu.Unlock()
		switch {
		case !info.Known:
		case info.Managed:
			l.SeedKind, l.SeedShoot, l.SeedHost = "managed", info.Shoot, info.Host
		default:
			l.SeedKind = "unmanaged"
		}
		return l
	}
	switch {
	case t.Shoot != "" && t.Seed == "":
		return seed(Location{Garden: t.Garden, Plane: "shoot", Project: t.ProjectName(), Shoot: t.Shoot, Seed: sh.seed, IsSeed: sh.isSeed})
	case t.Seed != "":
		if project, shoot, cp := gardener.ShootOfNamespace(namespace); cp {
			return seed(Location{Garden: t.Garden, Plane: "controlPlane", Project: project, Shoot: shoot, Seed: t.Seed})
		}
		return seed(Location{Garden: t.Garden, Plane: "seed", Seed: t.Seed})
	default:
		// a garden: the project of the pane's namespace
		l := Location{Garden: t.Garden, Plane: "garden"}
		if namespace == "garden" || strings.HasPrefix(namespace, "garden-") {
			l.Project = (gardener.Target{Namespace: namespace}).ProjectName()
		}
		return l
	}
}
