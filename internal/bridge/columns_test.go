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
