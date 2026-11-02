package bridge

import (
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/safety"
)

// the relation tapes in namespace shop (events left out): config maps 3,
// deployments 2, pods 5, claims 7, replica sets 2, role bindings 1, roles
// 1, secrets 2, service accounts 1, stateful sets 3, widgets 1 (and the
// e2e-deploys tape's apps/v1 Deployments resolve to rel-deployments)
const shopObjects = 28

func snapshotPane(t *testing.T) (*Service, OpenResult) {
	t.Helper()
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: all, namespace: shop}", shopObjects)
	return svc, res
}

// rowKey finds a snapshot row by its KIND and NAME cells.
func rowKey(t *testing.T, svc *Service, pane, kind, name string) string {
	t.Helper()
	pn, _ := svc.pane(pane)
	pn.mu.Lock()
	defer pn.mu.Unlock()
	for _, it := range pn.view.MatchedItems() {
		if it.Object.GetKind() == kind && it.Object.GetName() == name {
			return string(it.Object.GetUID())
		}
	}
	t.Fatalf("no %s %s", kind, name)
	return ""
}

func TestSnapshotPane(t *testing.T) {
	svc, res := snapshotPane(t)
	if res.Kind != "*" || res.Sort != "KIND" {
		t.Fatalf("open: %+v", res)
	}
	pn, _ := svc.pane(res.Pane)
	pn.mu.Lock()
	f, _ := pn.view.Frame(time.Now())
	pn.mu.Unlock()
	var cols []string
	for _, c := range f.Columns {
		cols = append(cols, c.Name)
	}
	if strings.Join(cols, ",") != "KIND,NAME,OWNER,AGE,DELETING,FINALIZERS" {
		t.Fatalf("columns %v", cols)
	}
	if f.Status == nil || !f.Status.Snapshot || f.Status.ListedAt == "" {
		t.Fatalf("status %+v", f.Status)
	}

	// a row's actions are of its own type: a pod's containers, its YAML in full
	key := rowKey(t, svc, res.Pane, "Pod", "gizmo-0")
	info, err := svc.RowInfo(res.Pane, key)
	if err != nil || !info.Pod || len(info.Containers) != 1 || info.Kind != "Pod" {
		t.Fatalf("row info %+v %v", info, err)
	}
	d, err := svc.Object(res.Pane, key)
	if err != nil || !strings.Contains(d.YAML, "secretKeyRef") {
		t.Fatalf("detail: %v\n%s", err, d.YAML)
	}
	// the jump menu reads the row's own references (the pod's secrets)
	rel, err := svc.Relations(res.Pane, key)
	if err != nil {
		t.Fatal(err)
	}
	ids := byID(rel.Items)
	if _, ok := ids["ns:here"]; ok {
		t.Error(`a listing of one namespace offers "all in shop" again`)
	}
	if _, ok := ids["ns:all"]; ok {
		t.Error(`"everything in shop" from everything in shop`)
	}
	found := false
	for _, r := range rel.Items {
		found = found || r.Section == "reference" && r.Kind == "Secret" && r.Name == "db"
	}
	if !found {
		t.Errorf("no reference to secret db: %+v", rel.Items)
	}
}

func TestSnapshotDeleteRefreshes(t *testing.T) {
	svc, res := snapshotPane(t)
	key := rowKey(t, svc, res.Pane, "ConfigMap", "plain")
	p, err := svc.Prepare(safety.Delete, res.Pane, key)
	if err != nil {
		t.Fatal(err)
	}
	if p.Action.Resource != "rel-configmaps" || p.Action.Name != "plain" {
		t.Fatalf("prepared %+v", p.Action)
	}
	if err := svc.Delete(p.Token); err != nil {
		t.Fatal(err)
	}
	// not watched: the delete lists again, so the row goes
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		pn, _ := svc.pane(res.Pane)
		pn.mu.Lock()
		gone := pn.view.Deleted(key)
		pn.mu.Unlock()
		if gone {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("deleted config map still listed")
}

func TestRefreshOnlyListings(t *testing.T) {
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	if err := svc.Refresh(res.Pane); err == nil {
		t.Fatal("a live pane refreshed")
	}
	svc, snap := snapshotPane(t)
	if err := svc.Refresh(snap.Pane); err != nil {
		t.Fatal(err)
	}
}

func TestEverythingInFromNamespaceAndRows(t *testing.T) {
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: rel-pods}", 6)
	key := ""
	pn, _ := svc.pane(res.Pane)
	pn.mu.Lock()
	for _, it := range pn.view.MatchedItems() {
		if it.Object.GetName() == "gizmo-0" {
			key = string(it.Object.GetUID())
		}
	}
	pn.mu.Unlock()
	rel, err := svc.Relations(res.Pane, key)
	if err != nil {
		t.Fatal(err)
	}
	r, ok := byID(rel.Items)["ns:all"]
	if !ok || r.Label != "everything in shop" || r.Target.Resource != "all" || r.Target.Namespace != "shop" {
		t.Fatalf("ns:all = %+v (%v)", r, ok)
	}

	ns := openSynced(t, svc, "source: {resource: rel-namespaces}", 2)
	pn, _ = svc.pane(ns.Pane)
	pn.mu.Lock()
	for _, it := range pn.view.MatchedItems() {
		if it.Object.GetName() == "shop" {
			key = string(it.Object.GetUID())
		}
	}
	pn.mu.Unlock()
	rel, err = svc.Relations(ns.Pane, key)
	if err != nil {
		t.Fatal(err)
	}
	if r, ok := byID(rel.Items)["ns:all"]; !ok || r.Target.Namespace != "shop" {
		t.Fatalf("from the namespace: %+v", rel.Items)
	}
}
