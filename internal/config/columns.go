package config

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/pipeline"
)

// ColumnsFile holds the column configurator's settings per resource type.
// Like history.yaml it is the app's and rewritten as a whole; it stays plain
// YAML to edit by hand or sync with dotfiles (edits apply on the next start).
const ColumnsFile = "columns.yaml"

// Columns mirrors columns.yaml.
type Columns struct {
	// Types by qualified resource (pods, deployments.apps).
	Types map[string]TypeView `json:"types"`
}

// TypeView is how a resource type's tables look.
type TypeView struct {
	// Columns are the shown columns in order (see pipeline.Column: a server
	// column by name, or a custom one); empty = the server's defaults.
	Columns []pipeline.Column `json:"columns,omitempty"`
	// Widths are the dragged column widths by column name; others keep their defaults.
	Widths map[string]int `json:"widths,omitempty"`
	// Metrics is where the metric columns (kubectl top) were when they were
	// turned off; nil = right after NAME, in their built-in order. Turned
	// on again, they go back there.
	Metrics *MetricsPlace `json:"metrics,omitempty"`
}

// MetricsPlace is where the metric columns were shown.
type MetricsPlace struct {
	// After: the shown column before them ("" = they were first).
	After string `json:"after"`
	// Order: the ones shown, in their order.
	Order []string `json:"order,omitempty"`
}

func (t TypeView) clone() TypeView {
	c := TypeView{Columns: slices.Clone(t.Columns), Widths: maps.Clone(t.Widths)}
	if t.Metrics != nil {
		c.Metrics = &MetricsPlace{After: t.Metrics.After, Order: slices.Clone(t.Metrics.Order)}
	}
	return c
}

func (t TypeView) empty() bool {
	return len(t.Columns) == 0 && len(t.Widths) == 0 && t.Metrics == nil
}

// ColumnStore reads and writes dir/columns.yaml. dir "" keeps the settings
// in memory only (headless runs, tests).
type ColumnStore struct {
	dir string

	mu sync.Mutex
	c  Columns
}

// OpenColumns loads dir/columns.yaml; a missing or unreadable file is no
// settings, an invalid type's columns are dropped (its widths stay).
func OpenColumns(dir string) *ColumnStore {
	s := &ColumnStore{dir: dir, c: Columns{Types: map[string]TypeView{}}}
	if dir == "" {
		return s
	}
	b, err := os.ReadFile(filepath.Join(dir, ColumnsFile))
	if err != nil {
		return s
	}
	var c Columns
	if yaml.Unmarshal(b, &c) != nil {
		return s
	}
	for typ, tv := range c.Types {
		p := pipeline.Pipeline{Source: pipeline.Source{Resource: typ}, Render: pipeline.Render{Columns: tv.Columns}}
		if p.Validate() != nil {
			tv.Columns = nil
		}
		if !tv.empty() {
			s.c.Types[typ] = tv
		}
	}
	return s
}

// All returns a copy of every type's settings.
func (s *ColumnStore) All() map[string]TypeView {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]TypeView, len(s.c.Types))
	for k, v := range s.c.Types {
		out[k] = v.clone()
	}
	return out
}

// Get returns a copy of a type's settings (zero = defaults).
func (s *ColumnStore) Get(typ string) TypeView {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.c.Types[typ].clone()
}

// SetColumns replaces a type's shown columns (nil = the defaults) and saves.
// The caller validates them.
func (s *ColumnStore) SetColumns(typ string, cols []pipeline.Column) error {
	return s.update(typ, func(t *TypeView) { t.Columns = slices.Clone(cols) })
}

// SetMetrics sets where the metric columns go when turned on (nil = right
// after NAME) and saves.
func (s *ColumnStore) SetMetrics(typ string, m *MetricsPlace) error {
	return s.update(typ, func(t *TypeView) { t.Metrics = m })
}

// SetWidths replaces a type's column widths (nil = the defaults) and saves.
func (s *ColumnStore) SetWidths(typ string, widths map[string]int) error {
	return s.update(typ, func(t *TypeView) { t.Widths = maps.Clone(widths) })
}

func (s *ColumnStore) update(typ string, f func(*TypeView)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.c.Types[typ]
	f(&t)
	if len(t.Widths) == 0 {
		t.Widths = nil
	}
	if t.empty() {
		delete(s.c.Types, typ)
	} else {
		s.c.Types[typ] = t
	}
	return writeAtomic(s.dir, ColumnsFile, "# Written by kubewing (columns and their widths per resource type, set in the column dialog).\n", s.c)
}
