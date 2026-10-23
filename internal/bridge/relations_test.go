package bridge

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/relations"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
)

// relSetup serves the relation tapes (testdata/tapes/rel-*.yaml) plus the
// unrelated e2e-deploys tape (another apps/v1 Deployment "web": a jump
// must resolve to the relation tapes, which act as the API).
func relSetup(t *testing.T) (*Service, *tape.Opener) {
	t.Helper()
	files, _ := filepath.Glob("../../testdata/tapes/rel-*.yaml")
	files = append(files, "../../testdata/tapes/e2e-deploys.yaml")
	op := &tape.Opener{Tapes: map[string]*tape.Tape{}}
	for _, f := range files {
		tp, err := tape.Load(f)
		if err != nil {
			t.Fatal(err)
		}
		op.Tapes[strings.TrimSuffix(filepath.Base(f), ".yaml")] = tp
	}
	cfg := config.Defaults("")
	log := &eventLog{events: map[string][]any{}}
	return New(source.NewRegistry(op), log, Options{Actor: op, Config: &cfg}), op
}

// openSynced opens a pipeline and waits until the pane holds want objects.
func openSynced(t *testing.T, svc *Service, yaml string, want int) OpenResult {
	t.Helper()
	res, err := svc.Open(yaml)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(res.Pane) })
	deadline := time.Now().Add(3 * time.Second)
	got := -1
	for time.Now().Before(deadline) {
		pn, _ := svc.pane(res.Pane)
		pn.mu.Lock()
		synced, n := pn.view.Synced()
		pn.mu.Unlock()
		if synced {
			got = n
		}
		if got == want {
			return res
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s: holds %d objects, want %d", yaml, got, want)
	return res
}

func byID(items []relations.Relation) map[string]relations.Relation {
	m := map[string]relations.Relation{}
	for _, r := range items {
		m[r.ID] = r
	}
	return m
}

func count(r relations.Relation) int {
	if r.Count == nil {
		return -1
	}
	return *r.Count
}

func TestRelationsOwnerChain(t *testing.T) {
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	got, err := svc.Relations(res.Pane, "rp-web-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "Pod" || got.Name != "web-7d9f-a" || got.Namespace != "shop" || !got.Scan || got.ScanAll {
		t.Errorf("header = %+v", got)
	}
	m := byID(got.Items)
	// all-namespaces pane: "<resource> in shop" keeps the pane's resource; the namespace object resolves to its tape
	if r := m["ns:here"]; r.Target == nil || *r.Target != (relations.Target{Resource: "rel-pods", Namespace: "shop"}) {
		t.Errorf("rel-pods in shop = %+v", r.Target)
	}
	if l := m["ns:here"].Label + " / " + m["ns:object"].Label; l != "rel-pods in shop / namespace object shop" {
		t.Errorf("labels = %s", l)
	}
	if r := m["ns:object"]; r.Target == nil || *r.Target != (relations.Target{Resource: "rel-namespaces", Filter: `o.metadata.name == "shop"`}) {
		t.Errorf("namespace object = %+v", r.Target)
	}
	rs, deploy := m["owner:rr-web-7d9f"], m["owner:rd-web"]
	if rs.Depth != 1 || !rs.Controller || rs.Target == nil || *rs.Target != (relations.Target{Resource: "rel-replicasets", Namespace: "shop", Filter: `o.metadata.name == "web-7d9f"`}) {
		t.Errorf("replica set = %+v %+v", rs, rs.Target)
	}
	// the chain goes on: the replica set's owner, resolved to the relation tape (not e2e-deploys)
	if deploy.Depth != 2 || deploy.Label != "deployment web" || deploy.Target == nil || deploy.Target.Resource != "rel-deployments" {
		t.Errorf("deployment = %+v %+v", deploy, deploy.Target)
	}
	// order: namespace, then owners by depth
	var ids []string
	for _, r := range got.Items {
		ids = append(ids, r.ID)
	}
	if strings.Join(ids, " ") != "ns:here ns:object owner:rr-web-7d9f owner:rd-web" {
		t.Errorf("items = %v", ids)
	}
}

func TestRelationsGoneOwners(t *testing.T) {
	svc, _ := relSetup(t)
	pods := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	got, err := svc.Relations(pods.Pane, "rp-orphan-0")
	if err != nil {
		t.Fatal(err)
	}
	if r := byID(got.Items)["owner:rr-old-5c4b"]; r.Gone != "deleted" || r.Target != nil {
		t.Errorf("deleted owner = %+v", r)
	}
	rss := openSynced(t, svc, "source: {resource: rel-replicasets}", 2)
	got, err = svc.Relations(rss.Pane, "rr-api-1a2b")
	if err != nil {
		t.Fatal(err)
	}
	if r := byID(got.Items)["owner:rd-api-old"]; !strings.HasPrefix(r.Gone, "recreated") || r.Target != nil {
		t.Errorf("recreated owner = %+v", r)
	}
}

func TestRelationsOwnedKnownKinds(t *testing.T) {
	svc, _ := relSetup(t)
	deploys := openSynced(t, svc, "source: {resource: rel-deployments}", 2)
	got, err := svc.Relations(deploys.Pane, "rd-web")
	if err != nil {
		t.Fatal(err)
	}
	m := byID(got.Items)
	rs, pods := m["owned:apps/v1/ReplicaSet"], m["owned:v1/Pod"]
	if count(rs) != 1 || rs.Target.Resource != "rel-replicasets" || rs.Target.Filter != relations.OwnedFilter("rd-web") {
		t.Errorf("replica sets = %+v %+v", rs, rs.Target)
	}
	// pods by the selector, in the deployment's namespace: the stray pod counts, lab's doesn't
	if count(pods) != 3 || *pods.Target != (relations.Target{Resource: "rel-pods", Namespace: "shop", LabelSelector: "app=web"}) {
		t.Errorf("pods = %+v %+v", pods, pods.Target)
	}

	rss := openSynced(t, svc, "source: {resource: rel-replicasets}", 2)
	got, _ = svc.Relations(rss.Pane, "rr-web-7d9f")
	// the replica set's selector has matchExpressions; only the pods it owns count (not the stray one)
	p := byID(got.Items)["owned:v1/Pod"]
	if count(p) != 2 || p.Target.LabelSelector != "app=web,tier notin (batch)" || p.Target.Filter != relations.OwnedFilter("rr-web-7d9f") {
		t.Errorf("pods of the replica set = %+v %+v", p, p.Target)
	}
}

func TestRelationsCustomResourceScalePods(t *testing.T) {
	svc, _ := relSetup(t)
	widgets := openSynced(t, svc, "source: {resource: rel-widgets}", 1)
	got, err := svc.Relations(widgets.Pane, "rw-gizmo")
	if err != nil {
		t.Fatal(err)
	}
	p := byID(got.Items)["owned:v1/Pod"]
	if count(p) != 1 || *p.Target != (relations.Target{Resource: "rel-pods", Namespace: "shop", LabelSelector: "widget=gizmo"}) {
		t.Errorf("pods of the widget = %+v %+v", p, p.Target)
	}
}

func TestOwnedScan(t *testing.T) {
	svc, _ := relSetup(t)
	widgets := openSynced(t, svc, "source: {resource: rel-widgets}", 1)
	got, err := svc.OwnedScan(widgets.Pane, "rw-gizmo")
	if err != nil {
		t.Fatal(err)
	}
	// configmaps (one by controller, one plain owner ref) and the pod; namespaces are cluster-scoped: not scanned
	m := byID(got.Items)
	cms, pods := m["scan:rel-configmaps"], m["scan:rel-pods"]
	if count(cms) != 2 || *cms.Target != (relations.Target{Resource: "rel-configmaps", Namespace: "shop", Filter: relations.OwnedFilter("rw-gizmo")}) {
		t.Errorf("configmaps = %+v %+v", cms, cms.Target)
	}
	if count(pods) != 1 || len(got.Items) != 2 {
		t.Errorf("items = %+v", got.Items)
	}
	// rel-* namespaced types: configmaps, deployments, pods, replicasets, widgets; e2e-deploys shares a kind
	if got.Scanned != 5 || got.Skipped != 0 {
		t.Errorf("scanned %d skipped %d", got.Scanned, got.Skipped)
	}
}

func TestRelationsOnTombstoneAndUnknownRow(t *testing.T) {
	svc, _ := relSetup(t)
	pods := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	if _, err := svc.Relations(pods.Pane, "nope"); err == nil {
		t.Error("unknown row: want an error")
	}
	// deleted while shown: the last state still has its owners
	p, err := svc.Prepare("delete", pods.Pane, "rp-web-b")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete(p.Token); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		pn, _ := svc.pane(pods.Pane)
		pn.mu.Lock()
		gone := pn.view.Deleted("rp-web-b")
		pn.mu.Unlock()
		if gone || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, err := svc.Relations(pods.Pane, "rp-web-b")
	if err != nil {
		t.Fatal(err)
	}
	if r := byID(got.Items)["owner:rr-web-7d9f"]; r.Target == nil {
		t.Errorf("tombstone's owner = %+v", r)
	}
}

func TestRowIndex(t *testing.T) {
	svc, _ := relSetup(t)
	pods := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	// kubectl order: namespace, name → lab/web-other, shop/gizmo-0, shop/orphan-0, shop/web-7d9f-a …
	for key, want := range map[string]int{"rp-web-other": 0, "rp-gizmo-0": 1, "rp-web-a": 3, "nope": -1} {
		if got, err := svc.RowIndex(pods.Pane, key); err != nil || got != want {
			t.Errorf("%s: %d (%v), want %d", key, got, err, want)
		}
	}
}

func TestFilteringTapeHonorsSelectors(t *testing.T) {
	svc, _ := relSetup(t)
	// the target of a jump is an ordinary pipeline: namespace and selectors apply
	openSynced(t, svc, "source: {resource: rel-pods, namespace: shop, labelSelector: app=web}", 3)
	openSynced(t, svc, "source: {resource: rel-pods, fieldSelector: spec.nodeName=node-2}", 2)
}

func TestRelationsNodePods(t *testing.T) {
	svc, _ := relSetup(t)
	nodes := openSynced(t, svc, "source: {resource: rel-nodes}", 2)
	got, err := svc.Relations(nodes.Pane, "rnd-1")
	if err != nil {
		t.Fatal(err)
	}
	// cluster-scoped: no namespace entries; the scan would cover everything, so it asks first
	if !got.Scan || !got.ScanAll {
		t.Errorf("scan = %v, scanAll = %v", got.Scan, got.ScanAll)
	}
	m := byID(got.Items)
	if _, ok := m["ns:object"]; ok {
		t.Error("a node has no namespace")
	}
	// the pods on node-1, in all namespaces (web-a, web-stray in shop; web-other in lab)
	p := m["owned:v1/Pod"]
	if count(p) != 3 || *p.Target != (relations.Target{Resource: "rel-pods", FieldSelector: "spec.nodeName=node-1"}) {
		t.Errorf("pods = %+v %+v", p, p.Target)
	}
}
