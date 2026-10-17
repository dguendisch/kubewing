package bridge

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/source"
)

// catalogOpener resolves only "pods" and records which clusters the
// catalog asked about.
type catalogOpener struct {
	stormOpener
	mu    sync.Mutex
	asked map[string]int
}

func (o *catalogOpener) Resolve(_, resource string) (source.Resolved, error) {
	if resource != "pods" {
		return source.Resolved{}, errors.New("the server doesn't have a resource type")
	}
	return source.Resolved{Kind: "Pod", Namespaced: true}, nil
}

func (o *catalogOpener) ResourceTypes(_ context.Context, cluster string, _ bool) ([]source.ResourceType, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.asked[cluster]++
	return []source.ResourceType{{Name: "pods", Version: "v1", Namespaced: true}}, nil
}

func (o *catalogOpener) Namespaces(context.Context, string) ([]string, error) {
	return []string{"ns"}, nil
}

func (o *catalogOpener) Changes(ctx context.Context, _ string, _ chan<- source.Change) { <-ctx.Done() }

func (o *catalogOpener) count(cluster string) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.asked[cluster]
}

func TestCatalogOnlyForOpenedContexts(t *testing.T) {
	op := &catalogOpener{stormOpener: stormOpener{n: 1}, asked: map[string]int{}}
	cat := catalog.New(op, catalog.Options{Debounce: time.Millisecond})
	defer cat.Close()
	svc := New(source.NewRegistry(op), &recorder{}, Options{Catalog: cat})

	// asking about a context must not connect to it (no background logins)
	if s := svc.Catalog("prod"); s.Loading || len(s.Resources) != 0 {
		t.Fatalf("untouched context: %+v", s)
	}
	res, err := svc.Open("source: {cluster: dev, resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	deadline := time.Now().Add(2 * time.Second)
	for s := svc.Catalog("dev"); s.Loading || len(s.Resources) == 0; s = svc.Catalog("dev") {
		if time.Now().After(deadline) {
			t.Fatalf("catalog for opened context never loaded: %+v", s)
		}
		time.Sleep(5 * time.Millisecond)
	}

	// a resolve miss (maybe a new CRD) refetches resource types
	before := op.count("dev")
	if _, err := svc.Open("source: {cluster: dev, resource: shoots}"); err == nil {
		t.Fatal("want resolve error")
	}
	for op.count("dev") == before {
		if time.Now().After(deadline) {
			t.Fatal("resolve miss did not refetch resource types")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if op.count("prod") != 0 {
		t.Fatal("catalog connected to a context nobody opened")
	}
}
