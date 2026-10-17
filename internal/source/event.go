// Package source turns Kubernetes list/watch streams into events for views.
package source

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Item is one object plus its server-side table cells (nil if the server
// did not return Table output for this resource).
type Item struct {
	Object *unstructured.Unstructured
	Cells  []any
}

// EventType enumerates source events.
type EventType string

const (
	Added    EventType = "added"
	Modified EventType = "modified"
	Deleted  EventType = "deleted"
	// Relist carries the complete current state (initial list, or a relist
	// after the watch expired). Consumers diff it against what they have.
	Relist EventType = "relist"
	// Error reports a source problem (e.g. forbidden); state is unchanged.
	Error EventType = "error"
)

// Event is delivered to subscribers in order.
type Event struct {
	Type  EventType
	Item  Item   // Added, Modified, Deleted
	Items []Item // Relist
	// Columns are the server-side table columns (Relist only; nil if the
	// resource has no Table support).
	Columns []metav1.TableColumnDefinition
	Err     string // Error
}

// StripManagedFields removes metadata.managedFields in place; it is noise
// for every consumer and dominates object size.
func StripManagedFields(o *unstructured.Unstructured) {
	if md, ok := o.Object["metadata"].(map[string]any); ok {
		delete(md, "managedFields")
	}
}
