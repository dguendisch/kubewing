package bridge

import (
	"slices"
	"testing"

	"github.com/dguendisch/kubewing/internal/view"
)

func items(lc LabelCounts) []view.ValueCount { return lc.Items }

// The applied selector doesn't limit label completion: what it filters out
// is listed (metadata only); the draft's other requirements do.
func TestLabelsBeyondAppliedSelector(t *testing.T) {
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: rel-pods, namespace: shop, labelSelector: app=web}", 3)

	// keys and values of the whole namespace (orphan-0 has no labels), not only of app=web
	lc, err := svc.Labels(res.Pane, "", "")
	if err != nil || lc.Objects != 5 || !slices.Equal(items(lc), []view.ValueCount{{Value: "app", Count: 3}, {Value: "widget", Count: 1}}) {
		t.Fatalf("keys = %+v, %v", lc, err)
	}
	lc, _ = svc.Labels(res.Pane, "widget", "")
	if lc.Objects != 5 || !slices.Equal(items(lc), []view.ValueCount{{Value: "gizmo", Count: 1}}) {
		t.Fatalf("widget values = %+v", lc)
	}
	// the source's namespace still applies (web-other is in lab)
	lc, _ = svc.Labels(res.Pane, "app", "")
	if !slices.Equal(items(lc), []view.ValueCount{{Value: "web", Count: 3}}) {
		t.Fatalf("app values = %+v", lc)
	}
	// other requirements of the draft narrow it
	lc, _ = svc.Labels(res.Pane, "", "widget=gizmo")
	if lc.Objects != 1 || !slices.Equal(items(lc), []view.ValueCount{{Value: "widget", Count: 1}}) {
		t.Fatalf("keys under widget=gizmo = %+v", lc)
	}
	// at least as strict as the applied selector: the pane's objects
	lc, _ = svc.Labels(res.Pane, "", "app=web")
	if lc.Objects != 3 {
		t.Fatalf("keys under app=web = %+v", lc)
	}
	// an unparsable rest: the pane's objects as they are
	lc, _ = svc.Labels(res.Pane, "", "app in (")
	if lc.Objects != 3 {
		t.Fatalf("keys under a broken rest = %+v", lc)
	}
}
