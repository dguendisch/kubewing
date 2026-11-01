package view

import (
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// Metric columns (kubectl top, and kubectl describe node's "Allocated
// resources"): offered for pods and nodes in the column configurator, never
// shown by default, fed from outside the object (see SetMetrics): usage
// polled from metrics.k8s.io, a node's allocation summed from its pods. They
// change without the object changing, so they aren't diffed, and the past
// has none (neither is part of the object, nor recorded).

// metricSource is what a metric column is computed from.
type metricSource int

const (
	fromUsage metricSource = iota + 1 // metrics.k8s.io (needs metrics-server)
	fromAlloc                         // the requests and limits of the node's pods
)

// metricGroup names a metric column's group for the column configurator
// ("" = not a metric column).
func (c colSpec) metricGroup() string { return c.metricFrom.group() }

func (s metricSource) group() string {
	switch s {
	case fromUsage:
		return "usage"
	case fromAlloc:
		return "alloc"
	}
	return ""
}

// metricData is what the metric cells of a row are rendered from.
type metricData struct {
	usage    source.Usage
	hasUsage bool
	alloc    source.Allocation
	hasAlloc bool
}

// metricColumns are the metric columns per kind, in their order; nodes
// have extendedColumns too.
var metricColumns = map[string][]colSpec{
	"Pod": {
		metricCol("CPU", pipeline.TypeNumber, fromUsage, cpuCell),
		metricCol("%CPU/R", pipeline.TypeNumber, fromUsage, ofPod("cpu", func(r source.Resources) source.Amounts { return r.Requests })),
		metricCol("%CPU/L", pipeline.TypeNumber, fromUsage, ofPod("cpu", func(r source.Resources) source.Amounts { return r.Limits })),
		metricCol("MEM", pipeline.TypeBytes, fromUsage, memCell),
		metricCol("%MEM/R", pipeline.TypeNumber, fromUsage, ofPod("memory", func(r source.Resources) source.Amounts { return r.Requests })),
		metricCol("%MEM/L", pipeline.TypeNumber, fromUsage, ofPod("memory", func(r source.Resources) source.Amounts { return r.Limits })),
	},
	"Node": {
		metricCol("CPU", pipeline.TypeNumber, fromUsage, cpuCell),
		metricCol("%CPU", pipeline.TypeNumber, fromUsage, ofNode("cpu", func(d metricData) int64 { return d.usage.CPU })),
		metricCol("MEM", pipeline.TypeBytes, fromUsage, memCell),
		metricCol("%MEM", pipeline.TypeNumber, fromUsage, ofNode("memory", func(d metricData) int64 { return d.usage.Memory })),
		// kubectl describe node: requests and limits of its unfinished pods, of allocatable
		allocCol("%CPU REQ", "cpu", requests),
		allocCol("%CPU LIM", "cpu", limits),
		allocCol("%MEM REQ", "memory", requests),
		allocCol("%MEM LIM", "memory", limits),
		allocCol("%EPH REQ", "ephemeral-storage", requests),
		allocCol("%EPH LIM", "ephemeral-storage", limits),
		// out of pod slots, a node takes no more pods however empty it is
		metricCol("PODS", pipeline.TypeNumber, fromAlloc, func(_ map[string]any, d metricData) string { return strconv.FormatInt(d.alloc.Pods, 10) }),
		metricCol("%PODS", pipeline.TypeNumber, fromAlloc, ofNode("pods", func(d metricData) int64 { return d.alloc.Pods })),
	},
}

func requests(a source.Allocation) source.Amounts { return a.Requests }
func limits(a source.Allocation) source.Amounts   { return a.Limits }

// allocCol is a node's pods' requests or limits of a resource, of its allocatable.
func allocCol(name, res string, of func(source.Allocation) source.Amounts) colSpec {
	return metricCol(name, pipeline.TypeNumber, fromAlloc, ofNode(res, func(d metricData) int64 { return of(d.alloc)[res] }))
}

// Extended resources (nvidia.com/gpu …) and huge pages: a node column of
// requests each ("%nvidia.com/gpu REQ"), offered once a node of the pane
// has some allocatable. Their limits always equal their requests (no
// overcommit), so there's no LIM column.

const extendedSuffix = " REQ"

// extendedResource reports whether an allocatable resource gets a column of
// its own: not cpu/memory/ephemeral-storage/pods (fixed columns), not
// kubernetes.io's own (attachable volumes …, which pods don't request).
func extendedResource(name string) bool {
	if strings.HasPrefix(name, "hugepages-") {
		return true
	}
	return strings.Contains(name, "/") && !strings.Contains(name, "kubernetes.io/")
}

func extendedColumn(res string) colSpec {
	return allocCol("%"+res+extendedSuffix, res, requests)
}

// extendedColumnRes is the resource of an extended column's name ("%x REQ").
func extendedColumnRes(name string) (string, bool) {
	res, ok := strings.CutPrefix(name, "%")
	if !ok || len(res) <= len(extendedSuffix) || !strings.EqualFold(res[len(res)-len(extendedSuffix):], extendedSuffix) {
		return "", false
	}
	res = res[:len(res)-len(extendedSuffix)]
	return res, extendedResource(res)
}

// extendedColumns are the columns of the extended resources the nodes have
// shown so far, by name.
func (v *View) extendedColumns() []colSpec {
	out := make([]colSpec, 0, len(v.extended))
	for _, res := range slices.Sorted(maps.Keys(v.extended)) {
		out = append(out, extendedColumn(res))
	}
	return out
}

// noteExtended records the extended resources a node has some of; true if
// one wasn't known (its column is now offered, and resolved if configured).
func (v *View) noteExtended(obj map[string]any) bool {
	if v.opts.Kind != "Node" {
		return false
	}
	st, _ := obj["status"].(map[string]any)
	m, _ := st["allocatable"].(map[string]any)
	added := false
	for res, q := range m {
		if v.extended[res] || !extendedResource(res) {
			continue
		}
		if f, ok := quantity(q); !ok || f <= 0 {
			continue // huge pages of a size not set up ("0")
		}
		if v.extended == nil {
			v.extended = map[string]bool{}
		}
		v.extended[res] = true
		added = true
	}
	return added
}

func metricCol(name string, typ pipeline.ColumnType, src metricSource, f func(obj map[string]any, d metricData) string) colSpec {
	return colSpec{info: ColumnInfo{Name: name, Type: string(typ)}, numeric: true, timeDerived: true, cellIndex: -1, metric: f, metricFrom: src}
}

// cpuCell is millicores as kubectl top shows them ("250m").
func cpuCell(_ map[string]any, d metricData) string {
	if !d.hasUsage {
		return ""
	}
	return strconv.FormatInt(d.usage.CPU, 10) + "m"
}

// memCell is bytes, formatted by the bytes type.
func memCell(_ map[string]any, d metricData) string {
	if !d.hasUsage {
		return ""
	}
	return strconv.FormatInt(d.usage.Memory, 10)
}

// pct is part of total as kubectl prints it: truncated to a whole percent.
func pct(part, total float64) string {
	if total <= 0 {
		return ""
	}
	return strconv.FormatInt(int64(part/total*100), 10) + "%"
}

// ofPod is a pod's usage of a resource ("cpu", "memory") as a percentage
// of its effective requests or limits (see source.PodResources); "" if the
// pod sets none.
func ofPod(res string, of func(source.Resources) source.Amounts) func(map[string]any, metricData) string {
	use := func(u source.Usage) int64 { return u.Memory }
	if res == "cpu" {
		use = func(u source.Usage) int64 { return u.CPU }
	}
	return func(obj map[string]any, d metricData) string {
		if !d.hasUsage {
			return ""
		}
		r, ok := source.PodResources(obj)
		if !ok {
			return ""
		}
		total, set := of(r)[res]
		if !set {
			return ""
		}
		return pct(float64(use(d.usage)), float64(total))
	}
}

// ofNode is part of the data as a percentage of the node's allocatable
// amount of a resource (capacity without one, as kubectl).
func ofNode(name string, part func(metricData) int64) func(map[string]any, metricData) string {
	alloc := name == "cpu"
	return func(obj map[string]any, d metricData) string {
		total, ok := nodeAmount(obj, name)
		if !ok {
			return ""
		}
		v := part(d)
		if alloc {
			// millicores against cores
			return pct(float64(v)/1000, total)
		}
		return pct(float64(v), total)
	}
}

// nodeAmount is status.allocatable[name], else status.capacity[name].
func nodeAmount(obj map[string]any, name string) (float64, bool) {
	st, _ := obj["status"].(map[string]any)
	for _, k := range []string{"allocatable", "capacity"} {
		m, _ := st[k].(map[string]any)
		if len(m) == 0 {
			continue
		}
		return quantity(m[name])
	}
	return 0, false
}

func quantity(v any) (float64, bool) {
	switch x := v.(type) {
	case string:
		q, err := resource.ParseQuantity(x)
		if err != nil {
			return 0, false
		}
		return q.AsApproximateFloat64(), true
	case int64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

// ShowsMetrics reports whether a metric column of a source is shown
// (0: any): its data is to be polled or summed.
func (v *View) ShowsMetrics() bool { return v.shows(0) }

// ShowsUsage: a column from metrics.k8s.io is shown (usage to poll).
func (v *View) ShowsUsage() bool { return v.shows(fromUsage) }

// ShowsAllocation: a column from the node's pods is shown (pods to sum).
func (v *View) ShowsAllocation() bool { return v.shows(fromAlloc) }

func (v *View) shows(src metricSource) bool {
	for _, c := range v.cols {
		if c.metric != nil && (src == 0 || c.metricFrom == src) {
			return true
		}
	}
	return false
}

// Metrics is what the metric columns are fed: usage by namespace/name
// ("/name" for nodes) and its error (why there's none), a node's
// allocation by node name and its error. Nil maps: none (yet);
// AllocLoading: the pods are being listed (the first sums take a while).
type Metrics struct {
	Usage        map[string]source.Usage
	UsageErr     string
	Alloc        map[string]source.Allocation
	AllocErr     string
	AllocLoading bool
}

// SetMetrics sets the metric data and re-renders the metric cells of the
// live rows. In the past it only keeps it for when the pane comes back to
// live.
func (v *View) SetMetrics(m Metrics) {
	v.metrics = m
	if !v.at.IsZero() || !v.ShowsMetrics() {
		return
	}
	for _, e := range v.entries {
		v.renderMetrics(e)
	}
	v.sorted = nil
}

// metricData is a row's data (nothing in the past: only now is known).
func (v *View) metricData(e *entry) metricData {
	var d metricData
	if !v.at.IsZero() {
		return d
	}
	ns, name := e.item.Object.GetNamespace(), e.item.Object.GetName()
	d.usage, d.hasUsage = v.metrics.Usage[ns+"/"+name]
	if ns == "" {
		d.alloc, d.hasAlloc = v.metrics.Alloc[name]
		// a node without a pod running: nothing allocated, not unknown
		if !d.hasAlloc && v.metrics.Alloc != nil {
			d.hasAlloc = true
		}
	}
	return d
}

// metricCell renders a metric column of a row.
func (v *View) metricCell(c colSpec, e *entry, d metricData) string {
	if (c.metricFrom == fromUsage && !d.hasUsage) || (c.metricFrom == fromAlloc && !d.hasAlloc) {
		return ""
	}
	return format(c.metric(e.item.Object.Object, d), c.info.Type)
}

// renderMetrics updates only an entry's metric cells (new data leaves the
// others as they are), then its match: grep sees the cells.
func (v *View) renderMetrics(e *entry) {
	d := v.metricData(e)
	changed := false
	for i, c := range v.cols {
		if c.metric == nil {
			continue
		}
		cell := v.metricCell(c, e, d)
		if cell != e.cells[i] {
			if !changed {
				// cells are shared with sent frames' rows: copy before writing
				e.cells = append([]string(nil), e.cells...)
				changed = true
			}
			e.cells[i] = cell
			e.nums[i] = math.NaN()
			if f, ok := numericValue(cell); ok {
				e.nums[i] = f
			}
		}
	}
	if changed {
		v.evalMatch(e)
	}
}

// percent parses "45%" (a metric column's cell) as 45.
func percent(s string) (float64, bool) {
	n, ok := strings.CutSuffix(s, "%")
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(n, 64)
	return f, err == nil
}
