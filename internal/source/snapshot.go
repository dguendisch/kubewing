package source

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// AllResources is the resource name of a namespace's snapshot: every
// listable namespaced type listed once (metadata only), as
// `kubectl api-resources --namespaced -o name | xargs kubectl get` would,
// not `kubectl get all` (a category: pods, services, workloads only).
const AllResources = "all"

// AllKind is the snapshot's Resolved.Kind; its rows carry their own kinds.
const AllKind = "*"

// IsAll reports whether a pipeline resource names the snapshot.
func IsAll(resource string) bool { return strings.EqualFold(strings.TrimSpace(resource), AllResources) }

// Snapshot parameters: how many lists run at once, how long one listing may take.
const (
	snapshotParallel = 8
	snapshotWait     = 60 * time.Second
)

// SnapshotLister is what a snapshot needs from an opener: the context's
// resource types and metadata lists (real clusters and tapes have both).
type SnapshotLister interface {
	Lister
	ListMetadata(ctx context.Context, cluster, resource, namespace, labelSel, fieldSel string) ([]*unstructured.Unstructured, error)
}

// Listing is a snapshot's progress and outcome, sent as an Event of type
// Listed: while listing (Done < Types) and once done.
type Listing struct {
	// Types: the resource types listed; Done of them answered so far.
	Types int `json:"types"`
	Done  int `json:"done"`
	// At: when the last complete listing finished (RFC 3339; "" = none yet).
	At string `json:"at,omitempty"`
	// Skipped: types that failed (forbidden, gone, an aggregated API down), by qualified name, with why.
	Skipped []SkippedType `json:"skipped,omitempty"`
}

// SkippedType is a resource type a snapshot couldn't list.
type SkippedType struct {
	Resource string `json:"resource"`
	Reason   string `json:"reason"`
}

// SnapshotTypes are the types a snapshot lists: namespaced ones, each
// group/kind once, events left out (core and events.k8s.io: they are about
// objects, and there are many).
func SnapshotTypes(types []ResourceType) []ResourceType {
	var out []ResourceType
	seen := map[string]bool{}
	for _, t := range types {
		if !t.Namespaced || t.Kind == "Event" || seen[t.Group+"/"+t.Kind] {
			continue
		}
		seen[t.Group+"/"+t.Kind] = true
		out = append(out, t)
	}
	return out
}

// SnapshotColumns are a snapshot's table columns, as a server's Table
// would send them: AGE and DELETING are dates (shown as ages, re-derived
// from the timestamps), the rest are cells (see snapshotCells).
var SnapshotColumns = []metav1.TableColumnDefinition{
	{Name: "Kind", Type: "string", Description: "the kind, with its group when several groups serve it"},
	{Name: "Name", Type: "string", Format: "name"},
	{Name: "Owner", Type: "string", Description: "the controller (else the first owner), kind/name; +n more owners"},
	{Name: "Age", Type: "date"},
	{Name: "Deleting", Type: "date", Description: "since the deletion was requested (deletionTimestamp)"},
	{Name: "Finalizers", Type: "string"},
}

// snapshotCells are an object's cells for SnapshotColumns; kind as shown.
func snapshotCells(u *unstructured.Unstructured, kind string) []any {
	owner := ""
	refs := u.GetOwnerReferences()
	if len(refs) > 0 {
		pick := refs[0]
		for _, r := range refs {
			if r.Controller != nil && *r.Controller {
				pick = r
				break
			}
		}
		owner = pick.Kind + "/" + pick.Name
		if len(refs) > 1 {
			owner += fmt.Sprintf(" +%d", len(refs)-1)
		}
	}
	return []any{kind, u.GetName(), owner, "", "", strings.Join(u.GetFinalizers(), ",")}
}

// kindLabels is the KIND cell per type (by qualified name): the kind, with
// its group where several groups serve the same kind (Machine.cluster.x-k8s.io).
func kindLabels(types []ResourceType) map[string]string {
	groups := map[string]int{}
	for _, t := range types {
		groups[t.Kind]++
	}
	out := make(map[string]string, len(types))
	for _, t := range types {
		out[t.Qualified()] = t.Kind
		if groups[t.Kind] > 1 && t.Group != "" {
			out[t.Qualified()] = t.Kind + "." + t.Group
		}
	}
	return out
}

// kindTyper is implemented by openers whose resource types for listing
// differ from the catalog's (tapes: one per kind they serve).
type kindTyper interface {
	RelationTypes() []ResourceType
}

// snapshot lists every type once (no watches: a live view would hold one
// watch per type) and sends the merged objects as one Relist, then idles
// until ctx ends. A refresh is a restart of the shared source (see
// Registry.Restart): the new Relist diffs against the last one, so
// subscribers see what was added, removed and changed meanwhile.
func snapshot(ctx context.Context, l SnapshotLister, cluster, namespace string, out chan<- Event) {
	// refresh: new CRDs since the last listing are listed too
	types, err := l.ResourceTypes(ctx, cluster, true)
	if kt, ok := l.(kindTyper); ok {
		types, err = kt.RelationTypes(), nil
	}
	if len(types) == 0 && err != nil {
		send(ctx, out, Event{Type: Error, Err: "resource types: " + errText(err)})
		<-ctx.Done()
		return
	}
	types = SnapshotTypes(types)
	kinds := kindLabels(types)
	prog := Listing{Types: len(types)}
	// events carry copies: the receiver keeps the pointer while prog counts on
	start := prog
	send(ctx, out, Event{Type: Listed, Listing: &start})

	lctx, cancel := context.WithTimeout(ctx, snapshotWait)
	defer cancel()
	type result struct {
		rt    ResourceType
		items []*unstructured.Unstructured
		err   error
	}
	results := make(chan result)
	sem := make(chan struct{}, snapshotParallel)
	var wg sync.WaitGroup
	for _, rt := range types {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-lctx.Done():
				results <- result{rt: rt, err: lctx.Err()}
				return
			}
			defer func() { <-sem }()
			items, err := l.ListMetadata(lctx, cluster, rt.Qualified(), namespace, "", "")
			results <- result{rt, items, err}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()
	var items []Item
	var last time.Time
	for r := range results {
		prog.Done++
		if r.err != nil {
			prog.Skipped = append(prog.Skipped, SkippedType{Resource: r.rt.Qualified(), Reason: firstLine(errText(r.err))})
		}
		for _, u := range r.items {
			u = stamped(u, r.rt)
			items = append(items, Item{Object: u, Cells: snapshotCells(u, kinds[r.rt.Qualified()])})
		}
		// progress at most every 100ms: a hundred types answer in a burst
		if time.Since(last) >= 100*time.Millisecond && prog.Done < prog.Types {
			last = time.Now()
			p := prog
			p.Skipped = nil
			if !send(ctx, out, Event{Type: Listed, Listing: &p}) {
				return
			}
		}
	}
	if ctx.Err() != nil {
		return
	}
	sort.Slice(prog.Skipped, func(i, j int) bool { return prog.Skipped[i].Resource < prog.Skipped[j].Resource })
	prog.At = time.Now().UTC().Format(time.RFC3339)
	if !send(ctx, out, Event{Type: Relist, Items: items, Columns: SnapshotColumns}) || !send(ctx, out, Event{Type: Listed, Listing: &prog}) {
		return
	}
	<-ctx.Done()
}

// stamped is a listed object with its type's apiVersion and kind: metadata
// lists say PartialObjectMetadata (tapes say the real ones already).
func stamped(u *unstructured.Unstructured, rt ResourceType) *unstructured.Unstructured {
	if u.GetKind() == rt.Kind && rt.Kind != "" {
		return u
	}
	gv := rt.Version
	if rt.Group != "" {
		gv = rt.Group + "/" + rt.Version
	}
	if rt.Version == "" {
		gv = u.GetAPIVersion()
	}
	u.SetAPIVersion(gv)
	if rt.Kind != "" {
		u.SetKind(rt.Kind)
	}
	return u
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

// snapshotWatch runs a snapshot for k on the registry's opener; it must
// list metadata (see SnapshotLister).
func (r *Registry) snapshotWatch(ctx context.Context, k Key, out chan<- Event) {
	l, ok := r.opener.(SnapshotLister)
	if !ok {
		send(ctx, out, Event{Type: Error, Err: fmt.Sprintf("%q isn't available on this source", AllResources)})
		<-ctx.Done()
		return
	}
	snapshot(ctx, l, k.Cluster, k.Namespace, out)
}
