package bridge

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

func paneColumns(t *testing.T, svc *Service, id string) []string {
	t.Helper()
	ch, err := svc.ColumnChoices(id)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, o := range ch.Options {
		if o.Shown {
			out = append(out, o.Name)
		}
	}
	return out
}

// A type's columns apply to its open panes live, to new ones, and survive
// a restart; a pane opened with its own columns keeps them.
func TestTypeColumns(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	svc := New(source.NewRegistry(stormOpener{n: 3}), &recorder{}, Options{Columns: config.OpenColumns(dir)})
	a, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(a.Pane)
	own, err := svc.Open("source: {resource: pods, namespace: ns}\nrender: {columns: [{name: NAME}]}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(own.Pane)
	if a.Type != "pods" {
		t.Fatalf("type = %q", a.Type)
	}
	if got := paneColumns(t, svc, a.Pane); !slices.Equal(got, []string{"NAME", "AGE"}) {
		t.Fatalf("defaults = %v", got)
	}

	cols := []pipeline.Column{{Name: "AGE"}, {Name: "NAME"}, {Name: "GEN", Path: "spec.gen", Type: pipeline.TypeNumber}}
	if err := svc.SetTypeColumns("pods", cols); err != nil {
		t.Fatal(err)
	}
	want := []string{"AGE", "NAME", "GEN"}
	if got := paneColumns(t, svc, a.Pane); !slices.Equal(got, want) {
		t.Fatalf("open pane = %v", got)
	}
	if got := paneColumns(t, svc, own.Pane); !slices.Equal(got, []string{"NAME"}) {
		t.Fatalf("pane with its own columns = %v", got)
	}
	// a filter bar edit (no render) keeps the type's columns
	if err := svc.Update(a.Pane, "source: {resource: pods, namespace: ns}\nstages: [{grep: pod}]"); err != nil {
		t.Fatal(err)
	}
	if got := paneColumns(t, svc, a.Pane); !slices.Equal(got, want) {
		t.Fatalf("after a stage edit = %v", got)
	}
	b, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(b.Pane)
	if got := paneColumns(t, svc, b.Pane); !slices.Equal(got, want) {
		t.Fatalf("new pane = %v", got)
	}

	// a bad column is refused and changes nothing
	if err := svc.SetTypeColumns("pods", []pipeline.Column{{Name: "X", Expr: "o."}}); err == nil {
		t.Fatal("want error")
	}
	if got := paneColumns(t, svc, a.Pane); !slices.Equal(got, want) {
		t.Fatalf("after a refused change = %v", got)
	}

	if err := svc.SetColumnWidths("pods", map[string]int{"NAME": 300}); err != nil {
		t.Fatal(err)
	}
	// next run
	got := config.OpenColumns(dir).Get("pods")
	if !slices.Equal(got.Columns, cols) || got.Widths["NAME"] != 300 {
		t.Fatalf("saved = %+v", got)
	}
	// back to the defaults
	if err := svc.SetTypeColumns("pods", nil); err != nil {
		t.Fatal(err)
	}
	if got := paneColumns(t, svc, b.Pane); !slices.Equal(got, []string{"NAME", "AGE"}) {
		t.Fatalf("reset = %v", got)
	}
}

// An events pane without a sort of its own starts by Last Seen, the latest
// first, and says so (the frontend takes it into the pane's spec); one with a
// sort keeps it, other kinds get none.
func TestDefaultSort(t *testing.T) {
	svc, _ := relSetup(t)
	stages := func(id string) []pipeline.Stage {
		pn, _ := svc.pane(id)
		pn.mu.Lock()
		defer pn.mu.Unlock()
		return pn.p.Stages
	}
	ev := openSynced(t, svc, "source: {resource: rel-events}\nstages: [{grep: web}]", 6)
	if ev.Sort != "LAST SEEN" {
		t.Fatalf("events sort = %q", ev.Sort)
	}
	if got := stages(ev.Pane); len(got) != 2 || got[0].Grep != "web" || !slices.Equal(got[1].Sort, []string{"LAST SEEN"}) {
		t.Fatalf("events stages = %+v", got)
	}
	own := openSynced(t, svc, "source: {resource: rel-events}\nstages: [{sort: [-REASON]}]", 6)
	if own.Sort != "" || len(stages(own.Pane)) != 1 {
		t.Fatalf("own sort: result %q, stages %+v", own.Sort, stages(own.Pane))
	}
	if pods := openSynced(t, svc, "source: {resource: rel-pods}", 6); pods.Sort != "" || len(stages(pods.Pane)) != 0 {
		t.Fatalf("pods: result %q, stages %+v", pods.Sort, stages(pods.Pane))
	}
}

// The metrics switch saves where the metric columns were with the columns,
// across a restart; a refused change keeps the old place.
func TestTypeMetricsPlace(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	svc := New(source.NewRegistry(stormOpener{n: 1}), &recorder{}, Options{Columns: config.OpenColumns(dir)})
	// an open pane compiles the columns (a bad one is refused)
	a, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(a.Pane)
	place := &config.MetricsPlace{After: "STATUS", Order: []string{"MEM", "CPU"}}
	if err := svc.SetTypeMetrics("pods", "usage", []pipeline.Column{{Name: "NAME"}}, place); err != nil {
		t.Fatal(err)
	}
	got := config.OpenColumns(dir).Get("pods")
	if got.Metrics == nil || got.Metrics.After != "STATUS" || !slices.Equal(got.Metrics.Order, place.Order) || !slices.Equal(got.Columns, []pipeline.Column{{Name: "NAME"}}) {
		t.Fatalf("saved = %+v", got)
	}
	if err := svc.SetTypeMetrics("pods", "usage", []pipeline.Column{{Name: "X", Expr: "o."}}, nil); err == nil {
		t.Fatal("want error")
	}
	if got := svc.ColumnConfigs()["pods"].Metrics; got == nil || got.After != "STATUS" {
		t.Fatalf("after a refused change = %+v", got)
	}
	// turned on: the place is used up; with the defaults nothing is left of the type
	if err := svc.SetTypeMetrics("pods", "usage", nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := config.OpenColumns(dir).All()["pods"]; ok {
		t.Fatalf("saved = %+v", config.OpenColumns(dir).All())
	}
}
