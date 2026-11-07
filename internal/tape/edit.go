package tape

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	jsonpatch "gopkg.in/evanphx/json-patch.v4"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/source"
)

// RejectEditAnnotation makes Patch refuse an object like an admission
// webhook would, with the annotation's value as the message.
const RejectEditAnnotation = "e2e.kubewing/reject-edit"

// current returns an object's latest version: as edited via Patch, else
// the tape's. ok is false for unknown or deleted objects.
func (o *Opener) current(namespace, name string) (*unstructured.Unstructured, *Tape, bool) {
	for _, t := range o.Tapes {
		found := t.find(namespace, name, "")
		if found == nil {
			continue
		}
		it := found.Full()
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.deleted[string(it.GetUID())] {
			return nil, nil, false
		}
		if e, ok := o.edited[string(it.GetUID())]; ok {
			return e.DeepCopy(), t, true
		}
		if it.GetResourceVersion() == "" {
			it.SetResourceVersion("1")
		}
		return it, t, true
	}
	return nil, nil, false
}

// Get implements source.Actor, without managedFields like the API reads.
func (o *Opener) Get(ctx context.Context, cluster string, res source.Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	u, err := o.GetManaged(ctx, cluster, res, namespace, name)
	if err != nil {
		return nil, err
	}
	source.StripManagedFields(u)
	return u, nil
}

// GetManaged implements source.Actor: the object with the managedFields
// its tape gives it (an edit keeps them and adds kubewing's, as the API
// server's merge patch would).
func (o *Opener) GetManaged(_ context.Context, _ string, res source.Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	u, _, ok := o.current(namespace, name)
	if !ok {
		return nil, fmt.Errorf("%s %q not found", strings.ToLower(res.Kind), name)
	}
	return u, nil
}

// Patch implements source.Actor like an API server's merge patch: a
// resourceVersion in the patch is a precondition (409 on mismatch), the
// stored version gets a new resourceVersion, and running replays of the
// tape see it modified. The fake webhook (RejectEditAnnotation) runs on
// the patched object, dry run or not.
func (o *Opener) Patch(_ context.Context, _ string, res source.Resolved, namespace, name string, patch []byte, dryRun bool) (*unstructured.Unstructured, error) {
	cur, t, ok := o.current(namespace, name)
	if !ok {
		return nil, fmt.Errorf("%s %q not found", strings.ToLower(res.Kind), name)
	}
	var p struct {
		Metadata struct {
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(patch, &p); err != nil {
		return nil, err
	}
	if rv := p.Metadata.ResourceVersion; rv != "" && rv != cur.GetResourceVersion() {
		return nil, fmt.Errorf("Operation cannot be fulfilled on %s %q: the object has been modified; please apply your changes to the latest version and try again", strings.ToLower(res.Kind), name)
	}
	before, err := json.Marshal(cur.Object)
	if err != nil {
		return nil, err
	}
	after, err := jsonpatch.MergePatch(before, patch)
	if err != nil {
		return nil, err
	}
	u := &unstructured.Unstructured{}
	if err := json.Unmarshal(after, &u.Object); err != nil {
		return nil, err
	}
	if msg := u.GetAnnotations()[RejectEditAnnotation]; msg != "" {
		return nil, fmt.Errorf("admission webhook %q denied the request: %s", "reject.kubewing.test", msg)
	}
	n, _ := strconv.Atoi(cur.GetResourceVersion())
	u.SetResourceVersion(strconv.Itoa(n + 1))
	managePatch(u, patch, time.Now())
	if dryRun {
		source.StripManagedFields(u)
		return u, nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.edited == nil {
		o.edited = map[string]*unstructured.Unstructured{}
	}
	o.edited[string(u.GetUID())] = u.DeepCopy()
	source.StripManagedFields(u)
	ev := source.Event{Type: source.Modified, Item: source.Item{Object: u.DeepCopy()}}
	for _, ch := range o.live[t] {
		select {
		case ch <- ev:
		default: // a stuck replay misses it, like a dropped watch
		}
	}
	return u, nil
}

// Scale implements source.Actor on spec.replicas, as the scale subresource
// of a workload does; objects without spec.replicas have none.
func (o *Opener) Scale(ctx context.Context, cluster string, res source.Resolved, namespace, name string, replicas int64) error {
	cur, _, ok := o.current(namespace, name)
	if !ok {
		return fmt.Errorf("%s %q not found", strings.ToLower(res.Kind), name)
	}
	if _, found, _ := unstructured.NestedFieldNoCopy(cur.Object, "spec", "replicas"); !found {
		return fmt.Errorf("the server could not find the requested resource (%s %s has no scale subresource)", strings.ToLower(cur.GetKind()), name)
	}
	_, err := o.Patch(ctx, cluster, res, namespace, name, fmt.Appendf(nil, `{"spec":{"replicas":%d}}`, replicas), false)
	return err
}

// managePatch records the fields a merge patch sets as kubewing's (its
// field manager), as an API server does: one Update entry, merged with
// what kubewing set before, the others kept (a fake: they keep theirs).
func managePatch(u *unstructured.Unstructured, patch []byte, at time.Time) {
	var p map[string]any
	if json.Unmarshal(patch, &p) != nil {
		return
	}
	if md, ok := p["metadata"].(map[string]any); ok {
		delete(md, "resourceVersion")
		if len(md) == 0 {
			delete(p, "metadata")
		}
	}
	set := fieldsOf(p)
	if len(set) == 0 {
		return
	}
	mf, _, _ := unstructured.NestedSlice(u.Object, "metadata", "managedFields")
	entry := map[string]any{"manager": "kubewing", "operation": "Update", "fieldsType": "FieldsV1", "time": at.UTC().Format(time.RFC3339)}
	var out []any
	for _, e := range mf {
		if m, ok := e.(map[string]any); ok && m["manager"] == "kubewing" && m["operation"] == "Update" && m["subresource"] == nil {
			if old, ok := m["fieldsV1"].(map[string]any); ok {
				set = mergeFields(old, set)
			}
			continue
		}
		out = append(out, e)
	}
	entry["fieldsV1"] = set
	_ = unstructured.SetNestedSlice(u.Object, append(out, entry), "metadata", "managedFields")
}

// fieldsOf is a merge patch's fields as a fieldsV1 set (a null: removed, not owned).
func fieldsOf(p map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range p {
		switch x := v.(type) {
		case nil:
		case map[string]any:
			if c := fieldsOf(x); len(c) > 0 {
				out["f:"+k] = c
			}
		default:
			out["f:"+k] = map[string]any{}
		}
	}
	return out
}

func mergeFields(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		am, ok1 := out[k].(map[string]any)
		bm, ok2 := v.(map[string]any)
		if ok1 && ok2 && len(am) > 0 && len(bm) > 0 {
			out[k] = mergeFields(am, bm)
		} else {
			out[k] = v
		}
	}
	return out
}
