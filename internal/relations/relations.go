// Package relations derives where the jump menu can go from one object:
// its namespace, its owners (ownerReferences), what it owns, what it refers
// to otherwise (a claim's volume) and its events. Each place
// is a pipeline (source + CEL filter), so the pane it opens looks like one
// the user could have typed. Pure: the bridge resolves kinds to resources
// and does the lookups.
package relations

import (
	"strconv"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/dguendisch/kubewing/internal/pipeline"
)

// Section groups the jump menu.
type Section string

const (
	SectionNamespace Section = "namespace"
	SectionOwner     Section = "owner"
	SectionOwned     Section = "owned"
	SectionReference Section = "reference"
	SectionEvents    Section = "events"
)

// Target is where a jump lands, in the pane's context. Unset fields are
// empty in the new pane (a jump replaces the pane's filters).
type Target struct {
	Resource      string `json:"resource"`
	Namespace     string `json:"namespace,omitempty"` // "" = all
	LabelSelector string `json:"labelSelector,omitempty"`
	FieldSelector string `json:"fieldSelector,omitempty"`
	Filter        string `json:"filter,omitempty"`
	Grep          string `json:"grep,omitempty"`
	HideHealthy   bool   `json:"hideHealthy,omitempty"`
}

// Relation is one jump menu entry.
type Relation struct {
	// ID is stable across lookups (the menu keeps its highlight by it).
	ID      string  `json:"id"`
	Section Section `json:"section"`
	Label   string  `json:"label"`
	Kind    string  `json:"kind,omitempty"`
	Name    string  `json:"name,omitempty"`
	// Depth of an owner: 1 = a direct owner, 2 = its owner …
	Depth      int  `json:"depth,omitempty"`
	Controller bool `json:"controller,omitempty"`
	// Target is nil when there is nowhere to go (see Gone).
	Target *Target `json:"target,omitempty"`
	// Count of owned objects; nil = not counted.
	Count *int `json:"count,omitempty"`
	// Gone says why an owner can't be jumped to (deleted, recreated).
	Gone string `json:"gone,omitempty"`
	// Note qualifies an entry that still works (not verified, not counted).
	Note string `json:"note,omitempty"`
}

// Quote renders s as a CEL string literal. Go's escapes (\", \\, \n,
// \xHH, \uHHHH …) are all valid in CEL.
func Quote(s string) string { return strconv.Quote(s) }

// NameFilter matches one object by name.
func NameFilter(name string) string { return "o.metadata.name == " + Quote(name) }

// OwnedFilter matches objects owned by uid. Objects without
// ownerReferences don't match (a missing field is no match).
func OwnedFilter(uid string) string {
	return "o.metadata.ownerReferences.exists(r, r.uid == " + Quote(uid) + ")"
}

// FromPipeline is a pane's own pipeline as a target (to re-scope it).
func FromPipeline(p pipeline.Pipeline) Target {
	t := Target{Resource: p.Source.Resource, Namespace: p.Source.Namespace, LabelSelector: p.Source.LabelSelector, FieldSelector: p.Source.FieldSelector}
	var filters []string
	for _, s := range p.Stages {
		switch {
		case s.Filter != "":
			filters = append(filters, s.Filter)
		case s.Grep != "":
			t.Grep = s.Grep
		case s.HideHealthy:
			t.HideHealthy = true
		}
	}
	if len(filters) == 1 {
		t.Filter = filters[0]
	} else if len(filters) > 1 {
		t.Filter = "(" + strings.Join(filters, ") && (") + ")"
	}
	if t.Namespace == "*" {
		t.Namespace = ""
	}
	return t
}

// Namespace lists the namespace entries of an object shown in pane p:
// "<plural> in <ns>" (the pane narrowed to it, filters kept; from an
// all-namespaces pane only) and the namespace object (nsResource, as
// resolved by the caller). plural names the pane's resource for the label
// ("pods"). Cluster-scoped objects have none.
func Namespace(obj *unstructured.Unstructured, p pipeline.Pipeline, plural, nsResource string) []Relation {
	ns := obj.GetNamespace()
	if ns == "" {
		return nil
	}
	var out []Relation
	if p.Source.AllNamespaces() {
		t := FromPipeline(p)
		t.Namespace = ns
		out = append(out, Relation{ID: "ns:here", Section: SectionNamespace, Label: plural + " in " + ns, Name: ns, Target: &t})
	}
	return append(out, Relation{
		ID: "ns:object", Section: SectionNamespace, Label: "namespace object " + ns, Kind: "Namespace", Name: ns,
		Target: &Target{Resource: nsResource, Filter: NameFilter(ns)},
	})
}

// Owner is one ownerReference.
type Owner struct {
	APIVersion, Kind, Name, UID string
	Controller                  bool
}

// Owners returns an object's ownerReferences, the controller first.
func Owners(obj *unstructured.Unstructured) []Owner {
	var out []Owner
	for _, r := range obj.GetOwnerReferences() {
		o := Owner{APIVersion: r.APIVersion, Kind: r.Kind, Name: r.Name, UID: string(r.UID), Controller: r.Controller != nil && *r.Controller}
		if o.Controller {
			out = append([]Owner{o}, out...)
		} else {
			out = append(out, o)
		}
	}
	return out
}

// OwnerRelation is the entry for an owner at a depth, without a target
// (the caller resolves its resource and checks it exists).
func OwnerRelation(o Owner, depth int) Relation {
	id := "owner:" + o.UID
	if o.UID == "" {
		id = "owner:" + o.APIVersion + "/" + o.Kind + "/" + o.Name
	}
	return Relation{ID: id, Section: SectionOwner, Label: strings.ToLower(o.Kind) + " " + o.Name, Kind: o.Kind, Name: o.Name, Depth: depth, Controller: o.Controller}
}

// OwnerTarget is the pane showing one owner.
func OwnerTarget(resource, namespace, name string) *Target {
	return &Target{Resource: resource, Namespace: namespace, Filter: NameFilter(name)}
}

// Child is a kind an object is known to own (or run), and how to find it.
type Child struct {
	APIVersion, Kind string
	// Resource is the conventional resource name, used when the kind can't be resolved.
	Resource      string
	Namespace     string // "" = all
	LabelSelector string
	FieldSelector string
	// OwnerUID is set for direct children: only objects with an
	// ownerReference to it count (a selector can over-match, e.g. other
	// owners with the same labels). Grandchildren go by the selector.
	OwnerUID string
}

// Target is the pane showing the children, as resource.
func (c Child) Target(resource string) *Target {
	t := &Target{Resource: resource, Namespace: c.Namespace, LabelSelector: c.LabelSelector, FieldSelector: c.FieldSelector}
	if c.OwnerUID != "" {
		t.Filter = OwnedFilter(c.OwnerUID)
	}
	return t
}

// Owns reports whether obj counts as one of the children.
func (c Child) Owns(obj *unstructured.Unstructured) bool {
	if c.OwnerUID == "" {
		return true
	}
	for _, r := range obj.GetOwnerReferences() {
		if string(r.UID) == c.OwnerUID {
			return true
		}
	}
	return false
}

// OwnedRelation is the entry for a child kind (resource as resolved).
func OwnedRelation(c Child, resource string) Relation {
	label, _, _ := strings.Cut(resource, ".")
	return Relation{ID: "owned:" + c.APIVersion + "/" + c.Kind, Section: SectionOwned, Label: label, Kind: c.Kind, Target: c.Target(resource)}
}

var (
	pods        = Child{APIVersion: "v1", Kind: "Pod", Resource: "pods"}
	replicaSets = Child{APIVersion: "apps/v1", Kind: "ReplicaSet", Resource: "replicasets.apps"}
	jobs        = Child{APIVersion: "batch/v1", Kind: "Job", Resource: "jobs.batch"}
)

// Children lists what obj is known to own, by kind: workloads select their
// replica sets and pods, cron jobs own jobs, nodes run pods, namespaces hold
// pods. Anything else (CRDs) is found by the owned scan.
func Children(obj *unstructured.Unstructured) []Child {
	gv, _ := schema.ParseGroupVersion(obj.GetAPIVersion())
	ns, uid := obj.GetNamespace(), string(obj.GetUID())
	direct := func(c Child) Child {
		c.Namespace, c.OwnerUID = ns, uid
		return c
	}
	sel, hasSel := Selector(obj)
	switch gv.Group + "/" + obj.GetKind() {
	case "apps/Deployment":
		if !hasSel {
			return []Child{direct(replicaSets)}
		}
		rs, p := direct(replicaSets), pods
		rs.LabelSelector, p.Namespace, p.LabelSelector = sel, ns, sel
		return []Child{rs, p}
	case "apps/ReplicaSet", "apps/StatefulSet", "apps/DaemonSet", "batch/Job":
		p := direct(pods)
		p.LabelSelector = sel
		return []Child{p}
	case "batch/CronJob":
		return []Child{direct(jobs)}
	case "/Node":
		p := pods
		p.FieldSelector = "spec.nodeName=" + obj.GetName()
		return []Child{p}
	case "/Namespace":
		p := pods
		p.Namespace = obj.GetName()
		return []Child{p}
	}
	return nil
}

// Ref is what an object refers to other than by ownerReferences: one
// object by name (looked up), or the objects a filter matches (counted).
type Ref struct {
	APIVersion, Kind string
	// Resource is the conventional resource name, used when the kind can't be resolved.
	Resource  string
	Namespace string
	// Name of the one object; UID, if known, must match it (else it was recreated).
	Name, UID string
	// Filter matches the objects when there is no Name: a CEL filter, as
	// no field selector covers the field (volume attachments by volume).
	Filter string
	// Missing says why there is nothing to refer to (yet): an unbound claim.
	Missing string
}

var (
	pvs      = Ref{APIVersion: "v1", Kind: "PersistentVolume", Resource: "persistentvolumes"}
	pvcs     = Ref{APIVersion: "v1", Kind: "PersistentVolumeClaim", Resource: "persistentvolumeclaims"}
	nodes    = Ref{APIVersion: "v1", Kind: "Node", Resource: "nodes"}
	attached = Ref{APIVersion: "storage.k8s.io/v1", Kind: "VolumeAttachment", Resource: "volumeattachments.storage.k8s.io"}
)

// AttachmentsFilter matches the volume attachments of a persistent volume.
func AttachmentsFilter(pv string) string { return "o.spec.source.persistentVolumeName == " + Quote(pv) }

// References lists what obj refers to, by kind: a claim its volume and the
// volume's attachments (straight there, not via the volume), a volume its
// claim and attachments, an attachment its volume and node.
func References(obj *unstructured.Unstructured) []Ref {
	gv, _ := schema.ParseGroupVersion(obj.GetAPIVersion())
	str := func(path ...string) string {
		s, _, _ := unstructured.NestedString(obj.Object, path...)
		return s
	}
	var out []Ref
	switch gv.Group + "/" + obj.GetKind() {
	case "/PersistentVolumeClaim":
		pv := str("spec", "volumeName")
		if pv == "" {
			r := pvs
			r.Missing = "not bound"
			return []Ref{r}
		}
		r, a := pvs, attached
		r.Name, a.Filter = pv, AttachmentsFilter(pv)
		return []Ref{r, a}
	case "/PersistentVolume":
		if name := str("spec", "claimRef", "name"); name != "" {
			r := pvcs
			r.Namespace, r.Name, r.UID = str("spec", "claimRef", "namespace"), name, str("spec", "claimRef", "uid")
			out = append(out, r)
		}
		a := attached
		a.Filter = AttachmentsFilter(obj.GetName())
		return append(out, a)
	case "storage.k8s.io/VolumeAttachment":
		if pv := str("spec", "source", "persistentVolumeName"); pv != "" {
			r := pvs
			r.Name = pv
			out = append(out, r)
		}
		if node := str("spec", "nodeName"); node != "" {
			r := nodes
			r.Name = node
			out = append(out, r)
		}
	}
	return out
}

// Target is the pane showing the referenced object(s), as resource.
func (r Ref) Target(resource string) *Target {
	if r.Name != "" {
		return &Target{Resource: resource, Namespace: r.Namespace, Filter: NameFilter(r.Name)}
	}
	return &Target{Resource: resource, Namespace: r.Namespace, Filter: r.Filter}
}

// RefRelation is the entry for a reference (resource as resolved), without
// a target (the caller checks or counts first): one object is labeled by
// kind and name (a missing one by kind), a set by its resource.
func RefRelation(r Ref, resource string) Relation {
	id := "ref:" + r.APIVersion + "/" + r.Kind
	label, _, _ := strings.Cut(resource, ".")
	switch {
	case r.Name != "":
		id += "/" + r.Namespace + "/" + r.Name
		label = strings.ToLower(r.Kind) + " " + r.Name
	case r.Missing != "":
		label = strings.ToLower(r.Kind)
	}
	return Relation{ID: id, Section: SectionReference, Label: label, Kind: r.Kind, Name: r.Name, Gone: r.Missing}
}

// Selector returns spec.selector as a selector string (matchExpressions
// too). ok is false without one, or for an empty selector (it would match
// everything).
func Selector(obj *unstructured.Unstructured) (string, bool) {
	m, found, err := unstructured.NestedMap(obj.Object, "spec", "selector")
	if err != nil || !found {
		return "", false
	}
	var ls metav1.LabelSelector
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(m, &ls); err != nil {
		return "", false
	}
	s, err := metav1.LabelSelectorAsSelector(&ls)
	if err != nil || s.Empty() {
		return "", false
	}
	return s.String(), true
}

// ScaleSelector reads the label selector a custom resource's scale
// subresource points at (labelSelectorPath, e.g. ".status.selector"): the
// pods it scales. Only plain dot paths are understood.
func ScaleSelector(obj *unstructured.Unstructured, path string) (string, bool) {
	path = strings.TrimPrefix(path, ".")
	if path == "" || strings.ContainsAny(path, "[]*@") {
		return "", false
	}
	s, found, err := unstructured.NestedString(obj.Object, strings.Split(path, ".")...)
	if err != nil || !found || strings.TrimSpace(s) == "" {
		return "", false
	}
	return s, true
}

// ScanRelation is an owned scan's entry for one resource type.
func ScanRelation(resource, kind, namespace, uid string, count int) Relation {
	label, _, _ := strings.Cut(resource, ".")
	return Relation{
		ID: "scan:" + resource, Section: SectionOwned, Label: label, Kind: kind, Count: &count,
		Target: &Target{Resource: resource, Namespace: namespace, Filter: OwnedFilter(uid)},
	}
}

// Events is the pane listing an object's events (eventResource as
// resolved, core v1), by the involved object's kind and name. Not by UID:
// the kubelet records a node's events with the node's name as its UID, so
// a UID match would miss them (kubectl describe makes the same exception).
// A namespaced object's events are in its namespace; a cluster-scoped
// object's land in "default" or elsewhere, so all namespaces.
func Events(obj *unstructured.Unstructured, eventResource string) Target {
	return Target{
		Resource:      eventResource,
		Namespace:     obj.GetNamespace(),
		FieldSelector: "involvedObject.kind=" + obj.GetKind() + ",involvedObject.name=" + obj.GetName(),
	}
}
