package bridge

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/view"
)

// Metric columns are fed from outside their objects, by feeds shared by the
// panes that show such a column, like watches; a feed stops when the last of
// its panes closes or hides the columns. Two kinds:
//   - usage (kubectl top): metrics.k8s.io can't be watched, so it's polled;
//     one feed per source (cluster, resource, namespace, selectors).
//   - allocation (kubectl describe node's "Allocated resources"): the
//     requests and limits of each node's unfinished pods, summed from one
//     shared watch on them; one feed per cluster.

// defaultMetricsInterval matches metrics-server's default resolution.
const defaultMetricsInterval = 15 * time.Second

// allocPushEvery throttles pushing changed allocations to the panes (a
// rollout moves many pods at once).
const allocPushEvery = time.Second

type feedKind int

const (
	usageFeed feedKind = iota
	allocFeed
)

type feedKey struct {
	kind feedKind
	key  source.Key
	// for usage: the source's kind (Pod, Node)
	res string
}

// feed is one shared source of metric data.
type feed struct {
	k      feedKey
	cancel context.CancelFunc

	mu    sync.Mutex
	panes map[*pane]bool
	// the latest data, handed to a pane joining; done: there is some
	usage map[string]source.Usage
	err   string
	alloc map[string]source.Allocation
	done  bool
}

// paneMetrics are the feeds of a pane and what they last delivered.
type paneMetrics struct {
	usage, alloc *feed
	data         view.Metrics
}

// syncMetrics starts or stops a pane's feeds after its columns changed.
func (s *Service) syncMetrics(pn *pane) {
	pn.mu.Lock()
	wantUsage := pn.view.ShowsUsage() && !pn.closed
	wantAlloc := pn.view.ShowsAllocation() && !pn.closed
	haveUsage, haveAlloc := pn.metrics.usage != nil, pn.metrics.alloc != nil
	pn.mu.Unlock()
	if wantUsage != haveUsage {
		s.setFeed(pn, usageFeed, wantUsage)
	}
	if wantAlloc != haveAlloc {
		s.setFeed(pn, allocFeed, wantAlloc)
	}
}

func (pm *paneMetrics) slot(kind feedKind) **feed {
	if kind == usageFeed {
		return &pm.usage
	}
	return &pm.alloc
}

// setFeed joins (on) or leaves a pane's feed of a kind.
func (s *Service) setFeed(pn *pane, kind feedKind, on bool) {
	if !on {
		pn.mu.Lock()
		slot := pn.metrics.slot(kind)
		f := *slot
		*slot = nil
		// shown again later: empty until the next data, not stale numbers
		if kind == usageFeed {
			pn.metrics.data.Usage, pn.metrics.data.UsageErr = nil, ""
		} else {
			pn.metrics.data.Alloc, pn.metrics.data.AllocErr, pn.metrics.data.AllocLoading = nil, "", false
		}
		pn.view.SetMetrics(pn.metrics.data)
		pn.mu.Unlock()
		if f != nil {
			s.release(f, pn)
		}
		pn.poke()
		return
	}
	src := pn.p.Source
	k := feedKey{kind: kind}
	if kind == usageFeed {
		k.key = source.Key{Cluster: src.Cluster, Resource: src.Resource, Namespace: src.Namespace, LabelSelector: src.LabelSelector, FieldSelector: src.FieldSelector}
		k.res = pn.res.Kind
	} else {
		k.key = source.Key{Cluster: src.Cluster}
	}
	s.mu.Lock()
	f, ok := s.feeds[k]
	if !ok {
		ctx, cancel := context.WithCancel(context.Background())
		f = &feed{k: k, cancel: cancel, panes: map[*pane]bool{}}
		s.feeds[k] = f
		if kind == usageFeed {
			go s.poll(ctx, f)
		} else {
			go s.sumAllocations(ctx, f)
		}
	}
	f.mu.Lock()
	f.panes[pn] = true
	usage, err, alloc, done := f.usage, f.err, f.alloc, f.done
	f.mu.Unlock()
	s.mu.Unlock()

	pn.mu.Lock()
	slot := pn.metrics.slot(kind)
	if pn.closed || *slot != nil {
		// closed meanwhile, or joined by a concurrent call: undo ours
		pn.mu.Unlock()
		s.release(f, pn)
		return
	}
	*slot = f
	if done {
		pn.metrics.deliver(kind, usage, err, alloc)
	} else if kind == allocFeed {
		// listing every pod takes a while: the status line says so
		pn.metrics.data.AllocLoading = true
	}
	pn.view.SetMetrics(pn.metrics.data)
	pn.mu.Unlock()
	pn.poke()
}

func (pm *paneMetrics) deliver(kind feedKind, usage map[string]source.Usage, err string, alloc map[string]source.Allocation) {
	if kind == usageFeed {
		pm.data.Usage, pm.data.UsageErr = usage, err
	} else {
		// sums or an error: loaded either way
		pm.data.Alloc, pm.data.AllocErr, pm.data.AllocLoading = alloc, err, false
	}
}

// leaveMetrics drops all of a pane's feeds (it closes).
func (s *Service) leaveMetrics(pn *pane) {
	s.setFeed(pn, usageFeed, false)
	s.setFeed(pn, allocFeed, false)
}

// release drops a pane from a feed, stopping it after the last one.
func (s *Service) release(f *feed, pn *pane) {
	s.mu.Lock()
	f.mu.Lock()
	delete(f.panes, pn)
	last := len(f.panes) == 0
	f.mu.Unlock()
	if last && s.feeds[f.k] == f {
		delete(s.feeds, f.k)
	}
	s.mu.Unlock()
	if last {
		f.cancel()
	}
}

// stopFeeds stops all feeds (shutdown).
func (s *Service) stopFeeds() {
	s.mu.Lock()
	feeds := s.feeds
	s.feeds = map[feedKey]*feed{}
	s.mu.Unlock()
	for _, f := range feeds {
		f.cancel()
	}
}

// publish stores a feed's new data and hands it to its panes.
func (s *Service) publish(f *feed, usage map[string]source.Usage, err string, alloc map[string]source.Allocation) {
	f.mu.Lock()
	f.usage, f.err, f.alloc, f.done = usage, err, alloc, true
	panes := make([]*pane, 0, len(f.panes))
	for pn := range f.panes {
		panes = append(panes, pn)
	}
	f.mu.Unlock()
	for _, pn := range panes {
		pn.mu.Lock()
		if *pn.metrics.slot(f.k.kind) == f {
			pn.metrics.deliver(f.k.kind, usage, err, alloc)
			pn.view.SetMetrics(pn.metrics.data)
		}
		pn.mu.Unlock()
		pn.poke()
	}
}

// poll fetches usage now and then every MetricsInterval until cancelled.
func (s *Service) poll(ctx context.Context, f *feed) {
	interval := s.opts.MetricsInterval
	if interval <= 0 {
		interval = defaultMetricsInterval
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		s.pollOnce(ctx, f)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Service) pollOnce(ctx context.Context, f *feed) {
	m, ok := s.opts.Actor.(source.Metrics)
	var usage map[string]source.Usage
	var err error
	if !ok {
		err = source.ErrNoMetrics
	} else {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		usage, err = m.Usage(cctx, f.k.key.Cluster, f.k.key, f.k.res)
		cancel()
	}
	if ctx.Err() != nil {
		return
	}
	msg := ""
	if err != nil {
		usage, msg = nil, err.Error()
		if !errors.Is(err, source.ErrNoMetrics) {
			msg = "metrics: " + msg
		}
	}
	s.publish(f, usage, msg, nil)
}

// sumAllocations watches the cluster's unfinished pods (one shared watch)
// and keeps each node's requests and limits summed, pushing changes at
// most every allocPushEvery.
func (s *Service) sumAllocations(ctx context.Context, f *feed) {
	sub, err := s.reg.Subscribe(source.Key{Cluster: f.k.key.Cluster, Resource: "pods", FieldSelector: source.UnfinishedPods})
	if err != nil {
		// no pods to sum: the columns stay empty, the status line says why
		s.publish(f, nil, "requests/limits: "+err.Error(), nil)
		return
	}
	defer sub.Close()
	type counted struct {
		node string
		r    source.Resources
	}
	pods := map[string]counted{}
	totals := map[string]source.Allocation{}
	key := func(it source.Item) string {
		if uid := string(it.Object.GetUID()); uid != "" {
			return uid
		}
		return it.Object.GetNamespace() + "/" + it.Object.GetName()
	}
	// uncount takes a pod out of its node's sum, count puts it in (again)
	uncount := func(k string) {
		if old, ok := pods[k]; ok {
			a := totals[old.node]
			a.Add(old.r, -1)
			totals[old.node] = a
			delete(pods, k)
		}
	}
	count := func(it source.Item) {
		k := key(it)
		uncount(k)
		spec, _ := it.Object.Object["spec"].(map[string]any)
		node, _ := spec["nodeName"].(string)
		r, ok := source.PodResources(it.Object.Object)
		if node == "" || !ok {
			return // not scheduled yet
		}
		pods[k] = counted{node: node, r: r}
		a := totals[node]
		a.Add(r, 1)
		totals[node] = a
	}

	tick := time.NewTicker(allocPushEvery)
	defer tick.Stop()
	dirty, synced := false, false
	push := func() {
		out := make(map[string]source.Allocation, len(totals))
		for n, a := range totals {
			// the totals' maps change on: the panes get copies
			out[n] = a.Clone()
		}
		s.publish(f, nil, "", out)
		dirty = false
	}
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.Events:
			if !ok {
				return
			}
			switch ev.Type {
			case source.Relist:
				pods, totals = map[string]counted{}, map[string]source.Allocation{}
				for _, it := range ev.Items {
					count(it)
				}
				if !synced {
					// the first list at once: the columns fill without a wait
					synced = true
					push()
					continue
				}
			case source.Added, source.Modified:
				count(ev.Item)
			case source.Deleted:
				uncount(key(ev.Item))
			case source.Error:
				// before the first list (forbidden …): the columns can't fill; after it the
				// watch retries and the sums stay as they were
				if !synced {
					s.publish(f, nil, "requests/limits: "+firstLine(ev.Err), nil)
				}
				continue
			default:
				continue
			}
			dirty = true
		case <-tick.C:
			if dirty && synced {
				push()
			}
		}
	}
}

// firstLine is an error's first line (errText adds the server's answer below).
func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}
