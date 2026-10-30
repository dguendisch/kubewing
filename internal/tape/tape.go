// Package tape defines scenario tapes: a starting state plus scripted watch
// events, used by golden tests, property tests and the headless backend.
package tape

import (
	"fmt"
	"os"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8stypes "k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// Tape is a recorded or hand-written scenario.
type Tape struct {
	Pipeline pipeline.Pipeline `json:"pipeline"`
	// Columns optionally simulates server-side Table column definitions.
	Columns []metav1.TableColumnDefinition `json:"columns,omitempty"`
	// Initial objects (delivered as the first relist at t=0).
	Initial []Object `json:"initial,omitempty"`
	Steps   []Step   `json:"steps,omitempty"`
	// Filter makes replays and metadata lists honor the source's namespace
	// and label/field selectors, as an API server would (relation tapes:
	// one tape is many sources). Other tapes replay everything.
	Filter bool `json:"filter,omitempty"`
	// CRD is the CustomResourceDefinition of a custom kind this tape serves
	// (its scale subresource drives the jump menu's owned pods).
	CRD map[string]any `json:"crd,omitempty"`
	// Metrics fakes metrics.k8s.io for the tape's pods or nodes: usage by
	// namespace/name ("/name" for nodes). A tape without is a cluster
	// without metrics-server.
	Metrics map[string]Usage `json:"metrics,omitempty"`
}

// Usage is an object's usage as quantities ("250m", "128Mi").
type Usage struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

// Object is an object plus optional table cells.
type Object struct {
	Object map[string]any `json:"object"`
	Cells  []any          `json:"cells,omitempty"`
}

// Step is one scripted action. Exactly one action field is set.
type Step struct {
	// At is the offset from tape start (e.g. "2s").
	At string `json:"at"`

	Add    *Object  `json:"add,omitempty"`
	Update *Object  `json:"update,omitempty"`
	Delete *Object  `json:"delete,omitempty"`
	Relist []Object `json:"relist,omitempty"`
	Error  string   `json:"error,omitempty"`
	// Viewport changes the client window.
	Viewport *Viewport `json:"viewport,omitempty"`
	// Frame asks the test harness to record a frame at this time.
	Frame bool `json:"frame,omitempty"`
}

// Viewport is a client window.
type Viewport struct {
	Offset int `json:"offset"`
	Limit  int `json:"limit"`
}

// Load reads a tape from disk.
func Load(path string) (*Tape, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var t Tape
	if err := yaml.UnmarshalStrict(b, &t); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &t, nil
}

// Offset parses a step's At.
func (s Step) Offset() (time.Duration, error) {
	if s.At == "" {
		return 0, nil
	}
	return time.ParseDuration(s.At)
}

func (o Object) Item() source.Item {
	u := &unstructured.Unstructured{Object: deepCopy(o.Object)}
	return source.Item{Object: u, Cells: o.Cells}
}

func items(objs []Object) []source.Item {
	out := make([]source.Item, len(objs))
	for i, o := range objs {
		out[i] = o.Item()
	}
	return out
}

// InitialEvent is the first relist.
func (t *Tape) InitialEvent() source.Event {
	return source.Event{Type: source.Relist, Items: items(t.Initial), Columns: t.Columns}
}

// Event converts a step into a source event; ok is false for steps that
// are not source events (viewport, frame).
func (t *Tape) Event(s Step) (source.Event, bool) {
	switch {
	case s.Add != nil:
		return source.Event{Type: source.Added, Item: s.Add.Item()}, true
	case s.Update != nil:
		return source.Event{Type: source.Modified, Item: s.Update.Item()}, true
	case s.Delete != nil:
		return source.Event{Type: source.Deleted, Item: s.Delete.Item()}, true
	case s.Relist != nil:
		return source.Event{Type: source.Relist, Items: items(s.Relist), Columns: t.Columns}, true
	case s.Error != "":
		return source.Event{Type: source.Error, Err: s.Error}, true
	}
	return source.Event{}, false
}

// find returns the latest version of an object in the tape (by uid, else
// namespace/name), or nil.
func (t *Tape) find(namespace, name string, uid k8stypes.UID) *Object {
	var found *Object
	match := func(o *Object) {
		if o == nil {
			return
		}
		it := o.Item()
		if uid != "" {
			if it.Object.GetUID() == uid {
				found = o
			}
		} else if it.Object.GetName() == name && it.Object.GetNamespace() == namespace {
			found = o
		}
	}
	for i := range t.Initial {
		match(&t.Initial[i])
	}
	for _, s := range t.Steps {
		match(s.Add)
		match(s.Update)
	}
	return found
}

func deepCopy(m map[string]any) map[string]any {
	return runtimeDeepCopy(m)
}

// LoadCatalog reads a catalog fixture.
func LoadCatalog(path string) (*Catalog, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Catalog
	if err := yaml.UnmarshalStrict(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}
