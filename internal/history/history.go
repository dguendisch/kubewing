// Package history keeps the recent versions of normalized objects: the
// newest one per key, plus field-path changes to step back from it. One
// Store belongs to one shared watch; it is not safe for concurrent use (the
// owner serializes calls).
package history

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/fieldpath"
)

// DefaultDepth is how many versions per object are kept.
const DefaultDepth = 20

// Store holds the versions of every object of one source, by key (UID).
type Store struct {
	depth   int
	objects map[string]*object
}

type object struct {
	cur  *unstructured.Unstructured
	hash string // cur's content hash ("" = unknown)
	// deleted: when the object went away (zero = live); see Prune
	deleted time.Time
	// at[i], deltas[i]: version first+i. deltas[i] turns version first+i
	// into first+i+1; there is one delta less than versions.
	first  int
	at     []time.Time
	deltas [][]fieldpath.Change
}

func (o *object) last() int { return o.first + len(o.at) - 1 }

// New returns a store keeping depth versions per object (≤ 0 = DefaultDepth).
func New(depth int) *Store {
	if depth <= 0 {
		depth = DefaultDepth
	}
	return &Store{depth: depth, objects: map[string]*object{}}
}

// Record adds obj (normalized, not changed afterwards: the store keeps it)
// as the newest version of key, unless it equals the newest one. It
// returns the newest version number; versions count up per key from 1.
func (s *Store) Record(key string, obj *unstructured.Unstructured, at time.Time) int {
	return s.RecordHashed(key, obj, "", at)
}

// RecordHashed is Record with obj's content hash (normalize.Hash), which
// skips the diff for an unchanged object (resyncs, relists); "" = unknown.
func (s *Store) RecordHashed(key string, obj *unstructured.Unstructured, hash string, at time.Time) int {
	o, ok := s.objects[key]
	if !ok || !o.deleted.IsZero() {
		// back after a delete (a key without UID): a new object, as in the view
		s.objects[key] = &object{cur: obj, hash: hash, first: 1, at: []time.Time{at}}
		return 1
	}
	if hash != "" && hash == o.hash {
		return o.last()
	}
	d := fieldpath.Diff(o.cur.Object, obj.Object)
	o.hash = hash
	if len(d) == 0 {
		return o.last()
	}
	o.cur = obj
	o.at = append(o.at, at)
	o.deltas = append(o.deltas, d)
	if len(o.at) > s.depth {
		n := len(o.at) - s.depth
		o.at = append([]time.Time(nil), o.at[n:]...)
		o.deltas = append([][]fieldpath.Change(nil), o.deltas[n:]...)
		o.first += n
	}
	return o.last()
}

// Delete marks key as gone at at. Its history stays readable (the
// view's tombstone row still diffs) until Prune drops it.
func (s *Store) Delete(key string, at time.Time) {
	if o, ok := s.objects[key]; ok && o.deleted.IsZero() {
		o.deleted = at
	}
}

// Forget drops key's history at once.
func (s *Store) Forget(key string) { delete(s.objects, key) }

// Prune drops the history of objects deleted before t.
func (s *Store) Prune(t time.Time) {
	for k, o := range s.objects {
		if !o.deleted.IsZero() && o.deleted.Before(t) {
			delete(s.objects, k)
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
	v := Version{N: n, At: o.at[n-o.first], Object: obj}
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
		prev := Version{N: to - 1, At: o.at[to-1-o.first], Object: cur.Object.DeepCopy()}
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

// Len returns the number of objects with history (for tests and status).
func (s *Store) Len() int { return len(s.objects) }
