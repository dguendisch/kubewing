// Package bridge is the only API the frontend talks to. It owns all view
// state; the frontend requests a viewport and receives throttled frames.
//
// Transport-agnostic: the app binds Service via Wails; tests and the
// headless backend serve the same methods over WebSocket (see ws.go).
package bridge

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/view"
)

// FrameEvent is the event name frames are emitted under.
const FrameEvent = "kw:frame"

// Emitter pushes events to the frontend.
type Emitter interface {
	Emit(event string, data any)
}

// Clock abstracts time for deterministic tests.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// Options configure the service.
type Options struct {
	// MaxRate caps frames per second per pane (bridge budget). Default 10.
	MaxRate float64
	Clock   Clock
	View    view.Options
	// Catalog serves completion data; nil disables it (empty snapshots).
	Catalog *catalog.Catalog
}

// Service manages panes.
type Service struct {
	// Contexts lists clusters (for the WebSocket transport).
	Contexts func() (ContextList, error)

	reg  *source.Registry
	emit Emitter
	opts Options

	mu    sync.Mutex
	panes map[string]*pane
	next  int
}

// New creates a service.
func New(reg *source.Registry, emit Emitter, opts Options) *Service {
	if opts.MaxRate <= 0 {
		opts.MaxRate = 10
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}
	return &Service{reg: reg, emit: emit, opts: opts, panes: map[string]*pane{}}
}

type pane struct {
	id     string
	mu     sync.Mutex
	view   *view.View
	sub    *source.Subscription
	cancel context.CancelFunc
	kick   chan struct{}
	p      pipeline.Pipeline
	res    source.Resolved
	// seq numbers frames per pane, monotonic across view rebuilds (Update),
	// so clients can drop stale frames.
	seq uint64
}

// FramePayload wraps a frame with its pane id.
type FramePayload struct {
	Pane  string     `json:"pane"`
	Frame view.Frame `json:"frame"`
}

// OpenResult describes a newly opened pane.
type OpenResult struct {
	Pane       string `json:"pane"`
	Kind       string `json:"kind"`
	Resource   string `json:"resource"`
	Namespaced bool   `json:"namespaced"`
}

// Open starts a pane for a pipeline given as YAML.
func (s *Service) Open(pipelineYAML string) (OpenResult, error) {
	p, err := pipeline.Parse([]byte(pipelineYAML))
	if err != nil {
		return OpenResult{}, err
	}
	return s.OpenPipeline(*p)
}

// OpenPipeline starts a pane for a pipeline.
func (s *Service) OpenPipeline(p pipeline.Pipeline) (OpenResult, error) {
	sub, err := s.reg.Subscribe(source.Key{
		Cluster: p.Source.Cluster, Resource: p.Source.Resource, Namespace: p.Source.Namespace,
		LabelSelector: p.Source.LabelSelector, FieldSelector: p.Source.FieldSelector,
	})
	if cat := s.opts.Catalog; cat != nil {
		// the connection exists now, so tracking can't trigger a login; a
		// resolve miss may be a CRD the catalog doesn't know yet
		cat.Track(p.Source.Cluster)
		if err != nil {
			cat.Invalidate(p.Source.Cluster)
		}
	}
	if err != nil {
		return OpenResult{}, err
	}
	vo := s.opts.View
	vo.Namespaced = sub.Resolved.Namespaced && p.Source.AllNamespaces()
	v, err := view.New(p, vo)
	if err != nil {
		sub.Close()
		return OpenResult{}, err
	}
	s.mu.Lock()
	s.next++
	id := fmt.Sprintf("p%d", s.next)
	ctx, cancel := context.WithCancel(context.Background())
	pn := &pane{id: id, view: v, sub: sub, cancel: cancel, kick: make(chan struct{}, 1), p: p, res: sub.Resolved}
	s.panes[id] = pn
	s.mu.Unlock()
	go s.pump(ctx, pn)
	return OpenResult{Pane: id, Kind: sub.Resolved.Kind, Resource: sub.Resolved.GVR.Resource, Namespaced: sub.Resolved.Namespaced}, nil
}

// Update replaces a pane's pipeline (e.g. filter bar edits). If the source
// is unchanged the shared watch is kept and only the view is rebuilt.
func (s *Service) Update(paneID, pipelineYAML string) error {
	p, err := pipeline.Parse([]byte(pipelineYAML))
	if err != nil {
		return err
	}
	pn, err := s.pane(paneID)
	if err != nil {
		return err
	}
	pn.mu.Lock()
	sameSource := pn.p.Source == p.Source
	pn.mu.Unlock()
	if !sameSource {
		return fmt.Errorf("changing the source of a pane is not supported; open a new pane")
	}
	vo := s.opts.View
	vo.Namespaced = pn.res.Namespaced && p.Source.AllNamespaces()
	v, err := view.New(*p, vo)
	if err != nil {
		return err
	}
	// Re-subscribe to get a fresh snapshot for the new view.
	sub, err := s.reg.Subscribe(source.Key{
		Cluster: p.Source.Cluster, Resource: p.Source.Resource, Namespace: p.Source.Namespace,
		LabelSelector: p.Source.LabelSelector, FieldSelector: p.Source.FieldSelector,
	})
	if err != nil {
		return err
	}
	pn.cancel()
	pn.sub.Close()

	pn.mu.Lock()
	v.SetViewport(pn.view.Viewport())
	pn.view, pn.sub, pn.p = v, sub, *p
	ctx, cancel := context.WithCancel(context.Background())
	pn.cancel = cancel
	pn.mu.Unlock()
	go s.pump(ctx, pn)
	return nil
}

// SetViewport sets the visible row window of a pane.
func (s *Service) SetViewport(paneID string, offset, limit int) error {
	pn, err := s.pane(paneID)
	if err != nil {
		return err
	}
	pn.mu.Lock()
	pn.view.SetViewport(offset, limit)
	pn.mu.Unlock()
	pn.poke()
	return nil
}

// Resync makes the next frame resend everything (frontend reload).
func (s *Service) Resync(paneID string) error {
	pn, err := s.pane(paneID)
	if err != nil {
		return err
	}
	pn.mu.Lock()
	pn.view.Resync()
	pn.mu.Unlock()
	pn.poke()
	return nil
}

// Object returns the full object and normalized versions for one row; the
// only call that ships object content over the bridge.
func (s *Service) Object(paneID, key string) (view.Detail, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.Detail{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	d, ok := pn.view.Object(key)
	if !ok {
		return view.Detail{}, fmt.Errorf("object %s not found", key)
	}
	return d, nil
}

// Close stops a pane.
func (s *Service) Close(paneID string) error {
	s.mu.Lock()
	pn, ok := s.panes[paneID]
	delete(s.panes, paneID)
	s.mu.Unlock()
	if !ok {
		return nil
	}
	pn.cancel()
	pn.sub.Close()
	return nil
}

// ContextList lists kubeconfig contexts.
type ContextList struct {
	Contexts []string `json:"contexts"`
	Current  string   `json:"current"`
}

// Catalog returns completion data for a context ("" = current). It never
// connects: contexts without an open pane yet return an empty snapshot.
// Snapshots fill in asynchronously; poll while Loading.
func (s *Service) Catalog(cluster string) catalog.Snapshot {
	if s.opts.Catalog == nil {
		return catalog.Snapshot{Context: cluster, Resources: []source.ResourceType{}, Namespaces: []string{}}
	}
	return s.opts.Catalog.Get(cluster, false)
}

func (s *Service) pane(id string) (*pane, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pn, ok := s.panes[id]
	if !ok {
		return nil, fmt.Errorf("unknown pane %s", id)
	}
	return pn, nil
}

func (pn *pane) poke() {
	select {
	case pn.kick <- struct{}{}:
	default:
	}
}

// pump applies source events and emits at most MaxRate frames per second.
// Markers expire over time, so it also ticks while idle.
func (s *Service) pump(ctx context.Context, pn *pane) {
	interval := time.Duration(float64(time.Second) / s.opts.MaxRate)
	tick := time.NewTicker(interval)
	defer tick.Stop()
	var last time.Time
	dirty := true
	pn.mu.Lock()
	events := pn.sub.Events
	pn.mu.Unlock()

	flush := func() {
		now := s.opts.Clock.Now()
		pn.mu.Lock()
		f, ok := pn.view.Frame(now)
		if ok {
			pn.seq++
			f.Seq = pn.seq
		}
		pn.mu.Unlock()
		last, dirty = time.Now(), false
		if ok {
			s.emit.Emit(FrameEvent, FramePayload{Pane: pn.id, Frame: f})
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			pn.mu.Lock()
			pn.view.Apply(ev, s.opts.Clock.Now())
			pn.mu.Unlock()
			dirty = true
		case <-pn.kick:
			dirty = true
		case <-tick.C:
			// periodic flush picks up marker expiry
			dirty = true
		}
		if dirty && time.Since(last) >= interval {
			flush()
		}
	}
}
