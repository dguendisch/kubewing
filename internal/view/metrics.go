package view

import (
	"math"
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
func (c colSpec) metricGroup() string {
	switch c.metricFrom {
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

// metricColumns are the metric columns per kind, in their order.
var metricColumns = map[string][]colSpec{
	"Pod": {
		metricCol("CPU", pipeline.TypeNumber, fromUsage, cpuCell),
		metricCol("%CPU/R", pipeline.TypeNumber, fromUsage, ofPod(func(u source.Usage) int64 { return u.CPU }, func(r source.Resources) (int64, bool) { return r.Requests.CPU, r.ReqCPU })),
		metricCol("%CPU/L", pipeline.TypeNumber, fromUsage, ofPod(func(u source.Usage) int64 { return u.CPU }, func(r source.Resources) (int64, bool) { return r.Limits.CPU, r.LimCPU })),
		metricCol("MEM", pipeline.TypeBytes, fromUsage, memCell),
		metricCol("%MEM/R", pipeline.TypeNumber, fromUsage, ofPod(func(u source.Usage) int64 { return u.Memory }, func(r source.Resources) (int64, bool) { return r.Requests.Memory, r.ReqMemory })),
		metricCol("%MEM/L", pipeline.TypeNumber, fromUsage, ofPod(func(u source.Usage) int64 { return u.Memory }, func(r source.Resources) (int64, bool) { return r.Limits.Memory, r.LimMemory })),
	},
	"Node": {
		metricCol("CPU", pipeline.TypeNumber, fromUsage, cpuCell),
		metricCol("%CPU", pipeline.TypeNumber, fromUsage, ofNode("cpu", func(d metricData) int64 { return d.usage.CPU })),
		metricCol("MEM", pipeline.TypeBytes, fromUsage, memCell),
		metricCol("%MEM", pipeline.TypeNumber, fromUsage, ofNode("memory", func(d metricData) int64 { return d.usage.Memory })),
		// kubectl describe node: requests and limits of its unfinished pods, of allocatable
		metricCol("%CPU REQ", pipeline.TypeNumber, fromAlloc, ofNode("cpu", func(d metricData) int64 { return d.alloc.Requests.CPU })),
		metricCol("%CPU LIM", pipeline.TypeNumber, fromAlloc, ofNode("cpu", func(d metricData) int64 { return d.alloc.Limits.CPU })),
		metricCol("%MEM REQ", pipeline.TypeNumber, fromAlloc, ofNode("memory", func(d metricData) int64 { return d.alloc.Requests.Memory })),
		metricCol("%MEM LIM", pipeline.TypeNumber, fromAlloc, ofNode("memory", func(d metricData) int64 { return d.alloc.Limits.Memory })),
	},
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

// ofPod is a pod's usage as a percentage of its effective requests or
// limits (see source.PodResources); "" if the pod sets none.
func ofPod(use func(source.Usage) int64, of func(source.Resources) (int64, bool)) func(map[string]any, metricData) string {
	return func(obj map[string]any, d metricData) string {
		if !d.hasUsage {
			return ""
		}
		r, ok := source.PodResources(obj)
		if !ok {
			return ""
		}
		total, set := of(r)
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
