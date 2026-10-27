// Package view applies a pipeline to a stream of source events and produces
// bridge frames with keyed (UID-based) diff markers.
//
// View is not safe for concurrent use; the owner serializes calls.
package view

import (
	"cmp"
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
	sigsyaml "sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/expr"
	"github.com/dguendisch/kubewing/internal/fieldpath"
	"github.com/dguendisch/kubewing/internal/history"
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
	// Normalizer applies to items that come without Norm; items from a
	// watch recording history come normalized by it.
	Normalizer *normalize.Normalizer
	// History is the shared watch's history (Subscription.History), read
	// for rows whose items it recorded; nil = none (only the previous
	// version, kept by the view).
	History Versions
	// Namespaced controls default columns when the server provides none.
	Namespaced bool
}

// Versions reads an object's recorded versions (source.History).
type Versions interface {
	Range(key string) (first, last int)
	Pair(key string, to int) (history.Pair, bool)
	Recording() bool
	Usage() (bytes int, limits history.Limits, ok bool)
	// for time-travel
	At(t time.Time) map[string]history.Version
	Span() (history.Span, bool)
	Changes(from, to time.Time, keep func(key string) bool) []time.Time
	VersionAt(key string, t time.Time) int
	Field(key string, p fieldpath.Path) []history.FieldChange
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
	info ColumnInfo
	// priority > 0: a server column kubectl shows only with -o wide
	priority    int32
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
	prev  *unstructured.Unstructured // previous normalized version, for the detail diff without history
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
	// goneLater: in the past, back in a step backward (it's deleted later);
	// marked like a deleted row, but there at this moment
	goneLater bool
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

	filters     []*expr.Program
	greps       []pipeline.GrepTerm
	hideHealthy bool
	sortBy      [][]string // raw sort specs, resolved against cols

	// shown: the configured columns (empty = the server's defaults), resolved
	// against serverDefs, the column definitions of the last relist (nil = none
	// yet, or the source isn't a server table)
	shown      []pipeline.Column
	serverDefs []metav1.TableColumnDefinition
	cols       []colSpec
	sortKeys   []sortKey

	entries map[string]*entry
	synced  bool

	// time-travel: at is the moment shown (zero = live). Then entries are
	// the objects as they were at it (from the history) and live holds the
	// live ones, which events keep updating (behind counts them).
	at     time.Time
	live   map[string]*entry
	behind int
	err    string

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
	v.filters, v.greps, v.hideHealthy, v.sortBy = st.filters, st.greps, st.hideHealthy, st.sortBy
	cols, err := v.resolveColumns(p.Render.Columns, nil)
	if err != nil {
		return nil, err
	}
	v.shown = p.Render.Columns
	v.setColumns(cols)
	return v, nil
}

// SetRender replaces the shown columns in place: objects and diff state are
// kept, the cells are rendered again. On error the view is unchanged.
func (v *View) SetRender(r pipeline.Render) error {
	p := v.p
	p.Render = r
	if err := p.Validate(); err != nil {
		return err
	}
	cols, err := v.resolveColumns(r.Columns, v.serverDefs)
	if err != nil {
		return err
	}
	v.p.Render, v.shown = r, r.Columns
	v.setColumns(cols)
	return nil
}

type stages struct {
	filters     []*expr.Program
	greps       []pipeline.GrepTerm
	hideHealthy bool
	sortBy      [][]string
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
			st.greps = append(st.greps, pipeline.ParseGrep(s.Grep)...)
		case len(s.Sort) > 0:
			st.sortBy = append(st.sortBy, s.Sort)
		case s.HideHealthy:
			st.hideHealthy = true
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
	v.filters, v.greps, v.hideHealthy = st.filters, st.greps, st.hideHealthy
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

// resolveColumns compiles the shown columns: none = the server's defaults
// (or NAME/AGE without a server table); otherwise in order, custom ones
// compiled, server ones looked up by name among all server columns (a name
// the resource doesn't have is left out).
func (v *View) resolveColumns(render []pipeline.Column, defs []metav1.TableColumnDefinition) ([]colSpec, error) {
	available := v.availableColumns(defs)
	if len(render) == 0 {
		var out []colSpec
		for _, c := range available {
			if c.priority == 0 {
				out = append(out, c)
			}
		}
		return out, nil
	}
	var out []colSpec
	for _, c := range render {
		if !c.Server() {
			cs, err := compileColumns([]pipeline.Column{c})
			if err != nil {
				return nil, err
			}
			out = append(out, cs...)
			continue
		}
		if i := slices.IndexFunc(available, func(a colSpec) bool { return strings.EqualFold(a.info.Name, c.Name) }); i >= 0 {
			out = append(out, available[i])
		}
	}
	return out, nil
}

// availableColumns are all server columns, -o wide ones too; without a
// server table (nil defs) the built-in NAMESPACE/NAME/AGE.
func (v *View) availableColumns(defs []metav1.TableColumnDefinition) []colSpec {
	if defs == nil {
		return defaultColumns(v.opts.Namespaced)
	}
	return serverColumns(defs, v.opts.Namespaced)
}

// ColumnOption is a column the column configurator offers: a server column
// (Priority > 0: -o wide only), or a custom one of the shown columns.
type ColumnOption struct {
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"`
	Priority int32  `json:"priority,omitempty"`
	Shown    bool   `json:"shown"`
	// Path or Expr: a custom column
	Path string `json:"path,omitempty"`
	Expr string `json:"expr,omitempty"`
	// Missing: a server column of the config this resource doesn't have
	Missing bool `json:"missing,omitempty"`
}

// ColumnChoices are what the column configurator offers for a pane.
type ColumnChoices struct {
	// Options: the shown columns in order, then the server columns not shown
	// (in the server's order).
	Options []ColumnOption `json:"options"`
	// Defaults: the columns shown without settings, in order.
	Defaults []string `json:"defaults"`
}

// ColumnChoices lists the pane's columns for the column configurator.
func (v *View) ColumnChoices() ColumnChoices {
	defaults := []string{}
	for _, c := range v.availableColumns(v.serverDefs) {
		if c.priority == 0 {
			defaults = append(defaults, c.info.Name)
		}
	}
	opts := v.columnOptions()
	if opts == nil {
		opts = []ColumnOption{}
	}
	return ColumnChoices{Options: opts, Defaults: defaults}
}

func (v *View) columnOptions() []ColumnOption {
	available := v.availableColumns(v.serverDefs)
	var out []ColumnOption
	shown := map[string]bool{}
	if len(v.shown) == 0 {
		for _, c := range v.cols {
			out = append(out, ColumnOption{Name: c.info.Name, Type: c.info.Type, Priority: c.priority, Shown: true})
			shown[strings.ToUpper(c.info.Name)] = true
		}
	}
	for _, c := range v.shown {
		shown[strings.ToUpper(c.Name)] = true
		if !c.Server() {
			out = append(out, ColumnOption{Name: c.Name, Type: string(c.Type), Shown: true, Path: c.Path, Expr: c.Expr})
			continue
		}
		o := ColumnOption{Name: c.Name, Shown: true, Missing: true}
		if i := slices.IndexFunc(available, func(a colSpec) bool { return strings.EqualFold(a.info.Name, c.Name) }); i >= 0 {
			a := available[i]
			o = ColumnOption{Name: a.info.Name, Type: a.info.Type, Priority: a.priority, Shown: true}
		}
		out = append(out, o)
	}
	for _, c := range available {
		if !shown[strings.ToUpper(c.info.Name)] {
			out = append(out, ColumnOption{Name: c.info.Name, Type: c.info.Type, Priority: c.priority})
		}
	}
	return out
}

// serverColumns maps all server-side table columns, -o wide ones (priority >
// 0) too. Date columns are time-derived; "Age" is re-derived from
// creationTimestamp so the frontend can render it against its own clock.
func serverColumns(defs []metav1.TableColumnDefinition, namespaced bool) []colSpec {
	var out []colSpec
	if namespaced {
		ns, _ := expr.CompilePath("metadata.namespace")
		out = append(out, colSpec{info: ColumnInfo{Name: "NAMESPACE"}, path: ns, cellIndex: -1})
	}
	for i, d := range defs {
		cs := colSpec{info: ColumnInfo{Name: strings.ToUpper(d.Name)}, priority: d.Priority, cellIndex: i}
		switch d.Type {
		case "integer", "number":
			cs.numeric = true
			cs.info.Type = string(pipeline.TypeNumber)
		case "date":
			cs.timeDerived = true
		}
		// apiservers send Age as text ("5m", type string), CRD printer columns as a date: either
		// way it's re-derived from the creation timestamp, so it ticks and sorts by time
		if strings.EqualFold(d.Name, "age") {
			cs.timeDerived = true
			cs.creation = true
			cs.cellIndex = -1
			cs.numeric = false
			cs.info.Type = string(pipeline.TypeAge)
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

// Apply feeds one source event into the view. While showing the past, it
// updates the live objects behind it (and counts it).
func (v *View) Apply(ev source.Event, now time.Time) {
	if !v.at.IsZero() {
		past, dirty := v.entries, v.colsDirty
		v.entries = v.live
		v.apply(ev, now)
		v.live, v.entries = v.entries, past
		if ev.Type != source.Error {
			v.behind++
		}
		if v.colsDirty && !dirty {
			// new server columns: the past is rendered with them too
			v.travel(v.at, false)
		}
		return
	}
	v.apply(ev, now)
}

func (v *View) apply(ev source.Event, now time.Time) {
	if ev.Type != source.Error {
		v.sorted = nil
	}
	switch ev.Type {
	case source.Error:
		v.err = ev.Err
		return
	case source.Relist:
		v.err = ""
		if ev.Columns != nil {
			v.serverDefs = ev.Columns
			// can't fail: custom columns compiled before
			cols, _ := v.resolveColumns(v.shown, ev.Columns)
			v.setColumns(cols)
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
	norm, hash := it.Norm, it.Hash
	if norm == nil {
		norm = v.opts.Normalizer.Normalize(it.Object)
	}
	if hash == "" {
		hash = normalize.Hash(norm)
	}

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

	oldCells, oldHash := e.cells, e.hash
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
	if !visible && oldHash != hash {
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
		} else if f, ok := humanDuration(cells[i]); ok {
			// a duration as kubectl prints it (Last Seen: "5m", "2d3h"): sorted by its length
			e.nums[i] = f
		}
	}
	v.evalMatch(e)
}

// evalMatch sets e.match from the filter, grep and hideHealthy stages,
// keeping the pane's error count in step.
func (v *View) evalMatch(e *entry) {
	v.clearMatchErr(e)
	ok, err := v.matches(e, v.filters)
	e.match = ok
	if err != nil && e.deletedAt.IsZero() {
		e.matchErr = true
		v.matchErrs++
		if v.firstErr == "" {
			v.firstErr = err.Error()
		}
	}
}

// matches applies the view's stages to an entry, with filters in place of
// the view's own (a draft filter is previewed that way).
func (v *View) matches(e *entry, filters []*expr.Program) (bool, error) {
	if v.hideHealthy && healthy(e.item.Object.Object) {
		return false, nil
	}
	return matches(e.item.Object.Object, e.cells, filters, v.greps)
}

// matches applies filters (all must be true) and grep terms (each must
// occur in the rendered row, or for a negated term must not). The error is
// the first evaluation failure, if any.
func matches(obj map[string]any, cells []string, filters []*expr.Program, greps []pipeline.GrepTerm) (bool, error) {
	for _, f := range filters {
		ok, err := f.Bool(obj)
		if err != nil || !ok {
			return false, err
		}
	}
	if len(greps) > 0 {
		row := strings.ToLower(strings.Join(cells, " "))
		for _, g := range greps {
			if strings.Contains(row, g.Text) == g.Not {
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

// humanDuration parses a duration as kubectl prints it (duration.HumanDuration:
// "10s", "5m", "2d3h", "3y45d") into seconds; anything else is not one.
func humanDuration(s string) (float64, bool) {
	if s == "" || s[0] < '0' || s[0] > '9' {
		return 0, false
	}
	units := map[byte]float64{'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'y': 365 * 86400}
	var total, n float64
	digits := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			n = n*10 + float64(c-'0')
			digits = true
		case units[c] > 0 && digits:
			total += n * units[c]
			n, digits = 0, false
		default:
			return 0, false
		}
	}
	if digits {
		return 0, false // a bare number isn't a duration
	}
	return total, true
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
		// empty cells sort last in either direction; so does one that isn't a duration
		// (<unknown>) next to one that is
		ae, be := a.cells[sk.col] == "", b.cells[sk.col] == ""
		if ae != be {
			return be
		}
		if !v.cols[sk.col].numeric {
			ad, bd := !math.IsNaN(a.nums[sk.col]), !math.IsNaN(b.nums[sk.col])
			if ad != bd {
				return ad
			}
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
	if v.cols[col].info.Type == string(pipeline.TypeAge) {
		// the cell is a timestamp, shown as an age: ascending = youngest first, as the column reads
		return strings.Compare(y, x)
	}
	if !v.cols[col].numeric {
		// durations as text ("5m" vs "2d3h") compare by their length when both are one
		if fx, fy := a.nums[col], b.nums[col]; !math.IsNaN(fx) && !math.IsNaN(fy) {
			return cmp.Compare(fx, fy)
		}
	}
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
	case !e.deletedAt.IsZero(), e.goneLater:
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
	if v.at.IsZero() {
		v.prune(now)
	} else {
		// markers of a past moment are about the step there; they stay
		now = v.at
	}
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
	status.Recording = v.opts.History != nil && v.opts.History.Recording()
	if !v.at.IsZero() {
		status.At, status.Behind = v.at.UTC().Format(time.RFC3339Nano), v.behind
	}
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

// Detail holds the full (managedFields-stripped) object and two normalized
// versions for the detail diff. Only produced on explicit request.
type Detail struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	YAML     string `json:"yaml"`
	PrevNorm string `json:"prevNorm,omitempty"`
	CurNorm  string `json:"curNorm"`
	Deleted  bool   `json:"deleted,omitempty"`
	// Diff: which versions PrevNorm and CurNorm are, and what can be
	// stepped to; nil if the history has nothing for the row.
	Diff *DiffInfo `json:"diff,omitempty"`
}

// DiffInfo places a detail diff in an object's history. Versions count up
// per object; First..Last are the ones kept (at most a few dozen).
type DiffInfo struct {
	// From → To are the versions diffed (From 0: To is the first, nothing before)
	From int `json:"from"`
	To   int `json:"to"`
	// FromAt / ToAt: when they were seen (RFC 3339; FromAt "" with From 0)
	FromAt string `json:"fromAt,omitempty"`
	ToAt   string `json:"toAt"`
	First  int    `json:"first"`
	Last   int    `json:"last"`
	// Changes: To's field paths that differ from From, as `path: old → new`
	Changes []string `json:"changes,omitempty"`
}

// Object returns the detail for a row key: its newest version diffed
// against the one before.
func (v *View) Object(key string) (Detail, bool) { return v.ObjectAt(key, 0) }

// ObjectAt returns the detail for a row key with version to diffed against
// the one before it; to ≤ 0 or past the newest = the newest, before the
// oldest kept = the oldest. With history recorded for the row the versions
// come from it, which can be a few events ahead of the row under an event
// storm (still queued for the view); the YAML is the row's object. Without,
// it's the previous version against the current one (to is ignored).
func (v *View) ObjectAt(key string, to int) (Detail, bool) {
	e, ok := v.entries[key]
	if !ok {
		return Detail{}, false
	}
	d := Detail{Key: key, Name: e.item.Object.GetName(), Deleted: !e.deletedAt.IsZero()}
	d.YAML = toYAML(e.item.Object)
	d.CurNorm = toYAML(e.norm)
	if to <= 0 && !v.at.IsZero() && v.opts.History != nil {
		// in the past: the version then (diffed against the one before)
		to = v.opts.History.VersionAt(key, v.at)
	}
	p, ok := v.pair(e, to)
	if !ok {
		if e.prev != nil {
			d.PrevNorm = toYAML(e.prev)
		}
		return d, true
	}
	d.CurNorm = toYAML(p.Cur.Object)
	info := &DiffInfo{To: p.Cur.N, ToAt: p.Cur.At.UTC().Format(time.RFC3339), First: p.First, Last: p.Last}
	if p.Prev != nil {
		info.From, info.FromAt = p.Prev.N, p.Prev.At.UTC().Format(time.RFC3339)
		d.PrevNorm = toYAML(p.Prev.Object)
		for _, c := range p.Cur.Changes {
			info.Changes = append(info.Changes, c.String())
		}
	}
	d.Diff = info
	return d, true
}

// pair reads a row's versions from the history, if it recorded the row.
func (v *View) pair(e *entry, to int) (history.Pair, bool) {
	if v.opts.History == nil || e.item.Norm == nil {
		return history.Pair{}, false
	}
	return v.opts.History.Pair(e.key, to)
}

// HasPrev reports whether a row has a previous version (for the detail diff).
func (v *View) HasPrev(key string) bool {
	e, ok := v.entries[key]
	if !ok {
		return false
	}
	if v.opts.History != nil && e.item.Norm != nil {
		if first, last := v.opts.History.Range(key); last > first {
			return true
		}
	}
	return e.prev != nil
}

// Time-travel. The view shows the objects as they were at a moment, from
// the history; filters, sort, columns and the detail view work on them as
// on the live ones. Markers say what changed in the step to that moment.

// ErrNoHistory: time-travel needs a source that records history.
var ErrNoHistory = errors.New("not recording history")

// Timeline is what a pane can travel over.
type Timeline struct {
	// Horizon..Newest is the recorded span (RFC 3339); At the moment shown ("" = live).
	Horizon string `json:"horizon"`
	Newest  string `json:"newest"`
	At      string `json:"at,omitempty"`
	// Changes are the moments a row of the pane changed (its filter and
	// grep applied to the live rows; deleted ones too), ascending, at most
	// a few hundred (the newest).
	Changes []string `json:"changes"`
	// Bytes is the source's recorded history's estimated size (all its
	// objects, not only the pane's rows); Budget its limit.
	Bytes  int `json:"bytes"`
	Budget int `json:"budget"`
}

const maxTimelineChanges = 500

// Timeline returns the pane's timeline.
func (v *View) Timeline() (Timeline, error) {
	if v.opts.History == nil {
		return Timeline{}, ErrNoHistory
	}
	sp, ok := v.opts.History.Span()
	if !ok {
		return Timeline{}, ErrNoHistory
	}
	tl := Timeline{Horizon: rfc(sp.Horizon), Newest: rfc(sp.Newest), Changes: []string{}}
	if b, l, ok := v.opts.History.Usage(); ok {
		tl.Bytes, tl.Budget = b, l.Budget
	}
	if !v.at.IsZero() {
		tl.At = rfc(v.at)
	}
	// the pane's rows: its filter applies to every object it has seen at
	// some point (live or past), so changes to rows it hides don't tick
	shown := map[string]bool{}
	for _, m := range []map[string]*entry{v.entries, v.live} {
		for k, e := range m {
			if e.match {
				shown[k] = true
			}
		}
	}
	keep := func(k string) bool {
		if _, ok := v.liveOrPast(k); !ok {
			return true // gone from both: deleted before, still in the history
		}
		return shown[k]
	}
	ch := v.opts.History.Changes(sp.Horizon, sp.Newest, keep)
	if len(ch) > maxTimelineChanges {
		ch = ch[len(ch)-maxTimelineChanges:]
	}
	for _, t := range ch {
		tl.Changes = append(tl.Changes, rfc(t))
	}
	return tl, nil
}

func (v *View) liveOrPast(k string) (*entry, bool) {
	if e, ok := v.entries[k]; ok {
		return e, true
	}
	e, ok := v.live[k]
	return e, ok
}

func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// At returns the moment shown (zero = live).
func (v *View) At() time.Time { return v.at }

// SetTime shows the objects as they were at t (clamped to the recorded
// span); zero t goes back to live.
func (v *View) SetTime(t time.Time) error {
	if t.IsZero() {
		if v.at.IsZero() {
			return nil
		}
		v.entries, v.live, v.at, v.behind = v.live, nil, time.Time{}, 0
		// stages or columns may have changed in the past: the live rows follow
		v.firstErr, v.matchErrs = "", 0
		for _, e := range v.entries {
			e.matchErr = false
			v.render(e)
			if len(e.changedAt) != len(v.cols) {
				e.changedAt = make([]time.Time, len(v.cols))
			}
		}
		v.sorted = nil
		return nil
	}
	if v.opts.History == nil || !v.opts.History.Recording() {
		return ErrNoHistory
	}
	sp, _ := v.opts.History.Span()
	if t.Before(sp.Horizon) {
		t = sp.Horizon
	}
	v.travel(t, true)
	return nil
}

// travel builds the entries for t. marks: diff them against the moment
// shown before (the step's markers); without, the past is rebuilt in place
// (new columns) and the markers stay. Forward, a row new in the step is
// added and one gone stays as deleted; backward, a row that wasn't there
// yet just goes and one back (deleted later) is marked deleted.
func (v *View) travel(t time.Time, marks bool) {
	forward := !v.at.IsZero() && t.After(v.at)
	if v.at.IsZero() {
		v.live = v.entries
		v.behind = 0
		// clear the live rows' errors from the count; the past's are its own
		v.firstErr, v.matchErrs = "", 0
		for _, e := range v.live {
			e.matchErr = false
		}
	}
	before := v.entries
	if before == nil || v.at.IsZero() {
		before = nil
	}
	vs := v.opts.History.At(t)
	past := make(map[string]*entry, len(vs))
	v.firstErr, v.matchErrs = "", 0
	for k, ver := range vs {
		e := &entry{key: k, changedAt: make([]time.Time, len(v.cols))}
		e.item = source.Item{Object: ver.Object, Cells: ver.Cells, Norm: ver.Object}
		e.norm = ver.Object
		past[k] = e
	}
	v.entries = past
	for _, e := range past {
		v.render(e)
	}
	if marks && before != nil {
		for k, e := range past {
			old, ok := before[k]
			switch {
			case (!ok || !old.deletedAt.IsZero()) && forward:
				e.addedAt = t
			case !ok || !old.deletedAt.IsZero():
				e.goneLater = true
			default:
				for i := range v.cols {
					if !v.cols[i].timeDerived && i < len(old.cells) && old.cells[i] != e.cells[i] {
						e.changedAt[i] = t
					}
				}
			}
		}
		// rows gone in a step forward stay as tombstones of the step
		for k, old := range before {
			if _, ok := past[k]; !ok && old.deletedAt.IsZero() && forward {
				e := &entry{key: k, item: old.item, norm: old.norm, changedAt: make([]time.Time, len(v.cols)), deletedAt: t}
				past[k] = e
				v.render(e)
			}
		}
	} else if !marks && before != nil {
		for k, e := range past {
			if old, ok := before[k]; ok {
				e.addedAt, e.deletedAt, e.hiddenAt, e.goneLater = old.addedAt, old.deletedAt, old.hiddenAt, old.goneLater
			}
		}
	}
	v.at = t
	v.sorted = nil
}

// Step moves the moment shown n changes of the pane's rows forward (n > 0)
// or back (n < 0); from live, back starts at the newest change. Past the
// last change that way it stops there; moved false: not even one step.
func (v *View) Step(n int) (bool, error) {
	tl, err := v.Timeline()
	if err != nil || n == 0 {
		return false, err
	}
	// the stops: the start (horizon), then each change
	stops := []time.Time{}
	h, _ := time.Parse(time.RFC3339Nano, tl.Horizon)
	stops = append(stops, h)
	for _, c := range tl.Changes {
		if t, _ := time.Parse(time.RFC3339Nano, c); t.After(h) {
			stops = append(stops, t)
		}
	}
	// where the moment is, between stops: at a stop it's that stop; between
	// two (or after the last, live included) back goes to the one before it,
	// forward to the one after
	i := len(stops) // live: after the last
	if !v.at.IsZero() {
		i = sort.Search(len(stops), func(i int) bool { return !stops[i].Before(v.at) })
	}
	var to int
	switch {
	case i < len(stops) && stops[i].Equal(v.at):
		to = i + n
	case n < 0:
		to = i + n // i is the next stop: one back is the one before the moment
	default:
		to = i + n - 1
	}
	to = max(0, min(to, len(stops)-1))
	if !v.at.IsZero() && stops[to].Equal(v.at) {
		return false, nil
	}
	return true, v.SetTime(stops[to])
}

// FieldHistory is one field's values over a row's history.
type FieldHistory struct {
	Path    string       `json:"path"`
	Changes []FieldValue `json:"changes"`
}

// FieldValue is a field's value from At on (Absent: not set).
type FieldValue struct {
	At      string `json:"at"`
	Value   string `json:"value,omitempty"`
	Absent  bool   `json:"absent,omitempty"`
	Version int    `json:"version"`
}

// FieldAt returns the history of the field on line (0-based) of a row's
// YAML as the detail view shows it: which "yaml" (the object, Detail.YAML)
// or "norm" (the normalized version to, Detail.CurNorm; 0 = the one shown).
// A field the noise rules drop has no history.
func (v *View) FieldAt(key string, to, line int, which string) (FieldHistory, error) {
	if v.opts.History == nil || !v.opts.History.Recording() {
		return FieldHistory{}, ErrNoHistory
	}
	d, ok := v.ObjectAt(key, to)
	if !ok {
		return FieldHistory{}, fmt.Errorf("object %s not found", key)
	}
	text := d.CurNorm
	if which == "yaml" {
		text = d.YAML
	}
	var obj map[string]any
	if err := sigsyaml.Unmarshal([]byte(text), &obj); err != nil {
		return FieldHistory{}, err
	}
	p, err := fieldpath.AtLine(text, line, obj)
	if err != nil {
		return FieldHistory{}, err
	}
	fh := FieldHistory{Path: p.String(), Changes: []FieldValue{}}
	for _, c := range v.opts.History.Field(key, p) {
		fv := FieldValue{At: rfc(c.At), Version: c.N, Absent: !c.Present}
		if c.Present {
			fv.Value = scalar(c.Value)
		}
		fh.Changes = append(fh.Changes, fv)
	}
	return fh, nil
}

// scalar renders a field value on one line (maps and lists as JSON).
func scalar(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]any, []any:
		b, _ := json.Marshal(x)
		return string(b)
	}
	return fmt.Sprint(v)
}

// Changes returns how many changes of a row the history keeps (0 without
// recorded history for it).
func (v *View) Changes(key string) int {
	e, ok := v.entries[key]
	if !ok || v.opts.History == nil || e.item.Norm == nil {
		return 0
	}
	first, last := v.opts.History.Range(key)
	return max(0, last-first)
}

// Deleted reports whether a row key is a tombstone.
func (v *View) Deleted(key string) bool {
	e, ok := v.entries[key]
	return ok && !e.deletedAt.IsZero()
}

// Synced reports whether the source delivered its first list, and how
// many live objects the view holds (filters not applied).
func (v *View) Synced() (bool, int) { return v.synced, v.objectCount() }

// Index is a row's position in the display order (filters and sort
// applied), or -1 if it isn't shown.
func (v *View) Index(key string) int {
	for i, e := range v.rows() {
		if e.key == key {
			return i
		}
	}
	return -1
}

// MatchedItems returns the live (non-tombstone) items the view currently
// shows: its filter, grep and hide-healthy stages applied, order ignored.
// It lets a consumer (the log tail) track exactly the objects a pane shows.
func (v *View) MatchedItems() []source.Item {
	var out []source.Item
	for _, e := range v.rows() {
		if e.deletedAt.IsZero() {
			out = append(out, e.item)
		}
	}
	return out
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
		ok, err := v.matches(e, filters)
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
		if ok, _ := v.matches(e, v.filters); ok {
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

// FieldKeys lists the keys found at a path (keys from the object down, e.g.
// [status containerStatuses]; nil for the top level) across the view's live
// objects, most common first. Keys are taken as they are, so a key with dots
// (`app.kubernetes.io/name`) is one step. A list on the way is looked into
// element-wise, so the keys of `status.containerStatuses` are those of its
// items. At most limit keys.
func (v *View) FieldKeys(segs []string, limit int) (keys []FieldKey, objects int) {
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
		visit(e.item.Object.Object, segs, func(cur any) {
			x, ok := cur.(map[string]any)
			if !ok {
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
		})
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

// ValueCount is a completion candidate for a field's value.
type ValueCount struct {
	Value string `json:"value"`
	// Count of the view's live objects that have the value.
	Count int `json:"count"`
}

// FieldValues lists the scalar values found at a path (as for FieldKeys,
// e.g. [metadata labels app]) across the view's live objects, most common
// first. Lists on the way and at the end are looked into element-wise.
// Strings are taken as they are, numbers and bools formatted; maps, lists
// and null are skipped. At most limit values.
func (v *View) FieldValues(segs []string, limit int) (values []ValueCount, objects int) {
	counts := map[string]int{}
	for _, e := range v.entries {
		if !e.deletedAt.IsZero() {
			continue
		}
		objects++
		seen := map[string]bool{}
		visit(e.item.Object.Object, segs, func(cur any) {
			var s string
			switch x := cur.(type) {
			case map[string]any:
				return
			case string:
				s = x
			default:
				s = fmt.Sprint(x)
			}
			if !seen[s] {
				seen[s] = true
				counts[s]++
			}
		})
	}
	for s, n := range counts {
		values = append(values, ValueCount{Value: s, Count: n})
	}
	sort.Slice(values, func(i, j int) bool {
		if values[i].Count != values[j].Count {
			return values[i].Count > values[j].Count
		}
		return values[i].Value < values[j].Value
	})
	if limit > 0 && len(values) > limit {
		values = values[:limit]
	}
	return values, objects
}

// visit calls fn with what is at the path below cur (nothing if it's
// missing); a list on the way or at the end is looked into element-wise.
func visit(cur any, segs []string, fn func(any)) {
	switch x := cur.(type) {
	case []any:
		for _, el := range x {
			visit(el, segs, fn)
		}
	case map[string]any:
		if len(segs) > 0 {
			visit(x[segs[0]], segs[1:], fn)
			return
		}
		fn(x)
	case nil:
	default:
		if len(segs) == 0 {
			fn(x)
		}
	}
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
