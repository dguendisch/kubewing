package relations

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/expr"
	"github.com/dguendisch/kubewing/internal/pipeline"
)

func obj(m map[string]any) *unstructured.Unstructured { return &unstructured.Unstructured{Object: m} }

func md(kind, apiVersion, ns, name, uid string, extra map[string]any) *unstructured.Unstructured {
	meta := map[string]any{"name": name, "uid": uid}
	if ns != "" {
		meta["namespace"] = ns
	}
	o := map[string]any{"apiVersion": apiVersion, "kind": kind, "metadata": meta}
	for k, v := range extra {
		o[k] = v
	}
	return obj(o)
}

func TestQuoteIsValidCEL(t *testing.T) {
	for _, s := range []string{`plain`, `with "quotes"`, `back\slash`, "new\nline", `ünïcode`, `${x}`} {
		prg, err := expr.Compile(NameFilter(s))
		if err != nil {
			t.Fatalf("%q: %v", s, err)
		}
		ok, err := prg.Bool(map[string]any{"metadata": map[string]any{"name": s}})
		if err != nil || !ok {
			t.Errorf("%q: filter %s doesn't match its own name (%v)", s, NameFilter(s), err)
		}
	}
}

func TestOwnedFilter(t *testing.T) {
	prg, err := expr.Compile(OwnedFilter("u-1"))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		o    map[string]any
		want bool
	}{
		{map[string]any{"metadata": map[string]any{"ownerReferences": []any{map[string]any{"uid": "u-0"}, map[string]any{"uid": "u-1"}}}}, true},
		{map[string]any{"metadata": map[string]any{"ownerReferences": []any{map[string]any{"uid": "u-0"}}}}, false},
		{map[string]any{"metadata": map[string]any{}}, false}, // no owners: no match, no error
	} {
		if got, err := prg.Bool(c.o); got != c.want || err != nil {
			t.Errorf("%v: got %v (%v), want %v", c.o, got, err, c.want)
		}
	}
}

func TestOwnersControllerFirst(t *testing.T) {
	o := md("Pod", "v1", "shop", "p", "u", nil)
	o.Object["metadata"].(map[string]any)["ownerReferences"] = []any{
		map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "name": "a", "uid": "a"},
		map[string]any{"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "rs", "uid": "rs", "controller": true},
	}
	got := Owners(o)
	if len(got) != 2 || got[0].Name != "rs" || !got[0].Controller || got[1].Name != "a" {
		t.Fatalf("owners = %+v, want the controller first", got)
	}
	if r := OwnerRelation(got[0], 1); r.ID != "owner:rs" || r.Label != "replicaset rs" || r.Section != SectionOwner {
		t.Errorf("relation = %+v", r)
	}
}

func TestSelector(t *testing.T) {
	cases := []struct {
		name string
		sel  any
		want string
		ok   bool
	}{
		{"labels", map[string]any{"matchLabels": map[string]any{"app": "web"}}, "app=web", true},
		{"expressions", map[string]any{"matchLabels": map[string]any{"app": "web"}, "matchExpressions": []any{
			map[string]any{"key": "tier", "operator": "NotIn", "values": []any{"batch"}},
			map[string]any{"key": "canary", "operator": "DoesNotExist"},
		}}, "app=web,!canary,tier notin (batch)", true},
		{"empty matches everything: none", map[string]any{}, "", false},
		{"none", nil, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			spec := map[string]any{}
			if c.sel != nil {
				spec["selector"] = c.sel
			}
			got, ok := Selector(md("Deployment", "apps/v1", "shop", "web", "d", map[string]any{"spec": spec}))
			if got != c.want || ok != c.ok {
				t.Errorf("got %q %v, want %q %v", got, ok, c.want, c.ok)
			}
		})
	}
}

func TestChildren(t *testing.T) {
	sel := map[string]any{"spec": map[string]any{"selector": map[string]any{"matchLabels": map[string]any{"app": "web"}}}}
	cases := []struct {
		name string
		obj  *unstructured.Unstructured
		want []Child
	}{
		{"deployment: replica sets it owns, pods by selector", md("Deployment", "apps/v1", "shop", "web", "d1", sel), []Child{
			{APIVersion: "apps/v1", Kind: "ReplicaSet", Resource: "replicasets.apps", Namespace: "shop", LabelSelector: "app=web", OwnerUID: "d1"},
			{APIVersion: "v1", Kind: "Pod", Resource: "pods", Namespace: "shop", LabelSelector: "app=web"},
		}},
		{"statefulset: pods it owns", md("StatefulSet", "apps/v1", "shop", "db", "s1", sel), []Child{
			{APIVersion: "v1", Kind: "Pod", Resource: "pods", Namespace: "shop", LabelSelector: "app=web", OwnerUID: "s1"},
		}},
		{"cronjob: jobs it owns", md("CronJob", "batch/v1", "shop", "nightly", "c1", nil), []Child{
			{APIVersion: "batch/v1", Kind: "Job", Resource: "jobs.batch", Namespace: "shop", OwnerUID: "c1"},
		}},
		{"node: pods running on it, in all namespaces", md("Node", "v1", "", "n1", "n1", nil), []Child{
			{APIVersion: "v1", Kind: "Pod", Resource: "pods", FieldSelector: "spec.nodeName=n1"},
		}},
		{"namespace: the pods in it", md("Namespace", "v1", "", "shop", "ns1", nil), []Child{
			{APIVersion: "v1", Kind: "Pod", Resource: "pods", Namespace: "shop"},
		}},
		{"a CRD kind: nothing known", md("Shoot", "core.gardener.cloud/v1beta1", "garden-x", "s", "s1", nil), nil},
		{"same kind name in another group: nothing", md("Deployment", "example.com/v1", "shop", "d", "x", sel), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Children(c.obj)
			if len(got) != len(c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("[%d] got %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestReferences(t *testing.T) {
	spec := func(m map[string]any) map[string]any { return map[string]any{"spec": m} }
	pv := Ref{APIVersion: "v1", Kind: "PersistentVolume", Resource: "persistentvolumes"}
	va := Ref{APIVersion: "storage.k8s.io/v1", Kind: "VolumeAttachment", Resource: "volumeattachments.storage.k8s.io"}
	cases := []struct {
		name string
		obj  *unstructured.Unstructured
		want []Ref
	}{
		{"bound claim: its volume, and the volume's attachments", md("PersistentVolumeClaim", "v1", "shop", "data", "c1", spec(map[string]any{"volumeName": "pv-1"})), []Ref{
			func() Ref { r := pv; r.Name = "pv-1"; return r }(),
			func() Ref { r := va; r.Filter = `o.spec.source.persistentVolumeName == "pv-1"`; return r }(),
		}},
		{"pending claim: no volume yet", md("PersistentVolumeClaim", "v1", "shop", "data", "c1", nil), []Ref{
			func() Ref { r := pv; r.Missing = "not bound"; return r }(),
		}},
		{"bound volume: its claim and attachments", md("PersistentVolume", "v1", "", "pv-1", "v1", spec(map[string]any{"claimRef": map[string]any{"namespace": "shop", "name": "data", "uid": "c1"}})), []Ref{
			{APIVersion: "v1", Kind: "PersistentVolumeClaim", Resource: "persistentvolumeclaims", Namespace: "shop", Name: "data", UID: "c1"},
			func() Ref { r := va; r.Filter = `o.spec.source.persistentVolumeName == "pv-1"`; return r }(),
		}},
		{"available volume: attachments only", md("PersistentVolume", "v1", "", "pv-2", "v2", nil), []Ref{
			func() Ref { r := va; r.Filter = `o.spec.source.persistentVolumeName == "pv-2"`; return r }(),
		}},
		{"attachment: its volume and node", md("VolumeAttachment", "storage.k8s.io/v1", "", "csi-1", "a1", spec(map[string]any{"nodeName": "n1", "source": map[string]any{"persistentVolumeName": "pv-1"}})), []Ref{
			func() Ref { r := pv; r.Name = "pv-1"; return r }(),
			{APIVersion: "v1", Kind: "Node", Resource: "nodes", Name: "n1"},
		}},
		{"a pod: its claims, named and ephemeral, once each", md("Pod", "v1", "shop", "p", "p1", spec(map[string]any{"volumes": []any{
			map[string]any{"name": "a", "persistentVolumeClaim": map[string]any{"claimName": "data"}},
			map[string]any{"name": "b", "persistentVolumeClaim": map[string]any{"claimName": "data"}},
			map[string]any{"name": "tmp", "ephemeral": map[string]any{}},
			map[string]any{"name": "cfg", "configMap": map[string]any{"name": "x"}},
		}})), []Ref{
			{APIVersion: "v1", Kind: "PersistentVolumeClaim", Resource: "persistentvolumeclaims", Namespace: "shop", Name: "data"},
			{APIVersion: "v1", Kind: "PersistentVolumeClaim", Resource: "persistentvolumeclaims", Namespace: "shop", Name: "p-tmp"},
		}},
		{"a pod without volumes: none", md("Pod", "v1", "shop", "p", "p1", nil), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := References(c.obj)
			if len(got) != len(c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("[%d] got %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}

	// the attachments filter is valid CEL and matches by the volume's name
	prg, err := expr.Compile(AttachmentsFilter("pv-1"))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]bool{"pv-1": true, "pv-10": false} {
		ok, err := prg.Bool(map[string]any{"spec": map[string]any{"source": map[string]any{"persistentVolumeName": name}}})
		if err != nil || ok != want {
			t.Errorf("%s: %v (%v), want %v", name, ok, err, want)
		}
	}
	// an inline volume (no persistentVolumeName): no match, no error
	if ok, err := prg.Bool(map[string]any{"spec": map[string]any{"source": map[string]any{"inlineVolumeSpec": map[string]any{}}}}); ok || err != nil {
		t.Errorf("inline volume: %v %v", ok, err)
	}

	// several volumes: one filter for all their attachments
	prg, err = expr.Compile(AttachmentsFilter("pv-1", "pv-2"))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]bool{"pv-1": true, "pv-2": true, "pv-3": false} {
		if ok, _ := prg.Bool(map[string]any{"spec": map[string]any{"source": map[string]any{"persistentVolumeName": name}}}); ok != want {
			t.Errorf("%s: %v, want %v", name, ok, want)
		}
	}

	one := RefRelation(Ref{APIVersion: "v1", Kind: "PersistentVolumeClaim", Namespace: "shop", Name: "data"}, "persistentvolumeclaims")
	if one.ID != "ref:v1/PersistentVolumeClaim/shop/data" || one.Label != "persistentvolumeclaim data" || one.Section != SectionReference {
		t.Errorf("one = %+v", one)
	}
	set := RefRelation(va, "volumeattachments.storage.k8s.io")
	if set.ID != "ref:storage.k8s.io/v1/VolumeAttachment" || set.Label != "volumeattachments" {
		t.Errorf("set = %+v", set)
	}
	if got := *(Ref{Name: "pv-1"}).Target("persistentvolumes"); got != (Target{Resource: "persistentvolumes", Filter: `o.metadata.name == "pv-1"`}) {
		t.Errorf("target = %+v", got)
	}
}

func TestPodVolumes(t *testing.T) {
	vol := func(name, claim string) any {
		return map[string]any{"name": name, "persistentVolumeClaim": map[string]any{"claimName": claim}}
	}
	pod := md("Pod", "v1", "shop", "p", "p1", map[string]any{"spec": map[string]any{"volumes": []any{vol("a", "bound"), vol("b", "pending"), vol("c", "gone"), vol("d", "bound2")}}})
	claim := func(name, uid, pv string) *unstructured.Unstructured {
		return md("PersistentVolumeClaim", "v1", "shop", name, uid, map[string]any{"spec": map[string]any{"volumeName": pv}})
	}
	got := PodVolumes(pod, []*unstructured.Unstructured{claim("bound", "c1", "pv-1"), claim("pending", "c2", ""), claim("bound2", "c4", "pv-2")})
	var s []string
	for _, r := range got {
		s = append(s, r.Kind+" "+r.Name+" "+r.UID+" "+r.Missing+" "+r.Filter)
	}
	want := []string{
		"PersistentVolumeClaim bound c1  ",
		"PersistentVolume pv-1   ",
		"PersistentVolumeClaim pending c2  ",
		"PersistentVolumeClaim gone  not found ",
		"PersistentVolumeClaim bound2 c4  ",
		"PersistentVolume pv-2   ",
		`VolumeAttachment    o.spec.source.persistentVolumeName in ["pv-1", "pv-2"]`,
	}
	if strings.Join(s, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(s, "\n"), strings.Join(want, "\n"))
	}
	// no bound volume: no attachments entry
	if got := PodVolumes(pod, nil); len(got) != 4 || got[0].Missing != "not found" {
		t.Errorf("no claims read = %+v", got)
	}
}

func TestChildTargetAndOwns(t *testing.T) {
	c := Child{APIVersion: "apps/v1", Kind: "ReplicaSet", Namespace: "shop", LabelSelector: "app=web", OwnerUID: "d1"}
	r := OwnedRelation(c, "replicasets.apps")
	want := Target{Resource: "replicasets.apps", Namespace: "shop", LabelSelector: "app=web", Filter: `o.metadata.ownerReferences.exists(r, r.uid == "d1")`}
	if r.Label != "replicasets" || *r.Target != want {
		t.Errorf("relation = %+v target %+v", r, *r.Target)
	}
	owned := md("ReplicaSet", "apps/v1", "shop", "a", "a", nil)
	if c.Owns(owned) {
		t.Error("an object without ownerReferences isn't a direct child")
	}
	owned.Object["metadata"].(map[string]any)["ownerReferences"] = []any{map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "uid": "d1"}}
	if !c.Owns(owned) {
		t.Error("owned by uid d1: a child")
	}
	if !(Child{}).Owns(owned) {
		t.Error("without OwnerUID (grandchildren) the selector decides")
	}
}

func TestNamespace(t *testing.T) {
	pod := md("Pod", "v1", "shop", "p", "u", nil)
	all := pipeline.Pipeline{Source: pipeline.Source{Resource: "pods", LabelSelector: "app=web"}, Stages: []pipeline.Stage{{Grep: "x"}, {Filter: "a"}, {Filter: "b"}, {HideHealthy: true}}}
	got := Namespace(pod, all, "pods", "namespaces")
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	here := Target{Resource: "pods", Namespace: "shop", LabelSelector: "app=web", Filter: "(a) && (b)", Grep: "x", HideHealthy: true}
	if *got[0].Target != here {
		t.Errorf("pods in shop keeps the pane's filters: %+v", *got[0].Target)
	}
	if got[0].Label != "pods in shop" || got[1].Label != "namespace object shop" {
		t.Errorf("labels = %q, %q", got[0].Label, got[1].Label)
	}
	if want := (Target{Resource: "namespaces", Filter: `o.metadata.name == "shop"`}); *got[1].Target != want {
		t.Errorf("namespace object: %+v", *got[1].Target)
	}
	// already in that namespace: only the namespace object
	in := pipeline.Pipeline{Source: pipeline.Source{Resource: "pods", Namespace: "shop"}}
	if got := Namespace(pod, in, "pods", "namespaces"); len(got) != 1 || got[0].ID != "ns:object" {
		t.Errorf("namespaced pane: %+v", got)
	}
	if got := Namespace(md("Node", "v1", "", "n", "n", nil), all, "nodes", "namespaces"); got != nil {
		t.Errorf("cluster-scoped: %+v", got)
	}
}

func TestScaleSelector(t *testing.T) {
	w := md("Widget", "e2e.kubewing/v1", "shop", "g", "g", map[string]any{"status": map[string]any{"selector": "widget=g"}})
	if s, ok := ScaleSelector(w, ".status.selector"); !ok || s != "widget=g" {
		t.Errorf("got %q %v", s, ok)
	}
	for _, p := range []string{"", ".status.missing", ".status.conditions[0].x"} {
		if _, ok := ScaleSelector(w, p); ok {
			t.Errorf("%q: want no selector", p)
		}
	}
}

func TestEvents(t *testing.T) {
	pod := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": "web-0", "namespace": "shop", "uid": "u1"}}}
	if got, want := Events(pod, "events"), (Target{Resource: "events", Namespace: "shop", FieldSelector: "involvedObject.kind=Pod,involvedObject.name=web-0"}); got != want {
		t.Errorf("pod = %+v", got)
	}
	node := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Node", "metadata": map[string]any{"name": "n1", "uid": "u2"}}}
	if got, want := Events(node, "events"), (Target{Resource: "events", FieldSelector: "involvedObject.kind=Node,involvedObject.name=n1"}); got != want {
		t.Errorf("node = %+v", got)
	}
}
