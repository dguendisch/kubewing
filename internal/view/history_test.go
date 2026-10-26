package view

import (
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/history"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// recorder stands in for a recording watch (source.History): items fed
// through it come normalized, as from the registry.
type recorder struct {
	*history.Store
	on bool
}

func (r *recorder) Recording() bool { return r.on }

func (r *recorder) item(it source.Item, at time.Time) source.Item {
	if !r.on {
		return it
	}
	it.Norm = it.Object.DeepCopy()
	r.RecordHashed(key(it), it.Norm, "", at)
	return it
}

func recView(t *testing.T, on bool) (*View, *recorder) {
	t.Helper()
	r := &recorder{Store: history.New(0), on: on}
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}}, Options{History: r})
	if err != nil {
		t.Fatal(err)
	}
	return v, r
}

func restart(v *View, r *recorder, n int64) {
	at := t0.Add(time.Duration(n) * time.Second)
	v.Apply(source.Event{Type: source.Modified, Item: r.item(stagePod("b", "api-1", "Running", "api", n), at)}, at)
}

// Not recording (the default): the diff is the previous version against
// the current one, no versions to step through.
func TestNotRecordingKeepsPrev(t *testing.T) {
	v, r := recView(t, false)
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{stagePod("b", "api-1", "Running", "api", 0)}}, t0)
	for n := int64(1); n <= 2; n++ {
		restart(v, r, n)
	}
	d, _ := v.ObjectAt("b", 1)
	if d.Diff != nil || !strings.Contains(d.PrevNorm, "restartCount: 1") || !strings.Contains(d.CurNorm, "restartCount: 2") || !v.HasPrev("b") {
		t.Fatalf("%+v\n%s\n---\n%s", d.Diff, d.PrevNorm, d.CurNorm)
	}
	if f, _ := v.Frame(t0.Add(3 * time.Second)); f.Status == nil || f.Status.Recording {
		t.Fatalf("status = %+v", f.Status)
	}
}

// Recording: the detail diff steps back through the versions; each diffs
// against the one before.
func TestObjectAtSteps(t *testing.T) {
	v, r := recView(t, true)
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{r.item(stagePod("b", "api-1", "Pending", "api", 0), t0)}}, t0)
	for n := int64(1); n <= 3; n++ { // versions 2 … 4
		restart(v, r, n)
	}
	d, _ := v.Object("b")
	if d.Diff == nil || d.Diff.From != 3 || d.Diff.To != 4 || d.Diff.First != 1 || d.Diff.Last != 4 {
		t.Fatalf("newest: %+v", d.Diff)
	}
	if !strings.Contains(d.PrevNorm, "restartCount: 2") || !strings.Contains(d.CurNorm, "restartCount: 3") {
		t.Fatalf("newest diff:\n%s\n---\n%s", d.PrevNorm, d.CurNorm)
	}
	if want := "status.containerStatuses[name=c].restartCount: 2 → 3"; len(d.Diff.Changes) != 1 || d.Diff.Changes[0] != want {
		t.Fatalf("changes = %v", d.Diff.Changes)
	}
	if d.Diff.ToAt != t0.Add(3*time.Second).Format(time.RFC3339) {
		t.Fatalf("toAt = %s", d.Diff.ToAt)
	}
	d, _ = v.ObjectAt("b", 2)
	if d.Diff.From != 1 || d.Diff.To != 2 || !strings.Contains(d.PrevNorm, "phase: Pending") || !strings.Contains(d.CurNorm, "restartCount: 1") {
		t.Fatalf("version 2: %+v\n%s\n---\n%s", d.Diff, d.PrevNorm, d.CurNorm)
	}
	// the oldest has nothing before it; out of range clamps
	if d, _ = v.ObjectAt("b", -5); d.Diff.To != 4 {
		t.Fatalf("≤ 0 = newest: %+v", d.Diff)
	}
	d, _ = v.ObjectAt("b", 1)
	if d.Diff.From != 0 || d.Diff.To != 1 || d.PrevNorm != "" || d.Diff.FromAt != "" || !strings.Contains(d.CurNorm, "phase: Pending") {
		t.Fatalf("oldest: %+v", d.Diff)
	}
	if d, _ = v.ObjectAt("b", 99); d.Diff.To != 4 {
		t.Fatalf("past the newest: %+v", d.Diff)
	}
	// the YAML is always the current object
	if d, _ = v.ObjectAt("b", 1); !strings.Contains(d.YAML, "restartCount: 3") {
		t.Fatalf("yaml:\n%s", d.YAML)
	}
	if f, _ := v.Frame(t0.Add(4 * time.Second)); f.Status == nil || !f.Status.Recording {
		t.Fatalf("status = %+v", f.Status)
	}
}

// Recording switched on mid-session: rows not changed since keep their
// previous-version diff until their next change comes through the history.
func TestRecordingStartsLater(t *testing.T) {
	v, r := recView(t, false)
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{stagePod("b", "api-1", "Running", "api", 0)}}, t0)
	restart(v, r, 1)
	r.on = true
	r.RecordHashed("b", stagePod("b", "api-1", "Running", "api", 1).Object, "", t0.Add(time.Second)) // the seed
	if d, _ := v.Object("b"); d.Diff != nil || !strings.Contains(d.PrevNorm, "restartCount: 0") {
		t.Fatalf("before the next change: %+v\n%s", d.Diff, d.PrevNorm)
	}
	restart(v, r, 2)
	if d, _ := v.Object("b"); d.Diff == nil || d.Diff.From != 1 || d.Diff.To != 2 || !strings.Contains(d.PrevNorm, "restartCount: 1") {
		t.Fatalf("after: %+v\n%s", d.Diff, d.PrevNorm)
	}
}

// Views on one source read one history (splits): a view that joins late
// still steps back to versions from before it existed.
func TestSharedHistory(t *testing.T) {
	r := &recorder{Store: history.New(0), on: true}
	first := r.item(stagePod("b", "api-1", "Running", "api", 0), t0)
	v1, _ := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}}, Options{History: r})
	v1.Apply(source.Event{Type: source.Relist, Items: []source.Item{first}}, t0)
	upd := r.item(stagePod("b", "api-1", "Running", "api", 1), t0.Add(time.Second))
	v1.Apply(source.Event{Type: source.Modified, Item: upd}, t0.Add(time.Second))

	v2, _ := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}}, Options{History: r})
	v2.Apply(source.Event{Type: source.Relist, Items: []source.Item{upd}}, t0.Add(2*time.Second))
	for _, v := range []*View{v1, v2} {
		d, _ := v.Object("b")
		if d.Diff == nil || d.Diff.From != 1 || d.Diff.To != 2 || !strings.Contains(d.PrevNorm, "restartCount: 0") {
			t.Fatalf("%+v\n%s", d.Diff, d.PrevNorm)
		}
	}
	// a version recorded but still queued for the view: the diff reads the
	// history's newest, the YAML stays the row's
	r.item(stagePod("b", "api-1", "Running", "api", 2), t0.Add(3*time.Second))
	if d, _ := v1.Object("b"); d.Diff.To != 3 || !strings.Contains(d.CurNorm, "restartCount: 2") || !strings.Contains(d.YAML, "restartCount: 1") {
		t.Fatalf("%+v\n%s", d.Diff, d.YAML)
	}
}
