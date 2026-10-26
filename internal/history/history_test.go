package history

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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
	s := New(10)
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
	s := New(10)
	s.Record("u", pod(0, "a:1"), t0)
	if n := s.Record("u", pod(0, "a:1"), t0.Add(time.Second)); n != 1 {
		t.Fatalf("no-op recorded as version %d", n)
	}
}

// Past the depth the oldest versions go; the numbers stay.
func TestDepth(t *testing.T) {
	s := New(3)
	for i := range 6 {
		s.Record("u", pod(int64(i), "a:1"), t0.Add(time.Duration(i)*time.Second))
	}
	if first, last := s.Range("u"); first != 4 || last != 6 {
		t.Fatalf("range = %d..%d", first, last)
	}
	if _, ok := s.Get("u", 3); ok {
		t.Fatal("dropped version still there")
	}
	for n := 4; n <= 6; n++ {
		v, ok := s.Get("u", n)
		if !ok || !reflect.DeepEqual(v.Object.Object, pod(int64(n-1), "a:1").Object) {
			t.Fatalf("version %d: %v", n, v.Object)
		}
	}
	if v, _ := s.Get("u", 4); v.Changes != nil {
		t.Fatalf("the oldest kept version has no previous one: %v", v.Changes)
	}
}

// A deleted object's history stays until pruned; back under the same key
// it starts over.
func TestDeleteAndPrune(t *testing.T) {
	s := New(3)
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
	s := New(3)
	for i := range 5 {
		s.Record("u", pod(int64(i), "a:1"), t0.Add(time.Duration(i)*time.Second))
	}
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
