package view

import (
	"slices"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// server table like kubectl get pods: IP is -o wide only
var podDefs = []metav1.TableColumnDefinition{
	{Name: "Name", Type: "string"},
	{Name: "Status", Type: "string"},
	{Name: "Age", Type: "date"},
	{Name: "IP", Type: "string", Priority: 1},
}

func widePod(uid, name, ip string) source.Item {
	it := stagePod(uid, name, "Running", "api", 0)
	it.Cells = []any{name, "Running", "2h", ip}
	return it
}

func colView(t *testing.T, cols ...pipeline.Column) *View {
	t.Helper()
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}, Render: pipeline.Render{Columns: cols}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{widePod("a", "api-0", "10.0.0.1")}}, t0)
	return v
}

func colNames(v *View) []string {
	var out []string
	for _, c := range v.cols {
		out = append(out, c.info.Name)
	}
	return out
}

func TestDefaultColumnsLeaveWideOut(t *testing.T) {
	v := colView(t)
	if got := colNames(v); !slices.Equal(got, []string{"NAME", "STATUS", "AGE"}) {
		t.Fatalf("columns = %v", got)
	}
}

func TestServerColumnRefs(t *testing.T) {
	// order as configured; a wide column by name; a custom one; an unknown one is left out
	v := colView(t, pipeline.Column{Name: "ip"}, pipeline.Column{Name: "NAME"}, pipeline.Column{Name: "IMAGE", Path: "spec.containers[0].image"}, pipeline.Column{Name: "GONE"})
	if got := colNames(v); !slices.Equal(got, []string{"IP", "NAME", "IMAGE"}) {
		t.Fatalf("columns = %v", got)
	}
	if got := v.entries["a"].cells; !slices.Equal(got, []string{"10.0.0.1", "api-0", "img"}) {
		t.Fatalf("cells = %v", got)
	}
	ch := v.ColumnChoices()
	if !slices.Equal(ch.Defaults, []string{"NAME", "STATUS", "AGE"}) {
		t.Fatalf("defaults = %v", ch.Defaults)
	}
	opts := ch.Options
	want := []ColumnOption{
		{Name: "IP", Priority: 1, Shown: true},
		{Name: "NAME", Shown: true},
		{Name: "IMAGE", Shown: true, Path: "spec.containers[0].image"},
		{Name: "GONE", Shown: true, Missing: true},
		{Name: "STATUS"},
		{Name: "AGE", Type: "age"},
	}
	if !slices.Equal(opts, want) {
		t.Fatalf("options =\n%+v\nwant\n%+v", opts, want)
	}
}

func TestServerColumnRefsWaitForTheTable(t *testing.T) {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}, Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME"}, {Name: "IP"}}}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := colNames(v); !slices.Equal(got, []string{"NAME"}) {
		t.Fatalf("before the relist: %v", got)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{widePod("a", "api-0", "10.0.0.1")}}, t0)
	if got := colNames(v); !slices.Equal(got, []string{"NAME", "IP"}) {
		t.Fatalf("after the relist: %v", got)
	}
}

func TestSetRenderKeepsDiffState(t *testing.T) {
	v := colView(t)
	v.Apply(source.Event{Type: source.Modified, Item: widePod("a", "api-0", "10.0.0.2")}, t0.Add(time.Second))
	if !v.HasPrev("a") {
		t.Fatal("no prev after update")
	}
	if err := v.SetRender(pipeline.Render{Columns: []pipeline.Column{{Name: "NAME"}, {Name: "IP"}}}); err != nil {
		t.Fatal(err)
	}
	if got := v.entries["a"].cells; !slices.Equal(got, []string{"api-0", "10.0.0.2"}) {
		t.Fatalf("cells = %v", got)
	}
	if !v.HasPrev("a") {
		t.Fatal("SetRender dropped the previous version")
	}
	if f, _ := v.Frame(t0.Add(2 * time.Second)); len(f.Columns) != 2 {
		t.Fatalf("frame columns = %+v", f.Columns)
	}
	// a bad column leaves the view as it was
	for _, bad := range []pipeline.Column{{Name: "X", Expr: "o.metadata."}, {Name: "NAME", Path: "metadata.name"}} {
		if err := v.SetRender(pipeline.Render{Columns: []pipeline.Column{{Name: "NAME"}, bad}}); err == nil {
			t.Fatalf("want error for %+v", bad)
		}
	}
	if got := colNames(v); !slices.Equal(got, []string{"NAME", "IP"}) {
		t.Fatalf("columns after failed SetRender = %v", got)
	}
	// back to the defaults
	if err := v.SetRender(pipeline.Render{}); err != nil {
		t.Fatal(err)
	}
	if got := colNames(v); !slices.Equal(got, []string{"NAME", "STATUS", "AGE"}) {
		t.Fatalf("columns = %v", got)
	}
}

func TestSortAgeReadsAsShown(t *testing.T) {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	old, young := widePod("o", "old", ""), widePod("y", "young", "")
	old.Object.SetCreationTimestamp(metav1.NewTime(t0.Add(-2 * time.Hour)))
	young.Object.SetCreationTimestamp(metav1.NewTime(t0.Add(-time.Minute)))
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{old, young}}, t0)
	for _, c := range []struct {
		sort string
		want []string
	}{{"AGE", []string{"young", "old"}}, {"-AGE", []string{"old", "young"}}} {
		if err := v.SetStages([]pipeline.Stage{{Sort: []string{c.sort}}}); err != nil {
			t.Fatal(err)
		}
		if got := names(v); !slices.Equal(got, c.want) {
			t.Errorf("sort %s = %v, want %v", c.sort, got, c.want)
		}
	}
}

// as a real apiserver sends it: Age and Last Seen are strings, already formatted ("5m", "3d")
var serverAgeDefs = []metav1.TableColumnDefinition{
	{Name: "Name", Type: "string"},
	{Name: "Last Seen", Type: "string"},
	{Name: "Age", Type: "string"},
}

func TestServerAgeAndDurationColumns(t *testing.T) {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "events"}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	mk := func(uid, name, seen, age string, created time.Time) source.Item {
		it := stagePod(uid, name, "Running", "x", 0)
		it.Object.SetCreationTimestamp(metav1.NewTime(created))
		it.Cells = []any{name, seen, age}
		return it
	}
	// "5m" < "3d" as text, but 3 days is older
	v.Apply(source.Event{Type: source.Relist, Columns: serverAgeDefs, Items: []source.Item{
		mk("a", "days", "2d3h", "3d", t0.Add(-72*time.Hour)),
		mk("b", "minutes", "5m", "5m", t0.Add(-5*time.Minute)),
		mk("c", "unknown", "<unknown>", "10s", t0.Add(-10*time.Second)),
	}}, t0)
	if got := v.cols[2].info.Type; got != string(pipeline.TypeAge) {
		t.Fatalf("AGE type = %q: rendered by the frontend from the creation timestamp", got)
	}
	for _, c := range []struct {
		sort string
		want []string
	}{
		{"AGE", []string{"unknown", "minutes", "days"}},
		{"-AGE", []string{"days", "minutes", "unknown"}},
		// a duration as text: by its length of time; one that isn't (<unknown>) last either way
		{"LAST SEEN", []string{"minutes", "days", "unknown"}},
		{"-LAST SEEN", []string{"days", "minutes", "unknown"}},
	} {
		if err := v.SetStages([]pipeline.Stage{{Sort: []string{c.sort}}}); err != nil {
			t.Fatal(err)
		}
		if got := names(v); !slices.Equal(got, c.want) {
			t.Errorf("sort %s = %v, want %v", c.sort, got, c.want)
		}
	}
}

func TestHumanDuration(t *testing.T) {
	for in, want := range map[string]float64{"10s": 10, "5m": 300, "2d3h": 2*86400 + 3*3600, "3y45d": 3*365*86400 + 45*86400, "0s": 0} {
		if got, ok := humanDuration(in); !ok || got != want {
			t.Errorf("humanDuration(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	// not durations: text columns stay text
	for _, in := range []string{"", "<unknown>", "5", "m5", "5x", "Running", "1/1", "10.0.0.1", "5m3", "-5m", "5 m"} {
		if _, ok := humanDuration(in); ok {
			t.Errorf("humanDuration(%q) parsed", in)
		}
	}
}
