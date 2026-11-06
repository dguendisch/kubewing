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

// LogsOptions are the log dialog's choices (⌘L). Containers empty = all.
// History picks where each stream starts: Tail lines back (0 = the configured
// logs.tail), Since ago (a Go duration, "10m"), or All of it; at most one of
// Since and All. Follow keeps streaming (and picks up pods that appear later);
// without it each container's log is read once and the session ends.
type LogsOptions struct {
	Containers []string `json:"containers,omitempty"`
	Tail       int      `json:"tail,omitempty"`
	Since      string   `json:"since,omitempty"`
	All        bool     `json:"all,omitempty"`
	Follow     bool     `json:"follow"`
}

// LogsTargets describes what a log tail of a row (or the whole pane) would
// follow, for the dialog: its title and the container names its pods have.
type LogsTargets struct {
	Title      string   `json:"title"`
	Containers []string `json:"containers"`
	// Tail is the configured logs.tail, the dialog's default.
	Tail int `json:"tail"`
}

// logsTarget is a resolved tail target: the pods watch to subscribe to, and
// what picks the pods from it.
type logsTarget struct {
	src source.Key
	// stages are applied to the watch to pick pods (whole pane); nil for a row
	stages   []pipeline.Stage
	ownerUID string
	title    string
}

func (s *Service) logsTarget(pn *pane, key string, whole bool) (logsTarget, error) {
	var (
		g   logsTarget
		err error
	)
	if whole {
		g.src, g.stages, g.title, err = s.wholePaneSource(pn)
	} else {
		g.src, g.ownerUID, g.title, err = s.rowSource(pn, key)
	}
	return g, err
}

// apply feeds ev through the target's filters (v, nil for a row tail) and
// returns the event the tailer applies.
func (g logsTarget) apply(v *view.View, ev source.Event) source.Event {
	if v != nil {
		return matchedEvent(v, ev)
	}
	return ev
}

// logsView is a private view applying a whole-pane target's filters; nil for a row.
func (s *Service) logsView(g logsTarget, sub *source.Subscription) *view.View {
	if len(g.stages) == 0 {
		return nil
	}
	v, _ := view.New(pipeline.Pipeline{Source: pipeline.Source{
		Cluster: g.src.Cluster, Resource: g.src.Resource, Namespace: g.src.Namespace,
		LabelSelector: g.src.LabelSelector, FieldSelector: g.src.FieldSelector,
	}, Stages: g.stages}, s.viewOptions(sub, true))
	return v
}

// logsTargetsWait bounds how long LogsTargets waits for the pods watch's
// first list (a shared watch already synced answers at once).
const logsTargetsWait = 5 * time.Second

// LogsTargets lists the containers a tail of the row (or whole pane) would
// follow, from the pods it would pick right now, for the log dialog.
func (s *Service) LogsTargets(paneID, key string, whole bool) (LogsTargets, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return LogsTargets{}, err
	}
	g, err := s.logsTarget(pn, key, whole)
	if err != nil {
		return LogsTargets{}, err
	}
	out := LogsTargets{Title: g.title, Containers: []string{}, Tail: s.Config().Config.Logs.Tail}
	pods, err := s.logsPods(g)
	if err != nil {
		return LogsTargets{}, err
	}
	if names := logs.ContainerNames(pods, g.ownerUID); names != nil {
		out.Containers = names
	}
	return out, nil
}

// logsPods is the target's current pods: the first list of its watch, through
// the whole-pane filters.
func (s *Service) logsPods(g logsTarget) ([]source.Item, error) {
	sub, err := s.reg.SubscribeWith(g.src, s.normalizer())
	if err != nil {
		return nil, err
	}
	defer sub.Close()
	v := s.logsView(g, sub)
	ev, err := firstList(sub, logsTargetsWait)
	if err != nil {
		return nil, err
	}
	return g.apply(v, ev).Items, nil
}

// firstList waits, up to wait, for the first list of a pods watch (a
// shared watch already synced answers at once).
func firstList(sub *source.Subscription, wait time.Duration) (source.Event, error) {
	timeout := time.After(wait)
	for {
		select {
		case ev, ok := <-sub.Events:
			if !ok {
				return source.Event{}, fmt.Errorf("the pods watch closed")
			}
			if ev.Type == source.Error {
				return source.Event{}, fmt.Errorf("%s", ev.Err)
			}
			if ev.Type == source.Relist {
				return ev, nil
			}
		case <-timeout:
			return source.Event{}, fmt.Errorf("timed out listing the pods")
		}
	}
}

// LogsStart tails the logs of a row's pods (stern-like). It needs no safety
// token: reading logs doesn't change the cluster, so it works on read-only
// contexts, like Describe and PortForwardStart. whole tails every pod the
// pane currently shows (its filters applied), for a pods pane; otherwise the
// selected row: a pod, or the pods of a workload/node/namespace.
func (s *Service) LogsStart(paneID, key string, whole bool, o LogsOptions) (LogsResult, error) {
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
	opts, err := tailOptions(o, cfg.Tail)
	if err != nil {
		return LogsResult{}, err
	}
	opts.Cluster = cluster
	opts.MaxStreams = cfg.MaxStreams

	g, err := s.logsTarget(pn, key, whole)
	if err != nil {
		return LogsResult{}, err
	}
	opts.OwnerUID = g.ownerUID

	sub, err := s.reg.SubscribeWith(g.src, s.normalizer())
	if err != nil {
		return LogsResult{}, err
	}

	id := s.startLogSession(func(ctx context.Context, sink logs.Sink) {
		defer sub.Close()
		t := logs.New(ctx, s.opts.Actor, opts, sink)
		defer t.Close()
		v := s.logsView(g, sub)
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-sub.Events:
				if !ok {
					return
				}
				if opts.NoFollow {
					// not following: the pods of the first list, each read once
					if ev.Type != source.Relist {
						continue
					}
					sub.Close()
					t.Apply(g.apply(v, ev))
					t.Wait()
					return
				}
				t.Apply(g.apply(v, ev))
			}
		}
	})
	return LogsResult{Session: id, Context: ctxName, Title: g.title}, nil
}

// tailOptions turns the dialog's choices into tailer options; tail is the
// configured logs.tail (the default when the dialog leaves it 0).
func tailOptions(o LogsOptions, tail int) (logs.Options, error) {
	opts := logs.Options{Tail: int64(tail), NoFollow: !o.Follow, Whole: o.All}
	for _, c := range o.Containers {
		if c = strings.TrimSpace(c); c != "" {
			opts.Containers = append(opts.Containers, c)
		}
	}
	if o.Containers != nil && len(opts.Containers) == 0 {
		return logs.Options{}, fmt.Errorf("no container selected")
	}
	if o.Tail < 0 {
		return logs.Options{}, fmt.Errorf("tail must not be negative")
	}
	if o.Tail > 0 {
		opts.Tail = int64(o.Tail)
	}
	if o.Since != "" {
		if o.All {
			return logs.Options{}, fmt.Errorf("since and all exclude each other")
		}
		d, err := time.ParseDuration(o.Since)
		if err != nil || d <= 0 {
			return logs.Options{}, fmt.Errorf("since %q is not a duration like 10m or 1h30m", o.Since)
		}
		opts.Since = d
	}
	return opts, nil
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
