package bridge

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8stypes "k8s.io/apimachinery/pkg/types"

	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/view"
)

type recorder struct {
	mu     sync.Mutex
	frames []FramePayload
	at     []time.Time
}

func (r *recorder) Emit(event string, data any) {
	if event != FrameEvent {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames = append(r.frames, data.(FramePayload))
	r.at = append(r.at, time.Now())
}

func (r *recorder) snapshot() ([]FramePayload, []time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]FramePayload{}, r.frames...), append([]time.Time{}, r.at...)
}

// stormOpener emits a relist with n objects and then updates as fast as possible.
type stormOpener struct{ n int }

func (stormOpener) Resolve(_, _ string) (source.Resolved, error) {
	return source.Resolved{Kind: "Pod", Namespaced: true}, nil
}

func obj(i, gen int) source.Item {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": fmt.Sprintf("pod-%05d", i), "namespace": "ns", "uid": fmt.Sprintf("u%d", i)},
		"spec":     map[string]any{"gen": int64(gen)},
	}}
	u.SetUID(k8stypes.UID(fmt.Sprintf("u%d", i)))
	return source.Item{Object: u, Cells: []any{u.GetName(), fmt.Sprint(gen)}}
}

func (s stormOpener) Watch(ctx context.Context, _ string, _ source.Resolved, _ source.Key, out chan<- source.Event) {
	items := make([]source.Item, s.n)
	for i := range items {
		items[i] = obj(i, 0)
	}
	out <- source.Event{Type: source.Relist, Items: items}
	for gen := 1; ; gen++ {
		for i := 0; i < s.n; i++ {
			select {
			case <-ctx.Done():
				return
			case out <- source.Event{Type: source.Modified, Item: obj(i, gen)}:
			}
		}
	}
}

func TestBridgeBudgetUnderEventStorm(t *testing.T) {
	rec := &recorder{}
	svc := New(source.NewRegistry(stormOpener{n: 10000}), rec, Options{MaxRate: 10})
	res, err := svc.Open("source: {resource: pods, namespace: ns}\nrender: {columns: [{name: NAME, path: metadata.name}, {name: GEN, path: spec.gen}]}")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetViewport(res.Pane, 100, 50); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	svc.Close(res.Pane)
	frames, at := rec.snapshot()

	if len(frames) < 5 {
		t.Fatalf("too few frames under storm: %d", len(frames))
	}
	// rate: no two frames closer than the interval (allow scheduler jitter)
	for i := 1; i < len(at); i++ {
		if d := at[i].Sub(at[i-1]); d < 90*time.Millisecond {
			t.Fatalf("frames %d and %d only %v apart (budget 10 Hz)", i-1, i, d)
		}
	}
	for _, f := range frames {
		if len(f.Frame.Order) > 50 || len(f.Frame.Rows) > 50 {
			t.Fatalf("frame exceeds viewport: order=%d rows=%d", len(f.Frame.Order), len(f.Frame.Rows))
		}
		if f.Frame.Total != 10000 && f.Frame.Total != 0 {
			t.Fatalf("total = %d", f.Frame.Total)
		}
	}
}

func TestPaneCloseReleasesWatch(t *testing.T) {
	reg := source.NewRegistry(stormOpener{n: 10})
	svc := New(reg, &recorder{}, Options{})
	a, _ := svc.Open("source: {resource: pods, namespace: ns}")
	b, _ := svc.Open("source: {resource: pods, namespace: ns}")
	if reg.Active() != 1 {
		t.Fatalf("splits on the same source must share one watch, got %d", reg.Active())
	}
	svc.Close(a.Pane)
	svc.Close(b.Pane)
	if reg.Active() != 0 {
		t.Fatal("watch not released")
	}
}

func TestSeqMonotonicAcrossUpdate(t *testing.T) {
	rec := &recorder{}
	svc := New(source.NewRegistry(stormOpener{n: 3}), rec, Options{})
	res, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := svc.Update(res.Pane, "source: {resource: pods, namespace: ns}\nstages: [{grep: pod-00001}]"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	svc.Close(res.Pane)
	frames, _ := rec.snapshot()
	var last uint64
	sawFiltered := false
	for _, f := range frames {
		if f.Frame.Seq <= last {
			t.Fatalf("seq not monotonic: %d after %d", f.Frame.Seq, last)
		}
		last = f.Frame.Seq
		if f.Frame.Total == 1 {
			sawFiltered = true
		}
	}
	if !sawFiltered {
		t.Fatal("no frame from the updated pipeline")
	}
}

// Splits share source objects; views must treat them as read-only.
func TestSplitsShareObjectsWithoutRace(t *testing.T) {
	svc := New(source.NewRegistry(stormOpener{n: 50}), &recorder{}, Options{})
	var panes []string
	for i := 0; i < 3; i++ {
		res, err := svc.Open("source: {resource: pods, namespace: ns}")
		if err != nil {
			t.Fatal(err)
		}
		panes = append(panes, res.Pane)
	}
	for i := 0; i < 20; i++ {
		for _, p := range panes {
			_ = svc.SetViewport(p, i%5, 10)
			_, _ = svc.Object(p, "u1")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for _, p := range panes {
		svc.Close(p)
	}
}

// flakyOpener: the first watch lists one pod and then fails; every later
// one (after a reconnect) lists two. It counts reconnects per cluster.
type flakyOpener struct {
	mu         sync.Mutex
	watches    int
	reconnects []string
}

func (*flakyOpener) Resolve(_, _ string) (source.Resolved, error) {
	return source.Resolved{Kind: "Pod", Namespaced: true}, nil
}

func (f *flakyOpener) Reconnect(cluster string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reconnects = append(f.reconnects, cluster)
	return []string{cluster}
}

func (f *flakyOpener) Watch(ctx context.Context, _ string, _ source.Resolved, _ source.Key, out chan<- source.Event) {
	f.mu.Lock()
	f.watches++
	n := f.watches
	f.mu.Unlock()
	evs := []source.Event{{Type: source.Relist, Items: []source.Item{obj(0, 0)}}, {Type: source.Error, Err: "dial tcp: connection refused"}}
	if n > 1 {
		evs = []source.Event{{Type: source.Relist, Items: []source.Item{obj(0, 0), obj(1, 0)}}}
	}
	for _, ev := range evs {
		select {
		case out <- ev:
		case <-ctx.Done():
			return
		}
	}
	<-ctx.Done()
}

// A reconnect restarts the pane's watch: the error goes, the new list is
// diffed into the objects the pane has (an added row, not a new pane).
func TestReconnectRestartsWatches(t *testing.T) {
	f := &flakyOpener{}
	rec := &recorder{}
	svc := New(source.NewRegistry(f), rec, Options{MaxRate: 100})
	res, err := svc.Open("source: {resource: pods, cluster: dev}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	_ = svc.SetViewport(res.Pane, 0, 50)
	status := func() view.Status {
		frames, _ := rec.snapshot()
		for i := len(frames) - 1; i >= 0; i-- {
			if frames[i].Pane == res.Pane && frames[i].Frame.Status != nil {
				return *frames[i].Frame.Status
			}
		}
		return view.Status{}
	}
	waitFor(t, func() bool { s := status(); return s.Synced && s.Error != "" })

	if n := svc.Reconnect("dev"); n != 1 {
		t.Fatalf("restarted %d watches", n)
	}
	waitFor(t, func() bool { s := status(); return s.Error == "" && s.Objects == 2 })
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reconnects) != 1 || f.reconnects[0] != "dev" {
		t.Fatalf("reconnects = %q", f.reconnects)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
