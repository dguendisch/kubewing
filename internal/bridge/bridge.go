// Package bridge is the only API the frontend talks to. It owns all view
// state; the frontend requests a viewport and receives throttled frames.
//
// Transport-agnostic: the app binds Service via Wails; tests and the
// headless backend serve the same methods over WebSocket (see ws.go).
package bridge

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	k8stypes "k8s.io/apimachinery/pkg/types"

	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/gardener"
	"github.com/dguendisch/kubewing/internal/health"
	"github.com/dguendisch/kubewing/internal/history"
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
	// User names ops pods (ops-pod-kubewing-<user>-…); "" = none.
	User string
	// History remembers recent debug images; nil = in memory only.
	History *config.HistoryStore
	// Columns are the column settings per resource type; nil = in memory only.
	Columns *config.ColumnStore
	// Clusters are the recently opened clusters; nil = in memory only.
	Clusters *config.ClusterStore
	// Gardener: gardenctl's config, sessions and garden lookups; nil = no Gardener targets.
	Gardener *Gardener
	// Actor performs object actions (delete …); nil disables them. If it
	// implements source.Metrics, it feeds the metric columns.
	Actor source.Actor
	// MetricsInterval is how often metric columns are polled (default 15s).
	MetricsInterval time.Duration
}

// Service manages panes.
type Service struct {
	reg *source.Registry
	// emit broadcasts to every window; stream events go through win to their window
	emit Emitter
	win  *Windows
	opts Options

	mu    sync.Mutex
	panes map[string]*pane
	next  int
	cfg   config.Effective
	// norm applies the config's diff ignore rules to new views.
	norm     *normalize.Normalizer
	guard    *safety.Guard
	sessions map[string]*session
	// running counts session goroutines, so Shutdown can wait for their
	// cleanup (an ops pod's delete)
	running  sync.WaitGroup
	forwards map[string]*forward
	// leased: the ops pod dialog's leases on shared watches (nodes, persistentvolumes)
	leased map[watchKey]*leasedWatch
	// described: last describe run per object, for the describe diff
	described map[string]*describeSnap
	// edits: open editors, by session id
	edits map[string]*editSession
	useq  uint64
	// feeds feed the metric columns (usage polls, allocation sums)
	feeds map[feedKey]*feed
	// opened: the Gardener targets OpenCluster resolved, by where their panes are (openedKey)
	opened map[string]gardener.Target
	// seeds: what resolving learned of seeds (managed or not), by garden/seed;
	// shoots: of shoots, their seed and the managed seed they are, by their cluster (see Location)
	seeds  map[string]gardener.Seed
	shoots map[string]shootInfo
}

// New creates a service.
func New(reg *source.Registry, emit Emitter, opts Options) *Service {
	if opts.MaxRate <= 0 {
		opts.MaxRate = 10
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}
	win := NewWindows(emit)
	s := &Service{reg: reg, emit: win, win: win, opts: opts, panes: map[string]*pane{}, sessions: map[string]*session{}, leased: map[watchKey]*leasedWatch{}, forwards: map[string]*forward{}, described: map[string]*describeSnap{}, edits: map[string]*editSession{}, feeds: map[feedKey]*feed{}, opened: map[string]gardener.Target{}, seeds: map[string]gardener.Seed{}, shoots: map[string]shootInfo{}}
	s.guard = safety.NewGuard(safety.NewPolicy(nil), opts.Clock.Now)
	if s.opts.History == nil {
		s.opts.History = config.OpenHistory("")
	}
	if s.opts.Columns == nil {
		s.opts.Columns = config.OpenColumns("")
	}
	if s.opts.Clusters == nil {
		s.opts.Clusters = config.OpenClusters("")
	}
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

// viewOptions are the view options for a new pane on sub.
func (s *Service) viewOptions(sub *source.Subscription, namespaced bool) view.Options {
	vo := s.opts.View
	vo.Namespaced = namespaced
	vo.Kind = sub.Resolved.Kind
	vo.Group = sub.Resolved.GVR.Group
	vo.History = sub.History
	vo.Health = s.Config().HealthRules()
	if vo.Normalizer == nil {
		vo.Normalizer = s.normalizer()
	}
	return vo
}

// normalizer applies the config's diff ignore rules.
func (s *Service) normalizer() *normalize.Normalizer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.norm
}

// Config returns the effective user configuration.
func (s *Service) Config() config.Effective {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// ReloadConfig re-reads the config files and emits ConfigEvent. Diff rules
// apply to watches started afterwards: a pane joining a running watch (a
// split) keeps its rules, so one history never mixes two rule sets. The
// history limits and the health rules apply at once, to running
// recordings and open panes too.
func (s *Service) ReloadConfig() config.Effective {
	cfg := config.Load(s.opts.ConfigDir)
	s.setConfig(cfg)
	s.reg.SetLimits(s.historyLimits())
	s.setHealth(cfg.HealthRules())
	s.emit.Emit(ConfigEvent, cfg)
	return cfg
}

// setHealth gives open panes new health rules; a pane hiding healthy
// objects shows what they change at its next frame.
func (s *Service) setHealth(rs *health.Rules) {
	s.mu.Lock()
	panes := make([]*pane, 0, len(s.panes))
	for _, pn := range s.panes {
		panes = append(panes, pn)
	}
	s.mu.Unlock()
	for _, pn := range panes {
		pn.mu.Lock()
		if pn.view != nil {
			pn.view.SetHealth(rs)
		}
		pn.mu.Unlock()
		pn.poke()
	}
}

// ConfigFile is a config file for the settings editor: config.yaml (⌘,)
// or keybindings.yaml (⌥⌘,), its text and path. A config.yaml that doesn't
// exist yet comes as the starter (every setting commented out), with the
// reference (every setting with its default) either way; keybindings.yaml
// comes without either: the frontend owns the keymap they're made of.
type ConfigFile struct {
	File      string `json:"file"`
	Path      string `json:"path"`
	Text      string `json:"text"`
	Exists    bool   `json:"exists"`
	Reference string `json:"reference,omitempty"`
}

// ConfigFile reads file (config.Editable; see type ConfigFile). Without a
// config directory (headless without -config) there is nothing to edit: an error.
func (s *Service) ConfigFile(file string) (ConfigFile, error) {
	dir := s.opts.ConfigDir
	text, exists, err := config.ReadFile(dir, file)
	if err != nil {
		return ConfigFile{}, err
	}
	f := ConfigFile{File: file, Path: filepath.Join(dir, file), Text: text, Exists: exists}
	if file == config.File {
		f.Reference = config.Reference
		if !exists {
			f.Text = config.Starter()
		}
	}
	return f, nil
}

// ConfigCheck is what a config file's text would bring (the editor's live
// check): its problems as kubewing would load it (empty = none), and for
// keybindings.yaml its entries, whose command ids and contexts the frontend
// checks.
type ConfigCheck struct {
	Problems    []string         `json:"problems"`
	Keybindings []config.Binding `json:"keybindings"`
}

// CheckConfig checks text as the content of file (see ConfigCheck).
func (s *Service) CheckConfig(file, text string) (ConfigCheck, error) {
	if !config.Editable(file) {
		return ConfigCheck{}, fmt.Errorf("%q is not an editable config file", file)
	}
	errs, e := config.Check(s.opts.ConfigDir, file, text)
	c := ConfigCheck{Problems: errs, Keybindings: []config.Binding{}}
	if c.Problems == nil {
		c.Problems = []string{}
	}
	if file == config.KeysFile {
		c.Keybindings = e.Keybindings
	}
	return c, nil
}

// SaveConfig writes file (config.Editable) and reloads the configuration
// (as ⌘⇧,): what it brings, problems included, comes back and as ConfigEvent.
func (s *Service) SaveConfig(file, text string) (config.Effective, error) {
	if err := config.WriteFile(s.opts.ConfigDir, file, text); err != nil {
		return config.Effective{}, err
	}
	return s.ReloadConfig(), nil
}

// Reconnect drops the connection to a cluster ("" = current) and restarts
// every watch on it with a fresh list (after the network was down, or a
// watch got stuck): the panes keep their objects, a list that differs
// shows as changes. Open shells, port-forwards and log streams keep their
// own connection. It returns how many watches restarted.
func (s *Service) Reconnect(cluster string) int {
	names := []string{cluster}
	if rc, ok := s.reg.Opener().(source.Reconnector); ok {
		names = rc.Reconnect(cluster)
	}
	n := s.reg.Restart(names...)
	if cat := s.opts.Catalog; cat != nil {
		for _, c := range names {
			cat.Restart(c)
		}
	}
	return n
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
	// typ is the resource type the column settings are kept by (resourceName);
	// explicit: the pipeline brought its own render, the type's columns don't apply
	typ      string
	explicit bool
	// metrics: the feeds of its metric columns and what they delivered;
	// closed: Close ran, so no feed may take it on any more
	metrics paneMetrics
	closed  bool
	// full: a snapshot's full objects of opened rows (see fullCache)
	full fullCache
	// blame: the managedFields of rows blamed lately (see blameCache)
	blame blameCache
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
	// Type is the resource type column settings are kept by (pods, deployments.apps).
	Type string `json:"type"`
	// Ambiguous: Resource exists in several groups, so only Type tells them apart.
	Ambiguous bool `json:"ambiguous,omitempty"`
	// Sort is the type's default sort (see defaultSorts) if the pipeline had
	// none and the pane uses it: the frontend takes it into the pane's spec.
	Sort string `json:"sort,omitempty"`
}

// defaultSorts are the sort a pane of a kind starts with when its pipeline
// has none (a column name, "-" = descending). Events: the latest first (an
// age column ascending is the youngest first).
var defaultSorts = map[string]string{"Event": "LAST SEEN", source.AllKind: "KIND"}

func hasSort(stages []pipeline.Stage) bool {
	return slices.ContainsFunc(stages, func(s pipeline.Stage) bool { return len(s.Sort) > 0 })
}

// Open starts a pane for a pipeline given as YAML.
func (s *Service) Open(pipelineYAML string) (OpenResult, error) {
	return s.OpenIn(context.Background(), pipelineYAML)
}

// OpenIn opens a pane for the calling window: its frames go there.
func (s *Service) OpenIn(ctx context.Context, pipelineYAML string) (OpenResult, error) {
	p, err := pipeline.Parse([]byte(pipelineYAML))
	if err != nil {
		return OpenResult{}, err
	}
	return s.openPipeline(windowOf(ctx), *p)
}

// OpenPipeline starts a pane for a pipeline (in the main window).
func (s *Service) OpenPipeline(p pipeline.Pipeline) (OpenResult, error) {
	return s.openPipeline(MainWindow, p)
}

func (s *Service) openPipeline(window string, p pipeline.Pipeline) (OpenResult, error) {
	sub, err := s.reg.SubscribeWith(source.Key{
		Cluster: p.Source.Cluster, Resource: p.Source.Resource, Namespace: p.Source.Namespace,
		LabelSelector: p.Source.LabelSelector, FieldSelector: p.Source.FieldSelector,
	}, s.normalizer())
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
	typ, explicit := resourceName(sub.Resolved, p.Source.Resource), len(p.Render.Columns) > 0
	if !explicit {
		p.Render.Columns = s.opts.Columns.Get(typ).Columns
	}
	sortBy := ""
	if def := defaultSorts[sub.Resolved.Kind]; def != "" && !hasSort(p.Stages) {
		sortBy = def
		p.Stages = append(slices.Clip(p.Stages), pipeline.Stage{Sort: []string{def}})
	}
	pn := &pane{p: p, res: sub.Resolved, typ: typ, explicit: explicit, sub: sub, kick: make(chan struct{}, 1)}
	vo := s.viewOptions(sub, sub.Resolved.Namespaced && p.Source.AllNamespaces())
	if pn.snapshot() {
		vo.Full = pn.full.get
	}
	v, err := view.New(p, vo)
	if err != nil {
		sub.Close()
		return OpenResult{}, err
	}
	s.mu.Lock()
	s.next++
	id := fmt.Sprintf("p%d", s.next)
	ctx, cancel := context.WithCancel(context.Background())
	pn.id, pn.view, pn.cancel = id, v, cancel
	s.panes[id] = pn
	s.mu.Unlock()
	s.win.Own(id, window) // before its first frame
	go s.pump(ctx, pn)
	s.syncMetrics(pn)
	ctxName, _ := s.contextName(p.Source.Cluster)
	s.recordCluster(p.Source.Cluster, ctxName)
	return OpenResult{Pane: id, Context: ctxName, Kind: sub.Resolved.Kind, Resource: sub.Resolved.GVR.Resource, Namespaced: sub.Resolved.Namespaced, Type: typ, Ambiguous: sub.Resolved.Ambiguous, Sort: sortBy}, nil
}

// Update replaces a pane's stages and columns (e.g. filter bar edits) in
// place: the shared watch, objects and diff state are kept. The source can't
// change. Unless the pane was opened with its own columns, its type's ones
// stay (see SetTypeColumns).
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
	if pn.p.Source != p.Source {
		pn.mu.Unlock()
		return fmt.Errorf("changing the source of a pane is not supported; open a new pane")
	}
	if !pn.explicit {
		// the frontend doesn't send columns: the type's ones stay
		p.Render = pn.p.Render
	}
	// keep objects and diff state: stages and columns change in place
	err = pn.view.SetStages(p.Stages)
	if err == nil && !equalColumns(pn.p.Render.Columns, p.Render.Columns) {
		if err = pn.view.SetRender(p.Render); err != nil {
			_ = pn.view.SetStages(pn.p.Stages) // can't fail: applied before
		}
	}
	if err == nil {
		pn.p = *p
	}
	pn.mu.Unlock()
	if err == nil {
		s.syncMetrics(pn)
		pn.poke()
	}
	return err
}

func equalColumns(a, b []pipeline.Column) bool { return slices.Equal(a, b) }

// Draft is a filter bar edit not applied yet: Field is "filter" (CEL) or
// "labels" (label selector).
type Draft struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// Preview evaluates a draft against a pane's live objects without changing
// the pane (the filter bar shows the outcome while typing).
func (s *Service) Preview(paneID string, d Draft) (view.Preview, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.Preview{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	switch d.Field {
	case "filter":
		return pn.view.PreviewFilter(d.Value), nil
	case "labels":
		return pn.view.PreviewLabels(d.Value, pn.p.Source.LabelSelector), nil
	}
	return view.Preview{}, fmt.Errorf("unknown draft field %q", d.Field)
}

// FieldKeys lists the keys at a path across a pane's live objects (CEL
// field completion). Path is the keys from the object down, empty for the
// top level; one key may contain dots (`labels`, `app.kubernetes.io/name`).
type FieldKeys struct {
	Keys    []view.FieldKey `json:"keys"`
	Objects int             `json:"objects"`
}

// FieldKeys returns completion candidates for the CEL filter field.
func (s *Service) FieldKeys(paneID string, path []string) (FieldKeys, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return FieldKeys{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	keys, n := pn.view.FieldKeys(path, 200)
	if keys == nil {
		keys = []view.FieldKey{}
	}
	return FieldKeys{Keys: keys, Objects: n}, nil
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
func (s *Service) Object(paneID, key string) (view.Detail, error) { return s.ObjectAt(paneID, key, 0) }

// ObjectAt is Object with version to of the row diffed against the one
// before it (0 = the newest), for stepping through the history.
func (s *Service) ObjectAt(paneID, key string, to int) (view.Detail, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.Detail{}, err
	}
	if pn.snapshot() && !pn.deleted(key) {
		// the list has metadata only: the YAML is the object as it is now
		// (a failed read keeps the metadata, which is what the list had)
		_ = s.fetchFull(pn, key)
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	d, ok := pn.view.ObjectAt(key, to)
	if !ok {
		return view.Detail{}, fmt.Errorf("object %s not found", key)
	}
	return d, nil
}

// SetRecording starts or stops history recording for a pane's source: it's
// the shared watch's, so every split on that source follows. Stopping
// brings panes showing the past back to live.
func (s *Service) SetRecording(paneID string, on bool) error {
	pn, err := s.pane(paneID)
	if err != nil {
		return err
	}
	if on {
		pn.sub.History.Record(s.historyLimits())
	} else {
		pn.sub.History.Stop()
	}
	// the other splits show it in their status line too
	s.mu.Lock()
	var same []*pane
	for _, p := range s.panes {
		if p.sub.History.Same(pn.sub.History) {
			same = append(same, p)
		}
	}
	s.mu.Unlock()
	for _, p := range same {
		if !on {
			p.mu.Lock()
			_ = p.view.SetTime(time.Time{})
			p.mu.Unlock()
		}
		p.poke()
	}
	return nil
}

// historyLimits are the config's history limits (invalid ones were
// reported and dropped by config.Load: the defaults then).
func (s *Service) historyLimits() history.Limits {
	s.mu.Lock()
	h := s.cfg.Config.History
	s.mu.Unlock()
	b, _ := h.Parse()
	return history.Limits{Budget: int(b)}
}

// Time-travel: a pane shows its objects as they were at a moment, from the
// recorded history of its source; stages, columns and the detail view work
// on them as on the live ones. Each pane has its own moment.

// SetTime shows the pane as of at (RFC 3339; "" = live). It starts
// recording if the source doesn't record yet: the timeline begins then.
func (s *Service) SetTime(paneID, at string) (view.Timeline, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.Timeline{}, err
	}
	var t time.Time
	if at != "" {
		if t, err = time.Parse(time.RFC3339Nano, at); err != nil {
			return view.Timeline{}, fmt.Errorf("time %q: %w", at, err)
		}
		if !pn.sub.History.Recording() {
			if err := s.SetRecording(paneID, true); err != nil {
				return view.Timeline{}, err
			}
		}
	}
	pn.mu.Lock()
	err = pn.view.SetTime(t)
	var tl view.Timeline
	if err == nil {
		tl, err = pn.view.Timeline()
		if errors.Is(err, view.ErrNoHistory) && at == "" {
			err = nil // back to live without recording: nothing to show
		}
	}
	pn.mu.Unlock()
	pn.poke()
	return tl, err
}

// Step moves the pane's moment to the next (dir > 0) or previous change
// of its rows; from live, back goes to the newest change. Moved false:
// nothing that way.
func (s *Service) Step(paneID string, dir int) (StepResult, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return StepResult{}, err
	}
	pn.mu.Lock()
	moved, err := pn.view.Step(dir)
	var tl view.Timeline
	if err == nil {
		tl, err = pn.view.Timeline()
	}
	pn.mu.Unlock()
	pn.poke()
	return StepResult{Moved: moved, Timeline: tl}, err
}

// StepResult: where a step went.
type StepResult struct {
	Moved    bool          `json:"moved"`
	Timeline view.Timeline `json:"timeline"`
}

// Timeline returns what a pane can travel over (refused without recording).
func (s *Service) Timeline(paneID string) (view.Timeline, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.Timeline{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	return pn.view.Timeline()
}

// FieldHistory returns how the field on line (0-based) of a row's YAML
// went over time; which: the YAML view's text ("yaml") or the normalized
// version to's ("norm", 0 = the one shown).
func (s *Service) FieldHistory(paneID, key string, to, line int, which string) (view.FieldHistory, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.FieldHistory{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	return pn.view.FieldAt(key, to, line, which)
}

// Decode decodes a row's field (⏎ in the YAML; see view.Decode).
func (s *Service) Decode(paneID string, req view.DecodeRequest) (view.Decoded, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.Decoded{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	return pn.view.Decode(req)
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
	s.win.Disown(paneID)
	pn.sub.Close()
	pn.mu.Lock()
	pn.closed = true
	pn.mu.Unlock()
	s.leaveMetrics(pn)
	return nil
}

// ContextList lists kubeconfig contexts.
type ContextList struct {
	Contexts []string `json:"contexts"`
	Current  string   `json:"current"`
	// Namespaces holds the namespace a context sets, for those that set one;
	// new panes on that context start in it.
	Namespaces map[string]string `json:"namespaces,omitempty"`
	// Kubeconfig lists the files of a kubeconfig other than kubewing's own
	// (opened from a terminal with its own $KUBECONFIG); its contexts are
	// clusters such as "@1/dev".
	Kubeconfig []string `json:"kubeconfig,omitempty"`
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
// context name, a pane's resolved one (OpenResult.Context): not a cluster,
// as "@1/dev" is "dev" too, and resolving "dev" would look in kubewing's
// own kubeconfig.
func (s *Service) ContextRule(context string) safety.Rule {
	return s.guard.Rule(context)
}

// row is one object of a pane, resolved for an action.
type row struct {
	pane    *pane
	cluster string // as the pipeline names it ("" = current)
	context string // resolved context name (safety rules match on it)
	res     source.Resolved
	typed   string // the pipeline's resource name
	item    source.Item
	key     string   // the row's key, where known (marked rows)
	cells   []string // the row's cells, where known (marked rows)
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
	r := row{pane: pn, cluster: pn.p.Source.Cluster, res: pn.res, typed: pn.p.Source.Resource, item: it}
	pn.mu.Unlock()
	if !ok || deleted {
		return row{}, fmt.Errorf("object %s is gone", key)
	}
	if pn.snapshot() {
		// a row of its own type, and the whole object (the list has metadata)
		if r.res, r.typed, err = s.rowType(r.cluster, it.Object); err != nil {
			return row{}, err
		}
		if err := s.fetchFull(pn, key); err == nil {
			r.item = source.Item{Object: pn.full.get(key)}
		}
	}
	if r.context, err = s.contextName(r.cluster); err != nil {
		return row{}, err
	}
	return r, nil
}

// deleted reports whether a row is a tombstone.
func (pn *pane) deleted(key string) bool {
	pn.mu.Lock()
	defer pn.mu.Unlock()
	return pn.view.Deleted(key)
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
	if (kind == safety.Exec || kind == safety.Debug) && !r.isPod() {
		return safety.Pending{}, fmt.Errorf("%s needs a pod, not %s", kind, strings.ToLower(r.kind()))
	}
	if kind == safety.Scale && replicas(r.item.Object) == nil {
		return safety.Pending{}, fmt.Errorf("%s has no replicas to scale", strings.ToLower(r.kind()))
	}
	if kind == safety.Restart {
		if why := restartable(r); why != "" {
			return safety.Pending{}, fmt.Errorf("restart: %s", why)
		}
	}
	a := safety.Action{
		Kind: kind, Context: r.context, Landscape: s.landscape(r.cluster), Resource: resourceName(r.res, r.typed),
		Namespace: r.namespace(), Name: r.name(), UID: string(r.item.Object.GetUID()),
	}
	return s.guard.Prepare(a, r)
}

// Delete executes a prepared delete. The open watch shows the deletion (a
// listing is listed again).
func (s *Service) Delete(token string) error {
	a, target, err := s.guard.Redeem(token, safety.Delete)
	if err != nil {
		return err
	}
	r := target.(row)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.opts.Actor.Delete(ctx, r.cluster, r.res, a.Namespace, a.Name, k8stypes.UID(a.UID)); err != nil {
		return err
	}
	s.refreshAfter(r)
	return nil
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
			s.win.emitStream(pn.id, FrameEvent, func(int64) any { return FramePayload{Pane: pn.id, Frame: f} })
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
			// a node's extended resource resolves a configured column of it: maybe
			// the first one to be summed
			resync := pn.view.ShowsAllocation() != (pn.metrics.alloc != nil)
			pn.mu.Unlock()
			if resync {
				s.syncMetrics(pn)
			}
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
