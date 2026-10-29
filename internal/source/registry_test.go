package source

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8stypes "k8s.io/apimachinery/pkg/types"

	"github.com/dguendisch/kubewing/internal/normalize"
)

type fakeOpener struct {
	watches atomic.Int32
	running atomic.Int32
	feed    chan Event
}

func (f *fakeOpener) Resolve(_, _ string) (Resolved, error) { return Resolved{Namespaced: true}, nil }

func (f *fakeOpener) Watch(ctx context.Context, _ string, _ Resolved, _ Key, out chan<- Event) {
	f.watches.Add(1)
	f.running.Add(1)
	defer f.running.Add(-1)
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-f.feed:
			out <- ev
		}
	}
}

func pod(name string) Item {
	u := &unstructured.Unstructured{}
	u.SetName(name)
	u.SetUID(k8stypes.UID("uid-" + name))
	return Item{Object: u}
}

func recv(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
		return Event{}
	}
}

func TestRegistrySharesAndRefCounts(t *testing.T) {
	f := &fakeOpener{feed: make(chan Event)}
	r := NewRegistry(f)
	k := Key{Cluster: "c", Resource: "pods"}

	a, err := r.Subscribe(k)
	if err != nil {
		t.Fatal(err)
	}
	f.feed <- Event{Type: Relist, Items: []Item{pod("x")}}
	if ev := recv(t, a.Events); ev.Type != Relist || len(ev.Items) != 1 {
		t.Fatalf("%+v", ev)
	}
	f.feed <- Event{Type: Added, Item: pod("y")}
	recv(t, a.Events)

	// late subscriber shares the watch and gets the current state
	b, _ := r.Subscribe(k)
	if ev := recv(t, b.Events); ev.Type != Relist || len(ev.Items) != 2 {
		t.Fatalf("late subscriber snapshot: %+v", ev)
	}
	if f.watches.Load() != 1 {
		t.Fatalf("watches = %d, want 1", f.watches.Load())
	}

	a.Close()
	a.Close() // idempotent
	if r.Active() != 1 {
		t.Fatal("watch stopped while still referenced")
	}
	b.Close()
	if r.Active() != 0 {
		t.Fatal("watch not released")
	}
	deadline := time.Now().Add(2 * time.Second)
	for f.running.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if f.running.Load() != 0 {
		t.Fatal("watch goroutine still running after last unsubscribe")
	}
}

// resolvingOpener resolves short names to one GVR, as discovery does.
type resolvingOpener struct{ fakeOpener }

func (f *resolvingOpener) Resolve(_, resource string) (Resolved, error) {
	if resource == "no" || resource == "node" || resource == "nodes" {
		return Resolved{GVR: nsGVR.GroupVersion().WithResource("nodes"), Kind: "Node"}, nil
	}
	return Resolved{GVR: nsGVR.GroupVersion().WithResource(resource), Namespaced: true}, nil
}

func TestRegistrySharesByResolvedResource(t *testing.T) {
	f := &resolvingOpener{fakeOpener{feed: make(chan Event)}}
	r := NewRegistry(f)
	// a nodes pane opened as "no" in namespace shop, the ops pod dialog's "nodes" watch
	a, _ := r.Subscribe(Key{Cluster: "c", Resource: "no", Namespace: "shop"})
	b, _ := r.Subscribe(Key{Cluster: "c", Resource: "nodes"})
	defer a.Close()
	defer b.Close()
	if r.Active() != 1 {
		t.Fatalf("active = %d: no and nodes must share a watch", r.Active())
	}
	// namespaced types still watch per namespace
	c, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods", Namespace: "a"})
	d, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods", Namespace: "b"})
	defer c.Close()
	defer d.Close()
	if r.Active() != 3 {
		t.Fatalf("active = %d, want 3", r.Active())
	}
}

func labelled(name, v string) Item {
	it := pod(name)
	it.Object.SetLabels(map[string]string{"v": v})
	it.Object.SetResourceVersion(v)
	return it
}

// By default a watch records nothing: items pass through as they came.
func TestRegistryNotRecording(t *testing.T) {
	f := &fakeOpener{feed: make(chan Event)}
	r := NewRegistry(f)
	a, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods"})
	defer a.Close()
	f.feed <- Event{Type: Relist, Items: []Item{labelled("x", "1")}}
	f.feed <- Event{Type: Modified, Item: labelled("x", "2")}
	recv(t, a.Events)
	if ev := recv(t, a.Events); ev.Item.Norm != nil || ev.Item.Hash != "" || a.History.Recording() {
		t.Fatalf("recorded without being asked: %+v", ev.Item)
	}
	if _, last := a.History.Range("uid-x"); last != 0 {
		t.Fatal("history kept")
	}
}

// One watch, one history: both subscribers read the same versions, the
// items come normalized, and a noise-only change is no new version.
func TestRegistryHistory(t *testing.T) {
	f := &fakeOpener{feed: make(chan Event)}
	r := NewRegistry(f)
	k := Key{Cluster: "c", Resource: "pods"}
	a, _ := r.Subscribe(k)
	defer a.Close()
	a.History.SetRecording(true)
	f.feed <- Event{Type: Relist, Items: []Item{labelled("x", "1")}}
	if ev := recv(t, a.Events); ev.Items[0].Norm == nil || ev.Items[0].Hash == "" || ev.Items[0].Norm.GetResourceVersion() != "" {
		t.Fatalf("relist item not normalized: %+v", ev.Items[0])
	}
	f.feed <- Event{Type: Modified, Item: labelled("x", "2")}
	recv(t, a.Events)
	b, _ := r.Subscribe(k)
	defer b.Close()
	recv(t, b.Events)
	if !b.History.Recording() {
		t.Fatal("recording is the watch's, not the subscriber's")
	}
	for _, s := range []*Subscription{a, b} {
		p, ok := s.History.Pair("uid-x", 0)
		if !ok || p.First != 1 || p.Last != 2 || p.Prev.Object.GetLabels()["v"] != "1" || p.Cur.Object.GetLabels()["v"] != "2" {
			t.Fatalf("%+v", p)
		}
	}
	// resourceVersion alone is noise
	x := labelled("x", "2")
	x.Object.SetResourceVersion("99")
	f.feed <- Event{Type: Modified, Item: x}
	recv(t, a.Events)
	if _, last := a.History.Range("uid-x"); last != 2 {
		t.Fatalf("noise recorded as version %d", last)
	}
}

// A watch keeps the rules it started with: a subscriber joining with other
// rules (a config reload in between) gets the running watch's.
func TestRegistryRulesFixedPerWatch(t *testing.T) {
	f := &fakeOpener{feed: make(chan Event)}
	r := NewRegistry(f)
	k := Key{Cluster: "c", Resource: "pods"}
	a, _ := r.SubscribeWith(k, normalize.New(normalize.Rule{Path: "metadata.labels"}))
	defer a.Close()
	b, _ := r.SubscribeWith(k, normalize.New())
	defer b.Close()
	b.History.SetRecording(true)
	f.feed <- Event{Type: Relist, Items: []Item{labelled("x", "1")}}
	recv(t, a.Events)
	if ev := recv(t, b.Events); ev.Items[0].Norm.GetLabels() != nil {
		t.Fatalf("joining subscriber changed the rules: %v", ev.Items[0].Norm.GetLabels())
	}
}

// A deleted object's history stays readable for a while, then goes.
func TestRegistryHistoryTombstone(t *testing.T) {
	f := &fakeOpener{feed: make(chan Event)}
	r := NewRegistry(f)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return now }
	r.TombstoneFor = time.Minute
	a, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods"})
	defer a.Close()
	a.History.SetRecording(true)
	f.feed <- Event{Type: Relist, Items: []Item{labelled("x", "1"), labelled("y", "1")}}
	recv(t, a.Events)
	f.feed <- Event{Type: Deleted, Item: pod("x")}
	recv(t, a.Events)
	if _, last := a.History.Range("uid-x"); last != 1 {
		t.Fatal("history gone with the delete")
	}
	now = now.Add(2 * time.Minute)
	f.feed <- Event{Type: Modified, Item: labelled("y", "2")}
	recv(t, a.Events)
	if _, last := a.History.Range("uid-x"); last != 0 {
		t.Fatal("tombstone history not pruned")
	}
	// a relist without y deletes it too
	f.feed <- Event{Type: Relist, Items: nil}
	recv(t, a.Events)
	now = now.Add(2 * time.Minute)
	f.feed <- Event{Type: Relist, Items: nil}
	recv(t, a.Events)
	if _, last := a.History.Range("uid-y"); last != 0 {
		t.Fatal("relisted-away object kept")
	}
}

// Switched on mid-watch, recording starts from the current objects (the
// next change already diffs); switched off, the history goes.
func TestRegistryRecordingToggle(t *testing.T) {
	f := &fakeOpener{feed: make(chan Event)}
	r := NewRegistry(f)
	a, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods"})
	defer a.Close()
	f.feed <- Event{Type: Relist, Items: []Item{labelled("x", "1")}}
	recv(t, a.Events)
	a.History.SetRecording(true)
	if first, last := a.History.Range("uid-x"); first != 1 || last != 1 {
		t.Fatalf("not seeded: %d..%d", first, last)
	}
	f.feed <- Event{Type: Modified, Item: labelled("x", "2")}
	if ev := recv(t, a.Events); ev.Item.Norm == nil {
		t.Fatal("item not normalized while recording")
	}
	if p, ok := a.History.Pair("uid-x", 0); !ok || p.Prev == nil || p.Prev.Object.GetLabels()["v"] != "1" {
		t.Fatalf("%+v", p)
	}
	a.History.SetRecording(true) // again: no reset
	if _, last := a.History.Range("uid-x"); last != 2 {
		t.Fatal("switching on again reset the history")
	}
	a.History.SetRecording(false)
	if _, last := a.History.Range("uid-x"); last != 0 || a.History.Recording() {
		t.Fatal("history kept after switching off")
	}
	f.feed <- Event{Type: Modified, Item: labelled("x", "3")}
	if ev := recv(t, a.Events); ev.Item.Norm != nil {
		t.Fatal("still normalizing after switching off")
	}
}

// restartOpener starts one feed per watch, so a test sees which watch
// (the first or the restarted one) delivers.
type restartOpener struct{ feeds chan chan Event }

func (f *restartOpener) Resolve(_, _ string) (Resolved, error) { return Resolved{Namespaced: true}, nil }

func (f *restartOpener) Watch(ctx context.Context, _ string, _ Resolved, _ Key, out chan<- Event) {
	feed := make(chan Event)
	f.feeds <- feed
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-feed:
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
	}
}

// A restart (reconnect) runs the watch anew under its subscribers: they
// stay attached, get the new list as a Relist, and nothing more from the
// old watch. Watches on other clusters keep running.
func TestRegistryRestart(t *testing.T) {
	f := &restartOpener{feeds: make(chan chan Event, 4)}
	r := NewRegistry(f)
	a, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods"})
	defer a.Close()
	other, _ := r.Subscribe(Key{Cluster: "d", Resource: "pods"})
	defer other.Close()
	first := <-f.feeds
	<-f.feeds // d's
	first <- Event{Type: Relist, Items: []Item{pod("x")}}
	recv(t, a.Events)
	first <- Event{Type: Error, Err: "connection refused"}
	recv(t, a.Events)

	if n := r.Restart("c"); n != 1 {
		t.Fatalf("restarted %d watches, want 1", n)
	}
	var second chan Event
	select {
	case second = <-f.feeds:
	case <-time.After(2 * time.Second):
		t.Fatal("no new watch")
	}
	select {
	case first <- Event{Type: Added, Item: pod("stale")}:
		t.Fatal("the old watch still runs")
	case <-time.After(50 * time.Millisecond):
	}
	second <- Event{Type: Relist, Items: []Item{pod("x"), pod("y")}}
	if ev := recv(t, a.Events); ev.Type != Relist || len(ev.Items) != 2 {
		t.Fatalf("%+v", ev)
	}
	// a late subscriber sees the new state, without the old error
	b, _ := r.Subscribe(Key{Cluster: "c", Resource: "pods"})
	defer b.Close()
	if ev := recv(t, b.Events); ev.Type != Relist || len(ev.Items) != 2 {
		t.Fatalf("%+v", ev)
	}
	select {
	case ev := <-b.Events:
		t.Fatalf("unexpected %+v", ev)
	default:
	}
	if r.Active() != 2 {
		t.Fatalf("active = %d", r.Active())
	}
}
