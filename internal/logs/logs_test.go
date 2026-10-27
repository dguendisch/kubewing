package logs

import (
	"context"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/source"
)

// fakeActor scripts Logs per (pod, container). A scripted stream writes its
// canned lines, then blocks until ctx ends (follow) unless follow is false.
// It records the options it was called with, so tests can assert tail/since.
type fakeActor struct {
	mu    sync.Mutex
	calls []logCall
	// streams maps "pod/container" to the lines it emits; "" entries error.
	streams map[string][]string
	follow  bool
	// release, if non-nil, is closed to end every blocking stream at once.
	gate chan struct{}
}

type logCall struct {
	pod, container string
	opts           source.LogOptions
}

func newFakeActor() *fakeActor {
	return &fakeActor{streams: map[string][]string{}, gate: make(chan struct{})}
}

func (f *fakeActor) Logs(ctx context.Context, _, _, pod, container string, o source.LogOptions, w io.Writer) error {
	f.mu.Lock()
	f.calls = append(f.calls, logCall{pod: pod, container: container, opts: o})
	lines := f.streams[pod+"/"+container]
	follow := f.follow
	f.mu.Unlock()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, l := range lines {
		ts := base.Add(time.Duration(i) * time.Second)
		if o.SinceTime != nil && !ts.After(*o.SinceTime) {
			continue
		}
		fmt.Fprintf(w, "%s %s\n", ts.Format(time.RFC3339Nano), l)
	}
	if !follow {
		return nil
	}
	select {
	case <-ctx.Done():
		return nil
	case <-f.gate:
		return nil
	}
}

func (f *fakeActor) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// recordSink collects lines and the latest stream set.
type recordSink struct {
	mu      sync.Mutex
	lines   []Line
	streams []Stream
}

func (s *recordSink) Line(l Line) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lines = append(s.lines, l)
}

func (s *recordSink) Streams(st []Stream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.streams = st
}

func (s *recordSink) texts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.lines))
	for i, l := range s.lines {
		out[i] = l.Text
	}
	return out
}

func (s *recordSink) streamCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams)
}

// pod builds an unstructured pod with the given running containers.
func pod(uid, ns, name string, running map[string]bool, owner string) *unstructured.Unstructured {
	var specCs, statusCs []any
	for c, run := range running {
		specCs = append(specCs, map[string]any{"name": c})
		state := map[string]any{}
		if run {
			state["running"] = map[string]any{}
		} else {
			state["terminated"] = map[string]any{"reason": "Completed"}
		}
		statusCs = append(statusCs, map[string]any{"name": c, "state": state})
	}
	meta := map[string]any{"uid": uid, "name": name, "namespace": ns}
	if owner != "" {
		meta["ownerReferences"] = []any{map[string]any{"uid": owner, "name": "rs", "kind": "ReplicaSet"}}
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": meta,
		"spec":     map[string]any{"containers": specCs},
		"status":   map[string]any{"containerStatuses": statusCs},
	}}
}

func item(u *unstructured.Unstructured) source.Item { return source.Item{Object: u} }

// eventually polls cond up to a second.
func eventually(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met: %s", msg)
}

func TestInitialTailAndFollow(t *testing.T) {
	fa := newFakeActor()
	fa.follow = true
	fa.streams["p/app"] = []string{"line one", "line two"}
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{Tail: 100}, sink)
	defer tl.Close()

	tl.Apply(source.Event{Type: source.Added, Item: item(pod("u1", "ns", "p", map[string]bool{"app": true}, ""))})
	eventually(t, func() bool { return len(sink.texts()) == 2 }, "two lines")
	if got := sink.texts(); got[0] != "line one" || got[1] != "line two" {
		t.Errorf("lines = %v", got)
	}
	if sink.streamCount() != 1 {
		t.Errorf("streams = %d, want 1", sink.streamCount())
	}
	// the first call fetched the tail
	fa.mu.Lock()
	tail := fa.calls[0].opts.TailLines
	fa.mu.Unlock()
	if tail == nil || *tail != 100 {
		t.Errorf("tail = %v, want 100", tail)
	}
}

func TestOwnerFilter(t *testing.T) {
	fa := newFakeActor()
	fa.follow = true
	fa.streams["mine/app"] = []string{"hello"}
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{OwnerUID: "owner"}, sink)
	defer tl.Close()

	// a pod owned by someone else is ignored
	tl.Apply(source.Event{Type: source.Added, Item: item(pod("other", "ns", "other", map[string]bool{"app": true}, "nope"))})
	// one owned by us is followed
	tl.Apply(source.Event{Type: source.Added, Item: item(pod("mine", "ns", "mine", map[string]bool{"app": true}, "owner"))})
	eventually(t, func() bool { return len(sink.texts()) == 1 }, "one line from the owned pod")
	if sink.streamCount() != 1 {
		t.Errorf("streams = %d, want 1 (only the owned pod)", sink.streamCount())
	}
}

func TestDeleteStopsFollower(t *testing.T) {
	fa := newFakeActor()
	fa.follow = true
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{}, sink)
	defer tl.Close()
	p := pod("u1", "ns", "p", map[string]bool{"app": true}, "")
	tl.Apply(source.Event{Type: source.Added, Item: item(p)})
	eventually(t, func() bool { return sink.streamCount() == 1 }, "one stream")
	tl.Apply(source.Event{Type: source.Deleted, Item: item(p)})
	eventually(t, func() bool {
		sink.mu.Lock()
		defer sink.mu.Unlock()
		return len(sink.streams) == 1 && sink.streams[0].State == Ended
	}, "stream ended on delete")
}

func TestRelistReconciles(t *testing.T) {
	fa := newFakeActor()
	fa.follow = true
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{}, sink)
	defer tl.Close()
	a := pod("a", "ns", "a", map[string]bool{"app": true}, "")
	b := pod("b", "ns", "b", map[string]bool{"app": true}, "")
	tl.Apply(source.Event{Type: source.Relist, Items: []source.Item{item(a), item(b)}})
	eventually(t, func() bool { return sink.streamCount() == 2 }, "two streams")
	// a relist without b ends b's follower, keeps a
	tl.Apply(source.Event{Type: source.Relist, Items: []source.Item{item(a)}})
	eventually(t, func() bool {
		for _, s := range tl.Streams() {
			if s.Pod == "b" && s.State != Ended {
				return false
			}
		}
		return true
	}, "b ended after relist without it")
}

func TestStreamCap(t *testing.T) {
	fa := newFakeActor()
	fa.follow = true
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{MaxStreams: 2}, sink)
	defer tl.Close()
	for i := 0; i < 4; i++ {
		name := fmt.Sprintf("p%d", i)
		tl.Apply(source.Event{Type: source.Added, Item: item(pod(name, "ns", name, map[string]bool{"app": true}, ""))})
	}
	eventually(t, func() bool { return fa.callCount() == 2 }, "only two streams actually opened")
	time.Sleep(20 * time.Millisecond)
	if fa.callCount() != 2 {
		t.Errorf("opened %d streams, cap was 2", fa.callCount())
	}
}

func TestResumeAfterRestart(t *testing.T) {
	fa := newFakeActor()
	// not following: the stream returns after its lines, so run() loops. The
	// container stays running, so it reconnects and must resume after the
	// last timestamp (SinceTime), not refetch the tail.
	fa.streams["u1/app"] = []string{"a", "b", "c"}
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{}, sink)
	defer tl.Close()
	tl.Apply(source.Event{Type: source.Added, Item: item(pod("u1", "ns", "u1", map[string]bool{"app": true}, ""))})
	// first pass emits a,b,c; it reconnects and, with SinceTime past the last
	// line, emits nothing new, so we just assert a second call used SinceTime.
	eventually(t, func() bool { return fa.callCount() >= 2 }, "reconnected at least once")
	fa.mu.Lock()
	second := fa.calls[1].opts
	fa.mu.Unlock()
	if second.SinceTime == nil {
		t.Error("reconnect must pass SinceTime to resume, not the tail")
	}
	if second.TailLines != nil {
		t.Error("reconnect must not refetch the tail")
	}
}

// Containers restricts following to those names; a NoFollow tailer reads each
// stream once (no reconnect), and Wait returns when they're all read.
func TestContainersAndNoFollow(t *testing.T) {
	fa := newFakeActor()
	fa.streams["u1/app"] = []string{"a"}
	fa.streams["u1/side"] = []string{"s"}
	sink := &recordSink{}
	tl := New(context.Background(), fa, Options{Containers: []string{"app"}, NoFollow: true}, sink)
	defer tl.Close()
	tl.Apply(source.Event{Type: source.Added, Item: item(pod("u1", "ns", "u1", map[string]bool{"app": true, "side": true}, ""))})
	tl.Wait()
	if got := sink.texts(); len(got) != 1 || got[0] != "a" {
		t.Errorf("lines = %v, want just app's", got)
	}
	if fa.callCount() != 1 || !fa.calls[0].opts.NoFollow {
		t.Errorf("calls = %+v, want one NoFollow read", fa.calls)
	}
	if st := tl.Streams(); len(st) != 1 || st[0].State != Ended {
		t.Errorf("streams = %+v, want app ended", st)
	}
}

// Since starts streams that long ago (rounded up to seconds); Whole reads
// them from the start: neither passes a tail.
func TestSinceAndWhole(t *testing.T) {
	for _, tc := range []struct {
		o     Options
		since int64
	}{{Options{Since: 1500 * time.Millisecond}, 2}, {Options{Whole: true}, 0}} {
		fa := newFakeActor()
		fa.follow = true
		tl := New(context.Background(), fa, tc.o, &recordSink{})
		tl.Apply(source.Event{Type: source.Added, Item: item(pod("u1", "ns", "u1", map[string]bool{"app": true}, ""))})
		eventually(t, func() bool { return fa.callCount() == 1 }, "one stream")
		fa.mu.Lock()
		o := fa.calls[0].opts
		fa.mu.Unlock()
		tl.Close()
		if o.TailLines != nil {
			t.Errorf("%+v: tail = %d, want none", tc.o, *o.TailLines)
		}
		if tc.since == 0 && o.SinceSeconds != nil || tc.since != 0 && (o.SinceSeconds == nil || *o.SinceSeconds != tc.since) {
			t.Errorf("%+v: sinceSeconds = %v, want %d", tc.o, o.SinceSeconds, tc.since)
		}
	}
}
