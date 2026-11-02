package config

import (
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"sigs.k8s.io/yaml"
)

// ClustersFile is where kubewing remembers the clusters it opened.
const ClustersFile = "clusters.yaml"

// MaxClusters is how many recent clusters are kept.
const MaxClusters = 100

// Cluster is a cluster opened before: a kubeconfig's context, or a Gardener
// target (Garden set): a garden, project, shoot, control plane or seed.
type Cluster struct {
	// Kubeconfig are the files of a kubeconfig ("" entries none: ~/.kube/config); Context its context.
	Kubeconfig []string `json:"kubeconfig,omitempty"`
	Context    string   `json:"context,omitempty"`

	Garden       string `json:"garden,omitempty"`
	Project      string `json:"project,omitempty"`
	Namespace    string `json:"namespace,omitempty"`
	Shoot        string `json:"shoot,omitempty"`
	ControlPlane bool   `json:"controlPlane,omitempty"`
	// Seed is a seed of its own (no Shoot): its cluster, all namespaces.
	Seed string `json:"seed,omitempty"`

	Used time.Time `json:"used"`
}

// Same reports whether c and o are the same cluster (when used aside).
func (c Cluster) Same(o Cluster) bool {
	if c.Garden != "" || o.Garden != "" {
		// a project's namespace or its name: either names it
		sameProject := c.Project == o.Project && (c.Project != "" || c.Namespace == o.Namespace) ||
			c.Namespace != "" && c.Namespace == o.Namespace
		return c.Garden == o.Garden && c.Seed == o.Seed && c.Shoot == o.Shoot && c.ControlPlane == o.ControlPlane && sameProject
	}
	return c.Context == o.Context && slices.Equal(c.Kubeconfig, o.Kubeconfig)
}

// ClusterStore reads and writes dir/clusters.yaml; dir "" keeps it in memory only.
type ClusterStore struct {
	dir string

	mu   sync.Mutex
	list []Cluster
}

// OpenClusters loads dir/clusters.yaml; a missing or unreadable file is an empty list.
func OpenClusters(dir string) *ClusterStore {
	s := &ClusterStore{dir: dir}
	if dir == "" {
		return s
	}
	b, err := os.ReadFile(filepath.Join(dir, ClustersFile))
	if err != nil {
		return s
	}
	var f struct {
		Clusters []Cluster `json:"clusters"`
	}
	if yaml.Unmarshal(b, &f) == nil {
		s.list = f.Clusters
		if len(s.list) > MaxClusters {
			s.list = s.list[:MaxClusters]
		}
	}
	return s
}

// List returns the recent clusters, the latest first.
func (s *ClusterStore) List() []Cluster {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.list)
}

// Add moves c to the front (at most MaxClusters) and saves. The same
// cluster used again within a minute isn't written again.
func (s *ClusterStore) Add(c Cluster) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.list) > 0 && s.list[0].Same(c) && c.Used.Sub(s.list[0].Used) < time.Minute {
		return nil
	}
	s.list = slices.DeleteFunc(s.list, c.Same)
	s.list = append([]Cluster{c}, s.list...)
	if len(s.list) > MaxClusters {
		s.list = s.list[:MaxClusters]
	}
	return s.save()
}

// Remove drops c from the list and saves; an unknown one is a no-op.
func (s *ClusterStore) Remove(c Cluster) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.list)
	if s.list = slices.DeleteFunc(s.list, c.Same); len(s.list) == n {
		return nil
	}
	return s.save()
}

func (s *ClusterStore) save() error {
	return writeAtomic(s.dir, ClustersFile, "# Written by kubewing (recently opened clusters, the latest first); safe to delete.\n", struct {
		Clusters []Cluster `json:"clusters"`
	}{s.list})
}
