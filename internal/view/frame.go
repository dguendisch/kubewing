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
	// Marked: the row is marked for an action on many rows (View.Mark).
	Marked bool `json:"marked,omitempty"`
}

// Status summarizes the source and pipeline state of a view.
type Status struct {
	Synced  bool   `json:"synced"`
	Objects int    `json:"objects"`
	Error   string `json:"error,omitempty"`
	// FilterErrors counts objects the filter failed on (other than a
	// missing field); FilterError is one of the messages.
	FilterErrors int    `json:"filterErrors,omitempty"`
	FilterError  string `json:"filterError,omitempty"`
	// Recording: the source records history (all its splits), so the
	// detail diff steps through versions
	Recording bool `json:"recording,omitempty"`
	// At: the pane shows the past, as of this moment (RFC 3339; "" = live);
	// Behind: live events since, applied behind it
	At     string `json:"at,omitempty"`
	Behind int    `json:"behind,omitempty"`
	// MetricsError: the pane shows metric columns but there is no usage
	// (no metrics-server, forbidden, unreachable)
	MetricsError string `json:"metricsError,omitempty"`
	// AllocLoading: the pane shows a node's requests/limits columns and
	// their pods are still being listed; AllocError: they can't be
	AllocLoading bool   `json:"allocLoading,omitempty"`
	AllocError   string `json:"allocError,omitempty"`
	// Snapshot: the source is listed once, not watched (a namespace's
	// snapshot); ListedAt is when the last listing finished (RFC 3339; ""
	// while the first runs), Listing/ListTypes the progress of one running
	// (Listing < ListTypes), Skipped the types the last one couldn't list
	// (Listing(): which and why).
	Snapshot  bool   `json:"snapshot,omitempty"`
	ListedAt  string `json:"listedAt,omitempty"`
	Listing   int    `json:"listing,omitempty"`
	ListTypes int    `json:"listTypes,omitempty"`
	Skipped   int    `json:"skipped,omitempty"`
	// Marked counts the rows marked for an action on many rows.
	Marked int `json:"marked,omitempty"`
}
