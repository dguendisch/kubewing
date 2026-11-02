package source

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8stypes "k8s.io/apimachinery/pkg/types"
)

// listingOpener serves resource types and metadata lists, as a snapshot
// needs; it watches nothing.
type listingOpener struct {
	fakeOpener
	mu      sync.Mutex
	types   []ResourceType
	objects map[string][]*unstructured.Unstructured // qualified resource → objects (any namespace)
	failing map[string]error
	lists   atomic.Int32
}

func (l *listingOpener) ResourceTypes(context.Context, string, bool) ([]ResourceType, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]ResourceType{}, l.types...), nil
}

func (l *listingOpener) Namespaces(context.Context, string) ([]string, error) { return nil, nil }

func (l *listingOpener) Changes(ctx context.Context, _ string, _ chan<- Change) { <-ctx.Done() }

func (l *listingOpener) ListMetadata(_ context.Context, _, resource, namespace, _, _ string) ([]*unstructured.Unstructured, error) {
	l.lists.Add(1)
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.failing[resource]; err != nil {
		return nil, err
	}
	var out []*unstructured.Unstructured
	for _, u := range l.objects[resource] {
		if u.GetNamespace() == namespace {
			// as a metadata list answers: PartialObjectMetadata
			c := u.DeepCopy()
			c.SetAPIVersion("meta.k8s.io/v1")
			c.SetKind("PartialObjectMetadata")
			out = append(out, c)
		}
	}
	return out, nil
}

func metaObj(ns, name string, mod func(u *unstructured.Unstructured)) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]any{}}
	u.SetNamespace(ns)
	u.SetName(name)
	u.SetUID(k8stypes.UID(ns + "-" + name))
	u.SetCreationTimestamp(metav1.Unix(1_700_000_000, 0))
	if mod != nil {
		mod(u)
	}
	return u
}

func shop() *listingOpener {
	yes := true
	return &listingOpener{
		types: []ResourceType{
			{Name: "configmaps", Version: "v1", Kind: "ConfigMap", Namespaced: true},
			{Name: "events", Version: "v1", Kind: "Event", Namespaced: true},
			{Name: "events", Group: "events.k8s.io", Version: "v1", Kind: "Event", Namespaced: true},
			{Name: "machines", Group: "cluster.x-k8s.io", Version: "v1beta1", Kind: "Machine", Namespaced: true},
			{Name: "machines", Group: "machine.sapcloud.io", Version: "v1alpha1", Kind: "Machine", Namespaced: true},
			{Name: "nodes", Version: "v1", Kind: "Node"},
			{Name: "pods", Version: "v1", Kind: "Pod", Namespaced: true},
			{Name: "secrets", Version: "v1", Kind: "Secret", Namespaced: true},
		},
		objects: map[string][]*unstructured.Unstructured{
			"configmaps": {metaObj("shop", "cfg", nil), metaObj("other", "cfg", nil)},
			"events":     {metaObj("shop", "ev", nil)},
			"machines.cluster.x-k8s.io": {metaObj("shop", "m-0", func(u *unstructured.Unstructured) {
				u.SetFinalizers([]string{"machine.cluster.x-k8s.io", "foo"})
				ts := metav1.Unix(1_700_000_100, 0)
				u.SetDeletionTimestamp(&ts)
			})},
			"pods": {metaObj("shop", "web-0", func(u *unstructured.Unstructured) {
				u.SetOwnerReferences([]metav1.OwnerReference{
					{APIVersion: "v1", Kind: "Node", Name: "n1", UID: "n"},
					{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "web", UID: "w", Controller: &yes},
				})
			})},
		},
		failing: map[string]error{"secrets": errors.New("secrets is forbidden: User \"jdoe\" cannot list\nmore")},
	}
}

func recvType(t *testing.T, ch <-chan Event, typ EventType) Event {
	t.Helper()
	for {
		ev := recv(t, ch)
		if ev.Type == typ && (typ != Listed || ev.Listing.At != "") {
			return ev
		}
	}
}

func TestSnapshotListsEveryNamespacedType(t *testing.T) {
	l := shop()
	r := NewRegistry(l)
	sub, err := r.Subscribe(Key{Cluster: "c", Resource: "all", Namespace: "shop"})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	if sub.Resolved.Kind != AllKind {
		t.Fatalf("kind = %q", sub.Resolved.Kind)
	}
	ev := recvType(t, sub.Events, Relist)
	if len(ev.Columns) != len(SnapshotColumns) {
		t.Fatalf("columns: %+v", ev.Columns)
	}
	got := map[string][]any{}
	for _, it := range ev.Items {
		got[it.Object.GetAPIVersion()+" "+it.Object.GetKind()+" "+it.Object.GetName()] = it.Cells
	}
	want := map[string][]any{
		// a kind of two groups names its group; the owner is the controller, +1 other
		"v1 ConfigMap cfg":                     {"ConfigMap", "cfg", "", "", "", ""},
		"v1 Pod web-0":                         {"Pod", "web-0", "StatefulSet/web +1", "", "", ""},
		"cluster.x-k8s.io/v1beta1 Machine m-0": {"Machine.cluster.x-k8s.io", "m-0", "", "", "", "machine.cluster.x-k8s.io,foo"},
	}
	if len(got) != len(want) {
		t.Fatalf("items: %v", got)
	}
	for k, cells := range want {
		if c, ok := got[k]; !ok || len(c) != len(cells) {
			t.Fatalf("%s: %v (all: %v)", k, c, got)
		}
		for i := range cells {
			if got[k][i] != cells[i] {
				t.Errorf("%s cell %d = %v, want %v", k, i, got[k][i], cells[i])
			}
		}
	}
	// events, cluster-scoped types and the other namespace are not listed; secrets failed
	done := recvType(t, sub.Events, Listed).Listing
	if done.Types != 5 || done.Done != 5 {
		t.Fatalf("listing: %+v", done)
	}
	if len(done.Skipped) != 1 || done.Skipped[0].Resource != "secrets" || done.Skipped[0].Reason != `secrets is forbidden: User "jdoe" cannot list` {
		t.Fatalf("skipped: %+v", done.Skipped)
	}
}

func TestSnapshotNeedsANamespace(t *testing.T) {
	r := NewRegistry(shop())
	for _, k := range []Key{{Resource: "all"}, {Resource: "all", Namespace: "*"}, {Resource: "ALL", Namespace: "shop", LabelSelector: "a=b"}} {
		if _, err := r.Subscribe(k); err == nil {
			t.Errorf("%+v: no error", k)
		}
	}
}

// A refresh lists again: subscribers see the new listing as a relist, and
// a late subscriber gets the last one (and its outcome) without a list.
func TestSnapshotRefresh(t *testing.T) {
	l := shop()
	r := NewRegistry(l)
	a, _ := r.Subscribe(Key{Cluster: "c", Resource: "all", Namespace: "shop"})
	defer a.Close()
	recvType(t, a.Events, Listed)
	lists := l.lists.Load()

	b, _ := r.Subscribe(Key{Cluster: "c", Resource: "all", Namespace: "shop"})
	defer b.Close()
	if ev := recv(t, b.Events); ev.Type != Relist || len(ev.Items) != 3 {
		t.Fatalf("late subscriber: %+v", ev)
	}
	if ev := recv(t, b.Events); ev.Type != Listed || ev.Listing.At == "" {
		t.Fatalf("late subscriber's listing: %+v", ev)
	}
	if l.lists.Load() != lists || r.Active() != 1 {
		t.Fatalf("a late subscriber listed again (%d → %d lists, %d active)", lists, l.lists.Load(), r.Active())
	}

	l.mu.Lock()
	l.objects["configmaps"] = append(l.objects["configmaps"], metaObj("shop", "new", nil))
	l.types = append(l.types, ResourceType{Name: "widgets", Group: "x.io", Version: "v1", Kind: "Widget", Namespaced: true})
	l.objects["widgets.x.io"] = []*unstructured.Unstructured{metaObj("shop", "w", nil)}
	l.mu.Unlock()
	a.Restart()
	ev := recvType(t, a.Events, Relist)
	if len(ev.Items) != 5 {
		t.Fatalf("after refresh: %d items, want 5 (a new config map, a new CRD's object)", len(ev.Items))
	}
	recvType(t, b.Events, Relist) // the other split sees it too
}
