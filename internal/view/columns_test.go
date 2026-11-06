package view

import (
	"slices"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8stypes "k8s.io/apimachinery/pkg/types"

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
	it.Object.Object["status"].(map[string]any)["podIP"] = ip // the cell and the object change together, as from a server
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

// kubectl get events' table (First Seen is -o wide)
var eventDefs = []metav1.TableColumnDefinition{
	{Name: "Last Seen", Type: "string"},
	{Name: "Type", Type: "string"},
	{Name: "Reason", Type: "string"},
	{Name: "First Seen", Type: "string", Priority: 1},
}

func event(uid, name string, count int64, fields map[string]any) source.Item {
	obj := map[string]any{
		"apiVersion": "v1", "kind": "Event",
		"metadata": map[string]any{"name": name, "namespace": "ns", "uid": uid, "creationTimestamp": "2026-01-01T09:00:00Z"},
		"type":     "Normal", "reason": "Pulled", "count": count,
	}
	for k, v := range fields {
		obj[k] = v
	}
	u := &unstructured.Unstructured{Object: obj}
	u.SetUID(k8stypes.UID(uid))
	return source.Item{Object: u, Cells: []any{"5m", "Normal", "Pulled", "1h"}}
}

// An event's Last Seen and First Seen are timestamps from the object (as
// kubectl picks them), shown as ages: they tick, sort exactly, aren't changes.
func TestEventSeenColumns(t *testing.T) {
	v, err := New(pipeline.Pipeline{
		Source: pipeline.Source{Resource: "events"},
		Render: pipeline.Render{Columns: []pipeline.Column{{Name: "LAST SEEN"}, {Name: "FIRST SEEN"}, {Name: "REASON"}}},
	}, Options{Kind: "Event"})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: eventDefs, Items: []source.Item{
		event("a", "legacy", 3, map[string]any{"firstTimestamp": "2026-01-01T10:00:00Z", "lastTimestamp": "2026-01-01T11:58:10Z"}),
		event("b", "series", 9, map[string]any{"eventTime": "2026-01-01T10:30:00.123456Z", "series": map[string]any{"count": int64(9), "lastObservedTime": "2026-01-01T11:58:20.5Z"}}),
		event("c", "once", 1, map[string]any{"eventTime": "2026-01-01T11:00:00.000000Z"}),
		event("d", "v1beta", 2, map[string]any{"deprecatedFirstTimestamp": "2026-01-01T10:00:00Z", "deprecatedLastTimestamp": "2026-01-01T11:58:00Z"}),
		event("e", "none", 1, nil),
	}}, t0)
	for _, i := range []int{0, 1} {
		if c := v.cols[i]; c.info.Type != string(pipeline.TypeAge) || !c.timeDerived {
			t.Fatalf("%s: type %q, time-derived %v", c.info.Name, c.info.Type, c.timeDerived)
		}
	}
	for name, want := range map[string][]string{
		"a": {"2026-01-01T11:58:10Z", "2026-01-01T10:00:00Z", "Pulled"},
		"b": {"2026-01-01T11:58:20Z", "2026-01-01T10:30:00Z", "Pulled"},
		"c": {"2026-01-01T11:00:00Z", "2026-01-01T11:00:00Z", "Pulled"},
		"d": {"2026-01-01T11:58:00Z", "2026-01-01T10:00:00Z", "Pulled"},
		"e": {"", "", "Pulled"},
	} {
		if got := v.entries[name].cells; !slices.Equal(got, want) {
			t.Errorf("%s cells = %v, want %v", name, got, want)
		}
	}
	for sort, want := range map[string][]string{
		// the server's "2m" for all of a, b, d: their order is the exact time; none last either way
		"LAST SEEN":  {"series", "legacy", "v1beta", "once", "none"},
		"-LAST SEEN": {"once", "v1beta", "legacy", "series", "none"},
	} {
		if err := v.SetStages([]pipeline.Stage{{Sort: []string{sort}}}); err != nil {
			t.Fatal(err)
		}
		if got := names(v); !slices.Equal(got, want) {
			t.Errorf("sort %s = %v, want %v", sort, got, want)
		}
	}

	// seen again: Last Seen moves, but only the count is a change
	_, _ = v.Frame(t0)
	v.Apply(source.Event{Type: source.Modified, Item: event("a", "legacy", 4, map[string]any{"firstTimestamp": "2026-01-01T10:00:00Z", "lastTimestamp": "2026-01-01T11:59:00Z"})}, t0.Add(time.Second))
	e := v.entries["a"]
	if e.cells[0] != "2026-01-01T11:59:00Z" {
		t.Fatalf("last seen = %q", e.cells[0])
	}
	if !e.changedAt[0].IsZero() || !e.changedAt[1].IsZero() {
		t.Fatalf("seen columns marked changed: %v", e.changedAt)
	}
	if e.hiddenAt.IsZero() {
		t.Fatal("the count change isn't marked as a hidden change")
	}
}

// Another kind's Last Seen (a CRD printer column) stays the server's text.
func TestSeenColumnsOnlyForEvents(t *testing.T) {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "widgets"}}, Options{Kind: "Widget"})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: eventDefs, Items: []source.Item{event("a", "w", 1, nil)}}, t0)
	if c := v.cols[0]; c.info.Type != "" || c.stamp != nil || v.entries["a"].cells[0] != "5m" {
		t.Fatalf("LAST SEEN: type %q, cell %q", c.info.Type, v.entries["a"].cells[0])
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

func restartsPod(uid string, cell any, finished ...string) source.Item {
	var statuses []any
	for _, f := range finished {
		statuses = append(statuses, map[string]any{"name": "c", "lastState": map[string]any{"terminated": map[string]any{"finishedAt": f}}})
	}
	obj := map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": uid, "namespace": "ns"}, "status": map[string]any{"containerStatuses": statuses}}
	u := &unstructured.Unstructured{Object: obj}
	u.SetUID(k8stypes.UID(uid))
	return source.Item{Object: u, Cells: []any{uid, cell}}
}

// A pod's Restarts "3 (5m ago)" keeps the server's count, its "ago" becomes
// the newest restart's timestamp (rendered by the frontend: it ticks); sorted
// by the count; an update with the same restarts isn't a change.
func TestPodRestartsColumn(t *testing.T) {
	defs := []metav1.TableColumnDefinition{{Name: "Name", Type: "string"}, {Name: "Restarts", Type: "string"}}
	v, err := New(pipeline.Pipeline{
		Source: pipeline.Source{Resource: "pods"},
		Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME"}, {Name: "RESTARTS"}}},
	}, Options{Kind: "Pod"})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: defs, Items: []source.Item{
		restartsPod("ten", "10 (2m ago)", "2026-01-01T11:50:00Z", "2026-01-01T11:58:00.5Z"),
		restartsPod("three", "3 (1h ago)", "2026-01-01T11:00:00Z"),
		restartsPod("none", "0"),
		restartsPod("gone", "1 (5m ago)"), // no lastState left: the server's text
		restartsPod("int", int64(2)),      // an integer cell: the count
	}}, t0)
	if c := v.cols[1]; c.info.Type != string(pipeline.TypeRestarts) || c.timeDerived {
		t.Fatalf("RESTARTS: type %q, time-derived %v", c.info.Type, c.timeDerived)
	}
	for name, want := range map[string]string{"ten": "10 (2026-01-01T11:58:00Z)", "three": "3 (2026-01-01T11:00:00Z)", "none": "0", "gone": "1 (5m ago)", "int": "2"} {
		if got := v.entries[name].cells[1]; got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
	if err := v.SetStages([]pipeline.Stage{{Sort: []string{"-RESTARTS"}}}); err != nil {
		t.Fatal(err)
	}
	if got, want := names(v), []string{"ten", "three", "int", "gone", "none"}; !slices.Equal(got, want) {
		t.Errorf("sort -RESTARTS = %v, want %v", got, want)
	}

	// the server's "ago" moved on, the restart didn't: no change
	_, _ = v.Frame(t0)
	v.Apply(source.Event{Type: source.Modified, Item: restartsPod("three", "3 (61m ago)", "2026-01-01T11:00:00Z")}, t0.Add(time.Minute))
	if e := v.entries["three"]; !e.changedAt[1].IsZero() {
		t.Fatal("same restarts marked changed")
	}
	// restarted again: a change
	v.Apply(source.Event{Type: source.Modified, Item: restartsPod("three", "4 (1s ago)", "2026-01-01T12:01:00Z")}, t0.Add(2*time.Minute))
	if e := v.entries["three"]; e.cells[1] != "4 (2026-01-01T12:01:00Z)" || e.changedAt[1].IsZero() {
		t.Fatalf("restart: cell %q, changed %v", e.cells[1], e.changedAt[1])
	}
}

// Another kind's Restarts stays the server's text.
func TestRestartsColumnOnlyForPods(t *testing.T) {
	defs := []metav1.TableColumnDefinition{{Name: "Name", Type: "string"}, {Name: "Restarts", Type: "string"}}
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "widgets"}}, Options{Kind: "Widget"})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: defs, Items: []source.Item{restartsPod("a", "3 (1h ago)", "2026-01-01T11:00:00Z")}}, t0)
	if c := v.cols[1]; c.info.Type != "" || v.entries["a"].cells[1] != "3 (1h ago)" {
		t.Fatalf("RESTARTS: type %q, cell %q", c.info.Type, v.entries["a"].cells[1])
	}
}
