package view

// Frame is the unit pushed over the bridge. It only ever describes the
// requested viewport window; full objects are never included.
//
// Client contract:
//   - A frame carrying Columns invalidates all cached rows.
//   - Order lists the row keys of the window [Offset, Offset+len(Order)).
//     Cached rows whose key is not in Order may be dropped.
//   - Rows contains every row in Order whose content the client does not
//     have yet (new to the window, or changed since last sent).
type Frame struct {
	Seq     uint64       `json:"seq"`
	Columns []ColumnInfo `json:"columns,omitempty"`
	Total   int          `json:"total"`
	Offset  int          `json:"offset"`
	Order   []string     `json:"order"`
	Rows    []RowData    `json:"rows,omitempty"`
	Status  *Status      `json:"status,omitempty"`
}

// ColumnInfo describes a rendered column.
type ColumnInfo struct {
	Name string `json:"name"`
	// Type is "", "number", "bytes" or "age" (cell holds an RFC3339
	// timestamp the frontend renders relative to its own clock).
	Type string `json:"type,omitempty"`
}

// Mark is a row-level diff marker.
type Mark string

const (
	MarkNone    Mark = ""
	MarkAdded   Mark = "added"
	MarkDeleted Mark = "deleted"
)

// RowData is one rendered row.
type RowData struct {
	Key   string   `json:"key"`
	Cells []string `json:"cells"`
	Mark  Mark     `json:"mark,omitempty"`
	// Changed lists column indices whose cell changed recently.
	Changed []int `json:"changed,omitempty"`
	// Hidden marks a recent change outside the displayed columns.
	Hidden bool `json:"hidden,omitempty"`
}

// Status summarizes the source and pipeline state of a view.
type Status struct {
	Synced  bool   `json:"synced"`
	Objects int    `json:"objects"`
	Error   string `json:"error,omitempty"`
}
