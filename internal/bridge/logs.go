package bridge

import (
	"cmp"
	"context"
	"fmt"
	"slices"
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
// Previous reads each container's previous, terminated instance instead
// (kubectl logs -p): read once, whatever Follow says.
type LogsOptions struct {
	Containers []string `json:"containers,omitempty"`
	Tail       int      `json:"tail,omitempty"`
	Since      string   `json:"since,omitempty"`
	All        bool     `json:"all,omitempty"`
	Follow     bool     `json:"follow"`
	Previous   bool     `json:"previous,omitempty"`
	// Only narrows the tail to one of its pods (namespace/name): a pane per
	// pod. That pod by name, so a recreated StatefulSet pod carries on.
	Only *PodRef `json:"only,omitempty"`
}

// PodRef names a pod.
type PodRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// LogsTargets describes what a log tail would follow, for the dialog: its
// title and the container names its pods have.
type LogsTargets struct {
	Title      string   `json:"title"`
	Containers []string `json:"containers"`
	// Tail is the configured logs.tail, the dialog's default.
	Tail int `json:"tail"`
	// Skipped names marked rows left out of a marked tail (no pods to tail).
	Skipped []string `json:"skipped,omitempty"`
	// Pods are the pods it would follow now, by namespace and name (a pane
	// per pod: LogsOptions.Only).
	Pods []PodRef `json:"pods"`
}

// What a tail follows (LogsTargets, LogsStart): the row's pods, every pod
// the pods pane shows, or the pods of the marked rows.
const (
	LogsRow    = "row"
	LogsPane   = "pane"
	LogsMarked = "marked"
)

// logsMaxWatches caps the pods watches of a marked tail: one per marked
// workload, node or namespace (marked pods share one).
const logsMaxWatches = 20

// logsSource is one pods watch of a tail and what picks pods from it.
type logsSource struct {
	src source.Key
	// stages are applied to the watch to pick pods (whole pane)
	stages []pipeline.Stage
	// ownerUID keeps only pods owned by it (a workload's: a selector can over-match)
	ownerUID string
	// names keeps only pods of these namespace/name (marked pods)
	names map[string]bool
	// only keeps just this namespace/name (a pane per pod)
	only string
}

// logsTarget is a resolved tail target: its sources, whose picked pods are
// followed together (a pod picked by two counts once).
type logsTarget struct {
	sources []logsSource
	title   string
	skipped []string
}

func (s *Service) logsTarget(pn *pane, key, scope string) (logsTarget, error) {
	switch scope {
	case LogsPane:
		src, stages, title, err := s.wholePaneSource(pn)
		return logsTarget{sources: []logsSource{{src: src, stages: stages}}, title: title}, err
	case LogsMarked:
		return s.markedTarget(pn)
	case LogsRow, "":
		src, ownerUID, title, err := s.rowSource(pn, key)
		return logsTarget{sources: []logsSource{{src: src, ownerUID: ownerUID}}, title: title}, err
	}
	return logsTarget{}, fmt.Errorf("unknown log scope %q", scope)
}

// markedTarget tails the pods of a pane's marked rows: marked pods by name on
// one watch (the pane's), each workload, node or namespace on its pods
// child's watch. Rows without pods are skipped.
func (s *Service) markedTarget(pn *pane) (logsTarget, error) {
	rows, err := s.markedRows(pn.id)
	if err != nil {
		return logsTarget{}, err
	}
	if len(rows) == 0 {
		return logsTarget{}, ErrNoMarks
	}
	var (
		g     logsTarget
		pods  *logsSource
		named []string
	)
	for _, r := range rows {
		if r.isPod() {
			if pods == nil {
				// the pane's own watch when it is a pods pane (tapes resolve it);
				// a mixed pane's pods go by their own type
				res := pn.p.Source.Resource
				if pn.snapshot() {
					res = r.typed
				}
				pods = &logsSource{src: source.Key{Cluster: pn.p.Source.Cluster, Resource: res, Namespace: pn.p.Source.Namespace}, names: map[string]bool{}}
			}
			pods.names[r.namespace()+"/"+r.name()] = true
			named = append(named, r.name())
			continue
		}
		c := podChild(r.item.Object)
		if c == nil {
			g.skipped = append(g.skipped, r.name())
			continue
		}
		g.sources = append(g.sources, logsSource{src: source.Key{
			Cluster: pn.p.Source.Cluster, Resource: c.Resource, Namespace: c.Namespace,
			LabelSelector: c.LabelSelector, FieldSelector: c.FieldSelector,
		}, ownerUID: c.OwnerUID})
		named = append(named, strings.ToLower(r.kind())+"/"+r.name())
	}
	if len(g.sources) > logsMaxWatches {
		return logsTarget{}, fmt.Errorf("logs of %d marked workloads, nodes or namespaces: at most %d at once", len(g.sources), logsMaxWatches)
	}
	if pods != nil {
		g.sources = append([]logsSource{*pods}, g.sources...)
	}
	if len(g.sources) == 0 {
		return logsTarget{}, fmt.Errorf("none of the %d marked rows has pods to tail", len(rows))
	}
	g.title = markedTitle(named)
	return g, nil
}

// markedTitle names a marked tail: up to 3 names, else the first 2 and how many more.
func markedTitle(names []string) string {
	if len(names) <= 3 {
		return strings.Join(names, ", ")
	}
	return fmt.Sprintf("%s +%d", strings.Join(names[:2], ", "), len(names)-2)
}

// pick keeps the pods of a Relist event this source follows.
func (c logsSource) pick(v *view.View, ev source.Event) []source.Item {
	items := ev.Items
	if v != nil {
		items = matchedEvent(v, ev).Items
	}
	if c.ownerUID == "" && c.names == nil && c.only == "" {
		return items
	}
	var out []source.Item
	for _, it := range items {
		o := it.Object
		if o == nil {
			continue
		}
		key := o.GetNamespace() + "/" + o.GetName()
		if !(relations.Child{OwnerUID: c.ownerUID}).Owns(o) || c.names != nil && !c.names[key] || c.only != "" && key != c.only {
			continue
		}
		out = append(out, it)
	}
	return out
}

// logsView is a private view applying a whole-pane source's filters; nil otherwise.
func (s *Service) logsView(c logsSource, sub *source.Subscription) *view.View {
	if len(c.stages) == 0 {
		return nil
	}
	v, _ := view.New(pipeline.Pipeline{Source: pipeline.Source{
		Cluster: c.src.Cluster, Resource: c.src.Resource, Namespace: c.src.Namespace,
		LabelSelector: c.src.LabelSelector, FieldSelector: c.src.FieldSelector,
	}, Stages: c.stages}, s.viewOptions(sub, true))
	return v
}

// podSet tracks one source's pods from its watch events, so its current set
// is known for the merge.
type podSet struct {
	c     logsSource
	v     *view.View
	items map[string]source.Item // by UID
}

func newPodSet(c logsSource, v *view.View) *podSet {
	return &podSet{c: c, v: v, items: map[string]source.Item{}}
}

// apply takes a watch event; ok is false for events that change nothing
// (errors, progress). Every change re-picks from the whole set, so the
// filters (owner, names, the pane's view) see a Relist.
func (p *podSet) apply(ev source.Event) bool {
	switch ev.Type {
	case source.Relist:
		all := ev.Items
		p.items = map[string]source.Item{}
		for _, it := range p.c.pick(p.v, source.Event{Type: source.Relist, Items: all}) {
			p.items[string(it.Object.GetUID())] = it
		}
		return true
	case source.Added, source.Modified, source.Deleted:
		if p.v != nil {
			// the view keeps the watch's state: feed it the event, take what it matches
			p.items = map[string]source.Item{}
			for _, it := range matchedEvent(p.v, ev).Items {
				p.items[string(it.Object.GetUID())] = it
			}
			return true
		}
		if ev.Item.Object == nil {
			return false
		}
		uid := string(ev.Item.Object.GetUID())
		if ev.Type == source.Deleted {
			delete(p.items, uid)
			return true
		}
		if picked := p.c.pick(nil, source.Event{Type: source.Relist, Items: []source.Item{ev.Item}}); len(picked) > 0 {
			p.items[uid] = ev.Item
		} else {
			delete(p.items, uid)
		}
		return true
	}
	return false
}

// mergePods is the union of the sources' pods as one Relist: a pod picked by
// several sources (a marked deployment and one of its pods) counts once.
func mergePods(sets []*podSet) source.Event {
	seen := map[string]bool{}
	var items []source.Item
	for _, p := range sets {
		for uid, it := range p.items {
			if !seen[uid] {
				seen[uid] = true
				items = append(items, it)
			}
		}
	}
	return source.Event{Type: source.Relist, Items: items}
}

// logsTargetsWait bounds how long LogsTargets waits for a pods watch's
// first list (a shared watch already synced answers at once).
const logsTargetsWait = 5 * time.Second

// LogsTargets lists the containers a tail would follow, from the pods it
// would pick right now, for the log dialog. scope: LogsRow (key's pods),
// LogsPane or LogsMarked.
func (s *Service) LogsTargets(paneID, key, scope string) (LogsTargets, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return LogsTargets{}, err
	}
	g, err := s.logsTarget(pn, key, scope)
	if err != nil {
		return LogsTargets{}, err
	}
	out := LogsTargets{Title: g.title, Containers: []string{}, Tail: s.Config().Config.Logs.Tail, Skipped: g.skipped}
	pods, err := s.logsPods(g)
	if err != nil {
		return LogsTargets{}, err
	}
	if names := logs.ContainerNames(pods); names != nil {
		out.Containers = names
	}
	out.Pods = podRefs(pods)
	return out, nil
}

// podRefs names pods, sorted by namespace and name (the table's usual order).
func podRefs(pods []source.Item) []PodRef {
	out := []PodRef{}
	for _, it := range pods {
		if it.Object != nil {
			out = append(out, PodRef{Namespace: it.Object.GetNamespace(), Name: it.Object.GetName()})
		}
	}
	slices.SortFunc(out, func(a, b PodRef) int {
		return cmp.Or(cmp.Compare(a.Namespace, b.Namespace), cmp.Compare(a.Name, b.Name))
	})
	return out
}

// only narrows a target to one pod: every source keeps only it.
func (g logsTarget) only(p PodRef) logsTarget {
	key := p.Namespace + "/" + p.Name
	out := logsTarget{title: p.Name}
	for _, c := range g.sources {
		c.only = key
		out.sources = append(out.sources, c)
	}
	return out
}

// logsPods is the target's current pods: the first list of each source's
// watch, picked and merged.
func (s *Service) logsPods(g logsTarget) ([]source.Item, error) {
	var sets []*podSet
	for _, c := range g.sources {
		sub, err := s.reg.SubscribeWith(c.src, s.normalizer())
		if err != nil {
			return nil, err
		}
		p := newPodSet(c, s.logsView(c, sub))
		ev, err := firstList(sub, logsTargetsWait)
		sub.Close()
		if err != nil {
			return nil, err
		}
		p.apply(ev)
		sets = append(sets, p)
	}
	return mergePods(sets).Items, nil
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

// logsEvent is a watch event of a tail's i-th source.
type logsEvent struct {
	i  int
	ev source.Event
	ok bool
}

// LogsStart tails the logs of pods (stern-like). It needs no safety token:
// reading logs doesn't change the cluster, so it works on read-only
// contexts, like Describe and PortForwardStart. scope LogsRow tails the
// row's pods (a pod, or the pods of a workload/node/namespace); LogsPane
// every pod a pods pane currently shows (its filters applied); LogsMarked
// the pods of the marked rows together.
func (s *Service) LogsStart(paneID, key, scope string, o LogsOptions) (LogsResult, error) {
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

	g, err := s.logsTarget(pn, key, scope)
	if err != nil {
		return LogsResult{}, err
	}
	if o.Only != nil {
		g = g.only(*o.Only)
	}
	subs := make([]*source.Subscription, 0, len(g.sources))
	closeAll := func() {
		for _, sub := range subs {
			sub.Close()
		}
	}
	for _, c := range g.sources {
		sub, err := s.reg.SubscribeWith(c.src, s.normalizer())
		if err != nil {
			closeAll()
			return LogsResult{}, err
		}
		subs = append(subs, sub)
	}

	id := s.startLogSession(func(ctx context.Context, sink logs.Sink) {
		// ending on its own (not following, a watch closed) stops the feeders too
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		defer closeAll()
		t := logs.New(ctx, s.opts.Actor, opts, sink)
		defer t.Close()
		sets := make([]*podSet, len(g.sources))
		for i, c := range g.sources {
			sets[i] = newPodSet(c, s.logsView(c, subs[i]))
		}
		// one goroutine per watch feeds a single loop, which owns the sets
		events := make(chan logsEvent)
		for i, sub := range subs {
			go func() {
				for {
					select {
					case ev, ok := <-sub.Events:
						select {
						case events <- logsEvent{i: i, ev: ev, ok: ok}:
						case <-ctx.Done():
							return
						}
						if !ok {
							return
						}
					case <-ctx.Done():
						return
					}
				}
			}()
		}
		listed := make([]bool, len(sets))
		pending := len(sets) // sources whose first list hasn't come yet
		for {
			select {
			case <-ctx.Done():
				return
			case e := <-events:
				if !e.ok {
					return
				}
				if !sets[e.i].apply(e.ev) {
					continue
				}
				if !listed[e.i] && e.ev.Type == source.Relist {
					listed[e.i] = true
					pending--
				}
				if pending > 0 {
					continue // start once every source has listed: no pod is dropped as missing meanwhile
				}
				if opts.NoFollow {
					// not following: the pods of the first lists, each read once
					closeAll()
					t.Apply(mergePods(sets))
					t.Wait()
					return
				}
				t.Apply(mergePods(sets))
			}
		}
	})
	return LogsResult{Session: id, Context: ctxName, Title: g.title}, nil
}

// tailOptions turns the dialog's choices into tailer options; tail is the
// configured logs.tail (the default when the dialog leaves it 0).
func tailOptions(o LogsOptions, tail int) (logs.Options, error) {
	opts := logs.Options{Tail: int64(tail), NoFollow: !o.Follow || o.Previous, Whole: o.All, Previous: o.Previous}
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
