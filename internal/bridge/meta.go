package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	kvalidation "k8s.io/apimachinery/pkg/util/validation"

	"github.com/dguendisch/kubewing/internal/safety"
)

// MetaChanges are the labels or annotations to set and the keys to remove
// (kubectl label key=value key-).
type MetaChanges struct {
	Set    map[string]string `json:"set,omitempty"`
	Remove []string          `json:"remove,omitempty"`
}

// RowMeta is a row's labels and annotations, for the label and annotate
// dialogs.
type RowMeta struct {
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// RowMeta reads a row's labels and annotations as the pane has them.
func (s *Service) RowMeta(paneID, key string) (RowMeta, error) {
	_, obj, err := s.rowObject(paneID, key)
	if err != nil {
		return RowMeta{}, err
	}
	return RowMeta{Labels: obj.GetLabels(), Annotations: obj.GetAnnotations()}, nil
}

// Label redeems a prepared label and patches the row's labels.
func (s *Service) Label(token string, c MetaChanges) error {
	return s.patchMeta(token, safety.Label, c)
}

// Annotate redeems a prepared annotate and patches the row's annotations.
func (s *Service) Annotate(token string, c MetaChanges) error {
	return s.patchMeta(token, safety.Annotate, c)
}

// patchMeta sends the changes as a JSON merge patch on metadata.labels or
// metadata.annotations (null removes a key), with the prepared UID: an
// object recreated under the same name meanwhile is refused (uid is
// immutable). Values already set are overwritten (kubectl's --overwrite):
// the dialog showed them.
func (s *Service) patchMeta(token, kind string, c MetaChanges) error {
	a, target, err := s.guard.Redeem(token, kind)
	if err != nil {
		return err
	}
	r := target.(row)
	field := "labels"
	if kind == safety.Annotate {
		field = "annotations"
	}
	patch, err := metaPatch(kind, c, a.UID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := s.opts.Actor.Patch(ctx, r.cluster, r.res, a.Namespace, a.Name, patch, false); err != nil {
		return fmt.Errorf("%s %s: %w", field, a.Name, err)
	}
	s.refreshAfter(r)
	return nil
}

// metaPatch checks the changes (keys as Kubernetes validates them, label
// values too) and builds their merge patch.
func metaPatch(kind string, c MetaChanges, uid string) ([]byte, error) {
	if len(c.Set) == 0 && len(c.Remove) == 0 {
		return nil, errors.New("no changes")
	}
	what := "label"
	if kind == safety.Annotate {
		what = "annotation"
	}
	fields := map[string]any{}
	for _, k := range slices.Sorted(maps.Keys(c.Set)) {
		v := c.Set[k]
		if errs := kvalidation.IsQualifiedName(k); len(errs) > 0 {
			return nil, fmt.Errorf("%s key %q: %s", what, k, strings.Join(errs, "; "))
		}
		if kind == safety.Label {
			if errs := kvalidation.IsValidLabelValue(v); len(errs) > 0 {
				return nil, fmt.Errorf("label value %q: %s", v, strings.Join(errs, "; "))
			}
		}
		fields[k] = v
	}
	for _, k := range c.Remove {
		if _, both := c.Set[k]; both {
			return nil, fmt.Errorf("%s %q is both set and removed", what, k)
		}
		if errs := kvalidation.IsQualifiedName(k); len(errs) > 0 {
			return nil, fmt.Errorf("%s key %q: %s", what, k, strings.Join(errs, "; "))
		}
		fields[k] = nil
	}
	md := map[string]any{what + "s": fields}
	if uid != "" {
		md["uid"] = uid
	}
	return json.Marshal(map[string]any{"metadata": md})
}

// Scale redeems a prepared scale and sets the row's replicas through the
// scale subresource.
func (s *Service) Scale(token string, replicas int64) error {
	a, target, err := s.guard.Redeem(token, safety.Scale)
	if err != nil {
		return err
	}
	if replicas < 0 {
		return fmt.Errorf("replicas must be 0 or more, not %d", replicas)
	}
	r := target.(row)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.opts.Actor.Scale(ctx, r.cluster, r.res, a.Namespace, a.Name, replicas); err != nil {
		return err
	}
	s.refreshAfter(r)
	return nil
}

// replicas is a row's spec.replicas, if it has one: a workload with a
// scale subresource, as the row menu and Prepare guess it.
func replicas(obj *unstructured.Unstructured) *int64 {
	if obj == nil {
		return nil
	}
	spec, _ := obj.Object["spec"].(map[string]any)
	// int64 from the cluster source; float64 would be plain encoding/json
	switch n := spec["replicas"].(type) {
	case int64:
		return &n
	case float64:
		i := int64(n)
		return &i
	}
	return nil
}
