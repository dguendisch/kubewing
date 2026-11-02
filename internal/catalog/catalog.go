// Package catalog keeps a per-context snapshot of what a cluster offers
// (resource types, namespaces) for completion. Snapshots are fetched in the
// background and kept fresh by change watches plus a periodic refresh.
//
// A context is only tracked once a pane opened on it, i.e. once its
// connection exists: the catalog never starts a connection on its own, so it
// never triggers exec-plugin logins (gardenlogin, OIDC) in the background.
package catalog

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/dguendisch/kubewing/internal/source"
)

// Snapshot is the catalog of one context as sent to the frontend. It is
// small (a few hundred types, ≤ thousands of namespaces) and sent whole.
type Snapshot struct {
	Context    string                `json:"context"`
	Resources  []source.ResourceType `json:"resources"`
	Namespaces []string              `json:"namespaces"`
	// Loading is true until both lists were fetched at least once.
	Loading bool `json:"loading"`
	// Partial lists API groups whose discovery failed; the rest is usable.
	Partial bool `json:"partial,omitempty"`
	// Errors per list ("resources", "namespaces"), e.g. forbidden.
	Errors map[string]string `json:"errors,omitempty"`
	// Gen increases with every change, so clients can skip identical refetches.
	Gen uint64 `json:"gen"`
}

// Options configure the catalog.
type Options struct {
	// Refresh is the periodic refetch interval (change watches may be
	// forbidden or miss aggregated APIs coming up). Default 5m.
	Refresh time.Duration
	// Debounce coalesces bursts of change signals. Default 500ms.
	Debounce time.Duration
	// Idle drops contexts nobody asked about for this long. Default 30m.
	Idle time.Duration
	Now  func() time.Time
}

// Catalog tracks contexts.
type Catalog struct {
	lister source.Lister
	opts   Options

	mu      sync.Mutex
	entries map[string]*entry
	closed  bool
}

type entry struct {
	snap   Snapshot
	cancel context.CancelFunc
	kick   chan source.Change
	used   time.Time
}

// New creates a catalog.
func New(l source.Lister, opts Options) *Catalog {
	if opts.Refresh <= 0 {
		opts.Refresh = 5 * time.Minute
	}
	if opts.Debounce <= 0 {
		opts.Debounce = 500 * time.Millisecond
	}
	if opts.Idle <= 0 {
		opts.Idle = 30 * time.Minute
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Catalog{lister: l, opts: opts, entries: map[string]*entry{}}
}

// Get returns the snapshot for a context and marks it used. An untracked
// context starts being tracked only if track is set; otherwise the result is
// empty and not loading. Never blocks on the network.
func (c *Catalog) Get(cluster string, track bool) Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[cluster]
	if !ok {
		if !track || c.closed {
			return Snapshot{Context: cluster, Resources: []source.ResourceType{}, Namespaces: []string{}}
		}
		e = c.start(cluster)
	}
	e.used = c.opts.Now()
	c.gc()
	return e.snap.clone()
}

// Track starts tracking a context (after a pane opened on it).
func (c *Catalog) Track(cluster string) { c.Get(cluster, true) }

// Invalidate requests a refetch of resource types, e.g. after a resolve miss
// (a new CRD). No-op for untracked contexts.
func (c *Catalog) Invalidate(cluster string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[cluster]; ok {
		select {
		case e.kick <- source.ResourcesChanged:
		default:
		}
	}
}

// Restart refetches a tracked context and restarts its change watches
// (after a reconnect); the last snapshot stays until the new one arrives.
// No-op for untracked contexts.
func (c *Catalog) Restart(cluster string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[cluster]
	if !ok || c.closed {
		return
	}
	e.cancel()
	ctx, cancel := context.WithCancel(context.Background())
	ne := &entry{snap: e.snap.clone(), cancel: cancel, kick: make(chan source.Change, 1), used: e.used}
	c.entries[cluster] = ne
	go c.run(ctx, cluster, ne)
}

// Close stops all background work.
func (c *Catalog) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	for k, e := range c.entries {
		e.cancel()
		delete(c.entries, k)
	}
}

// start must be called with c.mu held.
func (c *Catalog) start(cluster string) *entry {
	ctx, cancel := context.WithCancel(context.Background())
	e := &entry{
		snap:   Snapshot{Context: cluster, Resources: []source.ResourceType{}, Namespaces: []string{}, Loading: true, Gen: 1},
		cancel: cancel,
		kick:   make(chan source.Change, 1),
	}
	c.entries[cluster] = e
	go c.run(ctx, cluster, e)
	return e
}

// gc drops idle entries; must be called with c.mu held.
func (c *Catalog) gc() {
	now := c.opts.Now()
	for k, e := range c.entries {
		if now.Sub(e.used) > c.opts.Idle {
			e.cancel()
			delete(c.entries, k)
		}
	}
}

func (c *Catalog) run(ctx context.Context, cluster string, e *entry) {
	changes := make(chan source.Change, 16)
	c.fetch(ctx, cluster, e, source.ResourcesChanged|source.NamespacesChanged, false)
	go c.lister.Changes(ctx, cluster, changes)

	refresh := time.NewTicker(c.opts.Refresh)
	defer refresh.Stop()
	var pending source.Change
	var debounce <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case ch := <-changes:
			pending |= ch
		case ch := <-e.kick:
			pending |= ch
		case <-refresh.C:
			pending |= source.ResourcesChanged | source.NamespacesChanged
		case <-debounce:
			what := pending
			pending, debounce = 0, nil
			c.fetch(ctx, cluster, e, what, true)
			continue
		}
		if debounce == nil {
			debounce = time.After(c.opts.Debounce)
		}
	}
}

func (c *Catalog) fetch(ctx context.Context, cluster string, e *entry, what source.Change, refresh bool) {
	type result struct {
		res     []source.ResourceType
		ns      []string
		resErr  error
		nsErr   error
		partial bool
	}
	var r result
	var wg sync.WaitGroup
	if what&source.ResourcesChanged != 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.res, r.resErr = c.lister.ResourceTypes(ctx, cluster, refresh)
			if r.resErr != nil && source.PartialDiscovery(r.resErr) {
				r.partial = true
			}
		}()
	}
	if what&source.NamespacesChanged != 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.ns, r.nsErr = c.lister.Namespaces(ctx, cluster)
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	s := &e.snap
	if s.Errors == nil {
		s.Errors = map[string]string{}
	}
	if what&source.ResourcesChanged != 0 {
		switch {
		case r.resErr == nil || r.partial:
			s.Resources, s.Partial = r.res, r.partial
			delete(s.Errors, "resources")
		case len(s.Resources) == 0:
			s.Errors["resources"] = r.resErr.Error()
		}
		// on a failed refresh the last good list stays
	}
	if what&source.NamespacesChanged != 0 {
		switch {
		case r.nsErr == nil:
			sort.Strings(r.ns)
			s.Namespaces = r.ns
			delete(s.Errors, "namespaces")
		case len(s.Namespaces) == 0:
			s.Errors["namespaces"] = r.nsErr.Error()
		}
	}
	if s.Resources == nil {
		s.Resources = []source.ResourceType{}
	}
	if s.Namespaces == nil {
		s.Namespaces = []string{}
	}
	if len(s.Errors) == 0 {
		s.Errors = nil
	}
	s.Loading = false
	s.Gen++
}

func (s Snapshot) clone() Snapshot {
	out := s
	// never nil: JSON's null would reach the dialog as no list at all
	out.Resources = append([]source.ResourceType{}, s.Resources...)
	out.Namespaces = append([]string{}, s.Namespaces...)
	if s.Errors != nil {
		out.Errors = make(map[string]string, len(s.Errors))
		for k, v := range s.Errors {
			out.Errors[k] = v
		}
	}
	return out
}
