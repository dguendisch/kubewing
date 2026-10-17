package source

import (
	"context"
	"fmt"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// ResourceType is one listable API resource, as offered for completion.
type ResourceType struct {
	Name       string   `json:"name"`  // plural, e.g. "deployments"
	Group      string   `json:"group"` // "" = core
	Version    string   `json:"version"`
	Kind       string   `json:"kind"`
	Singular   string   `json:"singular,omitempty"`
	ShortNames []string `json:"shortNames,omitempty"`
	Namespaced bool     `json:"namespaced"`
}

// Qualified is the name that resolves unambiguously ("deployments.apps").
func (r ResourceType) Qualified() string {
	if r.Group == "" {
		return r.Name
	}
	return r.Name + "." + r.Group
}

// Lister is implemented by openers that can enumerate a cluster's API
// surface for completion (the catalog). Real clusters and tapes do.
type Lister interface {
	// ResourceTypes lists listable resource types; refresh bypasses cached
	// discovery. On partial discovery failure (an aggregated API is down)
	// it returns what it got plus an error (see PartialDiscovery).
	ResourceTypes(ctx context.Context, cluster string, refresh bool) ([]ResourceType, error)
	// Namespaces lists namespace names (metadata only).
	Namespaces(ctx context.Context, cluster string) ([]string, error)
	// Changes signals, until ctx ends, that resource types or namespaces
	// may have changed. Signals are hints; consumers refetch.
	Changes(ctx context.Context, cluster string, out chan<- Change)
}

// Change says what may have changed.
type Change uint8

const (
	ResourcesChanged Change = 1 << iota
	NamespacesChanged
)

// ResourceTypes returns preferred-version, listable resources. With refresh,
// discovery and the RESTMapper are reset first so new CRDs show up in both.
func (c *Cluster) ResourceTypes(_ context.Context, refresh bool) ([]ResourceType, error) {
	if refresh {
		c.deferred.Reset()
	}
	lists, err := c.disco.ServerPreferredResources()
	return resourceTypes(lists), err
}

var (
	crdGVR = schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}
	nsGVR  = schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}
)

// Changes runs metadata-only watches on CRDs and namespaces and signals on
// changes after the initial list. Forbidden watches just stay silent (the
// watch loop retries with backoff); callers should refresh periodically too.
func (c *Cluster) Changes(ctx context.Context, out chan<- Change) {
	watch := func(gvr schema.GroupVersionResource, what Change, modified bool) {
		evs := make(chan Event, 64)
		go c.Watch(ctx, Resolved{GVR: gvr, Metadata: true}, "", "", "", evs)
		listed := false
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-evs:
				switch {
				case ev.Type == Error:
					continue
				case ev.Type == Relist && !listed:
					listed = true // initial state, already fetched by the caller
					continue
				case ev.Type == Modified && !modified:
					continue
				}
				select {
				case out <- what:
				case <-ctx.Done():
					return
				}
			}
		}
	}
	// a CRD update can add or remove served versions; a namespace update can't change names
	go watch(crdGVR, ResourcesChanged, true)
	watch(nsGVR, NamespacesChanged, false)
}

func resourceTypes(lists []*metav1.APIResourceList) []ResourceType {
	var out []ResourceType
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range l.APIResources {
			// subresources ("pods/log") and non-listables (bindings, reviews) can't back a view
			if strings.Contains(r.Name, "/") || !hasVerb(r.Verbs, "list") || !hasVerb(r.Verbs, "watch") {
				continue
			}
			out = append(out, ResourceType{
				Name: r.Name, Group: gv.Group, Version: gv.Version, Kind: r.Kind,
				Singular: r.SingularName, ShortNames: r.ShortNames, Namespaced: r.Namespaced,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Qualified() < out[j].Qualified() })
	return out
}

func hasVerb(verbs metav1.Verbs, v string) bool {
	for _, x := range verbs {
		if x == v {
			return true
		}
	}
	return false
}

// PartialDiscovery reports whether err only means some API groups failed
// (results are still usable).
func PartialDiscovery(err error) bool {
	return discovery.IsGroupDiscoveryFailedError(err)
}

// Namespaces lists namespace names via a metadata-only list.
func (c *Cluster) Namespaces(ctx context.Context) ([]string, error) {
	res := Resolved{GVR: nsGVR, Metadata: true}
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return nil, err
	}
	var names []string
	cont := ""
	for {
		req := c.request(rc, res, "", "", "").Param("limit", "500")
		if cont != "" {
			req = req.Param("continue", cont)
		}
		body, err := req.DoRaw(ctx)
		if err != nil {
			return nil, err
		}
		t, err := decodeTableOrList(body)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", res.GVR.Resource, err)
		}
		for _, it := range t.items {
			names = append(names, it.Object.GetName())
		}
		if cont = t.cont; cont == "" {
			break
		}
	}
	sort.Strings(names)
	return names, nil
}
