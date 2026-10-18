package tape

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	k8stypes "k8s.io/apimachinery/pkg/types"

	"github.com/dguendisch/kubewing/internal/source"
)

// Opener replays tapes as sources (headless backend for E2E tests). Any
// resource name matching a tape's pipeline resource replays that tape in
// real time; Speed > 1 replays faster.
type Opener struct {
	Tapes map[string]*Tape // resource → tape
	Speed float64
	// Catalog optionally fakes the cluster's resource types and namespaces.
	Catalog *Catalog

	mu sync.Mutex
	// live are the running replays per tape (a tape is reachable under its
	// file name and its resource); Delete injects events into them, as a
	// real cluster's watch would deliver.
	live    map[*Tape]map[int]chan source.Event
	nextID  int
	deleted map[string]bool // uids deleted via Delete
	looks   map[string]int  // describe calls per namespace/name (fake events)
}

// Resolve implements source.Opener.
func (o *Opener) Resolve(_, resource string) (source.Resolved, error) {
	t, ok := o.Tapes[resource]
	if !ok {
		return source.Resolved{}, fmt.Errorf("the server doesn't have a resource type %q", resource)
	}
	kind := "Object"
	if len(t.Initial) > 0 {
		if k, ok := t.Initial[0].Object["kind"].(string); ok {
			kind = k
		}
	}
	return source.Resolved{Kind: kind, Namespaced: true}, nil
}

// Watch implements source.Opener.
func (o *Opener) Watch(ctx context.Context, _ string, res source.Resolved, k source.Key, out chan<- source.Event) {
	t := o.Tapes[k.Resource]
	speed := o.Speed
	if speed <= 0 {
		speed = 1
	}
	start := time.Now()
	emit := func(ev source.Event) bool {
		select {
		case out <- ev:
			return true
		case <-ctx.Done():
			return false
		}
	}
	inject, done := o.attach(t)
	defer done()
	if !emit(o.withoutDeleted(t.InitialEvent())) {
		return
	}
	steps := t.Steps
	for {
		var next <-chan time.Time
		if len(steps) > 0 {
			off, _ := steps[0].Offset()
			next = time.After(time.Until(start.Add(time.Duration(float64(off) / speed))))
		}
		select {
		case <-ctx.Done():
			return
		case ev := <-inject:
			if !emit(ev) {
				return
			}
		case <-next:
			ev, ok := t.Event(steps[0])
			steps = steps[1:]
			if ok && !emit(ev) {
				return
			}
		}
	}
}

func (o *Opener) attach(t *Tape) (<-chan source.Event, func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.live == nil {
		o.live = map[*Tape]map[int]chan source.Event{}
	}
	if o.live[t] == nil {
		o.live[t] = map[int]chan source.Event{}
	}
	o.nextID++
	id, ch := o.nextID, make(chan source.Event, 16)
	o.live[t][id] = ch
	return ch, func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		delete(o.live[t], id)
	}
}

// withoutDeleted drops objects deleted via Delete from a replayed relist,
// so a new pane on the same tape doesn't resurrect them.
func (o *Opener) withoutDeleted(ev source.Event) source.Event {
	o.mu.Lock()
	defer o.mu.Unlock()
	items := ev.Items[:0:0]
	for _, it := range ev.Items {
		if !o.deleted[string(it.Object.GetUID())] {
			items = append(items, it)
		}
	}
	ev.Items = items
	return ev
}

// ContextName implements source.Actor. Tapes replay on any cluster name,
// so tests can open the same tape on differently configured contexts;
// the current context ("") is "tape".
func (o *Opener) ContextName(cluster string) (string, error) {
	if cluster == "" {
		return "tape", nil
	}
	return cluster, nil
}

// Delete implements source.Actor: running replays of the tape that holds
// the object see it deleted. Objects are looked up in the tape's initial
// state and steps (by uid, else namespace/name).
func (o *Opener) Delete(_ context.Context, _ string, res source.Resolved, namespace, name string, uid k8stypes.UID) error {
	var found *Object
	var tape *Tape
	for _, t := range o.Tapes {
		if found = t.find(namespace, name, uid); found != nil {
			tape = t
			break
		}
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if found == nil || o.deleted[string(uid)] {
		return fmt.Errorf("%s %q not found", strings.ToLower(res.Kind), name)
	}
	if uid != "" {
		if o.deleted == nil {
			o.deleted = map[string]bool{}
		}
		o.deleted[string(uid)] = true
	}
	ev := source.Event{Type: source.Deleted, Item: found.Item()}
	for _, ch := range o.live[tape] {
		select {
		case ch <- ev:
		default: // a stuck replay misses it, like a dropped watch
		}
	}
	return nil
}

// Catalog is a fake cluster API surface for completion (tapes/catalog.yaml).
// Without one, the opener offers its tape resources as types.
type Catalog struct {
	Resources  []source.ResourceType `json:"resources"`
	Namespaces []string              `json:"namespaces"`
}

// ResourceTypes implements source.Lister.
func (o *Opener) ResourceTypes(_ context.Context, _ string, _ bool) ([]source.ResourceType, error) {
	if o.Catalog != nil {
		return o.Catalog.Resources, nil
	}
	var out []source.ResourceType
	for name := range o.Tapes {
		out = append(out, source.ResourceType{Name: name, Version: "v1", Namespaced: true})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Namespaces implements source.Lister.
func (o *Opener) Namespaces(context.Context, string) ([]string, error) {
	if o.Catalog != nil {
		return o.Catalog.Namespaces, nil
	}
	return []string{}, nil
}

// Changes implements source.Lister; tape catalogs are static.
func (o *Opener) Changes(ctx context.Context, _ string, _ chan<- source.Change) { <-ctx.Done() }
