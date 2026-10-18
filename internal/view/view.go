// Package view applies a pipeline to a stream of source events and produces
// bridge frames with keyed (UID-based) diff markers.
//
// View is not safe for concurrent use; the owner serializes calls.
package view

import (
	"encoding/json"
	"errors"
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
	"k8s.io/apimachinery/pkg/labels"

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
	// matchErr: the filter failed on this object (counted in View.matchErrs)
	matchErr bool

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

	// matchErrs counts live objects whose filter evaluation failed (not
	// "missing field": that's a plain no-match)
	matchErrs int
	firstErr  string

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
	st, err := compileStages(p.Stages)
	if err != nil {
		return nil, err
	}
	v.filters, v.greps, v.sortBy = st.filters, st.greps, st.sortBy
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

type stages struct {
	filters []*expr.Program
	greps   []string
	sortBy  [][]string
}

func compileStages(in []pipeline.Stage) (stages, error) {
	var st stages
	for _, s := range in {
		switch {
		case s.Filter != "":
			prg, err := expr.Compile(s.Filter)
			if err != nil {
				return stages{}, err
			}
			st.filters = append(st.filters, prg)
		case s.Grep != "":
			st.greps = append(st.greps, strings.ToLower(s.Grep))
		case len(s.Sort) > 0:
			st.sortBy = append(st.sortBy, s.Sort)
		}
	}
	return st, nil
}

// SetStages replaces filter, grep and sort stages in place: objects, rendered
// cells and diff state (previous versions, markers) are kept, only the match
// flags and the order are recomputed. On error the view is unchanged.
func (v *View) SetStages(in []pipeline.Stage) error {
	for i, s := range in {
		if _, err := s.Kind(); err != nil {
			return fmt.Errorf("stages[%d]: %w", i, err)
		}
	}
	st, err := compileStages(in)
	if err != nil {
		return err
	}
	v.p.Stages = in
	v.filters, v.greps = st.filters, st.greps
	if !slices.EqualFunc(v.sortBy, st.sortBy, slices.Equal) {
		v.sortBy = st.sortBy
		v.resolveSort()
	}
	v.sorted = nil
	v.firstErr = ""
	for _, e := range v.entries {
		v.evalMatch(e)
	}
	return nil
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
	v.resolveSort()
	for _, e := range v.entries {
		v.render(e)
		e.changedAt = make([]time.Time, len(cols))
	}
}

// resolveSort maps the sort stages onto the current columns.
func (v *View) resolveSort() {
	v.sortKeys = nil
	for _, spec := range v.sortBy {
		for _, s := range spec {
			desc := strings.HasPrefix(s, "-")
			name := strings.TrimPrefix(strings.TrimPrefix(s, "-"), "+")
			for i, c := range v.cols {
				if strings.EqualFold(c.info.Name, name) {
					v.sortKeys = append(v.sortKeys, sortKey{col: i, desc: desc})
					break
				}
			}
		}
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
	v.clearMatchErr(e)
}

func (v *View) clearMatchErr(e *entry) {
	if !e.matchErr {
		return
	}
	e.matchErr = false
	if v.matchErrs--; v.matchErrs == 0 {
		v.firstErr = ""
	}
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
	v.evalMatch(e)
}

// evalMatch sets e.match from the filter and grep stages, keeping the
// pane's error count in step.
func (v *View) evalMatch(e *entry) {
	v.clearMatchErr(e)
	ok, err := matches(e.item.Object.Object, e.cells, v.filters, v.greps)
	e.match = ok
	if err != nil && e.deletedAt.IsZero() {
		e.matchErr = true
		v.matchErrs++
		if v.firstErr == "" {
			v.firstErr = err.Error()
		}
	}
}

// matches applies filters (all must be true) and greps (all must occur in
// the rendered row). The error is the first evaluation failure, if any.
func matches(obj map[string]any, cells []string, filters []*expr.Program, greps []string) (bool, error) {
	for _, f := range filters {
		ok, err := f.Bool(obj)
		if err != nil || !ok {
			return false, err
		}
	}
	if len(greps) > 0 {
		row := strings.ToLower(strings.Join(cells, " "))
		for _, g := range greps {
			if !strings.Contains(row, g) {
				return false, nil
			}
		}
	}
	return true, nil
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
	status := Status{Synced: v.synced, Objects: v.objectCount(), Error: v.err, FilterErrors: v.matchErrs}
	if v.matchErrs > 0 {
		status.FilterError = v.firstErr
	}

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

// HasPrev reports whether a row has a previous version (for the detail diff).
func (v *View) HasPrev(key string) bool {
	e, ok := v.entries[key]
	return ok && e.prev != nil
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

// Preview is the outcome of a draft filter or label selector, evaluated
// against the view's live objects without changing the view.
type Preview struct {
	// Matched of Objects would be shown (the pane's grep still applies).
	Matched int `json:"matched"`
	Objects int `json:"objects"`
	// AtLeast: the draft may match objects that aren't loaded (a label
	// selector wider than the pane's), so Matched is a lower bound.
	AtLeast bool `json:"atLeast,omitempty"`
	// Errors counts objects the expression failed on; Error is one message.
	Errors int    `json:"errors,omitempty"`
	Error  string `json:"error,omitempty"`
	// Invalid: the draft can't be applied (parse error, not a bool); Column
	// is the 0-based position of a parse error, or -1.
	Invalid bool `json:"invalid,omitempty"`
	Column  int  `json:"column"`
}

// PreviewFilter evaluates a draft CEL filter in place of the pane's filter
// stages, together with its grep stages.
func (v *View) PreviewFilter(src string) Preview {
	pv := Preview{Column: -1}
	var filters []*expr.Program
	if strings.TrimSpace(src) != "" {
		prg, err := expr.Compile(src)
		if err != nil {
			pv.Invalid, pv.Error = true, err.Error()
			var ce *expr.Error
			if errors.As(err, &ce) {
				pv.Error, pv.Column = ce.Msg, ce.Column
			}
			return pv
		}
		if t := prg.OutputType(); t != "bool" && t != "dyn" {
			pv.Invalid, pv.Error = true, fmt.Sprintf("result is %s, not bool", t)
			return pv
		}
		filters = []*expr.Program{prg}
	}
	nonBool := true
	for _, e := range v.entries {
		if !e.deletedAt.IsZero() {
			continue
		}
		pv.Objects++
		ok, err := matches(e.item.Object.Object, e.cells, filters, v.greps)
		var nb *expr.NotBoolError
		switch {
		case err == nil:
			nonBool = false
		case errors.As(err, &nb):
		default:
			nonBool = false
		}
		if err != nil {
			pv.Errors++
			if pv.Error == "" {
				pv.Error = err.Error()
			}
		}
		if ok {
			pv.Matched++
		}
	}
	// a path like o.status.phase compiles (dyn) but is never a condition
	if pv.Objects > 0 && pv.Errors == pv.Objects && nonBool {
		pv.Invalid = true
	}
	return pv
}

// PreviewLabels evaluates a draft label selector against the view's live
// objects, together with its filter and grep stages. applied is the
// selector the source was opened with: objects outside it aren't loaded,
// so unless the draft is at least as strict the count is a lower bound.
func (v *View) PreviewLabels(draft, applied string) Preview {
	pv := Preview{Column: -1}
	sel, err := labels.Parse(draft)
	if err != nil {
		pv.Invalid, pv.Error = true, err.Error()
		return pv
	}
	pv.AtLeast = !narrower(draft, applied)
	for _, e := range v.entries {
		if !e.deletedAt.IsZero() {
			continue
		}
		pv.Objects++
		if !sel.Matches(labels.Set(e.item.Object.GetLabels())) {
			continue
		}
		if ok, _ := matches(e.item.Object.Object, e.cells, v.filters, v.greps); ok {
			pv.Matched++
		}
	}
	return pv
}

// narrower reports whether every requirement of applied is also one of
// draft (so draft selects a subset of what's loaded). Conservative: an
// equivalent selector written differently counts as not narrower.
func narrower(draft, applied string) bool {
	a, err := labels.ParseToRequirements(applied)
	if err != nil {
		return false
	}
	d, err := labels.ParseToRequirements(draft)
	if err != nil {
		return false
	}
	for _, r := range a {
		if !slices.ContainsFunc(d, func(x labels.Requirement) bool { return x.Equal(r) }) {
			return false
		}
	}
	return true
}

// FieldKey is a completion candidate for a CEL field path.
type FieldKey struct {
	Key string `json:"key"`
	// Type is "map", "list", "string", "int", "double", "bool" or "null";
	// the most common one if objects disagree.
	Type string `json:"type"`
	// Count of the view's live objects that have the key.
	Count int `json:"count"`
}

// FieldKeys lists the keys found at a dot path (relative to the object,
// e.g. "status.containerStatuses") across the view's live objects, most
// common first. A list on the way is looked into element-wise, so the keys
// of `status.containerStatuses` are those of its items. At most limit keys.
func (v *View) FieldKeys(path string, limit int) (keys []FieldKey, objects int) {
	var segs []string
	if path != "" {
		segs = strings.Split(path, ".")
	}
	type stat struct {
		n     int
		types map[string]int
	}
	stats := map[string]*stat{}
	for _, e := range v.entries {
		if !e.deletedAt.IsZero() {
			continue
		}
		objects++
		seen := map[string]bool{}
		var walk func(cur any, segs []string)
		walk = func(cur any, segs []string) {
			switch x := cur.(type) {
			case []any:
				for _, el := range x {
					walk(el, segs)
				}
			case map[string]any:
				if len(segs) > 0 {
					walk(x[segs[0]], segs[1:])
					return
				}
				for k, val := range x {
					st := stats[k]
					if st == nil {
						st = &stat{types: map[string]int{}}
						stats[k] = st
					}
					st.types[jsonType(val)]++
					if !seen[k] {
						seen[k] = true
						st.n++
					}
				}
			}
		}
		walk(e.item.Object.Object, segs)
	}
	for k, st := range stats {
		best := ""
		for t, n := range st.types {
			if best == "" || n > st.types[best] || (n == st.types[best] && t < best) {
				best = t
			}
		}
		keys = append(keys, FieldKey{Key: k, Type: best, Count: st.n})
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Count != keys[j].Count {
			return keys[i].Count > keys[j].Count
		}
		return keys[i].Key < keys[j].Key
	})
	if limit > 0 && len(keys) > limit {
		keys = keys[:limit]
	}
	return keys, objects
}

func jsonType(v any) string {
	switch v.(type) {
	case map[string]any:
		return "map"
	case []any:
		return "list"
	case string:
		return "string"
	case int64, int, int32, uint64:
		return "int"
	case float64, float32:
		return "double"
	case bool:
		return "bool"
	case nil:
		return "null"
	}
	return fmt.Sprintf("%T", v)
}
