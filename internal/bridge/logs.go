package bridge

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/logs"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/relations"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/view"
)

// LogsEvent carries a log session's output: its stream set when it changes,
// and batches of parsed lines. The last event carries Exit.
const LogsEvent = "kw:logs"

// logsFlush batches lines like the exec batcher, so a chatty set of pods
// doesn't flood the bridge. logsMaxBatch caps one flush (the transport drops
// messages for a slow client); the excess is reported as Dropped.
const (
	logsFlush    = 16 * time.Millisecond
	logsMaxBatch = 2000
)

// LogsPayload is one LogsEvent.
type LogsPayload struct {
	ID string `json:"id"`
	// Streams, when set, is the full current stream set (replaces the client's).
	Streams []logs.Stream `json:"streams,omitempty"`
	// Lines is a batch of log lines in arrival order.
	Lines []logs.Line `json:"lines,omitempty"`
	// Dropped counts lines dropped since the last event (batch overflow).
	Dropped int `json:"dropped,omitempty"`
	// Exit is set on the last event: "" while running, else why it ended.
	Exit string `json:"exit,omitempty"`
}

// LogsResult describes a started log tail.
type LogsResult struct {
	Session string `json:"session"`
	Context string `json:"context"`
	// Title names what is tailed (e.g. "etcd-0", "deploy/etcd", "pods · kube-system").
	Title string `json:"title"`
}

// LogsStart tails the logs of a row's pods (stern-like). It needs no safety
// token: reading logs doesn't change the cluster, so it works on read-only
// contexts, like Describe and PortForwardStart. whole tails every pod the
// pane currently shows (its filters applied), for a pods pane; otherwise the
// selected row: a pod, or the pods of a workload/node/namespace.
func (s *Service) LogsStart(paneID, key string, whole bool) (LogsResult, error) {
	if s.opts.Actor == nil {
		return LogsResult{}, fmt.Errorf("logs are not available")
	}
	pn, err := s.pane(paneID)
	if err != nil {
		return LogsResult{}, err
	}
	cluster := pn.p.Source.Cluster
	ctxName, err := s.contextName(cluster)
	if err != nil {
		return LogsResult{}, err
	}
	cfg := s.Config().Config.Logs

	var (
		src   source.Key   // the pods watch to subscribe to
		stages []pipeline.Stage // applied to the watch to pick pods (whole pane)
		opts  logs.Options
		title string
	)
	opts.Cluster = cluster
	opts.Tail = int64(cfg.Tail)
	opts.MaxStreams = cfg.MaxStreams

	if whole {
		src, stages, title, err = s.wholePaneSource(pn)
	} else {
		src, opts.OwnerUID, title, err = s.rowSource(pn, key)
	}
	if err != nil {
		return LogsResult{}, err
	}

	sub, err := s.reg.SubscribeWith(src, s.normalizer())
	if err != nil {
		return LogsResult{}, err
	}

	id := s.startLogSession(func(ctx context.Context, sink logs.Sink) {
		defer sub.Close()
		t := logs.New(ctx, s.opts.Actor, opts, sink)
		defer t.Close()
		// a private view applies the whole-pane filters; nil for a row tail
		var v *view.View
		if len(stages) > 0 {
			v, _ = view.New(pipeline.Pipeline{Source: pipeline.Source{
				Cluster: src.Cluster, Resource: src.Resource, Namespace: src.Namespace,
				LabelSelector: src.LabelSelector, FieldSelector: src.FieldSelector,
			}, Stages: stages}, s.viewOptions(sub, true))
		}
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-sub.Events:
				if !ok {
					return
				}
				if v != nil {
					t.Apply(matchedEvent(v, ev))
				} else {
					t.Apply(ev)
				}
			}
		}
	})
	return LogsResult{Session: id, Context: ctxName, Title: title}, nil
}

// rowSource builds the pods watch for a non-whole tail: a pod row follows
// itself (by name, so a recreated StatefulSet pod continues); a workload,
// node or namespace row follows its pods child. ownerUID restricts following
// to a workload's own pods (a label selector can over-match).
func (s *Service) rowSource(pn *pane, key string) (src source.Key, ownerUID, title string, err error) {
	r, err := s.row(pn.id, key)
	if err != nil {
		return source.Key{}, "", "", err
	}
	cluster := pn.p.Source.Cluster
	if r.isPod() {
		// the pane is itself a pods pane: follow this pod by name on the
		// pane's own resource (which resolves to pods), so tapes resolve it.
		return source.Key{
			Cluster: cluster, Resource: pn.p.Source.Resource, Namespace: r.namespace(),
			FieldSelector: "metadata.name=" + r.name(),
		}, "", r.name(), nil
	}
	c := podChild(r.item.Object)
	if c == nil {
		return source.Key{}, "", "", fmt.Errorf("%s has no pods to tail", r.kind())
	}
	label := strings.ToLower(r.kind()) + "/" + r.name()
	return source.Key{
		Cluster: cluster, Resource: c.Resource, Namespace: c.Namespace,
		LabelSelector: c.LabelSelector, FieldSelector: c.FieldSelector,
	}, c.OwnerUID, label, nil
}

// wholePaneSource tails every pod a pods pane shows: the same watch key, plus
// the pane's stages so the private view applies its CEL/grep/hide-healthy.
// Later filter edits in the pane don't change a running tail (a snapshot).
func (s *Service) wholePaneSource(pn *pane) (src source.Key, stages []pipeline.Stage, title string, err error) {
	pn.mu.Lock()
	p := pn.p
	res := pn.res
	pn.mu.Unlock()
	if res.Kind != "Pod" {
		return source.Key{}, nil, "", fmt.Errorf("tailing a whole pane needs a pods pane, not %s", res.Kind)
	}
	ns := p.Source.Namespace
	if ns == "" || p.Source.AllNamespaces() {
		title = "pods"
	} else {
		title = "pods · " + ns
	}
	if p.Source.LabelSelector != "" {
		title += " " + p.Source.LabelSelector
	}
	return source.Key{
		Cluster: p.Source.Cluster, Resource: p.Source.Resource, Namespace: p.Source.Namespace,
		LabelSelector: p.Source.LabelSelector, FieldSelector: p.Source.FieldSelector,
	}, p.Stages, title, nil
}

// matchedEvent feeds ev into v and returns a Relist of the items v now shows,
// so the tailer only follows the pods the pane's filters match. Every event
// becomes a relist: the tailer reconciles, starting and stopping followers to
// match exactly the shown set.
func matchedEvent(v *view.View, ev source.Event) source.Event {
	v.Apply(ev, time.Now())
	return source.Event{Type: source.Relist, Items: v.MatchedItems()}
}

// podChild returns obj's pods child (the workload/node/namespace relation
// that resolves to pods), or nil. relations.Children can list non-pod
// children (a CronJob's jobs), which this filters out.
func podChild(obj *unstructured.Unstructured) *relations.Child {
	for _, c := range relations.Children(obj) {
		if c.Kind == "Pod" {
			cc := c
			return &cc
		}
	}
	return nil
}

// logSink batches a tailer's output into LogsEvents. Line and Streams are
// called from follower goroutines; it coalesces and emits on a timer.
type logSink struct {
	emit  func(LogsPayload)
	mu    sync.Mutex
	lines []logs.Line
	// streams holds the latest set until the next flush (only the newest matters)
	streams    []logs.Stream
	hasStreams bool
	dropped    int
	timer      *time.Timer
	done       bool
}

func (k *logSink) Line(l logs.Line) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.done {
		return
	}
	if len(k.lines) >= logsMaxBatch {
		k.dropped++
		return
	}
	k.lines = append(k.lines, l)
	k.arm()
}

func (k *logSink) Streams(st []logs.Stream) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.done {
		return
	}
	k.streams, k.hasStreams = st, true
	k.arm()
}

// arm schedules a flush if none is pending. Must hold k.mu.
func (k *logSink) arm() {
	if k.timer == nil {
		k.timer = time.AfterFunc(logsFlush, k.flush)
	}
}

func (k *logSink) flush() {
	k.mu.Lock()
	if k.timer != nil {
		k.timer.Stop()
		k.timer = nil
	}
	p := LogsPayload{Lines: k.lines, Dropped: k.dropped}
	if k.hasStreams {
		p.Streams = k.streams
	}
	k.lines, k.dropped, k.hasStreams, k.streams = nil, 0, false, nil
	empty := len(p.Lines) == 0 && p.Streams == nil && p.Dropped == 0
	k.mu.Unlock()
	if !empty {
		k.emit(p)
	}
}

// close flushes the rest and stops further emits.
func (k *logSink) close() {
	k.flush()
	k.mu.Lock()
	k.done = true
	k.mu.Unlock()
}

// startLogSession registers a log session (no TTY: only a cancel) and runs
// run in the background, wiring its sink to LogsEvents. SessionClose and
// Shutdown cancel it, like an exec session.
func (s *Service) startLogSession(run func(context.Context, logs.Sink)) string {
	s.mu.Lock()
	s.next++
	id := fmt.Sprintf("s%d", s.next)
	ctx, cancel := context.WithCancel(context.Background())
	ss := &session{id: id, cancel: cancel}
	s.sessions[id] = ss
	s.mu.Unlock()

	sink := &logSink{emit: func(p LogsPayload) {
		p.ID = id
		s.emit.Emit(LogsEvent, p)
	}}
	s.running.Add(1)
	go func() {
		defer s.running.Done()
		run(ctx, sink)
		sink.close()
		s.endSession(ss)
		s.emit.Emit(LogsEvent, LogsPayload{ID: id, Exit: exitText(ctx, nil)})
	}()
	return id
}
