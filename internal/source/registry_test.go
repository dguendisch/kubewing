package source

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8stypes "k8s.io/apimachinery/pkg/types"
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
