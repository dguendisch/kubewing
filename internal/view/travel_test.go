package view

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/history"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// travelView: pods a (0 restarts), b (Pending) at t0; a restarts at +1s,
// b goes Running at +2s, c is added at +3s, a is deleted at +4s.
func travelView(t *testing.T, stages ...pipeline.Stage) (*View, *recorder) {
	t.Helper()
	r := &recorder{Store: history.New(history.Limits{}), on: true}
	v, err := New(pipeline.Pipeline{
		Source: pipeline.Source{Resource: "pods"},
		Stages: stages,
		Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME", Path: "metadata.name"}, {Name: "PHASE", Path: "status.phase"}, {Name: "RESTARTS", Path: "status.containerStatuses[0].restartCount"}}},
	}, Options{History: r})
	if err != nil {
		t.Fatal(err)
	}
	apply := func(typ source.EventType, it source.Item, at time.Duration) {
		now := t0.Add(at)
		if typ == source.Deleted {
			r.Delete(key(it), now)
		} else {
			it = r.item(it, now)
		}
		v.Apply(source.Event{Type: typ, Item: it}, now)
	}
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{
		r.item(stagePod("a", "api-0", "Running", "api", 0), t0),
		r.item(stagePod("b", "api-1", "Pending", "api", 0), t0),
	}}, t0)
	apply(source.Modified, stagePod("a", "api-0", "Running", "api", 1), time.Second)
	apply(source.Modified, stagePod("b", "api-1", "Running", "api", 0), 2*time.Second)
	apply(source.Added, stagePod("c", "etcd-0", "Running", "etcd", 0), 3*time.Second)
	apply(source.Deleted, stagePod("a", "api-0", "Running", "api", 1), 4*time.Second)
	return v, r
}

func cells(v *View) map[string][]string {
	out := map[string][]string{}
	for _, e := range v.rows() {
		out[e.key] = e.cells
	}
	return out
}

func frameAt(t *testing.T, v *View) Frame {
	t.Helper()
	v.Resync()
	f, ok := v.Frame(t0.Add(time.Hour))
	if !ok {
		t.Fatal("no frame")
	}
	return f
}

func row(f Frame, k string) (RowData, bool) {
	for _, r := range f.Rows {
		if r.Key == k {
			return r, true
		}
	}
	return RowData{}, false
}

// The table as it was: objects not there yet left out, deleted ones back,
// every cell from the version then.
func TestTravelShowsThePast(t *testing.T) {
	v, _ := travelView(t)
	if err := v.SetTime(t0.Add(1500 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	got := cells(v)
	if len(got) != 2 || !slices.Equal(got["a"], []string{"api-0", "Running", "1"}) || !slices.Equal(got["b"], []string{"api-1", "Pending", "0"}) {
		t.Fatalf("at +1.5s: %v", got)
	}
	f := frameAt(t, v)
	if f.Status == nil || f.Status.At != rfc(t0.Add(1500*time.Millisecond)) || f.Status.Objects != 2 {
		t.Fatalf("status = %+v", f.Status)
	}
	if err := v.SetTime(t0.Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := cells(v); len(got) != 3 || got["c"] == nil {
		t.Fatalf("at +3s: %v", got)
	}
	// before the horizon: the starting state
	_ = v.SetTime(t0.Add(-time.Hour))
	if got := cells(v); len(got) != 2 || got["a"][2] != "0" || !v.At().Equal(t0) {
		t.Fatalf("before the start: %v at %v", got, v.At())
	}
}

// Markers are the step's: moving to a moment marks what changed since the
// one shown before, and they stay until the next step.
func TestTravelMarksTheStep(t *testing.T) {
	v, _ := travelView(t)
	_ = v.SetTime(t0.Add(1500 * time.Millisecond))
	_ = v.SetTime(t0.Add(2 * time.Second)) // b: Pending → Running
	f := frameAt(t, v)
	if r, _ := row(f, "b"); !slices.Equal(r.Changed, []int{1}) {
		t.Fatalf("b = %+v", r)
	}
	if r, _ := row(f, "a"); len(r.Changed) != 0 || r.Mark != MarkNone {
		t.Fatalf("a unchanged in the step: %+v", r)
	}
	_ = v.SetTime(t0.Add(4 * time.Second)) // c added, a deleted
	f = frameAt(t, v)
	if r, _ := row(f, "c"); r.Mark != MarkAdded {
		t.Fatalf("c = %+v", r)
	}
	if r, ok := row(f, "a"); !ok || r.Mark != MarkDeleted {
		t.Fatalf("a = %+v (%v)", r, ok)
	}
	// still marked a while later (the frame's clock doesn't expire them)
	if r, _ := row(frameAt(t, v), "c"); r.Mark != MarkAdded {
		t.Fatal("step markers expired")
	}
}

// Step goes from change to change of the pane's rows; from live, back goes
// to the newest change, and before the first one to the starting state.
func TestTravelStep(t *testing.T) {
	v, _ := travelView(t)
	var at []time.Duration
	for {
		ok, err := v.Step(-1)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			break
		}
		at = append(at, v.At().Sub(t0))
	}
	if want := []time.Duration{4 * time.Second, 3 * time.Second, 2 * time.Second, time.Second, 0}; !slices.Equal(at, want) {
		t.Fatalf("back: %v", at)
	}
	if ok, _ := v.Step(1); !ok || v.At() != t0.Add(time.Second) {
		t.Fatalf("forward: %v", v.At())
	}
	if ok, _ := (func() (bool, error) { _ = v.SetTime(t0.Add(4 * time.Second)); return v.Step(1) })(); ok {
		t.Fatal("past the newest change")
	}
}

// A pane's timeline only ticks for the rows it shows: c (etcd) is filtered out.
func TestTimelineFollowsTheFilter(t *testing.T) {
	v, _ := travelView(t, pipeline.Stage{Filter: `o.metadata.labels.app == "api"`})
	tl, err := v.Timeline()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{rfc(t0.Add(time.Second)), rfc(t0.Add(2 * time.Second)), rfc(t0.Add(4 * time.Second))}
	if !slices.Equal(tl.Changes, want) || tl.Horizon != rfc(t0) || tl.Newest != rfc(t0.Add(4*time.Second)) || tl.At != "" {
		t.Fatalf("%+v", tl)
	}
	// in the past the filter applies to the objects then
	_ = v.SetTime(t0.Add(3 * time.Second))
	if got := cells(v); len(got) != 2 || got["c"] != nil {
		t.Fatalf("filtered past: %v", got)
	}
}

// Live events keep updating behind the past (counted); back to live shows
// them at once, with what the filter bar changed meanwhile.
func TestTravelBackToLive(t *testing.T) {
	v, r := travelView(t)
	_ = v.SetTime(t0.Add(time.Second))
	upd := r.item(stagePod("b", "api-1", "Failed", "api", 3), t0.Add(5*time.Second))
	v.Apply(source.Event{Type: source.Modified, Item: upd}, t0.Add(5*time.Second))
	if got := cells(v); got["b"][1] != "Pending" {
		t.Fatalf("the past moved: %v", got)
	}
	if f := frameAt(t, v); f.Status.Behind != 1 {
		t.Fatalf("behind = %+v", f.Status)
	}
	if err := v.SetStages([]pipeline.Stage{{Filter: `o.status.phase != "Running"`}}); err != nil {
		t.Fatal(err)
	}
	if got := cells(v); len(got) != 1 || got["b"] == nil { // b was Pending then
		t.Fatalf("past filtered: %v", got)
	}
	_ = v.SetTime(time.Time{})
	got := cells(v)
	if len(got) != 1 || !slices.Equal(got["b"], []string{"api-1", "Failed", "3"}) || !v.At().IsZero() {
		t.Fatalf("live: %v", got)
	}
	if f := frameAt(t, v); f.Status.At != "" || f.Status.Behind != 0 {
		t.Fatalf("status = %+v", f.Status)
	}
}

// The detail view in the past shows the version then.
func TestTravelDetail(t *testing.T) {
	v, _ := travelView(t)
	_ = v.SetTime(t0.Add(1500 * time.Millisecond))
	d, ok := v.Object("b")
	if !ok || !strings.Contains(d.YAML, "phase: Pending") || !strings.Contains(d.CurNorm, "phase: Pending") {
		t.Fatalf("%v\n%s", ok, d.YAML)
	}
}

// Without recording there's no past.
func TestTravelNeedsHistory(t *testing.T) {
	v := stageView(t)
	if err := v.SetTime(t0); err != ErrNoHistory {
		t.Fatalf("err = %v", err)
	}
	if _, err := v.Timeline(); err != ErrNoHistory {
		t.Fatalf("timeline err = %v", err)
	}
}

// When did this field flip: a field on a line of the YAML, over time.
func TestFieldAt(t *testing.T) {
	v, _ := travelView(t)
	d, _ := v.Object("b")
	line := -1
	for i, l := range strings.Split(d.CurNorm, "\n") {
		if strings.TrimSpace(l) == "phase: Running" {
			line = i
		}
	}
	fh, err := v.FieldAt("b", 0, line, "norm")
	if err != nil {
		t.Fatal(err)
	}
	if fh.Path != "status.phase" || len(fh.Changes) != 2 || fh.Changes[0].Value != "Pending" || fh.Changes[1].Value != "Running" || fh.Changes[1].At != rfc(t0.Add(2*time.Second)) {
		t.Fatalf("%+v", fh)
	}
}

// Backward, a row not there yet just goes; one back (deleted later) is
// marked deleted but counted, it's there at that moment.
func TestTravelBackwardMarks(t *testing.T) {
	v, _ := travelView(t)
	_ = v.SetTime(t0.Add(5 * time.Second)) // a gone, c there
	_ = v.SetTime(t0.Add(2 * time.Second)) // a back, c not yet
	f := frameAt(t, v)
	if _, ok := row(f, "c"); ok {
		t.Fatal("c shown before it existed")
	}
	if r, _ := row(f, "a"); r.Mark != MarkDeleted {
		t.Fatalf("a = %+v", r)
	}
	if f.Status.Objects != 2 {
		t.Fatalf("objects = %d", f.Status.Objects)
	}
	if d, _ := v.Object("a"); d.Deleted {
		t.Fatal("a reported deleted while it exists then")
	}
}

// Several steps at once (quick presses, merged): one move, the markers for
// the whole jump; clamped at the ends.
func TestTravelMultiStep(t *testing.T) {
	v, _ := travelView(t)
	if ok, _ := v.Step(-3); !ok || !v.At().Equal(t0.Add(2*time.Second)) {
		t.Fatalf("3 back from live: %v", v.At())
	}
	if ok, _ := v.Step(-9); !ok || !v.At().Equal(t0) {
		t.Fatalf("clamped at the start: %v", v.At())
	}
	if ok, _ := v.Step(-1); ok {
		t.Fatal("before the start")
	}
	if ok, _ := v.Step(2); !ok || !v.At().Equal(t0.Add(2*time.Second)) {
		t.Fatalf("2 forward: %v", v.At())
	}
	// the jump's markers: a restarted (+1s) and b Running (+2s) both marked
	f := frameAt(t, v)
	ra, _ := row(f, "a")
	rb, _ := row(f, "b")
	if len(ra.Changed) == 0 || len(rb.Changed) == 0 {
		t.Fatalf("a %+v b %+v", ra, rb)
	}
	if ok, _ := v.Step(9); !ok || !v.At().Equal(t0.Add(4*time.Second)) {
		t.Fatalf("clamped at the newest: %v", v.At())
	}
	if ok, _ := v.Step(1); ok {
		t.Fatal("past the newest")
	}
}

// Between changes (entering sets the moment to now, after the newest), back
// goes to the change before the moment, forward to the one after.
func TestTravelStepBetween(t *testing.T) {
	v, _ := travelView(t)
	_ = v.SetTime(t0.Add(10 * time.Second)) // after the newest change (+4s)
	if ok, _ := v.Step(-1); !ok || !v.At().Equal(t0.Add(4*time.Second)) {
		t.Fatalf("back from after the newest: %v", v.At())
	}
	_ = v.SetTime(t0.Add(2500 * time.Millisecond)) // between +2s and +3s
	if ok, _ := v.Step(-1); !ok || !v.At().Equal(t0.Add(2*time.Second)) {
		t.Fatalf("back from between: %v", v.At())
	}
	_ = v.SetTime(t0.Add(2500 * time.Millisecond))
	if ok, _ := v.Step(1); !ok || !v.At().Equal(t0.Add(3*time.Second)) {
		t.Fatalf("forward from between: %v", v.At())
	}
}
