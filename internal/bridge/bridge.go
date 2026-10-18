// Package bridge is the only API the frontend talks to. It owns all view
// state; the frontend requests a viewport and receives throttled frames.
//
// Transport-agnostic: the app binds Service via Wails; tests and the
// headless backend serve the same methods over WebSocket (see ws.go).
package bridge

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	k8stypes "k8s.io/apimachinery/pkg/types"

	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/normalize"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/view"
)

// FrameEvent is the event name frames are emitted under.
const FrameEvent = "kw:frame"

// ConfigEvent is emitted with the new config.Effective after a reload.
const ConfigEvent = "kw:config"

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
	// ConfigDir is read by ReloadConfig ("" = no config files). New loads
	// the config itself unless Config is set.
	ConfigDir string
	Config    *config.Effective
	// Actor performs object actions (delete …); nil disables them.
	Actor source.Actor
}

// Service manages panes.
type Service struct {
	reg  *source.Registry
	emit Emitter
	opts Options

	mu    sync.Mutex
	panes map[string]*pane
	next  int
	cfg   config.Effective
	// norm applies the config's diff ignore rules to new views.
	norm     *normalize.Normalizer
	guard    *safety.Guard
	sessions map[string]*session
	forwards map[string]*forward
	// described: last describe run per object, for the describe diff
	described map[string]*describeSnap
	useq      uint64
}

// New creates a service.
func New(reg *source.Registry, emit Emitter, opts Options) *Service {
	if opts.MaxRate <= 0 {
		opts.MaxRate = 10
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}
	s := &Service{reg: reg, emit: emit, opts: opts, panes: map[string]*pane{}, sessions: map[string]*session{}, forwards: map[string]*forward{}, described: map[string]*describeSnap{}}
	s.guard = safety.NewGuard(safety.NewPolicy(nil), opts.Clock.Now)
	if opts.Config != nil {
		s.setConfig(*opts.Config)
	} else {
		s.setConfig(config.Load(opts.ConfigDir))
	}
	return s
}

func (s *Service) setConfig(cfg config.Effective) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
	s.norm = normalize.New(cfg.Config.Diff.Ignore...)
	s.guard.SetPolicy(safety.NewPolicy(cfg.Config.Contexts))
}

// viewOptions are the view options for a new pane.
func (s *Service) viewOptions(namespaced bool) view.Options {
	vo := s.opts.View
	vo.Namespaced = namespaced
	if vo.Normalizer == nil {
		s.mu.Lock()
		vo.Normalizer = s.norm
		s.mu.Unlock()
	}
	return vo
}

// Config returns the effective user configuration.
func (s *Service) Config() config.Effective {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// ReloadConfig re-reads the config files and emits ConfigEvent. Diff rules
// apply to panes opened (or rebuilt by Update) afterwards.
func (s *Service) ReloadConfig() config.Effective {
	cfg := config.Load(s.opts.ConfigDir)
	s.setConfig(cfg)
	s.emit.Emit(ConfigEvent, cfg)
	return cfg
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
	Pane string `json:"pane"`
	// Context is the resolved context name (the pipeline may say "" for
	// the current one); safety rules match against it. "" if unknown.
	Context    string `json:"context"`
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
	v, err := view.New(p, s.viewOptions(sub.Resolved.Namespaced && p.Source.AllNamespaces()))
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
	ctxName, _ := s.contextName(p.Source.Cluster)
	return OpenResult{Pane: id, Context: ctxName, Kind: sub.Resolved.Kind, Resource: sub.Resolved.GVR.Resource, Namespaced: sub.Resolved.Namespaced}, nil
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
	v, err := view.New(*p, s.viewOptions(pn.res.Namespaced && p.Source.AllNamespaces()))
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

func (s *Service) contextName(cluster string) (string, error) {
	if s.opts.Actor == nil {
		return cluster, nil
	}
	return s.opts.Actor.ContextName(cluster)
}

// ContextRule returns the safety rule (label, color, read-only …) for a
// pane's cluster ("" = current context).
func (s *Service) ContextRule(cluster string) (safety.Rule, error) {
	name, err := s.contextName(cluster)
	if err != nil {
		return safety.Rule{}, err
	}
	return s.guard.Rule(name), nil
}

// row is one object of a pane, resolved for an action.
type row struct {
	cluster string // as the pipeline names it ("" = current)
	context string // resolved context name (safety rules match on it)
	res     source.Resolved
	typed   string // the pipeline's resource name
	item    source.Item
}

func (r row) namespace() string { return r.item.Object.GetNamespace() }
func (r row) name() string      { return r.item.Object.GetName() }
func (r row) kind() string {
	if k := r.item.Object.GetKind(); k != "" {
		return k
	}
	return r.res.Kind
}
func (r row) isPod() bool { return r.kind() == "Pod" && r.item.Object.GetAPIVersion() == "v1" }

// row resolves a live (non-tombstone) row of a pane.
func (s *Service) row(paneID, key string) (row, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return row{}, err
	}
	pn.mu.Lock()
	it, ok := pn.view.Item(key)
	deleted := pn.view.Deleted(key)
	r := row{cluster: pn.p.Source.Cluster, res: pn.res, typed: pn.p.Source.Resource, item: it}
	pn.mu.Unlock()
	if !ok || deleted {
		return row{}, fmt.Errorf("object %s is gone", key)
	}
	if r.context, err = s.contextName(r.cluster); err != nil {
		return row{}, err
	}
	return r, nil
}

// Prepare checks a mutating action on one row against the safety policy
// and returns a single-use token for it. The action is built from Go's own
// state (resolved context, resource, object identity), never from the caller.
func (s *Service) Prepare(kind, paneID, key string) (safety.Pending, error) {
	if s.opts.Actor == nil {
		return safety.Pending{}, fmt.Errorf("%s is not available", kind)
	}
	r, err := s.row(paneID, key)
	if err != nil {
		return safety.Pending{}, err
	}
	if kind == safety.Exec && !r.isPod() {
		return safety.Pending{}, fmt.Errorf("exec needs a pod, not %s", strings.ToLower(r.kind()))
	}
	a := safety.Action{
		Kind: kind, Context: r.context, Resource: resourceName(r.res, r.typed),
		Namespace: r.namespace(), Name: r.name(), UID: string(r.item.Object.GetUID()),
	}
	return s.guard.Prepare(a, r)
}

// Delete executes a prepared delete. The open watch shows the deletion.
func (s *Service) Delete(token string) error {
	a, target, err := s.guard.Redeem(token, safety.Delete)
	if err != nil {
		return err
	}
	r := target.(row)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.opts.Actor.Delete(ctx, r.cluster, r.res, a.Namespace, a.Name, k8stypes.UID(a.UID))
}

// resourceName is the qualified resource (deployments.apps), or the
// pipeline's name if the source resolved no GVR (tapes).
func resourceName(r source.Resolved, asTyped string) string {
	switch {
	case r.GVR.Resource == "":
		return asTyped
	case r.GVR.Group == "":
		return r.GVR.Resource
	}
	return r.GVR.Resource + "." + r.GVR.Group
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
