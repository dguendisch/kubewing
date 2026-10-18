// Package view applies a pipeline to a stream of source events and produces
// bridge frames with keyed (UID-based) diff markers.
//
// View is not safe for concurrent use; the owner serializes calls.
package view

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/expr"
	"github.com/dguendisch/kubewing/internal/normalize"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// Options tune marker lifetimes.
type Options struct {
	// HighlightFor is how long added/changed/hidden markers stay visible.
	HighlightFor time.Duration
	// TombstoneFor is how long deleted rows stay visible (marked deleted).
	TombstoneFor time.Duration
	Normalizer   *normalize.Normalizer
	// Namespaced controls default columns when the server provides none.
	Namespaced bool
}

func (o *Options) defaults() {
	if o.HighlightFor == 0 {
		o.HighlightFor = 10 * time.Second
	}
	if o.TombstoneFor == 0 {
		o.TombstoneFor = 10 * time.Second
	}
	if o.Normalizer == nil {
		o.Normalizer = normalize.New()
	}
}

// colSpec is an effective, compiled column.
type colSpec struct {
	info        ColumnInfo
	timeDerived bool
	numeric     bool
	// exactly one of the following is used
	path      *expr.Path
	program   *expr.Program
	cellIndex int // index into server-side table cells; -1 if unused
	creation  bool
}

type entry struct {
	key   string
	item  source.Item
	norm  *unstructured.Unstructured
	prev  *unstructured.Unstructured // previous normalized version, for the detail diff
	hash  string
	cells []string
	nums  []float64 // parsed numeric cells (NaN if not numeric)
	ns    string
	name  string
	match bool

	addedAt   time.Time
	deletedAt time.Time
	changedAt []time.Time // per column
	hiddenAt  time.Time
}

type sortKey struct {
	col  int
	desc bool
}

// View is a live, filtered, sorted, diffed table over one source.
type View struct {
	opts Options
	p    pipeline.Pipeline

	filters []*expr.Program
	greps   []string
	sortBy  [][]string // raw sort specs, resolved against cols

	userCols bool
	cols     []colSpec
	sortKeys []sortKey

	entries map[string]*entry
	synced  bool
	err     string

	sorted []*entry // cached display order; nil when dirty

	// frame state
	seq        uint64
	offset     int
	limit      int
	colsDirty  bool
	sent       map[string]string
	lastOrder  []string
	lastTotal  int
	lastOffset int
	lastStatus Status
	everFramed bool
}

// New compiles a pipeline into a view.
func New(p pipeline.Pipeline, opts Options) (*View, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	opts.defaults()
	v := &View{
		opts:    opts,
		p:       p,
		entries: map[string]*entry{},
		limit:   100,
		sent:    map[string]string{},
	}
	for _, s := range p.Stages {
		switch {
		case s.Filter != "":
			prg, err := expr.Compile(s.Filter)
			if err != nil {
				return nil, err
			}
			v.filters = append(v.filters, prg)
		case s.Grep != "":
			v.greps = append(v.greps, strings.ToLower(s.Grep))
		case len(s.Sort) > 0:
			v.sortBy = append(v.sortBy, s.Sort)
		}
	}
	if len(p.Render.Columns) > 0 {
		v.userCols = true
		cols, err := compileColumns(p.Render.Columns)
		if err != nil {
			return nil, err
		}
		v.setColumns(cols)
	} else {
		v.setColumns(defaultColumns(opts.Namespaced))
	}
	return v, nil
}

func compileColumns(in []pipeline.Column) ([]colSpec, error) {
	var out []colSpec
	for _, c := range in {
		cs := colSpec{
			info:        ColumnInfo{Name: c.Name, Type: string(c.Type)},
			timeDerived: c.TimeDerived(),
			numeric:     c.Type == pipeline.TypeNumber || c.Type == pipeline.TypeBytes,
			cellIndex:   -1,
		}
		var err error
		if c.Path != "" {
			cs.path, err = expr.CompilePath(c.Path)
		} else {
			cs.program, err = expr.Compile(c.Expr)
		}
		if err != nil {
			return nil, fmt.Errorf("column %s: %w", c.Name, err)
		}
		out = append(out, cs)
	}
	return out, nil
}

func defaultColumns(namespaced bool) []colSpec {
	cols, _ := compileColumns(pipeline.DefaultColumns(namespaced))
	return cols
}

// serverColumns maps server-side table columns (priority 0, like kubectl
// without -o wide). Date columns are time-derived; "Age" is re-derived from
// creationTimestamp so the frontend can render it against its own clock.
func serverColumns(defs []metav1.TableColumnDefinition, namespaced bool) []colSpec {
	var out []colSpec
	if namespaced {
		ns, _ := expr.CompilePath("metadata.namespace")
		out = append(out, colSpec{info: ColumnInfo{Name: "NAMESPACE"}, path: ns, cellIndex: -1})
	}
	for i, d := range defs {
		if d.Priority != 0 {
			continue
		}
		cs := colSpec{info: ColumnInfo{Name: strings.ToUpper(d.Name)}, cellIndex: i}
		switch d.Type {
		case "integer", "number":
			cs.numeric = true
			cs.info.Type = string(pipeline.TypeNumber)
		case "date":
			cs.timeDerived = true
			if strings.EqualFold(d.Name, "age") {
				cs.creation = true
				cs.cellIndex = -1
				cs.info.Type = string(pipeline.TypeAge)
			}
		}
		out = append(out, cs)
	}
	return out
}

func (v *View) setColumns(cols []colSpec) {
	v.sorted = nil
	v.cols = cols
	v.colsDirty = true
	v.sortKeys = nil
	for _, spec := range v.sortBy {
		for _, s := range spec {
			desc := strings.HasPrefix(s, "-")
			name := strings.TrimPrefix(strings.TrimPrefix(s, "-"), "+")
			for i, c := range cols {
				if strings.EqualFold(c.info.Name, name) {
					v.sortKeys = append(v.sortKeys, sortKey{col: i, desc: desc})
					break
				}
			}
		}
	}
	for _, e := range v.entries {
		v.render(e)
		e.changedAt = make([]time.Time, len(cols))
	}
}

// Apply feeds one source event into the view.
func (v *View) Apply(ev source.Event, now time.Time) {
	if ev.Type != source.Error {
		v.sorted = nil
	}
	switch ev.Type {
	case source.Error:
		v.err = ev.Err
		return
	case source.Relist:
		v.err = ""
		if !v.userCols && ev.Columns != nil {
			v.setColumns(serverColumns(ev.Columns, v.opts.Namespaced))
		}
		seen := make(map[string]bool, len(ev.Items))
		for _, it := range ev.Items {
			k := key(it)
			seen[k] = true
			v.upsert(it, now)
		}
		for k, e := range v.entries {
			if !seen[k] && e.deletedAt.IsZero() {
				v.remove(e, now)
			}
		}
		v.synced = true
	case source.Added, source.Modified:
		v.upsert(ev.Item, now)
	case source.Deleted:
		if e, ok := v.entries[key(ev.Item)]; ok && e.deletedAt.IsZero() {
			v.remove(e, now)
		}
	}
}

func key(it source.Item) string {
	if uid := string(it.Object.GetUID()); uid != "" {
		return uid
	}
	return it.Object.GetNamespace() + "/" + it.Object.GetName()
}

// upsert must not mutate it.Object: objects are shared between all views
// (splits) on the same source. Sources strip managedFields; normalization
// works on a copy.
func (v *View) upsert(it source.Item, now time.Time) {
	k := key(it)
	norm := v.opts.Normalizer.Normalize(it.Object)
	hash := normalize.Hash(norm)

	e, ok := v.entries[k]
	if ok && e.deletedAt.IsZero() && e.hash == hash && slices.Equal(e.item.Cells, it.Cells) {
		e.item = it // no-op update (resync / relist / noise): keep markers untouched
		return
	}
	if !ok || !e.deletedAt.IsZero() {
		e = &entry{key: k, changedAt: make([]time.Time, len(v.cols))}
		if v.synced {
			e.addedAt = now
		}
		v.entries[k] = e
		e.item, e.norm, e.hash = it, norm, hash
		v.render(e)
		return
	}

	oldCells := e.cells
	e.prev = e.norm
	e.item, e.norm, e.hash = it, norm, hash
	v.render(e)
	visible := false
	for i := range v.cols {
		if v.cols[i].timeDerived {
			continue
		}
		if i < len(oldCells) && oldCells[i] != e.cells[i] {
			e.changedAt[i] = now
			visible = true
		}
	}
	if !visible && e.prev != nil && normalize.Hash(e.prev) != hash {
		e.hiddenAt = now
	}
}

func (v *View) remove(e *entry, now time.Time) {
	e.deletedAt = now
}

func (v *View) render(e *entry) {
	obj := e.item.Object.Object
	cells := make([]string, len(v.cols))
	for i, c := range v.cols {
		var val any
		switch {
		case c.creation:
			val = e.item.Object.GetCreationTimestamp().UTC().Format(time.RFC3339)
		case c.cellIndex >= 0:
			if c.cellIndex < len(e.item.Cells) {
				val = e.item.Cells[c.cellIndex]
			}
		case c.path != nil:
			val = c.path.Get(obj)
		case c.program != nil:
			val, _ = c.program.Eval(obj)
		}
		cells[i] = format(val, c.info.Type)
	}
	e.cells = cells
	e.ns, e.name = e.item.Object.GetNamespace(), e.item.Object.GetName()
	e.nums = make([]float64, len(cells))
	for i, c := range v.cols {
		e.nums[i] = math.NaN()
		if c.numeric {
			if f, ok := numericValue(cells[i]); ok {
				e.nums[i] = f
			}
		}
	}

	e.match = true
	for _, f := range v.filters {
		ok, err := f.Bool(obj)
		if err != nil || !ok {
			e.match = false
			return
		}
	}
	if len(v.greps) > 0 {
		row := strings.ToLower(strings.Join(cells, " "))
		for _, g := range v.greps {
			if !strings.Contains(row, g) {
				e.match = false
				return
			}
		}
	}
}

func format(v any, typ string) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		if typ == string(pipeline.TypeBytes) {
			if f, ok := numericValue(x); ok {
				return humanBytes(f)
			}
		}
		return x
	case bool:
		return strconv.FormatBool(x)
	case int64:
		if typ == string(pipeline.TypeBytes) {
			return humanBytes(float64(x))
		}
		return strconv.FormatInt(x, 10)
	case float64:
		if typ == string(pipeline.TypeBytes) {
			return humanBytes(x)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprint(x)
		}
		return string(b)
	}
}

func humanBytes(b float64) string {
	units := []string{"B", "Ki", "Mi", "Gi", "Ti", "Pi"}
	i := 0
	for b >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	if i == 0 {
		return strconv.FormatFloat(b, 'f', 0, 64) + units[i]
	}
	return strconv.FormatFloat(b, 'f', 1, 64) + units[i]
}

func numericValue(s string) (float64, bool) {
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f, true
	}
	if q, err := resource.ParseQuantity(s); err == nil {
		return q.AsApproximateFloat64(), true
	}
	return 0, false
}

// SetViewport sets the window of rows the client displays.
func (v *View) SetViewport(offset, limit int) {
	if offset < 0 {
		offset = 0
	}
	if limit < 0 {
		limit = 0
	}
	v.offset, v.limit = offset, limit
}

// Viewport returns the current window.
func (v *View) Viewport() (offset, limit int) { return v.offset, v.limit }

// prune drops expired tombstones.
func (v *View) prune(now time.Time) {
	for k, e := range v.entries {
		if !e.deletedAt.IsZero() && now.Sub(e.deletedAt) >= v.opts.TombstoneFor {
			delete(v.entries, k)
			v.sorted = nil
		}
	}
}

// rows returns matching entries in display order (cached until the next mutation).
func (v *View) rows() []*entry {
	if v.sorted != nil {
		return v.sorted
	}
	out := make([]*entry, 0, len(v.entries))
	for _, e := range v.entries {
		if e.match {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return v.less(out[i], out[j]) })
	v.sorted = out
	return out
}

func (v *View) less(a, b *entry) bool {
	for _, sk := range v.sortKeys {
		// empty cells sort last in either direction
		ae, be := a.cells[sk.col] == "", b.cells[sk.col] == ""
		if ae != be {
			return be
		}
		if c := v.compare(sk.col, a, b); c != 0 {
			return (c < 0) != sk.desc
		}
	}
	// kubectl order: namespace, name; then key for determinism
	if a.ns != b.ns {
		return a.ns < b.ns
	}
	if a.name != b.name {
		return a.name < b.name
	}
	return a.key < b.key
}

func (v *View) compare(col int, a, b *entry) int {
	x, y := a.cells[col], b.cells[col]
	if v.cols[col].numeric {
		fx, fy := a.nums[col], b.nums[col]
		okx, oky := !math.IsNaN(fx), !math.IsNaN(fy)
		switch {
		case okx && oky:
			switch {
			case fx < fy:
				return -1
			case fx > fy:
				return 1
			}
			return 0
		case okx:
			return -1
		case oky:
			return 1
		}
	}
	return strings.Compare(x, y)
}

func (v *View) rowData(e *entry, now time.Time) RowData {
	r := RowData{Key: e.key, Cells: e.cells}
	active := func(t time.Time) bool { return !t.IsZero() && now.Sub(t) < v.opts.HighlightFor }
	switch {
	case !e.deletedAt.IsZero():
		r.Mark = MarkDeleted
	case active(e.addedAt):
		r.Mark = MarkAdded
	}
	if r.Mark == MarkNone {
		for i, t := range e.changedAt {
			if active(t) {
				r.Changed = append(r.Changed, i)
			}
		}
		r.Hidden = active(e.hiddenAt)
	}
	return r
}

func signature(r RowData) string {
	var b strings.Builder
	for _, c := range r.Cells {
		b.WriteString(c)
		b.WriteByte(0x1f)
	}
	fmt.Fprintf(&b, "%s|%v|%v", r.Mark, r.Changed, r.Hidden)
	return b.String()
}

// Frame computes the update for the current viewport. ok is false when the
// client is already up to date.
func (v *View) Frame(now time.Time) (f Frame, ok bool) {
	v.prune(now)
	rows := v.rows()

	end := min(v.offset+v.limit, len(rows))
	start := min(v.offset, end)
	window := rows[start:end]

	if v.colsDirty {
		v.sent = map[string]string{}
	}
	order := make([]string, len(window))
	sent := make(map[string]string, len(window))
	for i, e := range window {
		order[i] = e.key
		r := v.rowData(e, now)
		sig := signature(r)
		sent[e.key] = sig
		if v.sent[e.key] != sig {
			f.Rows = append(f.Rows, r)
		}
	}
	status := Status{Synced: v.synced, Objects: v.objectCount(), Error: v.err}

	changed := !v.everFramed || v.colsDirty || len(f.Rows) > 0 ||
		!slices.Equal(order, v.lastOrder) || len(rows) != v.lastTotal ||
		start != v.lastOffset || status != v.lastStatus
	if !changed {
		return Frame{}, false
	}
	if v.colsDirty {
		for _, c := range v.cols {
			f.Columns = append(f.Columns, c.info)
		}
	}
	if status != v.lastStatus || !v.everFramed {
		s := status
		f.Status = &s
	}
	v.seq++
	f.Seq, f.Total, f.Offset, f.Order = v.seq, len(rows), start, order

	v.sent, v.lastOrder, v.lastTotal, v.lastOffset, v.lastStatus = sent, order, len(rows), start, status
	v.colsDirty, v.everFramed = false, true
	return f, true
}

// Resync forces the next frame to resend columns and all visible rows
// (e.g. after the client reloaded).
func (v *View) Resync() {
	v.colsDirty = true
	v.everFramed = false
}

func (v *View) objectCount() int {
	n := 0
	for _, e := range v.entries {
		if e.deletedAt.IsZero() {
			n++
		}
	}
	return n
}

// Detail holds the full (managedFields-stripped) object and the previous
// and current normalized versions for the detail diff. Only produced on
// explicit request.
type Detail struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	YAML     string `json:"yaml"`
	PrevNorm string `json:"prevNorm,omitempty"`
	CurNorm  string `json:"curNorm"`
	Deleted  bool   `json:"deleted,omitempty"`
}

// Object returns the detail for a row key.
func (v *View) Object(key string) (Detail, bool) {
	e, ok := v.entries[key]
	if !ok {
		return Detail{}, false
	}
	d := Detail{Key: key, Name: e.item.Object.GetName(), Deleted: !e.deletedAt.IsZero()}
	d.YAML = toYAML(e.item.Object)
	d.CurNorm = toYAML(e.norm)
	if e.prev != nil {
		d.PrevNorm = toYAML(e.prev)
	}
	return d, true
}

// Deleted reports whether a row key is a tombstone.
func (v *View) Deleted(key string) bool {
	e, ok := v.entries[key]
	return ok && !e.deletedAt.IsZero()
}

// Item returns the source item for a row key (for actions).
func (v *View) Item(key string) (source.Item, bool) {
	e, ok := v.entries[key]
	if !ok {
		return source.Item{}, false
	}
	return e.item, true
}
