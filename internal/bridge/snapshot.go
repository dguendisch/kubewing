package bridge

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/source"
)

// A namespace's snapshot (resource "all", see source.AllResources) is one
// pane over every namespaced type, listed once: its rows are of many types
// and metadata only. Actions resolve each row's own type (rowType), and
// what needs the whole object (the YAML, decoding, the editor) gets it
// with a Get (fullCache).

// fullKeep bounds the full objects a snapshot pane keeps (the rows opened lately).
const fullKeep = 64

// fullCache holds the full objects of a snapshot pane's opened rows, by
// row key; the detail's YAML reads them (view.Options.Full). Fetched on
// Object (each time: the object view polls it while open, so it follows
// the object), dropped least recently fetched first.
type fullCache struct {
	mu   sync.Mutex
	objs map[string]*fullObj
	seq  uint64
}

type fullObj struct {
	obj  *unstructured.Unstructured
	used uint64
}

func (c *fullCache) get(key string) *unstructured.Unstructured {
	c.mu.Lock()
	defer c.mu.Unlock()
	if o, ok := c.objs[key]; ok {
		return o.obj
	}
	return nil
}

func (c *fullCache) put(key string, u *unstructured.Unstructured) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.objs == nil {
		c.objs = map[string]*fullObj{}
	}
	c.seq++
	c.objs[key] = &fullObj{obj: u, used: c.seq}
	if len(c.objs) > fullKeep {
		var oldest string
		for k, o := range c.objs {
			if oldest == "" || o.used < c.objs[oldest].used {
				oldest = k
			}
		}
		delete(c.objs, oldest)
	}
}

// snapshotPane reports whether a pane is a namespace's snapshot.
func (pn *pane) snapshot() bool { return pn.res.Kind == source.AllKind }

// rowType resolves the type of a snapshot row from its apiVersion and kind
// (stamped by the snapshot): the resource name a pipeline uses, then what
// the opener resolves it to (a GVR on real clusters).
func (s *Service) rowType(cluster string, obj *unstructured.Unstructured) (source.Resolved, string, error) {
	rel, err := s.relator()
	if err != nil {
		return source.Resolved{}, "", err
	}
	name, _, err := rel.ResolveKind(cluster, obj.GetAPIVersion(), obj.GetKind())
	if err != nil {
		return source.Resolved{}, "", err
	}
	res, err := s.reg.Opener().Resolve(cluster, name)
	if err != nil {
		return source.Resolved{}, "", err
	}
	return res, name, nil
}

// fetchFull reads a snapshot row's full object and keeps it for the
// detail. A failed read (forbidden to get, gone) keeps the metadata: the
// YAML shows what the list had.
func (s *Service) fetchFull(pn *pane, key string) error {
	if s.opts.Actor == nil {
		return nil
	}
	pn.mu.Lock()
	it, ok := pn.view.Item(key)
	cluster := pn.p.Source.Cluster
	pn.mu.Unlock()
	if !ok {
		return fmt.Errorf("object %s not found", key)
	}
	res, _, err := s.rowType(cluster, it.Object)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	u, err := s.opts.Actor.Get(ctx, cluster, res, it.Object.GetNamespace(), it.Object.GetName())
	if err != nil {
		return err
	}
	if uid := it.Object.GetUID(); uid != "" && u.GetUID() != uid {
		return errors.New("recreated meanwhile: refresh the listing")
	}
	pn.full.put(key, u)
	return nil
}

// Refresh lists a snapshot pane's source again (⌘R): the new listing
// reaches every pane on it as a relist, so what was added, removed and
// changed since the last one is marked (and recorded, with record changes
// on). Watched panes don't need it: refused.
func (s *Service) Refresh(paneID string) error {
	pn, err := s.pane(paneID)
	if err != nil {
		return err
	}
	if !pn.snapshot() {
		return errors.New("only a listing (all resources of a namespace) is refreshed; this pane is live")
	}
	pn.sub.Restart()
	return nil
}

// Skipped lists the types the last listing of a snapshot pane couldn't
// list (forbidden, an aggregated API down), with why.
func (s *Service) Skipped(paneID string) ([]source.SkippedType, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return nil, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	out := pn.view.Skipped()
	if out == nil {
		out = []source.SkippedType{}
	}
	return out, nil
}

// refreshAfter lists a snapshot pane again after a change made from it
// (delete, edit): the listing doesn't watch, so it wouldn't show otherwise.
func (s *Service) refreshAfter(r row) {
	if r.pane == nil || !r.pane.snapshot() {
		return
	}
	r.pane.sub.Restart()
}
