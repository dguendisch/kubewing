package bridge

import (
	"path/filepath"
	"strconv"
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
	// order: namespace, then owners by depth, references (its node, by the field rules)
	var ids []string
	for _, r := range got.Items {
		ids = append(ids, r.ID)
	}
	if strings.Join(ids, " ") != "ns:here ns:object ns:all owner:rr-web-7d9f owner:rd-web ref:v1/Node//node-1 events" {
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
	// rel-* namespaced types: configmaps, deployments, pods, pvcs, replicasets, rolebindings, roles, secrets,
	// serviceaccounts, statefulsets, widgets; e2e-deploys shares a kind
	if got.Scanned != 11 || got.Skipped != 0 {
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

func TestRelationsNamespacePods(t *testing.T) {
	svc, _ := relSetup(t)
	nss := openSynced(t, svc, "source: {resource: rel-namespaces}", 2)
	got, err := svc.Relations(nss.Pane, "rn-shop")
	if err != nil {
		t.Fatal(err)
	}
	// the pods in shop (lab's web-other isn't)
	p := byID(got.Items)["owned:v1/Pod"]
	if count(p) != 5 || *p.Target != (relations.Target{Resource: "rel-pods", Namespace: "shop"}) {
		t.Errorf("pods = %+v %+v", p, p.Target)
	}
}

func TestRelationsStorageReferences(t *testing.T) {
	svc, _ := relSetup(t)
	pvcs := openSynced(t, svc, "source: {resource: rel-pvcs}", 7)
	got, err := svc.Relations(pvcs.Pane, "rpvc-data-0")
	if err != nil {
		t.Fatal(err)
	}
	// a bound claim: its volume (cluster-scoped, checked) and that volume's attachments (counted by CEL)
	m := byID(got.Items)
	pv, va := m["ref:v1/PersistentVolume//pv-data-0"], m["ref:storage.k8s.io/v1/VolumeAttachment"]
	if pv.Section != relations.SectionReference || pv.Label != "persistentvolume pv-data-0" || pv.Target == nil ||
		*pv.Target != (relations.Target{Resource: "rel-pvs", Filter: `o.metadata.name == "pv-data-0"`}) {
		t.Errorf("volume = %+v %+v", pv, pv.Target)
	}
	if count(va) != 2 || va.Label != "rel-volumeattachments" ||
		*va.Target != (relations.Target{Resource: "rel-volumeattachments", Filter: `o.spec.source.persistentVolumeName == "pv-data-0"`}) {
		t.Errorf("attachments = %+v %+v", va, va.Target)
	}
	// the target shows those two only (not the inline volume's)
	shown := openSynced(t, svc, "source: {resource: rel-volumeattachments}\nstages: [{filter: '"+va.Target.Filter+"'}]", 5)
	for key, want := range map[string]bool{"rva-a": true, "rva-b": true, "rva-inline": false, "rva-scratch": false} {
		if idx, _ := svc.RowIndex(shown.Pane, key); (idx >= 0) != want {
			t.Errorf("%s shown = %v, want %v", key, idx >= 0, want)
		}
	}
	var ids []string
	for _, r := range got.Items {
		ids = append(ids, r.ID)
	}
	if strings.Join(ids, " ") != "ns:here ns:object ns:all ref:v1/PersistentVolume//pv-data-0 ref:storage.k8s.io/v1/VolumeAttachment events" {
		t.Errorf("items = %v", ids)
	}

	// pending: nothing to go to yet; lost: its volume is gone
	got, _ = svc.Relations(pvcs.Pane, "rpvc-pending")
	if r := byID(got.Items)["ref:v1/PersistentVolume"]; r.Gone != "not bound" || r.Label != "persistentvolume" || r.Target != nil {
		t.Errorf("pending = %+v", r)
	}
	if _, ok := byID(got.Items)["ref:storage.k8s.io/v1/VolumeAttachment"]; ok {
		t.Error("pending: no attachments entry")
	}
	got, _ = svc.Relations(pvcs.Pane, "rpvc-lost")
	if r := byID(got.Items)["ref:v1/PersistentVolume//pv-deleted"]; r.Gone != "deleted" || r.Target != nil {
		t.Errorf("lost = %+v", r)
	}

	// a volume: its claim (checked by UID) and attachments
	pvs := openSynced(t, svc, "source: {resource: rel-pvs}", 6)
	got, _ = svc.Relations(pvs.Pane, "rpv-data-0")
	m = byID(got.Items)
	if c := m["ref:v1/PersistentVolumeClaim/shop/data-0"]; c.Target == nil || *c.Target != (relations.Target{Resource: "rel-pvcs", Namespace: "shop", Filter: `o.metadata.name == "data-0"`}) {
		t.Errorf("claim = %+v %+v", c, c.Target)
	}
	if va := m["ref:storage.k8s.io/v1/VolumeAttachment"]; count(va) != 2 {
		t.Errorf("attachments = %+v", va)
	}
	got, _ = svc.Relations(pvs.Pane, "rpv-spare")
	if va := byID(got.Items)["ref:storage.k8s.io/v1/VolumeAttachment"]; count(va) != 0 || va.Target == nil {
		t.Errorf("spare's attachments = %+v", va)
	}
	got, _ = svc.Relations(pvs.Pane, "rpv-released")
	if c := byID(got.Items)["ref:v1/PersistentVolumeClaim/shop/old"]; c.Gone != "deleted" {
		t.Errorf("released's claim = %+v", c)
	}

	// an attachment: back to its volume, and the node
	vas := openSynced(t, svc, "source: {resource: rel-volumeattachments}", 5)
	got, _ = svc.Relations(vas.Pane, "rva-b")
	m = byID(got.Items)
	if r := m["ref:v1/PersistentVolume//pv-data-0"]; r.Target == nil || r.Target.Resource != "rel-pvs" {
		t.Errorf("attachment's volume = %+v", r)
	}
	if r := m["ref:v1/Node//node-2"]; r.Target == nil || *r.Target != (relations.Target{Resource: "rel-nodes", Filter: `o.metadata.name == "node-2"`}) {
		t.Errorf("attachment's node = %+v %+v", r, r.Target)
	}
}

func TestRelationsPodVolumes(t *testing.T) {
	svc, _ := relSetup(t)
	pods := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	got, err := svc.Relations(pods.Pane, "rp-gizmo-0")
	if err != nil {
		t.Fatal(err)
	}
	var refs []string
	m := byID(got.Items)
	for _, r := range got.Items {
		if r.Section == relations.SectionReference {
			refs = append(refs, r.Label)
		}
	}
	// in volume order, each claim followed by its volume; the attachments of both volumes; then what the
	// field rules find besides, in YAML order (keys sorted: env, node, service account, volumes), each object
	// once (db: two env vars), the claims not again
	want := "persistentvolumeclaim data-0 / persistentvolume pv-data-0 / persistentvolumeclaim gizmo-0-scratch / persistentvolume pv-scratch / persistentvolumeclaim cache / rel-volumeattachments / " +
		"secret db / secret gizmo-token / node node-2 / serviceaccount gizmo / configmap gizmo-config / secret gizmo-tls"
	if strings.Join(refs, " / ") != want {
		t.Errorf("references = %s", strings.Join(refs, " / "))
	}
	if c := m["ref:v1/PersistentVolumeClaim/shop/data-0"]; c.Target == nil || *c.Target != (relations.Target{Resource: "rel-pvcs", Namespace: "shop", Filter: `o.metadata.name == "data-0"`}) {
		t.Errorf("claim = %+v %+v", c, c.Target)
	}
	if c := m["ref:v1/PersistentVolumeClaim/shop/cache"]; c.Gone != "missing" || c.Target != nil {
		t.Errorf("missing claim = %+v", c)
	}
	va := m["ref:storage.k8s.io/v1/VolumeAttachment"]
	if count(va) != 3 || va.Target.Filter != `o.spec.source.persistentVolumeName in ["pv-data-0", "pv-scratch"]` {
		t.Errorf("attachments = %+v %+v", va, va.Target)
	}
	if db := m["ref:v1/Secret/shop/db"]; db.Places != 2 || db.Target == nil || db.Target.Resource != "rel-secrets" {
		t.Errorf("db = %+v", db)
	}
	if tok := m["ref:v1/Secret/shop/gizmo-token"]; tok.Gone != "missing" || tok.Target != nil {
		t.Errorf("gizmo-token = %+v", tok)
	}
	if cm := m["ref:v1/ConfigMap/shop/gizmo-config"]; cm.Target == nil || *cm.Target != (relations.Target{Resource: "rel-configmaps", Namespace: "shop", Filter: `o.metadata.name == "gizmo-config"`}) {
		t.Errorf("config map = %+v %+v", cm, cm.Target)
	}
	// a pod without claims: its node only
	got, _ = svc.Relations(pods.Pane, "rp-web-a")
	for _, r := range got.Items {
		if r.Section == relations.SectionReference && r.ID != "ref:v1/Node//node-1" {
			t.Errorf("web-7d9f-a: %+v", r)
		}
	}
}

func TestRelationsStatefulSetVolumes(t *testing.T) {
	svc, _ := relSetup(t)
	sets := openSynced(t, svc, "source: {resource: rel-statefulsets}", 3)
	got, err := svc.Relations(sets.Pane, "rss-db")
	if err != nil {
		t.Fatal(err)
	}
	var refs []string
	for _, r := range got.Items {
		if r.Section == relations.SectionReference {
			refs = append(refs, r.Label+" "+strconv.Itoa(count(r)))
		}
	}
	// counted sets: db's two claims (not dbx's), their volumes, the one attachment
	if s := strings.Join(refs, " / "); s != "rel-pvcs 2 / rel-pvs 2 / rel-volumeattachments 1" {
		t.Errorf("references = %s", s)
	}
	m := byID(got.Items)
	c := m["ref:v1/PersistentVolumeClaim"]
	if *c.Target != (relations.Target{Resource: "rel-pvcs", Namespace: "shop", Filter: `o.metadata.name.matches("^(data)-db-[0-9]+$")`}) {
		t.Errorf("claims = %+v", c.Target)
	}
	if v := m["ref:v1/PersistentVolume"]; *v.Target != (relations.Target{Resource: "rel-pvs", Filter: `o.metadata.name in ["pv-db-0", "pv-db-1"]`}) {
		t.Errorf("volumes = %+v", v.Target)
	}
	// the claims' target shows those two
	shown := openSynced(t, svc, "source: {resource: rel-pvcs, namespace: shop}\nstages: [{filter: '"+c.Target.Filter+"'}]", 7)
	for key, want := range map[string]bool{"rpvc-db-0": true, "rpvc-db-1": true, "rpvc-dbx-0": false} {
		if idx, _ := svc.RowIndex(shown.Pane, key); (idx >= 0) != want {
			t.Errorf("%s shown = %v, want %v", key, idx >= 0, want)
		}
	}

	// dbx: its pending claim, nothing bound; no templates: no references
	got, _ = svc.Relations(sets.Pane, "rss-dbx")
	m = byID(got.Items)
	if c := m["ref:v1/PersistentVolumeClaim"]; count(c) != 1 {
		t.Errorf("dbx's claims = %+v", c)
	}
	if _, ok := m["ref:v1/PersistentVolume"]; ok {
		t.Error("dbx: no volumes entry")
	}
	got, _ = svc.Relations(sets.Pane, "rss-cache")
	for _, r := range got.Items {
		if r.Section == relations.SectionReference {
			t.Errorf("cache: %+v", r)
		}
	}
}

func TestEventsTarget(t *testing.T) {
	svc, _ := relSetup(t)
	pods := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	got, err := svc.EventsTarget(pods.Pane, "rp-web-b")
	if err != nil {
		t.Fatal(err)
	}
	// v1 Event resolves to its tape; by kind and name, in the pod's namespace
	want := relations.Target{Resource: "rel-events", Namespace: "shop", FieldSelector: "involvedObject.kind=Pod,involvedObject.name=web-7d9f-b"}
	if got != want {
		t.Errorf("pod = %+v", got)
	}
	// the target opens on the pod's events only (not another pod's, not lab's namesake)
	ev := openSynced(t, svc, "source: {resource: rel-events, namespace: shop, fieldSelector: \""+got.FieldSelector+"\"}", 2)
	if idx, _ := svc.RowIndex(ev.Pane, "re-4"); idx != -1 {
		t.Error("lab's event of the same name is shown")
	}

	// cluster-scoped: all namespaces (a node's events are in default)
	nodes := openSynced(t, svc, "source: {resource: rel-nodes}", 2)
	got, err = svc.EventsTarget(nodes.Pane, "rnd-1")
	if err != nil {
		t.Fatal(err)
	}
	if want := (relations.Target{Resource: "rel-events", FieldSelector: "involvedObject.kind=Node,involvedObject.name=node-1"}); got != want {
		t.Errorf("node = %+v", got)
	}
	openSynced(t, svc, "source: {resource: rel-events, namespace: \"*\", fieldSelector: \""+got.FieldSelector+"\"}", 1)

	evs := openSynced(t, svc, "source: {resource: rel-events}", 6)
	if _, err := svc.EventsTarget(evs.Pane, "re-1"); err == nil {
		t.Error("an event's events: want an error")
	}
	if rel, err := svc.Relations(evs.Pane, "re-1"); err != nil || byID(rel.Items)["events"].ID != "" {
		t.Errorf("an event's jump menu has an events entry: %v %+v", err, rel.Items)
	}
	if _, err := svc.EventsTarget(pods.Pane, "nope"); err == nil {
		t.Error("unknown row: want an error")
	}

	// the jump menu's events entry: the same target, counted
	for key, want := range map[string]int{"rp-web-b": 2, "rp-web-stray": 0} {
		rel, err := svc.Relations(pods.Pane, key)
		if err != nil {
			t.Fatal(err)
		}
		r := byID(rel.Items)["events"]
		if r.Section != relations.SectionEvents || r.Count == nil || *r.Count != want || r.Target == nil || r.Target.FieldSelector != "involvedObject.kind=Pod,involvedObject.name="+rel.Name {
			t.Errorf("%s: events entry = %+v %+v", key, r, r.Target)
		}
	}
	rel, err := svc.Relations(nodes.Pane, "rnd-1")
	if err != nil {
		t.Fatal(err)
	}
	if r := byID(rel.Items)["events"]; r.Count == nil || *r.Count != 1 || r.Target.Namespace != "" {
		t.Errorf("node: events entry = %+v %+v", r, r.Target)
	}
}

// lineOf is the 0-based line of the first line of text containing s.
func lineOf(t *testing.T, text, s string) int {
	t.Helper()
	for i, l := range strings.Split(text, "\n") {
		if strings.Contains(l, s) {
			return i
		}
	}
	t.Fatalf("%q not in\n%s", s, text)
	return -1
}

func TestFieldRelations(t *testing.T) {
	svc, _ := relSetup(t)
	pods := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	d, err := svc.Object(pods.Pane, "rp-gizmo-0")
	if err != nil {
		t.Fatal(err)
	}
	marks, err := svc.FieldRefs(pods.Pane, d.YAML)
	if err != nil {
		t.Fatal(err)
	}
	var labels []string
	for _, m := range marks {
		labels = append(labels, m.Label)
	}
	// every reference value, in the text's order: the owner too (a click on it goes there)
	if got := strings.Join(labels, ", "); got != "widget gizmo, secret db, secret db, secret gizmo-token, node node-2, serviceaccount gizmo, persistentvolumeclaim data-0, persistentvolumeclaim cache, configmap gizmo-config, secret gizmo-tls" {
		t.Errorf("marks = %s", got)
	}
	tls := lineOf(t, d.YAML, "secretName: gizmo-tls")
	if m := marks[len(marks)-1]; m.Line != tls || strings.Split(d.YAML, "\n")[tls][m.Col-1:m.EndCol-1] != "gizmo-tls" {
		t.Errorf("gizmo-tls mark = %+v", m)
	}

	at := func(line int) map[string]relations.Relation {
		t.Helper()
		got, err := svc.FieldRelations(pods.Pane, d.YAML, line)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range got {
			if r.Section != relations.SectionField {
				t.Errorf("%+v: section %s", r, r.Section)
			}
		}
		return byID(got)
	}
	// on the value: that secret, checked and jumpable
	m := at(tls)
	if r := m["field:v1/Secret/shop/gizmo-tls"]; len(m) != 1 || r.Target == nil || *r.Target != (relations.Target{Resource: "rel-secrets", Namespace: "shop", Filter: `o.metadata.name == "gizmo-tls"`}) {
		t.Errorf("at gizmo-tls: %+v", m)
	}
	// on the container: its env's secrets, db once for two fields, the missing one
	m = at(lineOf(t, d.YAML, "- env:"))
	if db := m["field:v1/Secret/shop/db"]; len(m) != 2 || db.Places != 2 || db.Target == nil {
		t.Errorf("at the container: %+v", m)
	}
	if tok := m["field:v1/Secret/shop/gizmo-token"]; tok.Gone != "missing" || tok.Target != nil {
		t.Errorf("gizmo-token = %+v", tok)
	}
	// the node is cluster-scoped: no namespace; nothing on a line without a reference
	if r := at(lineOf(t, d.YAML, "nodeName:"))["field:v1/Node//node-2"]; r.Target == nil || *r.Target != (relations.Target{Resource: "rel-nodes", Filter: `o.metadata.name == "node-2"`}) {
		t.Errorf("node = %+v", r)
	}
	if m := at(lineOf(t, d.YAML, "name: gizmo-0")); len(m) != 0 {
		t.Errorf("at the name: %+v", m)
	}

	// a role binding: the role by apiGroup without a version, subjects as service accounts (in their namespace)
	rbs := openSynced(t, svc, "source: {resource: rel-rolebindings}", 1)
	d, _ = svc.Object(rbs.Pane, "rrb-gizmo-reader")
	if r := at2(t, svc, rbs.Pane, d.YAML, lineOf(t, d.YAML, "roleRef:"))["field:rbac.authorization.k8s.io//Role/shop/gizmo-reader"]; r.Target == nil || r.Target.Resource != "rel-roles" || r.Label != "role gizmo-reader" {
		t.Errorf("role = %+v", r)
	}
	m = at2(t, svc, rbs.Pane, d.YAML, lineOf(t, d.YAML, "subjects:"))
	if r := m["field:v1/ServiceAccount/shop/gizmo"]; len(m) != 2 || r.Target == nil || r.Target.Resource != "rel-serviceaccounts" {
		t.Errorf("subjects = %+v", m)
	}
	if r := m["field:v1/ServiceAccount/tools/ci"]; r.Gone != "missing" {
		t.Errorf("ci = %+v", r)
	}
	// the editor's text: what's typed, not what's stored
	role := lineOf(t, d.YAML, "roleRef:")
	lines := strings.Split(d.YAML, "\n")
	for i := role + 1; i < len(lines) && strings.HasPrefix(lines[i], "  "); i++ {
		lines[i] = strings.Replace(lines[i], "name: gizmo-reader", "name: other", 1)
	}
	edited := strings.Join(lines, "\n")
	if r := at2(t, svc, rbs.Pane, edited, role)["field:rbac.authorization.k8s.io//Role/shop/other"]; r.Gone != "missing" {
		t.Errorf("edited role = %+v", r)
	}
	if _, err := svc.FieldRelations(rbs.Pane, "a: [", 0); err == nil {
		t.Error("invalid YAML: no error")
	}
}

func at2(t *testing.T, svc *Service, pane, text string, line int) map[string]relations.Relation {
	t.Helper()
	got, err := svc.FieldRelations(pane, text, line)
	if err != nil {
		t.Fatal(err)
	}
	return byID(got)
}
