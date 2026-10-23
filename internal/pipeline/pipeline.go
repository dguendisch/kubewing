// Package pipeline defines kubewing's core abstraction: a serializable
// source → stages → render description of a view.
package pipeline

import (
	"fmt"
	"strings"

	"sigs.k8s.io/yaml"
)

// Pipeline is the serializable description of a view.
type Pipeline struct {
	Source Source  `json:"source"`
	Stages []Stage `json:"stages,omitempty"`
	Render Render  `json:"render,omitempty"`
}

// Source selects the objects a view is built from.
type Source struct {
	// Cluster is a kubeconfig context name (Gardener paths come later).
	Cluster string `json:"cluster,omitempty"`
	// Resource is a resource name, plural, short name or kind ("po", "pods", "deploy.apps").
	Resource string `json:"resource"`
	// Namespace restricts the source; "" or "*" means all namespaces.
	Namespace     string `json:"namespace,omitempty"`
	LabelSelector string `json:"labelSelector,omitempty"`
	FieldSelector string `json:"fieldSelector,omitempty"`
}

// AllNamespaces reports whether the source spans all namespaces.
func (s Source) AllNamespaces() bool { return s.Namespace == "" || s.Namespace == "*" }

// Stage is one processing step. Exactly one field must be set.
type Stage struct {
	// Filter is a CEL expression over the object `o`; objects evaluating to false are dropped.
	Filter string `json:"filter,omitempty"`
	// Grep matches the rendered row, case-insensitively: space-separated
	// terms that must all occur, "!x" for must not (see ParseGrep).
	Grep string `json:"grep,omitempty"`
	// Sort lists column names; a leading "-" sorts descending.
	Sort []string `json:"sort,omitempty"`
	// HideHealthy drops pods that are Running with every container ready,
	// and deployments, statefulsets, replicasets and daemonsets whose
	// rollout is complete (other kinds pass through).
	HideHealthy bool `json:"hideHealthy,omitempty"`
}

// Kind returns the stage kind, or an error if not exactly one field is set.
func (s Stage) Kind() (string, error) {
	var kinds []string
	if s.Filter != "" {
		kinds = append(kinds, "filter")
	}
	if s.Grep != "" {
		kinds = append(kinds, "grep")
	}
	if len(s.Sort) > 0 {
		kinds = append(kinds, "sort")
	}
	if s.HideHealthy {
		kinds = append(kinds, "hideHealthy")
	}
	if len(kinds) != 1 {
		return "", fmt.Errorf("stage must set exactly one of filter, grep, sort, hideHealthy (got %v)", kinds)
	}
	return kinds[0], nil
}

// Render describes how rows are displayed.
type Render struct {
	// Columns overrides the default columns when non-empty.
	Columns []Column `json:"columns,omitempty"`
}

// ColumnType controls formatting, sorting and diffing of a column.
type ColumnType string

const (
	TypeText   ColumnType = ""       // default
	TypeNumber ColumnType = "number" // numeric sort
	TypeBytes  ColumnType = "bytes"  // human-readable size, numeric sort
	TypeAge    ColumnType = "age"    // timestamp rendered relative by the frontend; never diffed
)

// Column is one rendered column; exactly one of Path or Expr must be set.
type Column struct {
	Name string     `json:"name"`
	Path string     `json:"path,omitempty"` // dot path, e.g. metadata.name or spec.containers[0].image
	Expr string     `json:"expr,omitempty"` // CEL over `o`
	Type ColumnType `json:"type,omitempty"`
}

// TimeDerived reports whether the column changes with wall-clock time and
// must therefore be excluded from diffing.
func (c Column) TimeDerived() bool { return c.Type == TypeAge }

// DefaultColumns are used when the pipeline does not define any.
func DefaultColumns(namespaced bool) []Column {
	cols := []Column{{Name: "NAME", Path: "metadata.name"}}
	if namespaced {
		cols = []Column{{Name: "NAMESPACE", Path: "metadata.namespace"}, cols[0]}
	}
	return append(cols, Column{Name: "AGE", Path: "metadata.creationTimestamp", Type: TypeAge})
}

// Validate checks structural correctness (expressions are checked when compiled).
func (p *Pipeline) Validate() error {
	if strings.TrimSpace(p.Source.Resource) == "" {
		return fmt.Errorf("source.resource is required")
	}
	for i, s := range p.Stages {
		if _, err := s.Kind(); err != nil {
			return fmt.Errorf("stages[%d]: %w", i, err)
		}
	}
	seen := map[string]bool{}
	for i, c := range p.Render.Columns {
		if c.Name == "" {
			return fmt.Errorf("render.columns[%d]: name is required", i)
		}
		if (c.Path == "") == (c.Expr == "") {
			return fmt.Errorf("render.columns[%d] (%s): set exactly one of path, expr", i, c.Name)
		}
		switch c.Type {
		case TypeText, TypeNumber, TypeBytes, TypeAge:
		default:
			return fmt.Errorf("render.columns[%d] (%s): unknown type %q", i, c.Name, c.Type)
		}
		key := strings.ToLower(c.Name)
		if seen[key] {
			return fmt.Errorf("render.columns[%d]: duplicate column name %q", i, c.Name)
		}
		seen[key] = true
	}
	return nil
}

// Parse decodes and validates a YAML (or JSON) pipeline.
func Parse(data []byte) (*Pipeline, error) {
	var p Pipeline
	if err := yaml.UnmarshalStrict(data, &p); err != nil {
		return nil, fmt.Errorf("parse pipeline: %w", err)
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return &p, nil
}

// Marshal encodes a pipeline as YAML.
func Marshal(p *Pipeline) ([]byte, error) { return yaml.Marshal(p) }
