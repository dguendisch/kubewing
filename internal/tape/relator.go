package tape

import (
	"context"
	"fmt"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/dguendisch/kubewing/internal/source"
)

// The tapes as a fake API for the jump menu: a tape is the resource of its
// objects' kind (the first initial object's apiVersion + kind), named as
// it is addressed. Custom kinds come with a fake CRD (CRDs).

// kindTapes maps "apiVersion/kind" to the tape resource name serving it.
// When several tapes share a kind, filtering tapes (Tape.Filter: they act
// as an API) win, then the shortest name (a file name and its pipeline
// resource are the same tape).
func (o *Opener) kindTapes() map[string]string {
	out := map[string]string{}
	better := func(name, cur string) bool {
		a, b := o.Tapes[name], o.Tapes[cur]
		if a.Filter != b.Filter {
			return a.Filter
		}
		return len(name) < len(cur) || len(name) == len(cur) && name < cur
	}
	for name, t := range o.Tapes {
		if len(t.Initial) == 0 || t.LookupOnly {
			continue
		}
		obj := t.Initial[0].Item().Object
		k := obj.GetAPIVersion() + "/" + obj.GetKind()
		if cur, ok := out[k]; !ok || better(name, cur) {
			out[k] = name
		}
	}
	return out
}

// ResolveKind implements source.Relator. A group without a version
// ("rbac.authorization.k8s.io/") takes any tape of that group and kind, as
// the API's preferred version would.
func (o *Opener) ResolveKind(_, apiVersion, kind string) (string, bool, error) {
	tapes := o.kindTapes()
	if name, ok := tapes[apiVersion+"/"+kind]; ok {
		return name, o.namespaced(name), nil
	}
	if g, v, ok := strings.Cut(apiVersion, "/"); ok && v == "" {
		var names []string
		for k, name := range tapes {
			i := strings.LastIndex(k, "/")
			if k[i+1:] == kind && strings.HasPrefix(k[:i], g+"/") {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			sort.Strings(names)
			return names[0], o.namespaced(names[0]), nil
		}
	}
	return "", false, fmt.Errorf("no matches for kind %q in version %q", kind, apiVersion)
}

// namespaced reports whether a tape's objects are namespaced (cluster-scoped
// tapes have no namespace on their objects).
func (o *Opener) namespaced(resource string) bool {
	t, ok := o.Tapes[resource]
	if !ok || len(t.Initial) == 0 {
		return true
	}
	return t.Initial[0].Item().Object.GetNamespace() != ""
}

// GetMetadata implements source.Relator.
func (o *Opener) GetMetadata(_ context.Context, _, resource, namespace, name string) (*unstructured.Unstructured, error) {
	for _, it := range o.state(resource) {
		if it.GetName() == name && it.GetNamespace() == namespace {
			return metadataOnly(it), nil
		}
	}
	return nil, apierrors.NewNotFound(schema.GroupResource{Resource: resource}, name)
}

// ListMetadata implements source.Relator.
func (o *Opener) ListMetadata(_ context.Context, _, resource, namespace, labelSel, fieldSel string) ([]*unstructured.Unstructured, error) {
	if _, ok := o.Tapes[resource]; !ok {
		return nil, fmt.Errorf("the server doesn't have a resource type %q", resource)
	}
	m, err := newMatcher(namespace, labelSel, fieldSel)
	if err != nil {
		return nil, err
	}
	var out []*unstructured.Unstructured
	for _, it := range o.state(resource) {
		if m.match(it) {
			out = append(out, metadataOnly(it))
		}
	}
	return out, nil
}

// List implements source.Relator.
func (o *Opener) List(_ context.Context, _, resource, namespace string) ([]*unstructured.Unstructured, error) {
	if _, ok := o.Tapes[resource]; !ok {
		return nil, fmt.Errorf("the server doesn't have a resource type %q", resource)
	}
	m, err := newMatcher(namespace, "", "")
	if err != nil {
		return nil, err
	}
	var out []*unstructured.Unstructured
	for _, it := range o.state(resource) {
		if m.match(it) {
			out = append(out, it.DeepCopy())
		}
	}
	return out, nil
}

// CRD implements source.Relator: a fake CustomResourceDefinition for a
// kind served by a tape that sets one (Tape.CRD).
func (o *Opener) CRD(_ context.Context, _, apiVersion, kind string) (*unstructured.Unstructured, error) {
	name, ok := o.kindTapes()[apiVersion+"/"+kind]
	if ok && o.Tapes[name].CRD != nil {
		return &unstructured.Unstructured{Object: deepCopy(o.Tapes[name].CRD)}, nil
	}
	return nil, apierrors.NewNotFound(schema.GroupResource{Group: "apiextensions.k8s.io", Resource: "customresourcedefinitions"}, kind)
}

// RelationTypes lists the tapes as resource types for the owned scan: each
// kind once, under its resolved name.
func (o *Opener) RelationTypes() []source.ResourceType {
	var out []source.ResourceType
	for k, name := range o.kindTapes() {
		i := strings.LastIndex(k, "/")
		gv, _ := schema.ParseGroupVersion(k[:i])
		// no group: a tape is addressed by its bare name (Qualified() must resolve)
		out = append(out, source.ResourceType{Name: name, Version: gv.Version, Kind: k[i+1:], Namespaced: o.namespaced(name)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// state is a tape's current objects: the initial ones with the steps
// applied (as a client would see them once replayed), minus deletes and
// with edits, as the opener's Get sees them.
func (o *Opener) state(resource string) []*unstructured.Unstructured {
	t, ok := o.Tapes[resource]
	if !ok {
		return nil
	}
	cur := map[string]*unstructured.Unstructured{}
	var order []string
	put := func(ob *Object) {
		it := ob.Item().Object
		k := itemKey(it)
		if _, ok := cur[k]; !ok {
			order = append(order, k)
		}
		cur[k] = it
	}
	for i := range t.Initial {
		put(&t.Initial[i])
	}
	for _, s := range t.Steps {
		switch {
		case s.Add != nil:
			put(s.Add)
		case s.Update != nil:
			put(s.Update)
		case s.Delete != nil:
			delete(cur, itemKey(s.Delete.Item().Object))
		}
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	var out []*unstructured.Unstructured
	for _, k := range order {
		it, ok := cur[k]
		if !ok || o.deleted[string(it.GetUID())] {
			continue
		}
		if e, ok := o.edited[string(it.GetUID())]; ok {
			it = e.DeepCopy()
		}
		out = append(out, it)
	}
	return out
}

func itemKey(u *unstructured.Unstructured) string {
	if uid := string(u.GetUID()); uid != "" {
		return uid
	}
	return u.GetNamespace() + "/" + u.GetName()
}

// metadataOnly is what a PartialObjectMetadata response carries.
func metadataOnly(u *unstructured.Unstructured) *unstructured.Unstructured {
	md, _ := u.Object["metadata"].(map[string]any)
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": u.GetAPIVersion(), "kind": u.GetKind(), "metadata": runtimeDeepCopy(md),
	}}
}

// matcher is an API server's namespace + selector filtering, for tapes
// that ask for it (Tape.Filter). Field selectors support metadata.name,
// metadata.namespace and spec.nodeName, like the pods fields kubewing uses,
// and involvedObject.* (events).
type matcher struct {
	namespace string
	labels    labels.Selector
	fields    fields.Selector
}

func newMatcher(namespace, labelSel, fieldSel string) (matcher, error) {
	m := matcher{namespace: namespace, labels: labels.Everything(), fields: fields.Everything()}
	if m.namespace == "*" {
		m.namespace = ""
	}
	var err error
	if labelSel != "" {
		if m.labels, err = labels.Parse(labelSel); err != nil {
			return matcher{}, err
		}
	}
	if fieldSel != "" {
		if m.fields, err = fields.ParseSelector(fieldSel); err != nil {
			return matcher{}, err
		}
	}
	return m, nil
}

func (m matcher) match(u *unstructured.Unstructured) bool {
	if m.namespace != "" && u.GetNamespace() != m.namespace {
		return false
	}
	if !m.labels.Matches(labels.Set(u.GetLabels())) {
		return false
	}
	node, _, _ := unstructured.NestedString(u.Object, "spec", "nodeName")
	set := fields.Set{"metadata.name": u.GetName(), "metadata.namespace": u.GetNamespace(), "spec.nodeName": node}
	for _, f := range []string{"kind", "name", "namespace", "uid"} {
		if v, ok, _ := unstructured.NestedString(u.Object, "involvedObject", f); ok {
			set["involvedObject."+f] = v
		}
	}
	return m.fields.Matches(set)
}

// filter applies the matcher to an event of a filtering tape. A Deleted
// event always passes (a client drops what it doesn't have).
func (m matcher) filter(ev source.Event) (source.Event, bool) {
	switch ev.Type {
	case source.Relist:
		items := ev.Items[:0:0]
		for _, it := range ev.Items {
			if m.match(it.Object) {
				items = append(items, it)
			}
		}
		ev.Items = items
	case source.Added, source.Modified:
		return ev, m.match(ev.Item.Object)
	}
	return ev, true
}

// GetObject implements gardener.Lookup: a full object of a tape, by the
// tape's name or its pipeline resource (a qualified name's resource part
// too: "shoots.core.gardener.cloud" is tape "shoots"); config maps are
// garden-cas' (a ConfigMap tape of its own would change which tape serves
// the kind for relations).
func (o *Opener) GetObject(_ context.Context, _, resource, namespace, name string) (*unstructured.Unstructured, error) {
	resource = o.tapeName(resource)
	for _, it := range o.state(resource) {
		if it.GetName() == name && it.GetNamespace() == namespace {
			return it, nil
		}
	}
	return nil, apierrors.NewNotFound(schema.GroupResource{Resource: resource}, name)
}

// ListObjects implements gardener.Lookup.
func (o *Opener) ListObjects(_ context.Context, _, resource, namespace, fieldSel string) ([]*unstructured.Unstructured, error) {
	resource = o.tapeName(resource)
	m, err := newMatcher(namespace, "", fieldSel)
	if err != nil {
		return nil, err
	}
	var out []*unstructured.Unstructured
	for _, it := range o.state(resource) {
		if m.match(it) {
			out = append(out, it)
		}
	}
	return out, nil
}

func (o *Opener) tapeName(resource string) string {
	if resource == "configmaps" {
		return "garden-cas"
	}
	if _, ok := o.Tapes[resource]; ok {
		return resource
	}
	plural, _, _ := strings.Cut(resource, ".")
	return plural
}
