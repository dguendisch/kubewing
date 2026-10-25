package bridge

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/expr"
	"github.com/dguendisch/kubewing/internal/relations"
	"github.com/dguendisch/kubewing/internal/source"
)

// Jump menu lookups: metadata only, bounded in depth, time and concurrency.
const (
	ownerDepth   = 8
	relationWait = 10 * time.Second
	scanWait     = 30 * time.Second
	scanParallel = 8
)

// Relations is the jump menu of one row (u): where the pane can go from it.
type Relations struct {
	Kind      string               `json:"kind"`
	Name      string               `json:"name"`
	Namespace string               `json:"namespace,omitempty"`
	Items     []relations.Relation `json:"items"`
	// Scan: the owned scan can look further (any kind owned by this UID).
	Scan bool `json:"scan,omitempty"`
	// ScanAll: the scan covers all namespaces and cluster-scoped types
	// (a cluster-scoped owner), so the menu asks before running it.
	ScanAll bool `json:"scanAll,omitempty"`
}

// relationTypes is implemented by openers that know the resource types the
// owned scan lists (tapes); otherwise the catalog's are used.
type relationTypes interface {
	RelationTypes() []source.ResourceType
}

// rowObject is a row's last known object, tombstones included (relations
// read metadata only, so the last state of a deleted object still works).
func (s *Service) rowObject(paneID, key string) (*pane, *unstructured.Unstructured, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return nil, nil, err
	}
	pn.mu.Lock()
	it, ok := pn.view.Item(key)
	pn.mu.Unlock()
	if !ok {
		return nil, nil, fmt.Errorf("object %s not found", key)
	}
	return pn, it.Object, nil
}

func (s *Service) relator() (source.Relator, error) {
	r, ok := s.opts.Actor.(source.Relator)
	if !ok {
		return nil, errors.New("relations are not available")
	}
	return r, nil
}

// Relations lists where the jump menu goes from a row: its namespace, its
// owner chain (each owner checked to exist, by UID), what it is known
// to own (counted), what it refers to (checked or counted) and its events (counted). Read-only: no token, works on read-only contexts and
// on tombstones.
func (s *Service) Relations(paneID, key string) (Relations, error) {
	rel, err := s.relator()
	if err != nil {
		return Relations{}, err
	}
	pn, obj, err := s.rowObject(paneID, key)
	if err != nil {
		return Relations{}, err
	}
	pn.mu.Lock()
	p, res := pn.p, pn.res
	pn.mu.Unlock()
	cluster := p.Source.Cluster
	kind := obj.GetKind()
	if kind == "" {
		kind = res.Kind
	}
	out := Relations{Kind: kind, Name: obj.GetName(), Namespace: obj.GetNamespace(), Items: []relations.Relation{}}
	ctx, cancel := context.WithTimeout(context.Background(), relationWait)
	defer cancel()

	nsRes, _, err := rel.ResolveKind(cluster, "v1", "Namespace")
	if err != nil {
		nsRes = "namespaces"
	}
	// the label names what the pane shows: the resolved plural ("pods" for a "po" pane), else as typed (tapes)
	plural := res.GVR.Resource
	if plural == "" {
		plural = p.Source.Resource
	}
	out.Items = append(out.Items, relations.Namespace(obj, p, plural, nsRes)...)
	out.Items = append(out.Items, s.owners(ctx, rel, cluster, obj)...)
	out.Items = append(out.Items, s.owned(ctx, rel, cluster, obj)...)
	refs, listed := refsOf(ctx, rel, cluster, withKind(obj, kind))
	out.Items = append(out.Items, references(ctx, rel, cluster, refs, listed)...)
	if kind != "Event" {
		out.Items = append(out.Items, eventsRelation(ctx, rel, cluster, withKind(obj, kind)))
	}
	if obj.GetUID() != "" {
		out.Scan = true
		out.ScanAll = obj.GetNamespace() == ""
	}
	return out, nil
}

// owners walks the ownerReferences up, breadth first: the direct owners,
// then theirs. Each owner is looked up (metadata only) so a deleted or
// recreated one shows as gone; a UID seen twice ends that branch.
func (s *Service) owners(ctx context.Context, rel source.Relator, cluster string, obj *unstructured.Unstructured) []relations.Relation {
	var out []relations.Relation
	seen := map[string]bool{string(obj.GetUID()): true}
	ns := obj.GetNamespace()
	level := relations.Owners(obj)
	for depth := 1; depth <= ownerDepth && len(level) > 0; depth++ {
		var next []relations.Owner
		for _, o := range level {
			if o.UID != "" && seen[o.UID] {
				continue
			}
			seen[o.UID] = true
			r := relations.OwnerRelation(o, depth)
			resource, namespaced, err := rel.ResolveKind(cluster, o.APIVersion, o.Kind)
			if err != nil {
				r.Gone = "unknown kind"
				out = append(out, r)
				continue
			}
			ons := ""
			if namespaced {
				ons = ns // owners live in the object's namespace, or are cluster-scoped
			}
			got, err := rel.GetMetadata(ctx, cluster, resource, ons, o.Name)
			switch {
			case apierrors.IsNotFound(err):
				r.Gone = "deleted"
			case err != nil:
				// can't check (forbidden, timeout): still offer the jump
				r.Target, r.Note = relations.OwnerTarget(resource, ons, o.Name), "not checked: "+shortErr(err)
			case o.UID != "" && string(got.GetUID()) != o.UID:
				r.Gone = "recreated (another object of that name)"
			default:
				r.Target = relations.OwnerTarget(resource, ons, o.Name)
				next = append(next, relations.Owners(got)...)
			}
			out = append(out, r)
		}
		level = next
	}
	return out
}

// owned lists the known child kinds (relations.Children, plus the pods of
// a custom resource with a scale subresource), each counted with a
// metadata-only list.
func (s *Service) owned(ctx context.Context, rel source.Relator, cluster string, obj *unstructured.Unstructured) []relations.Relation {
	children := relations.Children(obj)
	if len(children) == 0 {
		children = scaleChildren(ctx, rel, cluster, obj)
	}
	out := make([]relations.Relation, len(children))
	var wg sync.WaitGroup
	for i, c := range children {
		resource, _, err := rel.ResolveKind(cluster, c.APIVersion, c.Kind)
		if err != nil {
			resource = c.Resource
		}
		out[i] = relations.OwnedRelation(c, resource)
		wg.Add(1)
		go func() {
			defer wg.Done()
			list, err := rel.ListMetadata(ctx, cluster, resource, c.Namespace, c.LabelSelector, c.FieldSelector)
			if err != nil {
				out[i].Note = "not counted: " + shortErr(err)
				return
			}
			n := 0
			for _, it := range list {
				if c.Owns(it) {
					n++
				}
			}
			out[i].Count = &n
		}()
	}
	wg.Wait()
	return out
}

// listed holds full lists already read, by listKey (counting reuses them).
type listed map[string][]*unstructured.Unstructured

func listKey(resource, namespace string) string { return resource + "\x00" + namespace }

// refsOf is what obj refers to (relations.References). The claims of a pod
// or stateful set are read in full (one list of its namespace's claims,
// returned in listed) to go on to their volumes and attachments; if that
// fails, the claims alone.
func refsOf(ctx context.Context, rel source.Relator, cluster string, obj *unstructured.Unstructured) ([]relations.Ref, listed) {
	refs := relations.References(obj)
	gv := obj.GetAPIVersion() + "/" + obj.GetKind()
	if len(refs) == 0 || gv != "v1/Pod" && gv != "apps/v1/StatefulSet" {
		return refs, nil
	}
	resource, _, err := rel.ResolveKind(cluster, "v1", "PersistentVolumeClaim")
	if err != nil {
		resource = "persistentvolumeclaims"
	}
	claims, err := rel.List(ctx, cluster, resource, obj.GetNamespace())
	if err != nil {
		return refs, nil
	}
	l := listed{listKey(resource, obj.GetNamespace()): claims}
	if gv == "v1/Pod" {
		return relations.PodVolumes(obj, claims), l
	}
	return relations.StatefulSetVolumes(obj, claims), l
}

// references lists the entries of refs: one object looked up by name (gone
// if deleted or recreated), a set counted with its filter over a list
// (full objects unless the filter reads only metadata; the filter's field
// has no field selector), reusing what refsOf already listed.
func references(ctx context.Context, rel source.Relator, cluster string, refs []relations.Ref, pre listed) []relations.Relation {
	out := make([]relations.Relation, len(refs))
	var wg sync.WaitGroup
	for i, ref := range refs {
		resource, namespaced, err := rel.ResolveKind(cluster, ref.APIVersion, ref.Kind)
		if err != nil {
			resource, namespaced = ref.Resource, ref.Namespace != ""
		}
		if !namespaced {
			ref.Namespace = ""
		}
		out[i] = relations.RefRelation(ref, resource)
		if ref.Missing != "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := &out[i]
			if ref.Name != "" {
				got, err := rel.GetMetadata(ctx, cluster, resource, ref.Namespace, ref.Name)
				switch {
				case apierrors.IsNotFound(err):
					r.Gone = "deleted"
				case err != nil:
					r.Target, r.Note = ref.Target(resource), "not checked: "+shortErr(err)
				case ref.UID != "" && string(got.GetUID()) != ref.UID:
					r.Gone = "recreated (another object of that name)"
				default:
					r.Target = ref.Target(resource)
				}
				return
			}
			r.Target = ref.Target(resource)
			n, err := countMatching(ctx, rel, cluster, resource, ref, pre)
			if err != nil {
				r.Note = "not counted: " + shortErr(err)
				return
			}
			r.Count = &n
		}()
	}
	wg.Wait()
	return out
}

// countMatching counts the objects of resource that ref's CEL filter matches.
func countMatching(ctx context.Context, rel source.Relator, cluster, resource string, ref relations.Ref, pre listed) (int, error) {
	prg, err := expr.Compile(ref.Filter)
	if err != nil {
		return 0, err
	}
	list, ok := pre[listKey(resource, ref.Namespace)]
	switch {
	case ok:
	case ref.MetadataOnly:
		list, err = rel.ListMetadata(ctx, cluster, resource, ref.Namespace, "", "")
	default:
		list, err = rel.List(ctx, cluster, resource, ref.Namespace)
	}
	if err != nil {
		return 0, err
	}
	n := 0
	for _, it := range list {
		if ok, _ := prg.Bool(it.Object); ok {
			n++
		}
	}
	return n, nil
}

// scaleChildren: a custom resource whose CRD has a scale subresource with
// a labelSelectorPath runs the pods that selector matches.
func scaleChildren(ctx context.Context, rel source.Relator, cluster string, obj *unstructured.Unstructured) []relations.Child {
	if !strings.Contains(obj.GetAPIVersion(), ".") || obj.GetNamespace() == "" {
		return nil // built-in groups have no CRD
	}
	crd, err := rel.CRD(ctx, cluster, obj.GetAPIVersion(), obj.GetKind())
	if err != nil {
		return nil
	}
	versions, _, _ := unstructured.NestedSlice(crd.Object, "spec", "versions")
	_, version, _ := strings.Cut(obj.GetAPIVersion(), "/")
	for _, v := range versions {
		vm, _ := v.(map[string]any)
		if name, _, _ := unstructured.NestedString(vm, "name"); name != version {
			continue
		}
		path, _, _ := unstructured.NestedString(vm, "subresources", "scale", "labelSelectorPath")
		if sel, ok := relations.ScaleSelector(obj, path); ok {
			return []relations.Child{{APIVersion: "v1", Kind: "Pod", Resource: "pods", Namespace: obj.GetNamespace(), LabelSelector: sel}}
		}
	}
	return nil
}

// OwnedScanResult lists every resource type with objects owned by a row.
type OwnedScanResult struct {
	Items []relations.Relation `json:"items"`
	// Scanned resource types; Skipped ones failed (forbidden, gone), with one reason.
	Scanned    int    `json:"scanned"`
	Skipped    int    `json:"skipped,omitempty"`
	SkipReason string `json:"skipReason,omitempty"`
}

// OwnedScan finds what a row owns across all resource types: no reverse
// index exists, so it lists the metadata of every listable type in the
// row's namespace (a cluster-scoped owner: all namespaces and the
// cluster-scoped types) and matches ownerReferences by UID. Types that
// fail are skipped and counted.
func (s *Service) OwnedScan(paneID, key string) (OwnedScanResult, error) {
	rel, err := s.relator()
	if err != nil {
		return OwnedScanResult{}, err
	}
	pn, obj, err := s.rowObject(paneID, key)
	if err != nil {
		return OwnedScanResult{}, err
	}
	uid := string(obj.GetUID())
	if uid == "" {
		return OwnedScanResult{}, errors.New("the object has no UID to look for")
	}
	pn.mu.Lock()
	cluster := pn.p.Source.Cluster
	pn.mu.Unlock()
	ns := obj.GetNamespace()
	types := s.scanTypes(cluster)
	if len(types) == 0 {
		return OwnedScanResult{}, errors.New("the context's resource types aren't loaded yet")
	}

	ctx, cancel := context.WithTimeout(context.Background(), scanWait)
	defer cancel()
	type hit struct {
		rt    source.ResourceType
		count int
		err   error
	}
	hits := make([]hit, 0, len(types))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, scanParallel)
	for _, rt := range types {
		if ns != "" && !rt.Namespaced {
			continue // a namespaced owner owns namespaced objects only
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			lns := ns
			if !rt.Namespaced {
				lns = ""
			}
			list, err := rel.ListMetadata(ctx, cluster, rt.Qualified(), lns, "", "")
			n := 0
			for _, it := range list {
				for _, r := range it.GetOwnerReferences() {
					if string(r.UID) == uid {
						n++
						break
					}
				}
			}
			mu.Lock()
			hits = append(hits, hit{rt, n, err})
			mu.Unlock()
		}()
	}
	wg.Wait()

	res := OwnedScanResult{Items: []relations.Relation{}}
	for _, h := range hits {
		if h.err != nil {
			res.Skipped++
			if res.SkipReason == "" {
				res.SkipReason = shortErr(h.err)
			}
			continue
		}
		res.Scanned++
		if h.count > 0 {
			tns := ns
			if !h.rt.Namespaced {
				tns = ""
			}
			res.Items = append(res.Items, relations.ScanRelation(h.rt.Qualified(), h.rt.Kind, tns, uid, h.count))
		}
	}
	sort.Slice(res.Items, func(i, j int) bool { return res.Items[i].Label < res.Items[j].Label })
	return res, nil
}

// scanTypes are the listable resource types of a context, minus noise
// that never has owners worth jumping to (events).
func (s *Service) scanTypes(cluster string) []source.ResourceType {
	var types []source.ResourceType
	if rt, ok := s.opts.Actor.(relationTypes); ok {
		types = rt.RelationTypes()
	} else if s.opts.Catalog != nil {
		types = s.opts.Catalog.Get(cluster, false).Resources
	}
	out := types[:0:0]
	seen := map[string]bool{}
	for _, t := range types {
		// one entry per kind: events.k8s.io and core events, metrics …
		if t.Kind == "Event" || seen[t.Group+"/"+t.Kind] {
			continue
		}
		seen[t.Group+"/"+t.Kind] = true
		out = append(out, t)
	}
	return out
}

// EventsTarget is where v goes from a row: the events about its object
// (the jump menu's events entry, without opening the menu). Read-only,
// works on tombstones (events outlive their object for a while).
func (s *Service) EventsTarget(paneID, key string) (relations.Target, error) {
	pn, obj, err := s.rowObject(paneID, key)
	if err != nil {
		return relations.Target{}, err
	}
	pn.mu.Lock()
	cluster, kind := pn.p.Source.Cluster, pn.res.Kind
	pn.mu.Unlock()
	obj = withKind(obj, kind)
	if obj.GetKind() == "Event" {
		return relations.Target{}, errors.New("an event has no events of its own")
	}
	resource := "events"
	if rel, err := s.relator(); err == nil {
		resource = eventResource(rel, cluster)
	}
	return relations.Events(obj, resource), nil
}

// withKind fills in an object's kind from the pane's resource if the
// object lacks it.
func withKind(obj *unstructured.Unstructured, kind string) *unstructured.Unstructured {
	if obj.GetKind() != "" {
		return obj
	}
	obj = obj.DeepCopy()
	obj.SetKind(kind)
	return obj
}

func eventResource(rel source.Relator, cluster string) string {
	if r, _, err := rel.ResolveKind(cluster, "v1", "Event"); err == nil {
		return r
	}
	return "events"
}

// eventsRelation is the jump menu's events entry, counted with a
// metadata-only list.
func eventsRelation(ctx context.Context, rel source.Relator, cluster string, obj *unstructured.Unstructured) relations.Relation {
	t := relations.Events(obj, eventResource(rel, cluster))
	r := relations.Relation{ID: "events", Section: relations.SectionEvents, Label: "events", Kind: "Event", Target: &t}
	list, err := rel.ListMetadata(ctx, cluster, t.Resource, t.Namespace, "", t.FieldSelector)
	if err != nil {
		r.Note = "not counted: " + shortErr(err)
		return r
	}
	n := len(list)
	r.Count = &n
	return r
}

// RowIndex is the position of a row in a pane's current order (-1 if not
// shown), so going back after a jump selects the row it came from.
func (s *Service) RowIndex(paneID, key string) (int, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return -1, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	return pn.view.Index(key), nil
}

// shortErr is the first line of an error, for a menu note.
func shortErr(err error) string {
	msg, _, _ := strings.Cut(err.Error(), "\n")
	if len(msg) > 80 {
		msg = msg[:77] + "…"
	}
	return msg
}
