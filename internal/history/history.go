// Package history keeps the recent versions of normalized objects: the
// newest one per key, plus field-path changes to step back from it. One
// Store belongs to one shared watch; it is not safe for concurrent use (the
// owner serializes calls).
//
// Limits are global, so the history reaches back equally far for every
// object (time-travel shows the whole table at one moment): versions older
// than the window go, and past the budget the oldest changes go first,
// across all objects. Horizon is from when on the store is complete.
package history

import (
	"encoding/json"
	"sort"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/fieldpath"
)

// Defaults for Limits.
const (
	DefaultWindow = time.Hour
	DefaultBudget = 256 << 20
)

// Limits bound a store.
type Limits struct {
	// Window: versions older than this go (0 = DefaultWindow).
	Window time.Duration
	// Budget: estimated bytes of kept changes (0 = DefaultBudget); past it
	// the oldest changes go first, across all objects.
	Budget int
}

func (l Limits) withDefaults() Limits {
	if l.Window <= 0 {
		l.Window = DefaultWindow
	}
	if l.Budget <= 0 {
		l.Budget = DefaultBudget
	}
	return l
}

// Store holds the versions of every object of one source, by key (UID).
type Store struct {
	limits  Limits
	objects map[string]*object
	// started: the first Record (zero = none yet); horizon: the earliest
	// moment the store knows every object at (≥ started; moves forward as
	// old versions go); windowed: the last window trim (a walk over every
	// object, at most once a second)
	started, horizon, windowed time.Time
	bytes                      int
}

type object struct {
	cur  *unstructured.Unstructured
	hash string // cur's content hash ("" = unknown)
	// born: when the object was first recorded; deleted: when it went away
	// (zero = live); see Prune
	born, deleted time.Time
	// at[i], cells[i]: version first+i (cells: the server's table cells
	// with it, nil if none). deltas[i] turns version first+i into first+i+1
	// (one delta less than versions); size[i] estimates deltas[i] + cells.
	first  int
	at     []time.Time
	cells  [][]any
	deltas [][]fieldpath.Change
	size   []int
}

func (o *object) last() int { return o.first + len(o.at) - 1 }

// New returns a store with the given limits (zero fields = defaults).
func New(l Limits) *Store {
	return &Store{limits: l.withDefaults(), objects: map[string]*object{}}
}

// Record adds obj (normalized, not changed afterwards: the store keeps it)
// as the newest version of key, unless it equals the newest one. It
// returns the newest version number; versions count up per key from 1.
func (s *Store) Record(key string, obj *unstructured.Unstructured, at time.Time) int {
	return s.RecordItem(key, obj, "", nil, at)
}

// RecordHashed is Record with obj's content hash (normalize.Hash), which
// skips the diff for an unchanged object (resyncs, relists); "" = unknown.
func (s *Store) RecordHashed(key string, obj *unstructured.Unstructured, hash string, at time.Time) int {
	return s.RecordItem(key, obj, hash, nil, at)
}

// RecordItem is RecordHashed with the server's table cells of this version
// (for the past table; nil = none). Cells alone changing is a new version.
func (s *Store) RecordItem(key string, obj *unstructured.Unstructured, hash string, cells []any, at time.Time) int {
	if s.started.IsZero() {
		s.started, s.horizon, s.windowed = at, at, at
	}
	o, ok := s.objects[key]
	if !ok || !o.deleted.IsZero() {
		// back after a delete (a key without UID): a new object, as in the view
		if ok {
			s.drop(o)
		}
		s.objects[key] = &object{cur: obj, hash: hash, born: at, first: 1, at: []time.Time{at}, cells: [][]any{cells}, size: []int{0}}
		s.trim(at)
		return 1
	}
	sameCells := equalCells(o.cells[len(o.cells)-1], cells)
	if hash != "" && hash == o.hash && sameCells {
		return o.last()
	}
	var d []fieldpath.Change
	if hash == "" || hash != o.hash {
		d = fieldpath.Diff(o.cur.Object, obj.Object)
	}
	o.hash = hash
	if len(d) == 0 && sameCells {
		return o.last()
	}
	n := sizeOf(d) + sizeOf(cells)
	o.cur = obj
	o.at = append(o.at, at)
	o.cells = append(o.cells, cells)
	o.deltas = append(o.deltas, d)
	o.size = append(o.size, n)
	s.bytes += n
	s.trim(at)
	return o.last()
}

func equalCells(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// sizeOf estimates the memory a change list or cell list holds.
func sizeOf(v any) int {
	if v == nil {
		return 0
	}
	b, err := json.Marshal(v)
	if err != nil {
		return 64
	}
	return len(b) + 64
}

// trim applies the window (at most once a second: it walks every object)
// and the budget (past it, down to 90% so it doesn't run on every event):
// the oldest versions go first, across all objects, and the horizon moves
// to the newest dropped one.
func (s *Store) trim(now time.Time) {
	if now.Sub(s.windowed) >= time.Second {
		s.windowed = now
		cut := now.Add(-s.limits.Window)
		if s.horizon.Before(cut) {
			for _, o := range s.objects {
				for len(o.at) > 1 && !o.at[1].After(cut) {
					s.dropOldest(o)
				}
			}
			s.horizon = cut
		}
	}
	if s.bytes <= s.limits.Budget {
		return
	}
	// a version's change goes with the version before it: dropping an
	// object's oldest version (at[0]) means its state is known from at[1]
	// on, so the drop order is by at[1]
	type old struct {
		o  *object
		at time.Time
	}
	var olds []old
	for _, o := range s.objects {
		for i := 1; i < len(o.at); i++ {
			olds = append(olds, old{o, o.at[i]})
		}
	}
	sort.Slice(olds, func(i, j int) bool { return olds[i].at.Before(olds[j].at) })
	goal := s.limits.Budget / 10 * 9
	for _, x := range olds {
		if s.bytes <= goal {
			break
		}
		s.dropOldest(x.o)
		if x.at.After(s.horizon) {
			s.horizon = x.at
		}
	}
}

// dropOldest forgets an object's oldest version: the next becomes its first.
// The change that led to the next one isn't needed anymore.
func (s *Store) dropOldest(o *object) {
	s.bytes -= o.size[1]
	o.at, o.cells, o.deltas = o.at[1:], o.cells[1:], o.deltas[1:]
	o.size = append([]int{0}, o.size[2:]...)
	o.first++
}

func (s *Store) drop(o *object) {
	for _, n := range o.size {
		s.bytes -= n
	}
}

// Delete marks key as gone at at. Its history stays readable (the
// view's tombstone row still diffs, the past table still shows it) until
// Prune drops it.
func (s *Store) Delete(key string, at time.Time) {
	if o, ok := s.objects[key]; ok && o.deleted.IsZero() {
		o.deleted = at
	}
}

// Forget drops key's history at once.
func (s *Store) Forget(key string) {
	if o, ok := s.objects[key]; ok {
		s.drop(o)
		delete(s.objects, key)
	}
}

// Prune drops the history of objects deleted before t, or before the
// horizon (no moment the store can still show has them).
func (s *Store) Prune(t time.Time) {
	for k, o := range s.objects {
		if !o.deleted.IsZero() && (o.deleted.Before(t) || !o.deleted.After(s.horizon)) {
			s.Forget(k)
		}
	}
}

// Keys calls f for every live (not deleted) key.
func (s *Store) Keys(f func(key string)) {
	for k, o := range s.objects {
		if o.deleted.IsZero() {
			f(k)
		}
	}
}

// Range returns key's oldest and newest kept version (0, 0 if unknown).
func (s *Store) Range(key string) (first, last int) {
	o, ok := s.objects[key]
	if !ok {
		return 0, 0
	}
	return o.first, o.last()
}

// Version is one reconstructed version of an object.
type Version struct {
	N  int
	At time.Time
	// Object is a copy; the caller may change it.
	Object *unstructured.Unstructured
	// Cells are the server's table cells with this version (nil if none).
	Cells []any
	// Changes turn the previous version into this one (nil for the oldest kept).
	Changes []fieldpath.Change
}

// Get reconstructs version n of key, walking back from the newest.
func (s *Store) Get(key string, n int) (Version, bool) {
	o, ok := s.objects[key]
	if !ok || n < o.first || n > o.last() {
		return Version{}, false
	}
	obj := o.cur.DeepCopy()
	for i := o.last(); i > n; i-- {
		if err := fieldpath.Revert(obj.Object, o.deltas[i-o.first-1]); err != nil {
			// can't happen for changes from Diff; an unreadable version is
			// reported as missing rather than shown wrong
			return Version{}, false
		}
	}
	v := Version{N: n, At: o.at[n-o.first], Object: obj, Cells: o.cells[n-o.first]}
	if n > o.first {
		v.Changes = o.deltas[n-o.first-1]
	}
	return v, true
}

// Pair is version To of an object and the one before it, read together.
type Pair struct {
	First, Last int
	Cur         Version
	// Prev is nil when Cur is the oldest kept version.
	Prev *Version
}

// Pair reconstructs version to of key (≤ 0 = the newest; clamped to the
// kept ones) and the version before it.
func (s *Store) Pair(key string, to int) (Pair, bool) {
	o, ok := s.objects[key]
	if !ok {
		return Pair{}, false
	}
	if to <= 0 {
		to = o.last()
	}
	to = max(o.first, min(to, o.last()))
	cur, ok := s.Get(key, to)
	if !ok {
		return Pair{}, false
	}
	p := Pair{First: o.first, Last: o.last(), Cur: cur}
	if to > o.first {
		// one step back from cur instead of a second walk from the newest
		prev := Version{N: to - 1, At: o.at[to-1-o.first], Object: cur.Object.DeepCopy(), Cells: o.cells[to-1-o.first]}
		if fieldpath.Revert(prev.Object.Object, cur.Changes) != nil {
			return Pair{}, false
		}
		if to-1 > o.first {
			prev.Changes = o.deltas[to-o.first-2]
		}
		p.Prev = &prev
	}
	return p, true
}

// VersionAt returns key's version current at t: the newest recorded at or
// before t; 0 if the object didn't exist then (not born yet, deleted at or
// before t) or t is before what's kept of it.
func (s *Store) VersionAt(key string, t time.Time) int {
	o, ok := s.objects[key]
	if !ok || t.Before(o.at[0]) || (!o.deleted.IsZero() && !t.Before(o.deleted)) {
		return 0
	}
	i := sort.Search(len(o.at), func(i int) bool { return o.at[i].After(t) })
	return o.first + i - 1
}

// At is every object as it was at t (those that existed then, see
// VersionAt), by key. t before the horizon is answered for the horizon.
func (s *Store) At(t time.Time) map[string]Version {
	t = later(t, s.horizon)
	out := map[string]Version{}
	for k := range s.objects {
		if n := s.VersionAt(k, t); n > 0 {
			if v, ok := s.Get(k, n); ok {
				out[k] = v
			}
		}
	}
	return out
}

func later(a, b time.Time) time.Time {
	if a.Before(b) {
		return b
	}
	return a
}

// Span is what the store can show: Horizon (complete from there on) to
// Newest (the last change); zero if nothing is recorded yet.
type Span struct {
	Horizon, Newest time.Time
}

// Span returns the store's time span.
func (s *Store) Span() Span {
	sp := Span{Horizon: s.horizon, Newest: s.horizon}
	for _, o := range s.objects {
		sp.Newest = later(sp.Newest, o.at[len(o.at)-1])
		sp.Newest = later(sp.Newest, o.deleted)
	}
	return sp
}

// Changes returns the moments in [from, to] something changed (a version
// after the horizon, an object added or deleted), ascending and
// deduplicated; keep (nil = all) limits them to some keys (a pane's rows).
// The state when recording started is no change.
func (s *Store) Changes(from, to time.Time, keep func(key string) bool) []time.Time {
	seen := map[time.Time]bool{}
	var out []time.Time
	add := func(t time.Time) {
		if t.After(s.horizon) && t.After(s.started) && !t.Before(from) && !t.After(to) && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for k, o := range s.objects {
		if keep != nil && !keep(k) {
			continue
		}
		for _, t := range o.at {
			add(t)
		}
		if !o.deleted.IsZero() {
			add(o.deleted)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out
}

// FieldChange is one value of a field over an object's history.
type FieldChange struct {
	At time.Time `json:"at"`
	// Value is the field's value from At on; Present false = absent.
	Value   any  `json:"value,omitempty"`
	Present bool `json:"present"`
	N       int  `json:"n"`
}

// Field returns how the field at p went over key's kept versions: its
// value at the oldest kept, then each version that changed it.
func (s *Store) Field(key string, p fieldpath.Path) []FieldChange {
	o, ok := s.objects[key]
	if !ok {
		return nil
	}
	first, ok := s.Get(key, o.first)
	if !ok {
		return nil
	}
	obj := first.Object.Object
	v, present := fieldpath.Lookup(obj, p)
	out := []FieldChange{{At: o.at[0], Value: v, Present: present, N: o.first}}
	for i, d := range o.deltas {
		// forward from the oldest kept: one change list per version
		if fieldpath.Apply(obj, d) != nil {
			return out // can't happen for changes from Diff
		}
		if !touches(d, p) {
			continue
		}
		nv, np := fieldpath.Lookup(obj, p)
		last := out[len(out)-1]
		if np == last.Present && fieldpath.Equal(nv, last.Value) {
			continue
		}
		out = append(out, FieldChange{At: o.at[i+1], Value: fieldpath.Copy(nv), Present: np, N: o.first + i + 1})
	}
	return out
}

// touches reports whether a change list may change the field at p: a
// change at p, inside it, or at one of its parents.
func touches(d []fieldpath.Change, p fieldpath.Path) bool {
	for _, c := range d {
		if fieldpath.Overlaps(c.Path, p) {
			return true
		}
	}
	return false
}

// Len returns the number of objects with history (for tests and status).
func (s *Store) Len() int { return len(s.objects) }

// Bytes returns the estimated size of the kept changes.
func (s *Store) Bytes() int { return s.bytes }
