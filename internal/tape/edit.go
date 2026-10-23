package tape

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

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
		it := found.Item().Object
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

// Get implements source.Actor.
func (o *Opener) Get(_ context.Context, _ string, res source.Resolved, namespace, name string) (*unstructured.Unstructured, error) {
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
	if dryRun {
		return u, nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.edited == nil {
		o.edited = map[string]*unstructured.Unstructured{}
	}
	o.edited[string(u.GetUID())] = u.DeepCopy()
	ev := source.Event{Type: source.Modified, Item: source.Item{Object: u.DeepCopy()}}
	for _, ch := range o.live[t] {
		select {
		case ch <- ev:
		default: // a stuck replay misses it, like a dropped watch
		}
	}
	return u, nil
}
