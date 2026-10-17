package source

import (
	"context"
	"fmt"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

// Registry shares one watch per key between all subscribers (splits on the
// same source), ref-counted: the watch stops when the last subscriber leaves.
type Registry struct {
	opener Opener
	mu     sync.Mutex
	shared map[Key]*shared
}

// NewRegistry creates a registry.
func NewRegistry(o Opener) *Registry {
	return &Registry{opener: o, shared: map[Key]*shared{}}
}

type shared struct {
	key     Key
	res     Resolved
	cancel  context.CancelFunc
	refs    int
	subs    map[int]chan Event
	nextSub int

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
	close    func()
}

// Close unsubscribes.
func (s *Subscription) Close() { s.close() }

// Subscribe attaches to (or starts) the shared watch for k. A late
// subscriber first receives a Relist with the current state.
func (r *Registry) Subscribe(k Key) (*Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sh, ok := r.shared[k]
	if !ok {
		res, err := r.opener.Resolve(k.Cluster, k.Resource)
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", k.Resource, err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		sh = &shared{key: k, res: res, cancel: cancel, subs: map[int]chan Event{}, items: map[string]Item{}}
		r.shared[k] = sh
		in := make(chan Event, 256)
		go r.opener.Watch(ctx, k.Cluster, res, k, in)
		go r.fanout(ctx, sh, in)
	}
	sh.refs++
	id := sh.nextSub
	sh.nextSub++
	// generous buffer; subscribers coalesce on their side
	ch := make(chan Event, 1024)
	if sh.synced {
		ch <- sh.snapshot()
	}
	if sh.lastErr != "" {
		ch <- Event{Type: Error, Err: sh.lastErr}
	}
	sh.subs[id] = ch
	var once sync.Once
	return &Subscription{Events: ch, Resolved: sh.res, close: func() {
		once.Do(func() { r.unsubscribe(sh, id) })
	}}, nil
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
			r.mu.Lock()
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
		}
	}
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
