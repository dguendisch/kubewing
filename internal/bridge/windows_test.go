package bridge

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/source"
)

// inbox collects one window's events.
type inbox struct {
	mu      sync.Mutex
	got     []queued
	windows []string
}

func (b *inbox) announced() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.windows)
}

func (b *inbox) emit(event string, data any) {
	if m, ok := data.(WindowMessage); ok && event == WindowEvent && m.Kind == "windows" {
		b.mu.Lock()
		b.windows = append(b.windows, string(m.Data))
		b.mu.Unlock()
		return // the open windows' list, announced on every change: see TestWindowsAnnounce
	}
	b.mu.Lock()
	b.got = append(b.got, queued{event, data})
	b.mu.Unlock()
}

func (b *inbox) events() []queued {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.got)
}

// wait until the inbox holds n events (delivery is asynchronous)
func (b *inbox) wait(t *testing.T, n int) []queued {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if e := b.events(); len(e) >= n {
			return e
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("got %d events, want %d", len(b.events()), n)
	return nil
}

func seqs(es []queued) []int64 {
	var out []int64
	for _, e := range es {
		out = append(out, e.data.(SessionPayload).Seq)
	}
	return out
}

func TestWindowsRouteStreamsToTheirOwner(t *testing.T) {
	r := NewWindows(nil)
	var main, w1 inbox
	r.Register(MainWindow, main.emit)
	r.Register("w1", w1.emit)
	r.Own("p1", MainWindow)
	r.Own("p2", "w1")
	r.emitStream("p1", FrameEvent, func(int64) any { return "a" })
	r.emitStream("p2", FrameEvent, func(int64) any { return "b" })
	r.Emit(ConfigEvent, "all")
	m, w := main.wait(t, 2), w1.wait(t, 2)
	if m[0].data != "a" || m[1].data != "all" || w[0].data != "b" || w[1].data != "all" {
		t.Fatalf("main %v, w1 %v", m, w)
	}
}

// A stream moving to another window is split exactly: every chunk once, the
// old window's up to the number Reassign returns, the new one's after it,
// also while chunks keep coming.
func TestWindowsReassignSplitsTheStream(t *testing.T) {
	r := NewWindows(nil)
	var main, w1 inbox
	r.Register(MainWindow, main.emit)
	r.Register("w1", w1.emit)
	r.Own("s1", MainWindow)
	const n = 2000
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range n {
			r.emitStream("s1", SessionEvent, func(seq int64) any { return SessionPayload{ID: "s1", Seq: seq} })
		}
	}()
	time.Sleep(time.Millisecond)
	cut, err := r.Reassign([]string{"s1"}, "w1")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	last := cut["s1"]
	m := seqs(main.wait(t, int(last)))
	w := seqs(w1.wait(t, n-int(last)))
	all := append(m, w...)
	if len(all) != n {
		t.Fatalf("%d chunks delivered, want %d (cut at %d)", len(all), n, last)
	}
	for i, s := range all {
		if s != int64(i+1) {
			t.Fatalf("chunk %d has seq %d", i, s)
		}
	}
	if len(m) > 0 && m[len(m)-1] != last {
		t.Fatalf("main's last chunk %d, cut at %d", m[len(m)-1], last)
	}
}

// A window opened to take a pane gets nothing until its frontend listens,
// then everything sent meanwhile, in order.
func TestWindowsQueueUntilReady(t *testing.T) {
	r := NewWindows(nil)
	name := r.NewName()
	var w inbox
	r.Register(name, w.emit)
	r.Own("s1", name)
	for range 3 {
		r.emitStream("s1", SessionEvent, func(seq int64) any { return SessionPayload{ID: "s1", Seq: seq} })
	}
	time.Sleep(10 * time.Millisecond)
	if got := w.events(); len(got) != 0 {
		t.Fatalf("delivered before ready: %v", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go r.Ready(name)
	if err := r.AwaitReady(ctx, name); err != nil {
		t.Fatal(err)
	}
	if got := seqs(w.wait(t, 3)); !slices.Equal(got, []int64{1, 2, 3}) {
		t.Fatalf("got %v", got)
	}
}

// A page reloading (headless) registers again: the old connection going
// away closes only the streams the old page owned.
func TestWindowsUnregisterReturnsOnlyItsStreams(t *testing.T) {
	r := NewWindows(nil)
	var a, b inbox
	old := r.Register(MainWindow, a.emit)
	r.Own("p1", MainWindow)
	r.Register(MainWindow, b.emit)
	r.Own("p2", MainWindow)
	if got := r.Unregister(old); !slices.Equal(got, []string{"p1"}) {
		t.Fatalf("closing %v, want [p1]", got)
	}
	if r.Owner("p2") != MainWindow {
		t.Fatalf("p2 lost its window")
	}
}

func TestWindowsWithoutRegistrationsUseFallback(t *testing.T) {
	var fb inbox
	r := NewWindows(emitterFunc(fb.emit))
	r.emitStream("p1", FrameEvent, func(int64) any { return "f" })
	r.Emit(ConfigEvent, "c")
	if got := fb.events(); len(got) != 2 {
		t.Fatalf("fallback got %v", got)
	}
}

type emitterFunc func(string, any)

func (f emitterFunc) Emit(e string, d any) { f(e, d) }

// The service: a window closing closes the panes and sessions it showed.
func TestServiceWindowClosedClosesItsStreams(t *testing.T) {
	svc := New(nil, nil, Options{})
	r := svc.Router()
	var main, w1 inbox
	r.Register(MainWindow, main.emit)
	r.Register("w1", w1.emit)
	ended := make(chan struct{})
	ctx := WithWindow(context.Background(), "w1")
	id := svc.startSession(windowOf(ctx), 0, 0, func(ctx context.Context, _ source.ExecStreams) error {
		<-ctx.Done()
		close(ended)
		return ctx.Err()
	})
	if r.Owner(id) != "w1" {
		t.Fatalf("session owned by %q", r.Owner(id))
	}
	svc.WindowClosed("w1")
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("session kept running after its window closed")
	}
}

func TestSendWindow(t *testing.T) {
	svc := New(nil, nil, Options{})
	var main, w1 inbox
	svc.Router().Register(MainWindow, main.emit)
	svc.Router().Register("w1", w1.emit)
	if err := svc.SendWindow(context.Background(), "w1", "handoff", json.RawMessage(`{"x":1}`)); err != nil {
		t.Fatal(err)
	}
	got := w1.wait(t, 1)[0]
	m := got.data.(WindowMessage)
	if got.event != WindowEvent || m.From != MainWindow || m.Kind != "handoff" {
		t.Fatalf("got %+v", got)
	}
	if err := svc.SendWindow(context.Background(), "w9", "x", nil); err == nil {
		t.Fatal("no error for a window that isn't open")
	}
}

// Every window hears which windows are open whenever that changes (a pane's
// grip can be dragged to another window once there is one).
func TestWindowsAnnounce(t *testing.T) {
	r := NewWindows(nil)
	var main, w1 inbox
	r.Register(MainWindow, main.emit)
	w := r.Register("w1", w1.emit)
	r.Unregister(w)
	deadline := time.Now().Add(2 * time.Second)
	want := []string{`["main"]`, `["main","w1"]`, `["main"]`}
	for time.Now().Before(deadline) && !slices.Equal(main.announced(), want) {
		time.Sleep(time.Millisecond)
	}
	if got := main.announced(); !slices.Equal(got, want) {
		t.Fatalf("main heard %v, want %v", got, want)
	}
}
