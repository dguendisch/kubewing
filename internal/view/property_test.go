package view

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"pgregory.net/rapid"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// model is a tiny fake cluster used to generate valid event sequences.
type model struct {
	objs map[string]map[string]any // uid → object
	next int
}

func podObj(uid, name string, restarts int64, label, heartbeat string) map[string]any {
	return map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{
			"name": name, "namespace": "ns", "uid": uid,
			"creationTimestamp": "2026-01-01T00:00:00Z",
			"resourceVersion":   fmt.Sprint(time.Now().UnixNano()),
			"labels":            map[string]any{"l": label},
		},
		"status": map[string]any{
			"containerStatuses": []any{map[string]any{"name": "c", "restartCount": restarts}},
			"conditions":        []any{map[string]any{"type": "Ready", "lastHeartbeatTime": heartbeat}},
		},
	}
}

func item(o map[string]any) source.Item {
	return source.Item{Object: &unstructured.Unstructured{Object: deepCopyMap(o)}}
}

func deepCopyMap(m map[string]any) map[string]any {
	return (&unstructured.Unstructured{Object: m}).DeepCopy().Object
}

// genEvents draws a random but valid event sequence.
func genEvents(t *rapid.T) []source.Event {
	m := &model{objs: map[string]map[string]any{}}
	names := []string{"a", "b", "c", "d"}
	var evs []source.Event
	n := rapid.IntRange(1, 40).Draw(t, "n")
	for i := 0; i < n; i++ {
		switch rapid.IntRange(0, 4).Draw(t, "op") {
		case 0: // add (possibly same name as an existing/deleted object → recreate)
			m.next++
			uid := fmt.Sprintf("u%d", m.next)
			o := podObj(uid, rapid.SampledFrom(names).Draw(t, "name"), rapid.Int64Range(0, 5).Draw(t, "r"), "x", "h0")
			m.objs[uid] = o
			evs = append(evs, source.Event{Type: source.Added, Item: item(o)})
		case 1, 2: // update visible, hidden or noise-only
			uid, ok := pick(t, m)
			if !ok {
				continue
			}
			o := deepCopyMap(m.objs[uid])
			md := o["metadata"].(map[string]any)
			st := o["status"].(map[string]any)
			switch rapid.IntRange(0, 2).Draw(t, "kind") {
			case 0:
				st["containerStatuses"].([]any)[0].(map[string]any)["restartCount"] = rapid.Int64Range(0, 5).Draw(t, "r")
			case 1:
				md["labels"] = map[string]any{"l": rapid.SampledFrom([]string{"x", "y"}).Draw(t, "label")}
			case 2:
				st["conditions"].([]any)[0].(map[string]any)["lastHeartbeatTime"] = rapid.String().Draw(t, "hb")
			}
			md["resourceVersion"] = fmt.Sprint(i)
			m.objs[uid] = o
			evs = append(evs, source.Event{Type: source.Modified, Item: item(o)})
		case 3: // delete
			uid, ok := pick(t, m)
			if !ok {
				continue
			}
			evs = append(evs, source.Event{Type: source.Deleted, Item: item(m.objs[uid])})
			delete(m.objs, uid)
		case 4: // relist of the current state
			var items []source.Item
			for _, o := range m.objs {
				items = append(items, item(o))
			}
			evs = append(evs, source.Event{Type: source.Relist, Items: items})
		}
	}
	return evs
}

func pick(t *rapid.T, m *model) (string, bool) {
	if len(m.objs) == 0 {
		return "", false
	}
	var uids []string
	for u := range m.objs {
		uids = append(uids, u)
	}
	slices.Sort(uids)
	return rapid.SampledFrom(uids).Draw(t, "uid"), true
}

var propCols = []pipeline.Column{
	{Name: "NAME", Path: "metadata.name"},
	{Name: "RESTARTS", Expr: "o.status.containerStatuses.map(c, c.restartCount).sum()", Type: pipeline.TypeNumber},
	{Name: "AGE", Path: "metadata.creationTimestamp", Type: pipeline.TypeAge},
}

func newPropView(t *rapid.T, sort []string) *View {
	p := pipeline.Pipeline{Source: pipeline.Source{Resource: "pods", Namespace: "ns"}, Render: pipeline.Render{Columns: propCols}}
	if sort != nil {
		p.Stages = []pipeline.Stage{{Sort: sort}}
	}
	v, err := New(p, Options{HighlightFor: time.Hour, TombstoneFor: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	v.SetViewport(0, 1000)
	return v
}

// markers returns key → rendered row (markers included) for all visible rows.
func markers(v *View, now time.Time) map[string]string {
	out := map[string]string{}
	for _, e := range v.rows() {
		out[e.key] = signature(v.rowData(e, now))
	}
	return out
}

func run(v *View, evs []source.Event, t0 time.Time) time.Time {
	now := t0
	v.Apply(source.Event{Type: source.Relist}, now)
	for _, ev := range evs {
		now = now.Add(time.Second)
		v.Apply(ev, now)
	}
	return now
}

// Sorting is presentation only: it must never affect diff markers.
func TestPropSortDoesNotAffectMarkers(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		evs := genEvents(t)
		a, b := newPropView(t, nil), newPropView(t, []string{"-RESTARTS", "NAME"})
		now := run(a, evs, t0)
		run(b, evs, t0)
		ma, mb := markers(a, now), markers(b, now)
		if fmt.Sprint(ma) != fmt.Sprint(mb) {
			t.Fatalf("markers differ by sort order:\n%v\n%v", ma, mb)
		}
	})
}

// A relist of unchanged state, or noise-only updates, produce no frame.
func TestPropNoopRelistProducesNoFrame(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		evs := genEvents(t)
		v := newPropView(t, nil)
		now := run(v, evs, t0)
		v.Frame(now)

		var items []source.Item
		for _, e := range v.entries {
			if e.deletedAt.IsZero() {
				o := deepCopyMap(e.item.Object.Object)
				o["metadata"].(map[string]any)["resourceVersion"] = "relisted"
				items = append(items, source.Item{Object: &unstructured.Unstructured{Object: o}})
			}
		}
		v.Apply(source.Event{Type: source.Relist, Items: items}, now)
		if f, ok := v.Frame(now); ok {
			t.Fatalf("no-op relist produced a frame: %+v", f)
		}
	})
}

// Rows shipped over the bridge stay within the requested window, and no row
// is sent twice without a change.
func TestPropFramesRespectViewport(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		evs := genEvents(t)
		v := newPropView(t, []string{"NAME"})
		now := t0
		v.Apply(source.Event{Type: source.Relist}, now)
		client := map[string]RowData{}
		for _, ev := range evs {
			now = now.Add(time.Second)
			v.Apply(ev, now)
			if rapid.Bool().Draw(t, "scroll") {
				v.SetViewport(rapid.IntRange(0, 5).Draw(t, "off"), rapid.IntRange(0, 3).Draw(t, "lim"))
			}
			f, ok := v.Frame(now)
			if !ok {
				continue
			}
			if len(f.Order) > v.limit {
				t.Fatalf("order exceeds limit: %d > %d", len(f.Order), v.limit)
			}
			inOrder := map[string]bool{}
			for _, k := range f.Order {
				inOrder[k] = true
			}
			for _, r := range f.Rows {
				if !inOrder[r.Key] {
					t.Fatalf("row %s sent outside window %v", r.Key, f.Order)
				}
				if prev, ok := client[r.Key]; ok && signature(prev) == signature(r) && f.Columns == nil {
					t.Fatalf("row %s resent unchanged", r.Key)
				}
				client[r.Key] = r
			}
			// client must be able to render every row in the window
			for k := range client {
				if !inOrder[k] {
					delete(client, k)
				}
			}
			for _, k := range f.Order {
				if _, ok := client[k]; !ok {
					t.Fatalf("window row %s missing on client", k)
				}
			}
		}
	})
}

// Deleting and re-adding the same name yields a tombstone plus a new row.
func TestRecreateIsRemovePlusAdd(t *testing.T) {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods", Namespace: "ns"}, Render: pipeline.Render{Columns: propCols}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{item(podObj("u1", "a", 0, "x", "h"))}}, t0)
	v.Apply(source.Event{Type: source.Deleted, Item: item(podObj("u1", "a", 0, "x", "h"))}, t0.Add(time.Second))
	v.Apply(source.Event{Type: source.Added, Item: item(podObj("u2", "a", 0, "x", "h"))}, t0.Add(time.Second))
	f, _ := v.Frame(t0.Add(time.Second))
	marks := map[string]Mark{}
	for _, r := range f.Rows {
		marks[r.Key] = r.Mark
	}
	if marks["u1"] != MarkDeleted || marks["u2"] != MarkAdded {
		t.Fatalf("got %v", marks)
	}
}

// Time-derived columns never count as a change.
func TestAgeTickIsNotADiff(t *testing.T) {
	cols := []pipeline.Column{{Name: "NAME", Path: "metadata.name"}, {Name: "AGE", Path: "metadata.creationTimestamp", Type: pipeline.TypeAge}}
	v, _ := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}, Render: pipeline.Render{Columns: cols}}, Options{})
	o := podObj("u1", "a", 0, "x", "h")
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{{Object: item(o).Object, Cells: []any{"a", "1m"}}}}, t0)
	v.Frame(t0)
	v.Apply(source.Event{Type: source.Modified, Item: source.Item{Object: item(o).Object, Cells: []any{"a", "2m"}}}, t0.Add(time.Minute))
	if f, ok := v.Frame(t0.Add(time.Minute)); ok {
		t.Fatalf("age tick produced frame: %+v", f)
	}
}
