package view

import (
	"fmt"
	"maps"
)

// MarkOp changes a view's marked rows, the rows an action on many rows
// (delete, label, debug …) acts on, apart from the cursor row:
//   - "toggle": Key in or out; it becomes the anchor.
//   - "range": the rows from From (the anchor's key) to the row at index To
//     (an index: ⇧End reaches rows the client hasn't loaded), in display
//     order, added to the marks the anchor started with: moving back
//     towards the anchor unmarks again, as ⇧↑/⇧↓ and ⇧-click do in a file list.
//   - "all": every row shown; "clear": none.
type MarkOp struct {
	Op   string `json:"op"`
	Key  string `json:"key,omitempty"`
	From string `json:"from,omitempty"`
	To   int    `json:"to,omitempty"`
}

// Mark applies a change to the marked rows. Only live rows that are shown
// can be marked: tombstones and filtered-out rows are left out.
func (v *View) Mark(op MarkOp) error {
	switch op.Op {
	case "clear":
		v.marks, v.anchor, v.base = nil, "", nil
	case "all":
		v.marks, v.anchor, v.base = map[string]bool{}, "", nil
		for _, e := range v.rows() {
			if markable(e) {
				v.marks[e.key] = true
			}
		}
	case "toggle":
		i := v.Index(op.Key)
		if i < 0 || !markable(v.rows()[i]) {
			return fmt.Errorf("row %s isn't shown", op.Key)
		}
		if v.marks == nil {
			v.marks = map[string]bool{}
		}
		if v.marks[op.Key] {
			delete(v.marks, op.Key)
		} else {
			v.marks[op.Key] = true
		}
		v.anchor, v.base = op.Key, maps.Clone(v.marks)
	case "range":
		rows := v.rows()
		from, to := v.Index(op.From), min(max(op.To, 0), len(rows)-1)
		if from < 0 {
			return fmt.Errorf("row %s isn't shown", op.From)
		}
		if op.From != v.anchor {
			v.anchor, v.base = op.From, maps.Clone(v.marks)
		}
		v.marks = maps.Clone(v.base)
		if v.marks == nil {
			v.marks = map[string]bool{}
		}
		for _, e := range rows[min(from, to) : max(from, to)+1] {
			if markable(e) {
				v.marks[e.key] = true
			}
		}
	default:
		return fmt.Errorf("unknown mark op %q", op.Op)
	}
	if len(v.marks) == 0 {
		v.marks = nil
	}
	return nil
}

// Marked returns the marked rows' keys in display order.
func (v *View) Marked() []string {
	if len(v.marks) == 0 {
		return nil
	}
	var out []string
	for _, e := range v.rows() {
		if v.marks[e.key] {
			out = append(out, e.key)
		}
	}
	return out
}

// pruneMarks drops the marks of rows no longer shown (filtered out, deleted):
// an action never hits a row that can't be seen.
func (v *View) pruneMarks() {
	if len(v.marks) == 0 {
		return
	}
	shown := make(map[string]bool, len(v.marks))
	for _, e := range v.rows() {
		if v.marks[e.key] && markable(e) {
			shown[e.key] = true
		}
	}
	if len(shown) == len(v.marks) {
		return
	}
	v.marks = shown
	if len(v.marks) == 0 {
		v.marks, v.anchor, v.base = nil, "", nil
	}
}

func markable(e *entry) bool { return e.deletedAt.IsZero() && !e.goneLater }
