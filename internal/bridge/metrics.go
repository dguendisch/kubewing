package bridge

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dguendisch/kubewing/internal/source"
)

// Metric columns (kubectl top) are fed by pollers: metrics.k8s.io can't be
// watched. One poller per source (cluster, resource, namespace, labels),
// shared by the panes on it that show a metric column, like watches; it
// stops when the last of them closes or hides the columns.

// defaultMetricsInterval matches metrics-server's default resolution.
const defaultMetricsInterval = 15 * time.Second

type metricsKey struct {
	key  source.Key
	kind string
}

type poller struct {
	k      metricsKey
	cancel context.CancelFunc

	mu    sync.Mutex
	panes map[*pane]bool
	// the last poll, handed to a pane joining
	usage map[string]source.Usage
	err   string
	done  bool // polled at least once
}

// syncMetrics starts or stops polling for a pane after its columns changed.
func (s *Service) syncMetrics(pn *pane) {
	pn.mu.Lock()
	want := pn.view.ShowsMetrics() && !pn.closed
	have := pn.metrics != nil
	pn.mu.Unlock()
	switch {
	case want && !have:
		s.joinMetrics(pn)
	case !want && have:
		s.leaveMetrics(pn)
	}
}

func (s *Service) joinMetrics(pn *pane) {
	k := metricsKey{key: source.Key{
		Cluster: pn.p.Source.Cluster, Resource: pn.p.Source.Resource, Namespace: pn.p.Source.Namespace,
		LabelSelector: pn.p.Source.LabelSelector, FieldSelector: pn.p.Source.FieldSelector,
	}, kind: pn.res.Kind}
	s.mu.Lock()
	po, ok := s.pollers[k]
	if !ok {
		ctx, cancel := context.WithCancel(context.Background())
		po = &poller{k: k, cancel: cancel, panes: map[*pane]bool{}}
		s.pollers[k] = po
		go s.poll(ctx, po)
	}
	po.mu.Lock()
	po.panes[pn] = true
	usage, err, done := po.usage, po.err, po.done
	po.mu.Unlock()
	s.mu.Unlock()

	pn.mu.Lock()
	if pn.closed || pn.metrics != nil {
		// closed meanwhile, or joined by a concurrent call: undo ours
		pn.mu.Unlock()
		s.release(po, pn)
		return
	}
	pn.metrics = po
	if done {
		pn.view.SetUsage(usage, err)
	}
	pn.mu.Unlock()
	pn.poke()
}

func (s *Service) leaveMetrics(pn *pane) {
	pn.mu.Lock()
	po := pn.metrics
	pn.metrics = nil
	// shown again later: empty until the next poll, not stale numbers
	pn.view.SetUsage(nil, "")
	pn.mu.Unlock()
	if po != nil {
		s.release(po, pn)
	}
}

// release drops a pane from a poller, stopping it after the last one.
func (s *Service) release(po *poller, pn *pane) {
	s.mu.Lock()
	po.mu.Lock()
	delete(po.panes, pn)
	last := len(po.panes) == 0
	po.mu.Unlock()
	if last && s.pollers[po.k] == po {
		delete(s.pollers, po.k)
	}
	s.mu.Unlock()
	if last {
		po.cancel()
	}
}

// stopPollers stops all pollers (shutdown).
func (s *Service) stopPollers() {
	s.mu.Lock()
	pollers := s.pollers
	s.pollers = map[metricsKey]*poller{}
	s.mu.Unlock()
	for _, po := range pollers {
		po.cancel()
	}
}

// poll fetches usage now and then every MetricsInterval until cancelled.
func (s *Service) poll(ctx context.Context, po *poller) {
	interval := s.opts.MetricsInterval
	if interval <= 0 {
		interval = defaultMetricsInterval
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		s.pollOnce(ctx, po)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Service) pollOnce(ctx context.Context, po *poller) {
	m, ok := s.opts.Actor.(source.Metrics)
	var usage map[string]source.Usage
	var err error
	if !ok {
		err = source.ErrNoMetrics
	} else {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		usage, err = m.Usage(cctx, po.k.key.Cluster, po.k.key, po.k.kind)
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
	po.mu.Lock()
	po.usage, po.err, po.done = usage, msg, true
	panes := make([]*pane, 0, len(po.panes))
	for pn := range po.panes {
		panes = append(panes, pn)
	}
	po.mu.Unlock()
	for _, pn := range panes {
		pn.mu.Lock()
		if pn.metrics == po {
			pn.view.SetUsage(usage, msg)
		}
		pn.mu.Unlock()
		pn.poke()
	}
}
