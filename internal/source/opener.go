package source

import (
	"context"
	"fmt"
	"sync"
)

// ClusterOpener opens watches against real clusters from kubeconfig,
// caching one connection per context.
type ClusterOpener struct {
	mu       sync.Mutex
	clusters map[string]*Cluster
}

// NewClusterOpener creates an opener.
func NewClusterOpener() *ClusterOpener { return &ClusterOpener{clusters: map[string]*Cluster{}} }

func (o *ClusterOpener) cluster(name string) (*Cluster, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if c, ok := o.clusters[name]; ok {
		return c, nil
	}
	// "" (current context) and its name are the same connection
	for _, c := range o.clusters {
		if c.is(name) {
			o.clusters[name] = c
			return c, nil
		}
	}
	c, err := Connect(name)
	if err != nil {
		return nil, fmt.Errorf("context %q: %w", name, err)
	}
	o.clusters[name] = c
	return c, nil
}

// is reports whether cluster names c's context by name.
func (c *Cluster) is(cluster string) bool {
	ref, ctx := SplitCluster(cluster)
	return ctx != "" && c.Kubeconfig == ref && c.Context == ctx
}

// Resolve implements Opener.
func (o *ClusterOpener) Resolve(cluster, resource string) (Resolved, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return Resolved{}, err
	}
	return c.Resolve(resource)
}

// Watch implements Opener.
func (o *ClusterOpener) Watch(ctx context.Context, cluster string, res Resolved, k Key, out chan<- Event) {
	c, err := o.cluster(cluster)
	if err != nil {
		send(ctx, out, Event{Type: Error, Err: err.Error()})
		return
	}
	c.Watch(ctx, res, k.Namespace, k.LabelSelector, k.FieldSelector, out)
}

// Reconnect implements Reconnector: the next request on the context
// connects anew (a new transport; an exec plugin's credentials stay cached
// by client-go). Running sessions, port-forwards and log streams keep the
// old connection until they end.
func (o *ClusterOpener) Reconnect(cluster string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	c, ok := o.clusters[cluster]
	if !ok {
		for _, x := range o.clusters {
			if x.is(cluster) {
				c = x
				break
			}
		}
	}
	names := []string{cluster}
	for n, x := range o.clusters {
		if c != nil && x == c {
			delete(o.clusters, n)
			if n != cluster {
				names = append(names, n)
			}
		}
	}
	return names
}

// Connected reports whether a connection to the context exists. The catalog
// uses it to avoid starting exec-plugin logins in the background.
func (o *ClusterOpener) Connected(cluster string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, ok := o.clusters[cluster]; ok {
		return true
	}
	for _, c := range o.clusters {
		if c.is(cluster) {
			return true
		}
	}
	return false
}

// ResourceTypes implements Lister.
func (o *ClusterOpener) ResourceTypes(ctx context.Context, cluster string, refresh bool) ([]ResourceType, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.ResourceTypes(ctx, refresh)
}

// Namespaces implements Lister.
func (o *ClusterOpener) Namespaces(ctx context.Context, cluster string) ([]string, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.Namespaces(ctx)
}

// Changes implements Lister.
func (o *ClusterOpener) Changes(ctx context.Context, cluster string, out chan<- Change) {
	c, err := o.cluster(cluster)
	if err != nil {
		return
	}
	c.Changes(ctx, out)
}
