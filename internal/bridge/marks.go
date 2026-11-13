package bridge

import (
	"errors"
	"fmt"
	"strings"

	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/view"
)

// Mark changes a pane's marked rows (see view.MarkOp); frames show them.
// It returns how many are marked now: an action right after (⇧↓ then ⌘⌫)
// mustn't wait for the frame to know there are marks.
func (s *Service) Mark(paneID string, op view.MarkOp) (int, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return 0, err
	}
	pn.mu.Lock()
	err = pn.view.Mark(op)
	n := len(pn.view.Marked())
	pn.mu.Unlock()
	pn.poke()
	return n, err
}

// ErrNoMarks: PrepareMarked on a pane without marked rows (the caller acts on the cursor row instead).
var ErrNoMarks = errors.New("no rows marked")

// MarkedRow is one marked row, with what the dialogs of an action on many
// rows show: names (copy name, confirmation), replicas (scale), containers
// (debug), labels and annotations (label, annotate), restartability, and
// the cells as the table shows them (copy cells: the table holds only the
// rows in view).
type MarkedRow struct {
	Key         string            `json:"key"`
	Kind        string            `json:"kind"`
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace,omitempty"`
	Replicas    *int64            `json:"replicas,omitempty"`
	Containers  []ContainerInfo   `json:"containers,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	// Restart: why it can't be restarted ("" = it can), as RowInfo.Restart.
	Restart string `json:"restart,omitempty"`
	// Logs: it has pods to tail, as RowInfo.Logs.
	Logs bool `json:"logs,omitempty"`
	// Cells: the row's cells in the pane's column order.
	Cells []string `json:"cells,omitempty"`
}

// Marked lists a pane's marked rows in display order.
func (s *Service) Marked(paneID string) ([]MarkedRow, error) {
	rows, err := s.markedRows(paneID)
	if err != nil {
		return nil, err
	}
	out := make([]MarkedRow, len(rows))
	for i, r := range rows {
		out[i] = markedRow(r)
	}
	return out, nil
}

func (s *Service) markedRows(paneID string) ([]row, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return nil, err
	}
	pn.mu.Lock()
	keys := pn.view.Marked()
	cells := make([][]string, len(keys))
	for i, k := range keys {
		cells[i] = pn.view.Cells(k)
	}
	pn.mu.Unlock()
	rows := make([]row, 0, len(keys))
	for i, k := range keys {
		r, err := s.row(paneID, k)
		if err != nil {
			continue // gone since: the next frame drops its mark
		}
		r.key, r.cells = k, cells[i]
		rows = append(rows, r)
	}
	return rows, nil
}

func markedRow(r row) MarkedRow {
	m := MarkedRow{Key: r.key, Kind: r.kind(), Name: r.name(), Namespace: r.namespace(), Replicas: replicas(r.item.Object), Cells: r.cells}
	if r.isPod() {
		m.Containers = podContainers(r)
		def := defaultContainer(r, m.Containers)
		for i := range m.Containers {
			m.Containers[i].Default = m.Containers[i].Name == def
		}
	}
	m.Labels, m.Annotations = r.item.Object.GetLabels(), r.item.Object.GetAnnotations()
	m.Restart = restartable(r)
	m.Logs = r.isPod() || podChild(r.item.Object) != nil
	return m
}

// MarkedBatch is an action prepared for a pane's marked rows: a token per
// row (Batch.Pending, in the order of Rows), redeemed one by one by the
// single-object calls (Delete, Label, Scale, Restart, DebugStart …).
// Skipped are marked rows the action doesn't apply to (scale: no replicas;
// debug: not a pod; restart: not a deployment, stateful set or daemon
// set, or paused), left out of the batch.
type MarkedBatch struct {
	safety.Batch
	Rows    []MarkedRow `json:"rows"`
	Skipped []string    `json:"skipped,omitempty"`
}

// PrepareMarked checks a mutating action on every marked row of a pane
// against the safety policy, under one decision (one confirmation). As
// Prepare, the actions are built from Go's state, never from the caller.
func (s *Service) PrepareMarked(kind, paneID string) (MarkedBatch, error) {
	if s.opts.Actor == nil {
		return MarkedBatch{}, fmt.Errorf("%s is not available", kind)
	}
	switch kind {
	case safety.Delete, safety.Label, safety.Annotate, safety.Scale, safety.Restart, safety.Debug:
	default:
		return MarkedBatch{}, fmt.Errorf("%s acts on one row only", kind)
	}
	rows, err := s.markedRows(paneID)
	if err != nil {
		return MarkedBatch{}, err
	}
	var b MarkedBatch
	var as []safety.Action
	var targets []any
	landscape := ""
	if len(rows) > 0 {
		landscape = s.landscape(rows[0].cluster) // one pane: one cluster
	}
	for _, r := range rows {
		if kind == safety.Debug && !r.isPod() || kind == safety.Scale && replicas(r.item.Object) == nil || kind == safety.Restart && restartable(r) != "" {
			b.Skipped = append(b.Skipped, r.name())
			continue
		}
		as = append(as, safety.Action{
			Kind: kind, Context: r.context, Landscape: landscape, Resource: resourceName(r.res, r.typed),
			Namespace: r.namespace(), Name: r.name(), UID: string(r.item.Object.GetUID()),
		})
		targets = append(targets, r)
		b.Rows = append(b.Rows, markedRow(r))
	}
	if len(as) == 0 {
		if len(rows) == 0 {
			return MarkedBatch{}, ErrNoMarks
		}
		if kind == safety.Restart {
			return MarkedBatch{}, fmt.Errorf("restart: none of the marked rows can be restarted (%s)", strings.Join(b.Skipped, ", "))
		}
		what := map[string]string{safety.Debug: "a pod", safety.Scale: "replicas"}[kind]
		return MarkedBatch{}, fmt.Errorf("%s: none of the marked rows has %s (%s)", kind, what, strings.Join(b.Skipped, ", "))
	}
	if b.Batch, err = s.guard.PrepareBatch(as, targets); err != nil {
		return MarkedBatch{}, err
	}
	return b, nil
}
