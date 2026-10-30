package bridge

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// metricsOpener serves three static pods and fakes metrics.k8s.io,
// counting polls per source. The rest of source.Actor isn't used.
type metricsOpener struct {
	stormOpener
	source.Actor
	unavailable bool

	mu    sync.Mutex
	polls map[source.Key]int
}

func (o *metricsOpener) Watch(ctx context.Context, _ string, _ source.Resolved, _ source.Key, out chan<- source.Event) {
	items := []source.Item{obj(0, 0), obj(1, 0), obj(2, 0)}
	select {
	case out <- source.Event{Type: source.Relist, Items: items}:
	case <-ctx.Done():
	}
	<-ctx.Done()
}

func (o *metricsOpener) Usage(_ context.Context, _ string, k source.Key, kind string) (map[string]source.Usage, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.polls[k]++
	if o.unavailable {
		return nil, fmt.Errorf("%w: forbidden", source.ErrNoMetrics)
	}
	return map[string]source.Usage{"ns/pod-00001": {CPU: int64(100 * o.polls[k]), Memory: 1 << 20}}, nil
}

func (o *metricsOpener) count(k source.Key) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.polls[k]
}

func (o *metricsOpener) ContextName(c string) (string, error) { return c, nil }

func metricsService(t *testing.T, o *metricsOpener) (*Service, *recorder) {
	t.Helper()
	o.polls = map[source.Key]int{}
	rec := &recorder{}
	svc := New(source.NewRegistry(o), rec, Options{Actor: o, MetricsInterval: 20 * time.Millisecond})
	t.Cleanup(svc.Shutdown)
	return svc, rec
}

func paneCells(t *testing.T, _ *Service, rec *recorder, id string) map[string][]string {
	t.Helper()
	frames, _ := rec.snapshot()
	out := map[string][]string{}
	for _, f := range frames {
		if f.Pane != id {
			continue
		}
		for _, r := range f.Frame.Rows {
			out[r.Key] = r.Cells
		}
	}
	return out
}

var podsKey = source.Key{Resource: "pods", Namespace: "ns"}

// Polling runs only while a pane shows a metric column, shared by the panes
// on the same source; a pane hiding them or closing stops it.
func TestMetricsPolling(t *testing.T) {
	o := &metricsOpener{}
	svc, rec := metricsService(t, o)
	a, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if n := o.count(podsKey); n != 0 {
		t.Fatalf("polled %d times without metric columns", n)
	}

	cols := []pipeline.Column{{Name: "NAME"}, {Name: "CPU"}, {Name: "MEM"}}
	if err := svc.SetTypeColumns("pods", cols); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { c := paneCells(t, svc, rec, a.Pane)["u1"]; return len(c) == 3 && c[1] != "" })
	if c := paneCells(t, svc, rec, a.Pane)["u1"]; c[2] != "1.0Mi" {
		t.Fatalf("cells = %q", c)
	}
	// it keeps polling: the numbers move
	first := paneCells(t, svc, rec, a.Pane)["u1"][1]
	waitFor(t, func() bool { return paneCells(t, svc, rec, a.Pane)["u1"][1] != first })

	// a split on the same source shares the poller
	b, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	n := len(svc.feeds)
	svc.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d pollers for one source", n)
	}
	// and gets the last poll at once, not only after the next one
	waitFor(t, func() bool { c := paneCells(t, svc, rec, b.Pane)["u1"]; return len(c) == 3 && c[1] != "" })

	svc.Close(a.Pane)
	before := o.count(podsKey)
	time.Sleep(60 * time.Millisecond)
	if o.count(podsKey) == before {
		t.Fatal("stopped while a pane still shows the columns")
	}
	// hiding the columns stops it
	if err := svc.SetTypeColumns("pods", nil); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	n = len(svc.feeds)
	svc.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d pollers after hiding the columns", n)
	}
	before = o.count(podsKey)
	time.Sleep(60 * time.Millisecond)
	if after := o.count(podsKey); after > before+1 {
		t.Fatalf("still polling: %d → %d", before, after)
	}
	svc.Close(b.Pane)
}

// No metrics-server (or forbidden): empty cells, a hint in the status line.
func TestMetricsUnavailableHint(t *testing.T) {
	o := &metricsOpener{unavailable: true}
	svc, rec := metricsService(t, o)
	if err := svc.SetTypeColumns("pods", []pipeline.Column{{Name: "NAME"}, {Name: "CPU"}}); err != nil {
		t.Fatal(err)
	}
	a, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(a.Pane)
	waitFor(t, func() bool {
		if len(paneCells(t, svc, rec, a.Pane)["u1"]) == 0 {
			return false
		}
		frames, _ := rec.snapshot()
		for _, f := range frames {
			if f.Pane == a.Pane && f.Frame.Status != nil && f.Frame.Status.MetricsError == "metrics unavailable: forbidden" {
				return true
			}
		}
		return false
	})
	if c := paneCells(t, svc, rec, a.Pane)["u1"]; len(c) != 2 || c[1] != "" {
		t.Fatalf("cells = %q", c)
	}
}

// allocOpener serves nodes, and unfinished pods (the field selector the
// allocation feed watches) whose events the test sends.
type allocOpener struct {
	source.Actor
	pods chan source.Event

	mu      sync.Mutex
	watches int // pod watches started
}

func (o *allocOpener) Resolve(_, resource string) (source.Resolved, error) {
	if resource == "pods" {
		return source.Resolved{Kind: "Pod", Namespaced: true}, nil
	}
	return source.Resolved{Kind: "Node"}, nil
}

func node(name string) source.Item {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Node",
		"metadata": map[string]any{"name": name, "uid": name},
		"status":   map[string]any{"allocatable": map[string]any{"cpu": "2", "memory": "1Gi"}},
	}}
	return source.Item{Object: u, Cells: []any{name}}
}

func allocPod(name, node, cpu string) source.Item {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": name, "namespace": "ns", "uid": name},
		"spec": map[string]any{"nodeName": node, "containers": []any{map[string]any{"name": "c", "resources": map[string]any{
			"requests": map[string]any{"cpu": cpu},
		}}}},
	}}
	return source.Item{Object: u}
}

func (o *allocOpener) Watch(ctx context.Context, _ string, res source.Resolved, k source.Key, out chan<- source.Event) {
	if res.Kind == "Node" {
		select {
		case out <- source.Event{Type: source.Relist, Items: []source.Item{node("n1"), node("n2")}}:
		case <-ctx.Done():
		}
		<-ctx.Done()
		return
	}
	if k.FieldSelector != source.UnfinishedPods {
		panic("pods watched without the unfinished selector: " + k.FieldSelector)
	}
	o.mu.Lock()
	o.watches++
	o.mu.Unlock()
	for {
		select {
		case ev := <-o.pods:
			out <- ev
		case <-ctx.Done():
			return
		}
	}
}

func (o *allocOpener) ContextName(c string) (string, error) { return c, nil }

// The node allocation columns sum the pods on each node from one shared
// watch, follow pod changes and deletes, need no metrics-server, and stop
// the watch when hidden.
func TestAllocationFeed(t *testing.T) {
	o := &allocOpener{pods: make(chan source.Event, 16)}
	rec := &recorder{}
	reg := source.NewRegistry(o)
	svc := New(reg, rec, Options{Actor: o})
	t.Cleanup(svc.Shutdown)
	if err := svc.SetTypeColumns("nodes", []pipeline.Column{{Name: "NAME"}, {Name: "%CPU REQ"}}); err != nil {
		t.Fatal(err)
	}
	a, err := svc.Open("source: {resource: nodes}")
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.Open("source: {resource: nodes}")
	if err != nil {
		t.Fatal(err)
	}
	// until the pods are listed, the status line says it's loading
	status := func(id string) (loading bool, err string) {
		frames, _ := rec.snapshot()
		for _, f := range frames {
			if f.Pane == id && f.Frame.Status != nil {
				loading, err = f.Frame.Status.AllocLoading, f.Frame.Status.AllocError
			}
		}
		return
	}
	waitFor(t, func() bool { l, _ := status(a.Pane); return l })
	// an error before the first list ends the loading with it
	o.pods <- source.Event{Type: source.Error, Err: "pods is forbidden\nHTTP 403 Forbidden"}
	waitFor(t, func() bool { l, e := status(a.Pane); return !l && e == "requests/limits: pods is forbidden" })
	o.pods <- source.Event{Type: source.Relist, Items: []source.Item{allocPod("p1", "n1", "500m"), allocPod("p2", "n1", "500m"), allocPod("pending", "", "1")}}
	cell := func(id, key string) string {
		c := paneCells(t, svc, rec, id)[key]
		if len(c) < 2 {
			return "?"
		}
		return c[1]
	}
	waitFor(t, func() bool { return cell(a.Pane, "n1") == "50%" && cell(a.Pane, "n2") == "0%" })
	if l, e := status(a.Pane); l || e != "" {
		t.Fatalf("after the list: loading %v, error %q", l, e)
	}
	waitFor(t, func() bool { return cell(b.Pane, "n1") == "50%" })
	o.mu.Lock()
	if o.watches != 1 {
		t.Fatalf("%d pod watches for two panes", o.watches)
	}
	o.mu.Unlock()

	// a pod scheduled, one changed, one gone
	o.pods <- source.Event{Type: source.Modified, Item: allocPod("pending", "n2", "1")}
	o.pods <- source.Event{Type: source.Modified, Item: allocPod("p1", "n1", "1500m")}
	o.pods <- source.Event{Type: source.Deleted, Item: allocPod("p2", "n1", "500m")}
	waitFor(t, func() bool { return cell(a.Pane, "n1") == "75%" && cell(a.Pane, "n2") == "50%" })
	frames, _ := rec.snapshot()
	for _, f := range frames {
		if f.Frame.Status != nil && f.Frame.Status.MetricsError != "" {
			t.Fatalf("hint without usage columns: %q", f.Frame.Status.MetricsError)
		}
	}

	if err := svc.SetTypeColumns("nodes", nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return reg.Active() == 1 }) // only the nodes watch is left
	svc.Close(a.Pane)
	svc.Close(b.Pane)
}
