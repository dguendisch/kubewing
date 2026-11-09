package view

import (
	"slices"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/health"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

func stagePod(uid, name, phase, app string, restarts int64) source.Item {
	return item(map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": name, "namespace": "ns", "uid": uid, "labels": map[string]any{"app": app, "tier": "x"}},
		"spec":     map[string]any{"containers": []any{map[string]any{"name": "c", "image": "img"}}},
		"status": map[string]any{
			"phase":             phase,
			"containerStatuses": []any{map[string]any{"name": "c", "restartCount": restarts}},
		},
	})
}

func stageView(t *testing.T, stages ...pipeline.Stage) *View {
	t.Helper()
	v, err := New(pipeline.Pipeline{
		Source: pipeline.Source{Resource: "pods", LabelSelector: "tier=x"},
		Stages: stages,
		Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME", Path: "metadata.name"}, {Name: "PHASE", Path: "status.phase"}}},
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{
		stagePod("a", "api-0", "Running", "api", 0),
		stagePod("b", "api-1", "Pending", "api", 2),
		stagePod("c", "etcd-0", "Running", "etcd", 5),
	}}, t0)
	return v
}

func names(v *View) []string {
	var out []string
	for _, e := range v.rows() {
		out = append(out, e.name)
	}
	return out
}

func TestSetStagesKeepsDiffState(t *testing.T) {
	v := stageView(t)
	v.Apply(source.Event{Type: source.Modified, Item: stagePod("b", "api-1", "Running", "api", 2)}, t0.Add(time.Second))
	if !v.HasPrev("b") {
		t.Fatal("no prev after update")
	}
	if err := v.SetStages([]pipeline.Stage{{Filter: `o.metadata.labels.app == "api"`}}); err != nil {
		t.Fatal(err)
	}
	if got := names(v); len(got) != 2 || got[0] != "api-0" || got[1] != "api-1" {
		t.Fatalf("rows = %v", got)
	}
	if !v.HasPrev("b") {
		t.Fatal("SetStages dropped the previous version")
	}
	f, _ := v.Frame(t0.Add(2 * time.Second))
	for _, r := range f.Rows {
		if r.Key == "b" && len(r.Changed) == 0 {
			t.Fatalf("changed marker lost: %+v", r)
		}
	}
	// a bad expression leaves the view as it was
	if err := v.SetStages([]pipeline.Stage{{Filter: `o.metadata.`}}); err == nil {
		t.Fatal("want compile error")
	}
	if got := names(v); len(got) != 2 {
		t.Fatalf("rows after failed SetStages = %v", got)
	}
	// clearing shows everything again
	if err := v.SetStages(nil); err != nil {
		t.Fatal(err)
	}
	if got := names(v); len(got) != 3 {
		t.Fatalf("rows = %v", got)
	}
}

func TestFilterErrorsAreCounted(t *testing.T) {
	v := stageView(t, pipeline.Stage{Filter: `o.status.phase > 3`}) // string vs int
	f, _ := v.Frame(t0)
	if f.Status == nil || f.Status.FilterErrors != 3 || f.Status.FilterError == "" {
		t.Fatalf("status = %+v", f.Status)
	}
	// a missing field is a plain no-match, not an error
	if err := v.SetStages([]pipeline.Stage{{Filter: `o.spec.nodeName == "w1"`}}); err != nil {
		t.Fatal(err)
	}
	f, _ = v.Frame(t0)
	if f.Status == nil || f.Status.FilterErrors != 0 {
		t.Fatalf("status = %+v", f.Status)
	}
	// deleting an object drops its error from the count
	_ = v.SetStages([]pipeline.Stage{{Filter: `o.status.phase > 3`}})
	v.Apply(source.Event{Type: source.Deleted, Item: stagePod("a", "api-0", "", "", 0)}, t0)
	if v.matchErrs != 2 {
		t.Fatalf("matchErrs = %d", v.matchErrs)
	}
}

func TestPreviewFilter(t *testing.T) {
	v := stageView(t, pipeline.Stage{Grep: "api"})
	cases := []struct {
		src     string
		matched int
		invalid bool
		column  int
	}{
		{``, 2, false, -1}, // grep only
		{`o.status.phase == "Running"`, 1, false, -1},           // api-0 (etcd-0 fails the grep)
		{`o.status.phase == "Run"`, 0, false, -1},               // valid, matches nothing
		{`o.status.phase`, 0, true, -1},                         // dyn, but a string on every object
		{`1 + 2`, 0, true, -1},                                  // statically int
		{`o.status.phase == "Running" && o.spec.`, 0, true, 38}, // parse error at the dot
	}
	for _, c := range cases {
		pv := v.PreviewFilter(c.src)
		if pv.Matched != c.matched || pv.Invalid != c.invalid || pv.Column != c.column {
			t.Errorf("%q: %+v", c.src, pv)
		}
	}
	if got := names(v); len(got) != 2 {
		t.Fatalf("preview changed the view: %v", got)
	}
}

func TestPreviewLabels(t *testing.T) {
	v := stageView(t)
	pv := v.PreviewLabels("tier=x,app=api", "tier=x")
	if pv.Matched != 2 || pv.AtLeast || pv.Invalid {
		t.Fatalf("narrower: %+v", pv)
	}
	pv = v.PreviewLabels("app=et", "tier=x")
	if pv.Matched != 0 || !pv.AtLeast {
		t.Fatalf("wider: %+v", pv)
	}
	pv = v.PreviewLabels("app in (", "tier=x")
	if !pv.Invalid || pv.Error == "" {
		t.Fatalf("invalid: %+v", pv)
	}
}

func TestFieldKeys(t *testing.T) {
	v := stageView(t)
	keys, n := v.FieldKeys([]string{"status", "containerStatuses"}, 0)
	if n != 3 || len(keys) != 2 || keys[0] != (FieldKey{Key: "name", Type: "string", Count: 3}) || keys[1].Key != "restartCount" || keys[1].Type != "int" {
		t.Fatalf("keys = %+v (%d)", keys, n)
	}
	top, _ := v.FieldKeys(nil, 0)
	if len(top) != 5 || top[0].Key != "apiVersion" || top[4].Key != "status" || top[4].Type != "map" {
		t.Fatalf("top keys = %+v", top)
	}
	if keys, _ := v.FieldKeys([]string{"status", "nope"}, 0); len(keys) != 0 {
		t.Fatalf("keys = %+v", keys)
	}
}

func TestLabels(t *testing.T) {
	v := stageView(t)
	var apps []string
	for _, set := range v.Labels() {
		apps = append(apps, set["app"])
	}
	slices.Sort(apps)
	if !slices.Equal(apps, []string{"api", "api", "etcd"}) {
		t.Fatalf("apps = %v", apps)
	}
}

func TestGrepTerms(t *testing.T) {
	cases := map[string][]string{
		"api":             {"api-0", "api-1"},
		"api !pending":    {"api-0"},
		"!running":        {"api-1"},
		"!api !etcd":      nil,
		`"api-0 running"`: {"api-0"}, // a phrase across cells
		"running !":       {"api-0", "etcd-0"},
		"^api":            {"api-0", "api-1"},
		"^pi":             nil,
		"-0$":             {"api-0", "etcd-0"},
		"pending | ^etcd": {"api-1", "etcd-0"},
		"!^run":           {"api-1"},
	}
	for grep, want := range cases {
		v := stageView(t, pipeline.Stage{Grep: grep})
		if got := names(v); !slices.Equal(got, want) {
			t.Errorf("grep %q: rows = %v, want %v", grep, got, want)
		}
	}
}

func TestHideHealthyStage(t *testing.T) {
	ready := func(uid, name string, ok bool) source.Item {
		it := stagePod(uid, name, "Running", "api", 0)
		it.Object.Object["status"].(map[string]any)["containerStatuses"] = []any{map[string]any{"name": "c", "ready": ok}}
		return it
	}
	v := stageView(t)
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{
		ready("a", "api-0", true),
		ready("b", "api-1", false),
		stagePod("c", "api-2", "Pending", "api", 0),
	}}, t0)
	if err := v.SetStages([]pipeline.Stage{{HideHealthy: true}}); err != nil {
		t.Fatal(err)
	}
	if got := names(v); !slices.Equal(got, []string{"api-1", "api-2"}) {
		t.Fatalf("rows = %v", got)
	}
	// the draft CEL preview keeps the stage
	if pv := v.PreviewFilter(`o.status.phase == "Running"`); pv.Matched != 1 {
		t.Fatalf("preview = %+v", pv)
	}
	// becoming ready hides a pod live
	v.Apply(source.Event{Type: source.Modified, Item: ready("b", "api-1", true)}, t0)
	if got := names(v); !slices.Equal(got, []string{"api-2"}) {
		t.Fatalf("rows after ready = %v", got)
	}
	_ = v.SetStages(nil)
	if got := names(v); len(got) != 3 {
		t.Fatalf("rows after toggle off = %v", got)
	}
}

// new health rules (a config reload) apply to the rows in place; the status
// names what the pane's rule hides
func TestSetHealth(t *testing.T) {
	ready := func(uid, name string) source.Item {
		it := stagePod(uid, name, "Running", "api", 0)
		it.Object.Object["status"].(map[string]any)["containerStatuses"] = []any{map[string]any{"name": "c", "ready": true}}
		return it
	}
	v, err := New(pipeline.Pipeline{
		Source: pipeline.Source{Resource: "pods"},
		Stages: []pipeline.Stage{{HideHealthy: true}},
		Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME", Path: "metadata.name"}}},
	}, Options{Kind: "Pod"})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{ready("a", "api-0"), stagePod("b", "api-1", "Pending", "api", 0)}}, t0)
	if got := names(v); !slices.Equal(got, []string{"api-1"}) {
		t.Fatalf("rows = %v", got)
	}
	f, _ := v.Frame(t0)
	if f.Status.Healthy != "pods that are Running with all containers ready" {
		t.Errorf("status healthy = %q", f.Status.Healthy)
	}
	// a rule of one's own: pending pods count as healthy, running ones don't
	rs, errs := health.Compile(health.RulesFile{Rules: []health.Rule{{ID: "pod", Kinds: []string{"Pod"}, Title: "pending pods", CEL: `o.status.phase == "Pending"`}}})
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	v.SetHealth(rs)
	if got := names(v); !slices.Equal(got, []string{"api-0"}) {
		t.Fatalf("rows after reload = %v", got)
	}
	if f, _ := v.Frame(t0); f.Status.Healthy != "pending pods" {
		t.Errorf("status healthy after reload = %q", f.Status.Healthy)
	}
	// no rule for the kind: nothing hidden, nothing to name
	none, _ := health.Compile(health.RulesFile{Disable: []string{"pod"}})
	v.SetHealth(none)
	if got := names(v); len(got) != 2 {
		t.Fatalf("rows without a rule = %v", got)
	}
	if f, _ := v.Frame(t0); f.Status.Healthy != "" {
		t.Errorf("status healthy without a rule = %q", f.Status.Healthy)
	}
}
