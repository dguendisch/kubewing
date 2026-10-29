package source

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/dguendisch/kubewing/internal/fieldpath"
	"github.com/dguendisch/kubewing/internal/history"
	"github.com/dguendisch/kubewing/internal/normalize"
)

// Key identifies a shared watch.
type Key struct {
	Cluster, Resource, Namespace, LabelSelector, FieldSelector string
}

// Opener starts a watch for a key, sending events to out until ctx ends.
// It is implemented by real clusters and by tape replays.
type Opener interface {
	Resolve(cluster, resource string) (Resolved, error)
	Watch(ctx context.Context, cluster string, res Resolved, k Key, out chan<- Event)
}

// Reconnector is an Opener that can drop a context's connection, so the
// next request connects anew. Reconnect returns every cluster name that
// shared the connection ("" and the current context's name are one).
type Reconnector interface {
	Reconnect(cluster string) []string
}

// Registry shares one watch per key between all subscribers (splits on the
// same source), ref-counted: the watch stops when the last subscriber leaves.
// A watch can record history (off by default, it costs per event): it then
// normalizes its objects once for all subscribers and keeps their recent
// versions (History).
type Registry struct {
	opener Opener
	mu     sync.Mutex
	shared map[Key]*shared

	// Now stamps recorded versions; tests replace it.
	Now func() time.Time
	// TombstoneFor is how long a deleted object's history stays (0 = 1m;
	// past every view's tombstone row).
	TombstoneFor time.Duration
}

// NewRegistry creates a registry.
func NewRegistry(o Opener) *Registry {
	return &Registry{opener: o, shared: map[Key]*shared{}, Now: time.Now}
}

type shared struct {
	key Key
	// cluster as the first subscriber named it (key has the resolved resource)
	cluster string
	res     Resolved
	cancel  context.CancelFunc
	refs    int
	subs    map[int]chan Event
	nextSub int

	// norm is fixed for the watch's life, so its history never mixes two
	// rule sets; hmu guards hist (read by subscribers, written by fanout
	// outside the registry lock); hist nil = not recording
	norm *normalize.Normalizer
	hmu  sync.Mutex
	hist *history.Store
	// pruned: the last Prune, a walk over every object (at most once a second)
	pruned time.Time

	// current state, replayed to late subscribers
	synced  bool
	items   map[string]Item
	columns []metav1.TableColumnDefinition
	lastErr string
}

// Subscription receives events for one subscriber.
type Subscription struct {
	Events   <-chan Event
	Resolved Resolved
	History  *History
	close    func()
}

// History reads a shared watch's versions and switches its recording;
// safe for concurrent use.
type History struct {
	sh  *shared
	reg *Registry
	now func() time.Time
}

// Range returns the oldest and newest kept version of key (0, 0 if none).
func (h *History) Range(key string) (first, last int) {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return 0, 0
	}
	return h.sh.hist.Range(key)
}

// Pair reconstructs version to of key and the one before it (see history.Store.Pair).
func (h *History) Pair(key string, to int) (history.Pair, bool) {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return history.Pair{}, false
	}
	return h.sh.hist.Pair(key, to)
}

// At is every object as it was at t (see history.Store.At); nil if not recording.
func (h *History) At(t time.Time) map[string]history.Version {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return nil
	}
	return h.sh.hist.At(t)
}

// Span is the recorded time span; ok false if not recording.
func (h *History) Span() (history.Span, bool) {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return history.Span{}, false
	}
	return h.sh.hist.Span(), true
}

// Changes returns the moments in [from, to] the objects keep accepts changed.
func (h *History) Changes(from, to time.Time, keep func(key string) bool) []time.Time {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return nil
	}
	return h.sh.hist.Changes(from, to, keep)
}

// VersionAt returns key's version current at t (0 = none).
func (h *History) VersionAt(key string, t time.Time) int {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return 0
	}
	return h.sh.hist.VersionAt(key, t)
}

// Field returns how one field of key went over its kept versions.
func (h *History) Field(key string, p fieldpath.Path) []history.FieldChange {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return nil
	}
	return h.sh.hist.Field(key, p)
}

// Usage is the recorded history's estimated size and limits; ok false if not recording.
func (h *History) Usage() (bytes int, limits history.Limits, ok bool) {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	if h.sh.hist == nil {
		return 0, history.Limits{}, false
	}
	return h.sh.hist.Bytes(), h.sh.hist.Limits(), true
}

// SetLimits applies new limits to every recording watch now (config reload).
func (r *Registry) SetLimits(l history.Limits) {
	r.mu.Lock()
	shs := make([]*shared, 0, len(r.shared))
	for _, sh := range r.shared {
		shs = append(shs, sh)
	}
	r.mu.Unlock()
	for _, sh := range shs {
		sh.hmu.Lock()
		if sh.hist != nil {
			sh.hist.SetLimits(l)
		}
		sh.hmu.Unlock()
	}
}

// Opener is the registry's opener.
func (r *Registry) Opener() Opener { return r.opener }

// Same reports whether h and o read the same shared watch.
func (h *History) Same(o *History) bool { return o != nil && h.sh == o.sh }

// Recording reports whether the watch records history.
func (h *History) Recording() bool {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	return h.sh.hist != nil
}

// SetRecording starts or stops recording for the watch (every subscriber
// on it) with the default limits; see Record.
func (h *History) SetRecording(on bool) {
	if on {
		h.Record(history.Limits{})
	} else {
		h.Stop()
	}
}

// Stop stops recording and drops the history.
func (h *History) Stop() {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	h.sh.hist = nil
}

// Record starts recording for the watch (every subscriber on it) within
// limits; already recording, it changes nothing. The current objects are
// the first versions, so the next change already diffs. Lock order: hmu,
// then the registry's mu (as fanout).
func (h *History) Record(limits history.Limits) {
	h.sh.hmu.Lock()
	defer h.sh.hmu.Unlock()
	switch {
	case h.sh.hist == nil:
		h.sh.hist = history.New(limits)
		now := h.now()
		h.reg.mu.Lock()
		items := make([]Item, 0, len(h.sh.items))
		for _, it := range h.sh.items {
			items = append(items, it)
		}
		h.reg.mu.Unlock()
		for _, it := range items {
			h.sh.recordItem(it, now)
		}
	}
}

// Close unsubscribes.
func (s *Subscription) Close() { s.close() }

// Subscribe attaches to (or starts) the shared watch for k with the default
// noise rules; see SubscribeWith.
func (r *Registry) Subscribe(k Key) (*Subscription, error) { return r.SubscribeWith(k, nil) }

// SubscribeWith attaches to (or starts) the shared watch for k. A late
// subscriber first receives a Relist with the current state. Watches are
// shared by what they resolve to: "no", "node" and "nodes" are one watch,
// and a cluster-scoped type ignores the namespace. norm (nil = the default
// rules) only applies when this call starts the watch; joining one keeps
// its rules.
func (r *Registry) SubscribeWith(k Key, norm *normalize.Normalizer) (*Subscription, error) {
	res, err := r.opener.Resolve(k.Cluster, k.Resource)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", k.Resource, err)
	}
	id := shareKey(k, res)
	r.mu.Lock()
	defer r.mu.Unlock()
	sh, ok := r.shared[id]
	if !ok {
		if norm == nil {
			norm = normalize.New()
		}
		sh = &shared{key: id, cluster: k.Cluster, res: res, subs: map[int]chan Event{}, items: map[string]Item{}, norm: norm}
		r.shared[id] = sh
		r.start(sh, k)
	}
	sh.refs++
	sub := sh.nextSub
	sh.nextSub++
	// generous buffer; subscribers coalesce on their side
	ch := make(chan Event, 1024)
	if sh.synced {
		ch <- sh.snapshot()
	}
	if sh.lastErr != "" {
		ch <- Event{Type: Error, Err: sh.lastErr}
	}
	sh.subs[sub] = ch
	var once sync.Once
	return &Subscription{Events: ch, Resolved: sh.res, History: &History{sh: sh, reg: r, now: r.Now}, close: func() {
		once.Do(func() { r.unsubscribe(sh, sub) })
	}}, nil
}

// start runs the opener's watch for sh; r.mu held (or sh not shared yet).
func (r *Registry) start(sh *shared, k Key) {
	ctx, cancel := context.WithCancel(context.Background())
	sh.cancel = cancel
	in := make(chan Event, 256)
	go r.opener.Watch(ctx, k.Cluster, sh.res, k, in)
	go r.fanout(ctx, sh, in)
}

// Restart starts the running watches on the given clusters anew (after a
// reconnect): a fresh list, without the backoff of a failing watch.
// Subscribers stay attached and keep their objects (and history); the new
// list reaches them as a Relist, which they diff as usual. It returns how
// many watches restarted.
func (r *Registry) Restart(clusters ...string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, sh := range r.shared {
		if !slices.Contains(clusters, sh.cluster) {
			continue
		}
		sh.cancel()
		k := sh.key
		k.Cluster = sh.cluster
		r.start(sh, k)
		n++
	}
	return n
}

// shareKey identifies the watch k resolves to. Openers without GVRs (tapes)
// share by the name as given.
func shareKey(k Key, res Resolved) Key {
	if res.GVR.Resource == "" {
		return k
	}
	k.Resource = res.GVR.String()
	if !res.Namespaced {
		k.Namespace = ""
	}
	return k
}

func (r *Registry) unsubscribe(sh *shared, id int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ch, ok := sh.subs[id]; ok {
		delete(sh.subs, id)
		close(ch)
	}
	sh.refs--
	if sh.refs == 0 {
		sh.cancel()
		delete(r.shared, sh.key)
	}
}

// Active returns the number of running shared watches (for tests/status).
func (r *Registry) Active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.shared)
}

func (sh *shared) snapshot() Event {
	items := make([]Item, 0, len(sh.items))
	for _, it := range sh.items {
		items = append(items, it)
	}
	return Event{Type: Relist, Items: items, Columns: sh.columns}
}

func itemKey(it Item) string {
	if uid := string(it.Object.GetUID()); uid != "" {
		return uid
	}
	return it.Object.GetNamespace() + "/" + it.Object.GetName()
}

func (r *Registry) fanout(ctx context.Context, sh *shared, in <-chan Event) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-in:
			// outside the registry lock: a 10k-object relist must not stall
			// subscribes on other watches. hmu (before r.mu) stays held until
			// the items are stored, so a recording that starts meanwhile
			// seeds from exactly what the history has seen.
			sh.hmu.Lock()
			if ctx.Err() != nil {
				sh.hmu.Unlock()
				return
			}
			ev = r.record(sh, ev)
			r.mu.Lock()
			if ctx.Err() != nil {
				// restarted (or stopped) meanwhile: only the new watch's
				// events reach subscribers
				r.mu.Unlock()
				sh.hmu.Unlock()
				return
			}
			switch ev.Type {
			case Relist:
				sh.items = make(map[string]Item, len(ev.Items))
				for _, it := range ev.Items {
					sh.items[itemKey(it)] = it
				}
				sh.columns, sh.synced, sh.lastErr = ev.Columns, true, ""
			case Added, Modified:
				sh.items[itemKey(ev.Item)] = ev.Item
			case Deleted:
				delete(sh.items, itemKey(ev.Item))
			case Error:
				sh.lastErr = ev.Err
			}
			for _, ch := range sh.subs {
				select {
				case ch <- ev:
				default:
					// subscriber is far behind: drop the backlog and resend the
					// full state, which the view reconciles as a relist.
					drain(ch)
					ch <- sh.snapshot()
				}
			}
			r.mu.Unlock()
			sh.hmu.Unlock()
		}
	}
}

// record normalizes the event's objects into the watch's history and
// returns the event with each item's Norm and Hash set; unchanged when the
// watch doesn't record. hmu must be held.
func (r *Registry) record(sh *shared, ev Event) Event {
	if sh.hist == nil {
		return ev
	}
	now := r.Now()
	tomb := r.TombstoneFor
	if tomb <= 0 {
		tomb = time.Minute
	}
	if now.Sub(sh.pruned) >= time.Second {
		sh.hist.Prune(now.Add(-tomb))
		sh.pruned = now
	}
	switch ev.Type {
	case Relist:
		items := make([]Item, len(ev.Items))
		seen := make(map[string]bool, len(ev.Items))
		for i, it := range ev.Items {
			items[i] = sh.recordItem(it, now)
			seen[itemKey(it)] = true
		}
		sh.hist.Keys(func(k string) {
			if !seen[k] {
				sh.hist.Delete(k, now)
			}
		})
		ev.Items = items
	case Added, Modified:
		ev.Item = sh.recordItem(ev.Item, now)
	case Deleted:
		sh.hist.Delete(itemKey(ev.Item), now)
	}
	return ev
}

// recordItem needs hmu held and hist set.
func (sh *shared) recordItem(it Item, now time.Time) Item {
	norm := sh.norm.Normalize(it.Object)
	hash, size := normalize.HashSize(norm)
	it.Norm, it.Hash = norm, hash
	sh.hist.RecordSized(itemKey(it), norm, hash, size, it.Cells, now)
	return it
}

func drain(ch chan Event) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
