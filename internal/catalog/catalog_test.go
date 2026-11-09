package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	"github.com/dguendisch/kubewing/internal/source"
)

type fakeLister struct {
	mu       sync.Mutex
	res      []source.ResourceType
	resErr   error
	ns       []string
	nsErr    error
	calls    map[string]int
	refresh  []bool
	changes  chan source.Change
	watching chan struct{}
}

func newFake() *fakeLister {
	return &fakeLister{
		res:      []source.ResourceType{{Name: "pods", Version: "v1", Namespaced: true}},
		ns:       []string{"b", "a"},
		calls:    map[string]int{},
		changes:  make(chan source.Change),
		watching: make(chan struct{}, 1),
	}
}

func (f *fakeLister) ResourceTypes(_ context.Context, cluster string, refresh bool) ([]source.ResourceType, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls["res:"+cluster]++
	f.refresh = append(f.refresh, refresh)
	return append([]source.ResourceType(nil), f.res...), f.resErr
}

func (f *fakeLister) Namespaces(_ context.Context, cluster string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls["ns:"+cluster]++
	return append([]string(nil), f.ns...), f.nsErr
}

func (f *fakeLister) Changes(ctx context.Context, _ string, out chan<- source.Change) {
	f.watching <- struct{}{}
	for {
		select {
		case <-ctx.Done():
			return
		case c := <-f.changes:
			out <- c
		}
	}
}

func (f *fakeLister) set(fn func(f *fakeLister)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeLister) count(k string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[k]
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func loaded(c *Catalog, ctx string, minGen uint64) func() bool {
	return func() bool {
		s := c.Get(ctx, false)
		return !s.Loading && s.Gen >= minGen
	}
}

func TestUntrackedContextNeverConnects(t *testing.T) {
	f := newFake()
	c := New(f, Options{})
	defer c.Close()
	s := c.Get("prod", false)
	if s.Loading || len(s.Resources) != 0 || s.Resources == nil || s.Namespaces == nil {
		t.Fatalf("untracked snapshot = %+v, want empty (non-nil lists), not loading", s)
	}
	c.Invalidate("prod")
	time.Sleep(20 * time.Millisecond)
	if n := f.count("res:prod") + f.count("ns:prod"); n != 0 {
		t.Fatalf("lister called %d times for an untracked context", n)
	}
}

func TestTrackFetchesInBackground(t *testing.T) {
	f := newFake()
	c := New(f, Options{})
	defer c.Close()
	if s := c.Get("dev", true); !s.Loading {
		t.Fatalf("first Get = %+v, want loading", s)
	}
	waitFor(t, "load", loaded(c, "dev", 2))
	s := c.Get("dev", false)
	if len(s.Resources) != 1 || s.Resources[0].Name != "pods" {
		t.Fatalf("resources = %+v", s.Resources)
	}
	if got := s.Namespaces; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("namespaces = %v, want sorted [a b]", got)
	}
	if s.Errors != nil || s.Partial {
		t.Fatalf("unexpected errors/partial: %+v", s)
	}
	// initial fetch uses cached discovery (the mapper just populated it)
	if f.refresh[0] {
		t.Fatal("initial fetch should not bypass the discovery cache")
	}
}

// A context still loading has empty lists, never null ones: ⌘⇧O opens ⌘O on
// a catalog that just started, and the dialog iterates them.
func TestLoadingSnapshotHasEmptyLists(t *testing.T) {
	f := newFake()
	c := New(f, Options{})
	defer c.Close()
	c.Track("dev")
	b, err := json.Marshal(c.Get("dev", false))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "null") {
		t.Fatalf("snapshot = %s", b)
	}
}

func TestPartialDiscoveryIsUsable(t *testing.T) {
	f := newFake()
	f.resErr = &discovery.ErrGroupDiscoveryFailed{Groups: map[schema.GroupVersion]error{
		{Group: "metrics.k8s.io", Version: "v1beta1"}: errors.New("service unavailable"),
	}}
	c := New(f, Options{})
	defer c.Close()
	c.Track("dev")
	waitFor(t, "load", loaded(c, "dev", 2))
	s := c.Get("dev", false)
	if !s.Partial || len(s.Resources) != 1 || s.Errors["resources"] != "" {
		t.Fatalf("partial discovery: %+v, want partial with resources and no error", s)
	}
}

func TestForbiddenNamespacesKeepResources(t *testing.T) {
	f := newFake()
	f.nsErr = errors.New(`namespaces is forbidden: User "dev" cannot list resource "namespaces"`)
	c := New(f, Options{})
	defer c.Close()
	c.Track("dev")
	waitFor(t, "load", loaded(c, "dev", 2))
	s := c.Get("dev", false)
	if len(s.Resources) != 1 || len(s.Namespaces) != 0 || s.Errors["namespaces"] == "" {
		t.Fatalf("forbidden namespaces: %+v", s)
	}
}

func TestChangesAndInvalidateRefetch(t *testing.T) {
	f := newFake()
	c := New(f, Options{Debounce: time.Millisecond})
	defer c.Close()
	c.Track("dev")
	waitFor(t, "load", loaded(c, "dev", 2))
	<-f.watching

	// new CRD: resources refetched with a discovery refresh, namespaces not
	f.set(func(f *fakeLister) {
		f.res = append(f.res, source.ResourceType{Name: "shoots", Group: "core.gardener.cloud", Version: "v1beta1", Namespaced: true})
	})
	f.changes <- source.ResourcesChanged
	waitFor(t, "crd refetch", func() bool { return len(c.Get("dev", false).Resources) == 2 })
	if f.count("ns:dev") != 1 {
		t.Fatalf("namespaces refetched on a CRD change (%d calls)", f.count("ns:dev"))
	}
	if !f.refresh[len(f.refresh)-1] {
		t.Fatal("change-triggered fetch must bypass the discovery cache")
	}

	f.set(func(f *fakeLister) { f.ns = append(f.ns, "c") })
	f.changes <- source.NamespacesChanged
	waitFor(t, "ns refetch", func() bool { return len(c.Get("dev", false).Namespaces) == 3 })

	before := f.count("res:dev")
	c.Invalidate("dev")
	waitFor(t, "invalidate refetch", func() bool { return f.count("res:dev") > before })
}

func TestFailedRefreshKeepsLastGoodState(t *testing.T) {
	f := newFake()
	c := New(f, Options{Debounce: time.Millisecond})
	defer c.Close()
	c.Track("dev")
	waitFor(t, "load", loaded(c, "dev", 2))
	gen := c.Get("dev", false).Gen
	f.set(func(f *fakeLister) {
		f.resErr, f.nsErr = errors.New("connection refused"), errors.New("connection refused")
	})
	c.Invalidate("dev")
	waitFor(t, "refetch", loaded(c, "dev", gen+1))
	s := c.Get("dev", false)
	if len(s.Resources) != 1 || len(s.Namespaces) != 2 || s.Errors != nil {
		t.Fatalf("after failed refresh: %+v, want last good lists and no error", s)
	}
}

func TestIdleContextsAreDropped(t *testing.T) {
	f := newFake()
	now := time.Unix(0, 0)
	var mu sync.Mutex
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	c := New(f, Options{Idle: time.Minute, Now: clock})
	defer c.Close()
	c.Track("old")
	waitFor(t, "load", loaded(c, "old", 2))
	mu.Lock()
	now = now.Add(2 * time.Minute)
	mu.Unlock()
	c.Track("new") // any access collects idle entries
	if s := c.Get("old", false); s.Loading || len(s.Resources) != 0 {
		t.Fatalf("idle context still tracked: %+v", s)
	}
}

func TestSnapshotsAreCopies(t *testing.T) {
	f := newFake()
	c := New(f, Options{})
	defer c.Close()
	c.Track("dev")
	waitFor(t, "load", loaded(c, "dev", 2))
	s := c.Get("dev", false)
	s.Namespaces[0] = "mutated"
	if c.Get("dev", false).Namespaces[0] != "a" {
		t.Fatal("snapshot shares memory with the catalog")
	}
}
