// Package logs tails the logs of many pods at once (stern-like): it turns a
// stream of pod watch events into one follower per pod container, parses the
// lines (splitting off kubectl's RFC 3339 timestamps) and emits them, plus a
// list of the streams it follows, through callbacks. It is transport- and
// UI-agnostic: the bridge wires it to a shared pods watch and the frontend.
package logs

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/source"
)

// Defaults for the options.
const (
	DefaultTail       = 100
	DefaultMaxStreams = 50
	DefaultLineCap    = 1 << 20 // 1 MiB; longer lines are truncated
	reconnectBackoff  = time.Second
	// palette is how many distinct colors the UI cycles pods through; the
	// Color index is taken modulo this, assigned per pod in first-seen order.
	palette = 6
)

// Line is one log line of a stream (trailing newline stripped). TS is the
// RFC 3339 timestamp kubectl prefixes, split off; "" if the line had none.
type Line struct {
	Stream string `json:"stream"`
	TS     string `json:"ts,omitempty"`
	Text   string `json:"text"`
}

// StreamState is where a stream is in its life.
type StreamState string

const (
	Following StreamState = "following" // connected (or reconnecting)
	Ended     StreamState = "ended"     // the container is gone, or its pod deleted
	Limited   StreamState = "limited"   // not followed: the stream cap is reached
)

// Stream is one followed container, reported whenever the set changes.
type Stream struct {
	ID        string `json:"id"`
	Pod       string `json:"pod"`
	Namespace string `json:"namespace"`
	Container string `json:"container"`
	// Color is a stable per-pod index into the UI's palette (0…palette-1).
	Color int         `json:"color"`
	State StreamState `json:"state"`
}

// Options configure a tailer.
type Options struct {
	Cluster string
	// Tail is how many lines to fetch before following; <=0 = DefaultTail.
	// Pods that appear later are read from their start (0 tail), as stern does.
	Tail int64
	// Since, if set, starts each stream that long ago instead of Tail lines back.
	Since time.Duration
	// Whole reads each stream from its start (neither Tail nor Since).
	Whole bool
	// NoFollow reads what each stream holds once and ends it (kubectl logs
	// without -f): no reconnects. The bridge feeds it a single pod list.
	NoFollow bool
	// Containers, if set, restricts following to containers of these names.
	Containers []string
	// MaxStreams caps concurrent followers; <=0 = DefaultMaxStreams.
	MaxStreams int
	// LineCap caps a single line's length in bytes; <=0 = DefaultLineCap.
	LineCap int
}

// Sink receives a tailer's output. Both methods may be called concurrently
// from follower goroutines; implementations must be safe for that and should
// not block (the bridge batches and never blocks).
type Sink interface {
	// Line is one parsed log line.
	Line(Line)
	// Streams is the current stream set, newest change last; sent on every
	// change (a container starts, ends, or is refused by the cap).
	Streams([]Stream)
}

// LogStreamer is the slice of source.Actor the tailer needs: following one
// container's logs. *source.ClusterOpener and the tape fake satisfy it.
type LogStreamer interface {
	Logs(ctx context.Context, cluster, namespace, pod, container string, o source.LogOptions, w io.Writer) error
}

// Tailer follows the logs of the pods fed to Apply. Create it with New, feed
// it source events, and Close it (or cancel the ctx) to stop every follower.
type Tailer struct {
	opts  Options
	actor LogStreamer
	sink  Sink

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	followers map[string]*follower // by stream ID (pod UID / container)
	colors    map[string]int       // pod UID → color index
	nextColor int
	limited   int // containers not followed because of the cap
	closed    bool
	// running counts follower goroutines, for Wait
	running sync.WaitGroup
}

type follower struct {
	stream Stream
	cancel context.CancelFunc
	// running is whether the container is running per the latest pod status;
	// a follower reconnects only while it is (a completed container's logs
	// are read once). Guarded by Tailer.mu.
	running bool
	// lastTS is the timestamp of the last line emitted, to resume after a
	// reconnect without repeating it. Guarded by Tailer.mu.
	lastTS string
}

// New creates a tailer. Feed it events with Apply; it starts no followers on
// its own.
func New(ctx context.Context, actor LogStreamer, o Options, sink Sink) *Tailer {
	if o.Tail <= 0 {
		o.Tail = DefaultTail
	}
	if o.MaxStreams <= 0 {
		o.MaxStreams = DefaultMaxStreams
	}
	if o.LineCap <= 0 {
		o.LineCap = DefaultLineCap
	}
	cctx, cancel := context.WithCancel(ctx)
	return &Tailer{
		opts: o, actor: actor, sink: sink,
		ctx: cctx, cancel: cancel,
		followers: map[string]*follower{}, colors: map[string]int{},
	}
}

// Wait blocks until every follower started so far has returned: for a
// NoFollow tailer, until each stream is read. Don't call Apply concurrently.
func (t *Tailer) Wait() { t.running.Wait() }

// Close stops every follower.
func (t *Tailer) Close() {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	t.cancel()
}

// Apply reconciles a pod watch event into the follower set. Added/Modified
// start or update followers for the pod's loggable containers; Deleted stops
// them; Relist reconciles against the whole set (followers of pods no longer
// present are stopped). Events for non-pods are ignored.
func (t *Tailer) Apply(ev source.Event) {
	switch ev.Type {
	case source.Added, source.Modified:
		if ev.Item.Object != nil {
			t.reconcilePod(ev.Item.Object)
		}
	case source.Deleted:
		if ev.Item.Object != nil {
			t.stopPod(string(ev.Item.Object.GetUID()), "")
		}
	case source.Relist:
		keep := map[string]bool{}
		for _, it := range ev.Items {
			if it.Object == nil {
				continue
			}
			t.reconcilePod(it.Object)
			keep[string(it.Object.GetUID())] = true
		}
		t.stopMissing(keep)
	}
}

// reconcilePod starts followers for the pod's loggable containers not yet
// followed, updates their running flag, and marks ended any that vanished
// from the spec.
func (t *Tailer) reconcilePod(obj *unstructured.Unstructured) {
	uid := string(obj.GetUID())
	pod, ns := obj.GetName(), obj.GetNamespace()
	deleting := obj.GetDeletionTimestamp() != nil
	cs := containers(obj)
	seen := map[string]bool{}
	var changed bool

	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	for _, c := range cs {
		if !c.loggable() || len(t.opts.Containers) > 0 && !slices.Contains(t.opts.Containers, c.name) {
			continue
		}
		id := uid + "/" + c.name
		seen[id] = true
		if f, ok := t.followers[id]; ok {
			if f.running != (c.running && !deleting) {
				f.running = c.running && !deleting
				f.stream.State = Following
				changed = true
			}
			continue
		}
		if len(t.active()) >= t.opts.MaxStreams {
			t.limited++
			changed = true
			continue
		}
		f := t.startFollower(id, uid, ns, pod, c.name, c.running && !deleting)
		t.followers[id] = f
		changed = true
	}
	// a container dropped from the spec (rare) ends its follower
	for id, f := range t.followers {
		if strings.HasPrefix(id, uid+"/") && !seen[id] && f.cancel != nil {
			f.cancel()
			f.stream.State = Ended
			changed = true
		}
	}
	streams := t.snapshotLocked()
	t.mu.Unlock()
	if changed {
		t.sink.Streams(streams)
	}
}

// startFollower launches the goroutine that streams one container. Must be
// called with t.mu held (it reads color assignment); it does not block.
func (t *Tailer) startFollower(id, uid, ns, pod, container string, running bool) *follower {
	color, ok := t.colors[uid]
	if !ok {
		color = t.nextColor % palette
		t.colors[uid] = color
		t.nextColor++
	}
	fctx, cancel := context.WithCancel(t.ctx)
	f := &follower{
		stream: Stream{ID: id, Pod: pod, Namespace: ns, Container: container, Color: color, State: Following},
		cancel: cancel, running: running,
	}
	t.running.Add(1)
	go func() {
		defer t.running.Done()
		t.run(fctx, f)
	}()
	return f
}

// run streams a container, reconnecting while it is running.
func (t *Tailer) run(ctx context.Context, f *follower) {
	first := true
	for {
		lo := source.LogOptions{}
		if since := t.lastTS(f); since != nil {
			lo.SinceTime = since
		} else if first && t.opts.Since > 0 {
			secs := int64((t.opts.Since + time.Second - 1) / time.Second)
			lo.SinceSeconds = &secs
		} else if first && !t.opts.Whole {
			tail := t.opts.Tail
			lo.TailLines = &tail
		}
		first = false
		lo.NoFollow = t.opts.NoFollow
		w := &lineWriter{tailer: t, f: f, cap: t.opts.LineCap}
		err := t.actor.Logs(ctx, t.opts.Cluster, f.stream.Namespace, f.stream.Pod, f.stream.Container, lo, w)
		w.flush()
		if ctx.Err() != nil {
			return // stopped
		}
		if t.opts.NoFollow {
			if err != nil {
				t.emitMarker(f, fmt.Sprintf("— log stream error: %v —", err))
			}
			t.markEnded(f)
			return
		}
		if !t.keepGoing(f) {
			t.markEnded(f)
			return
		}
		if err != nil {
			t.emitMarker(f, fmt.Sprintf("— log stream error: %v —", err))
		} else {
			t.emitMarker(f, "— stream ended, reconnecting —")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(reconnectBackoff):
		}
	}
}

// keepGoing reports whether a follower whose stream ended should reconnect:
// only while its container is still running.
func (t *Tailer) keepGoing(f *follower) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.closed && f.running
}

func (t *Tailer) lastTS(f *follower) *time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	if f.lastTS == "" {
		return nil
	}
	ts, err := time.Parse(time.RFC3339Nano, f.lastTS)
	if err != nil {
		return nil
	}
	return &ts
}

func (t *Tailer) markEnded(f *follower) {
	t.mu.Lock()
	f.stream.State = Ended
	streams := t.snapshotLocked()
	t.mu.Unlock()
	t.sink.Streams(streams)
}

func (t *Tailer) emitMarker(f *follower, text string) {
	t.sink.Line(Line{Stream: f.stream.ID, Text: text})
}

// emit records a parsed line and forwards it. Called from the follower's
// lineWriter.
func (t *Tailer) emit(f *follower, ts, text string) {
	if ts != "" {
		t.mu.Lock()
		f.lastTS = ts
		t.mu.Unlock()
	}
	t.sink.Line(Line{Stream: f.stream.ID, TS: ts, Text: text})
}

// stopPod cancels every follower of a pod. reason "" = deleted.
func (t *Tailer) stopPod(uid, _ string) {
	t.mu.Lock()
	var changed bool
	for id, f := range t.followers {
		if strings.HasPrefix(id, uid+"/") && f.stream.State != Ended {
			if f.cancel != nil {
				f.cancel()
			}
			f.running = false
			f.stream.State = Ended
			changed = true
		}
	}
	streams := t.snapshotLocked()
	t.mu.Unlock()
	if changed {
		t.sink.Streams(streams)
	}
}

// stopMissing ends followers whose pod UID is not in keep (relist).
func (t *Tailer) stopMissing(keep map[string]bool) {
	t.mu.Lock()
	var changed bool
	for id, f := range t.followers {
		uid, _, _ := strings.Cut(id, "/")
		if !keep[uid] && f.stream.State != Ended {
			if f.cancel != nil {
				f.cancel()
			}
			f.running = false
			f.stream.State = Ended
			changed = true
		}
	}
	streams := t.snapshotLocked()
	t.mu.Unlock()
	if changed {
		t.sink.Streams(streams)
	}
}

// active lists the followers that still hold a stream (not ended). Must be
// called with t.mu held.
func (t *Tailer) active() []*follower {
	var out []*follower
	for _, f := range t.followers {
		if f.stream.State != Ended {
			out = append(out, f)
		}
	}
	return out
}

// snapshotLocked builds the stream list in a stable order (by ID). Must be
// called with t.mu held.
func (t *Tailer) snapshotLocked() []Stream {
	ids := make([]string, 0, len(t.followers))
	for id := range t.followers {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	out := make([]Stream, 0, len(ids))
	for _, id := range ids {
		out = append(out, t.followers[id].stream)
	}
	return out
}

// Streams returns the current stream set (tests).
func (t *Tailer) Streams() []Stream {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked()
}
