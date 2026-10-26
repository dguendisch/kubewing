package history

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/fieldpath"
)

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func pod(restarts int64, image string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"kind":     "Pod",
		"metadata": map[string]any{"name": "p", "uid": "u"},
		"spec":     map[string]any{"containers": []any{map[string]any{"name": "app", "image": image}}},
		"status":   map[string]any{"containerStatuses": []any{map[string]any{"name": "app", "restartCount": restarts}}},
	}}
}

func TestRecordAndGet(t *testing.T) {
	s := New(Limits{})
	want := []*unstructured.Unstructured{pod(0, "a:1"), pod(1, "a:1"), pod(1, "a:2"), pod(2, "a:2")}
	for i, o := range want {
		if n := s.Record("u", o, t0.Add(time.Duration(i)*time.Second)); n != i+1 {
			t.Fatalf("version %d recorded as %d", i+1, n)
		}
	}
	if first, last := s.Range("u"); first != 1 || last != 4 {
		t.Fatalf("range = %d..%d", first, last)
	}
	for i, o := range want {
		v, ok := s.Get("u", i+1)
		if !ok || !reflect.DeepEqual(v.Object.Object, o.Object) || !v.At.Equal(t0.Add(time.Duration(i)*time.Second)) {
			t.Fatalf("version %d: ok=%v %v at %v", i+1, ok, v.Object, v.At)
		}
		if (i == 0) != (v.Changes == nil) {
			t.Fatalf("version %d: changes %v", i+1, v.Changes)
		}
	}
	v, _ := s.Get("u", 3)
	if len(v.Changes) != 1 || v.Changes[0].String() != `spec.containers[name=app].image: "a:1" → "a:2"` {
		t.Fatalf("changes of version 3: %v", v.Changes)
	}
	// a copy: changing it leaves the history alone
	v.Object.Object["spec"] = nil
	if again, _ := s.Get("u", 3); again.Object.Object["spec"] == nil {
		t.Fatal("Get returned the stored object")
	}
	if _, ok := s.Get("u", 5); ok {
		t.Fatal("version past the newest")
	}
	if _, ok := s.Get("other", 1); ok {
		t.Fatal("unknown key")
	}
}

// An unchanged object (resync, relist) isn't a new version.
func TestRecordUnchanged(t *testing.T) {
	s := New(Limits{})
	s.Record("u", pod(0, "a:1"), t0)
	if n := s.Record("u", pod(0, "a:1"), t0.Add(time.Second)); n != 1 {
		t.Fatalf("no-op recorded as version %d", n)
	}
}

// Past the budget the oldest changes go first, across all objects, down
// to 90% of it; the horizon moves to the newest dropped one.
func TestBudget(t *testing.T) {
	// the four newest copies (~250 bytes each) count too: room for a few changes on top
	s := New(Limits{Budget: 3000})
	for i := range 40 {
		key := fmt.Sprint("k", i%4)
		s.Record(key, pod(int64(i), "a:1"), t0.Add(time.Duration(i)*time.Second))
	}
	if s.Bytes() > 3000 {
		t.Fatalf("bytes = %d over budget", s.Bytes())
	}
	h := s.Span().Horizon
	if !h.After(t0) {
		t.Fatal("horizon didn't move")
	}
	// every object is complete from the horizon on: each one's oldest kept
	// version is at or before it, or the object was born after
	for k := range 4 {
		key := fmt.Sprint("k", k)
		first, last := s.Range(key)
		v, _ := s.Get(key, first)
		if v.At.After(h) || last <= first {
			t.Fatalf("%s: oldest kept %v after horizon %v (range %d..%d)", key, v.At, h, first, last)
		}
	}
	// the newest version is always there
	if v, ok := s.Get("k3", 10); !ok || !reflect.DeepEqual(v.Object.Object, pod(39, "a:1").Object) {
		t.Fatalf("newest: %v", v.Object)
	}
}

// The table as of a moment: each object's version then, objects not born
// yet or deleted already left out.
func TestAt(t *testing.T) {
	s := New(Limits{})
	s.Record("a", pod(0, "a:1"), t0)
	s.Record("a", pod(1, "a:1"), t0.Add(2*time.Second))
	s.Record("b", pod(0, "b:1"), t0.Add(time.Second))
	s.Delete("b", t0.Add(3*time.Second))
	for _, tc := range []struct {
		at   time.Duration
		want map[string]int64
	}{
		{0, map[string]int64{"a": 0}},
		{time.Second, map[string]int64{"a": 0, "b": 0}},
		{2 * time.Second, map[string]int64{"a": 1, "b": 0}},
		{3 * time.Second, map[string]int64{"a": 1}},
		{-time.Hour, map[string]int64{"a": 0}}, // before the horizon: answered for it
	} {
		got := map[string]int64{}
		for k, v := range s.At(t0.Add(tc.at)) {
			got[k] = v.Object.Object["status"].(map[string]any)["containerStatuses"].([]any)[0].(map[string]any)["restartCount"].(int64)
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("at +%v: %v, want %v", tc.at, got, tc.want)
		}
	}
	if sp := s.Span(); !sp.Horizon.Equal(t0) || !sp.Newest.Equal(t0.Add(3*time.Second)) {
		t.Fatalf("span = %+v", sp)
	}
}

// The moments something changed: not the starting state, adds and deletes
// included, limited to some keys on request.
func TestChanges(t *testing.T) {
	s := New(Limits{})
	s.Record("a", pod(0, "a:1"), t0)
	s.Record("b", pod(0, "b:1"), t0)
	s.Record("a", pod(1, "a:1"), t0.Add(2*time.Second))
	s.Record("c", pod(0, "c:1"), t0.Add(3*time.Second))
	s.Delete("b", t0.Add(4*time.Second))
	s.Record("a", pod(2, "a:1"), t0.Add(4*time.Second))
	all := s.Changes(t0, t0.Add(time.Hour), nil)
	want := []time.Time{t0.Add(2 * time.Second), t0.Add(3 * time.Second), t0.Add(4 * time.Second)}
	if !reflect.DeepEqual(all, want) {
		t.Fatalf("changes = %v", all)
	}
	if got := s.Changes(t0, t0.Add(time.Hour), func(k string) bool { return k == "c" }); len(got) != 1 || !got[0].Equal(t0.Add(3*time.Second)) {
		t.Fatalf("only c: %v", got)
	}
	if got := s.Changes(t0.Add(3*time.Second), t0.Add(3*time.Second), nil); len(got) != 1 {
		t.Fatalf("one moment: %v", got)
	}
}

// Server cells are kept with each version; cells alone changing (a server
// column computed from something normalized away) is a new version.
func TestCells(t *testing.T) {
	s := New(Limits{})
	s.RecordItem("a", pod(0, "a:1"), "h", []any{"a", "0"}, t0)
	if n := s.RecordItem("a", pod(0, "a:1"), "h", []any{"a", "0"}, t0.Add(time.Second)); n != 1 {
		t.Fatalf("unchanged recorded as %d", n)
	}
	if n := s.RecordItem("a", pod(0, "a:1"), "h", []any{"a", "1"}, t0.Add(2*time.Second)); n != 2 {
		t.Fatalf("cells change recorded as %d", n)
	}
	v, _ := s.Get("a", 1)
	if !reflect.DeepEqual(v.Cells, []any{"a", "0"}) {
		t.Fatalf("cells of 1: %v", v.Cells)
	}
	p, _ := s.Pair("a", 0)
	if !reflect.DeepEqual(p.Prev.Cells, []any{"a", "0"}) || !reflect.DeepEqual(p.Cur.Cells, []any{"a", "1"}) {
		t.Fatalf("pair cells: %v / %v", p.Prev.Cells, p.Cur.Cells)
	}
}

// A field's values over time: the starting value, then each change of it.
func TestField(t *testing.T) {
	s := New(Limits{})
	s.Record("u", pod(0, "a:1"), t0)
	s.Record("u", pod(0, "a:2"), t0.Add(time.Second)) // not the field
	s.Record("u", pod(1, "a:2"), t0.Add(2*time.Second))
	s.Record("u", pod(3, "a:2"), t0.Add(3*time.Second))
	p := fieldpath.Path{{Key: "status"}, {Key: "containerStatuses"}, {By: "name", Val: "app"}, {Key: "restartCount"}}
	got := s.Field("u", p)
	if len(got) != 3 {
		t.Fatalf("got %+v", got)
	}
	for i, w := range []struct {
		at time.Duration
		v  int64
	}{{0, 0}, {2 * time.Second, 1}, {3 * time.Second, 3}} {
		if !got[i].At.Equal(t0.Add(w.at)) || got[i].Value != w.v || !got[i].Present {
			t.Errorf("%d: %+v, want %v at +%v", i, got[i], w.v, w.at)
		}
	}
	// a field that appears later starts absent
	q := fieldpath.Path{{Key: "metadata"}, {Key: "labels"}}
	s.Record("u", func() *unstructured.Unstructured {
		o := pod(3, "a:2")
		o.SetLabels(map[string]string{"x": "y"})
		return o
	}(), t0.Add(4*time.Second))
	if got := s.Field("u", q); len(got) != 2 || got[0].Present || !got[1].Present {
		t.Fatalf("labels: %+v", got)
	}
	if s.Field("nope", p) != nil {
		t.Fatal("unknown key")
	}
}

// A deleted object's history stays until pruned; back under the same key
// it starts over.
func TestDeleteAndPrune(t *testing.T) {
	s := New(Limits{})
	for i := range 3 {
		s.Record(fmt.Sprint(i), pod(0, "a:1"), t0)
	}
	s.Record("1", pod(1, "a:1"), t0)
	s.Delete("0", t0)
	s.Delete("1", t0.Add(time.Minute))
	if _, last := s.Range("1"); last != 2 {
		t.Fatal("deleted history not readable")
	}
	var live []string
	s.Keys(func(k string) { live = append(live, k) })
	if !reflect.DeepEqual(live, []string{"2"}) {
		t.Fatalf("live keys = %v", live)
	}
	s.Prune(t0.Add(time.Second))
	if s.Len() != 2 {
		t.Fatalf("len = %d", s.Len())
	}
	if n := s.Record("1", pod(5, "a:1"), t0.Add(2*time.Minute)); n != 1 {
		t.Fatalf("recreated under the same key: version %d", n)
	}
}

// Pair reads a version and the one before together, clamped to the kept ones.
func TestPair(t *testing.T) {
	s := New(Limits{})
	for i := range 5 {
		s.Record("u", pod(int64(i), "a:1"), t0.Add(time.Duration(i)*time.Second))
	}
	// versions 1 and 2 dropped (as the budget does): 3 (t0+2s) … 5 kept
	s.dropOldest(s.objects["u"])
	s.dropOldest(s.objects["u"])
	p, ok := s.Pair("u", 0)
	if !ok || p.First != 3 || p.Last != 5 || p.Cur.N != 5 || p.Prev == nil || p.Prev.N != 4 || len(p.Cur.Changes) != 1 {
		t.Fatalf("newest: %+v", p)
	}
	if !reflect.DeepEqual(p.Prev.Object.Object, pod(3, "a:1").Object) || !reflect.DeepEqual(p.Cur.Object.Object, pod(4, "a:1").Object) {
		t.Fatalf("objects: %v / %v", p.Prev.Object, p.Cur.Object)
	}
	if p, _ = s.Pair("u", 1); p.Cur.N != 3 || p.Prev != nil || p.Cur.Changes != nil {
		t.Fatalf("before the oldest kept: %+v", p)
	}
	if p, _ = s.Pair("u", 4); p.Prev.N != 3 || p.Prev.Changes != nil || !p.Prev.At.Equal(t0.Add(2*time.Second)) {
		t.Fatalf("version 4: %+v", p.Prev)
	}
	if _, ok := s.Pair("x", 0); ok {
		t.Fatal("unknown key")
	}
}

// Bytes counts each object's newest copy and the kept changes; a forgotten
// object gives all of it back.
func TestBytes(t *testing.T) {
	s := New(Limits{})
	s.Record("a", pod(0, "a:1"), t0)
	one := s.Bytes()
	if one < 100 {
		t.Fatalf("one object: %d", one)
	}
	s.Record("a", pod(1, "a:1"), t0.Add(time.Second))
	if s.Bytes() <= one {
		t.Fatalf("a change adds: %d", s.Bytes())
	}
	s.Forget("a")
	if s.Bytes() != 0 {
		t.Fatalf("after forget: %d", s.Bytes())
	}
}

// New limits apply at once: a lower budget drops old versions now.
func TestSetLimits(t *testing.T) {
	s := New(Limits{})
	for i := range 20 {
		s.Record("a", pod(int64(i), "a:1"), t0.Add(time.Duration(i)*time.Second))
	}
	if first, _ := s.Range("a"); first != 1 {
		t.Fatalf("first = %d", first)
	}
	s.SetLimits(Limits{Budget: 1500})
	if s.Bytes() > 1500 || s.Limits().Budget != 1500 {
		t.Fatalf("bytes %d, limits %+v", s.Bytes(), s.Limits())
	}
	if first, last := s.Range("a"); first == 1 || last != 20 {
		t.Fatalf("range %d..%d", first, last)
	}
	s.SetLimits(Limits{})
	if s.Limits().Budget != DefaultBudget {
		t.Fatal("zero budget is the default")
	}
}
