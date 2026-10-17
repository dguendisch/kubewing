package tape

import (
	"context"
	"fmt"
	"sort"
	"time"

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
	if !emit(t.InitialEvent()) {
		return
	}
	for _, s := range t.Steps {
		ev, ok := t.Event(s)
		if !ok {
			continue
		}
		off, _ := s.Offset()
		wait := time.Until(start.Add(time.Duration(float64(off) / speed)))
		if wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return
			}
		}
		if !emit(ev) {
			return
		}
	}
	<-ctx.Done()
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
