package view

import (
	"math"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// Metric columns (kubectl top): usage polled from metrics.k8s.io (see
// SetUsage), offered for pods and nodes in the column configurator, never
// shown by default. They change with every poll, so they aren't diffed,
// and the past has none (usage isn't part of the object, nor recorded).

// metricColumns are the metric columns per kind, in their order.
var metricColumns = map[string][]colSpec{
	"Pod": {
		metricCol("CPU", pipeline.TypeNumber, cpuCell),
		metricCol("%CPU/R", pipeline.TypeNumber, percentOf(cpuOf, containersSum("requests", "cpu"))),
		metricCol("%CPU/L", pipeline.TypeNumber, percentOf(cpuOf, containersSum("limits", "cpu"))),
		metricCol("MEM", pipeline.TypeBytes, memCell),
		metricCol("%MEM/R", pipeline.TypeNumber, percentOf(memOf, containersSum("requests", "memory"))),
		metricCol("%MEM/L", pipeline.TypeNumber, percentOf(memOf, containersSum("limits", "memory"))),
	},
	"Node": {
		metricCol("CPU", pipeline.TypeNumber, cpuCell),
		metricCol("%CPU", pipeline.TypeNumber, percentOf(cpuOf, allocatable("cpu"))),
		metricCol("MEM", pipeline.TypeBytes, memCell),
		metricCol("%MEM", pipeline.TypeNumber, percentOf(memOf, allocatable("memory"))),
	},
}

func metricCol(name string, typ pipeline.ColumnType, f func(obj map[string]any, u source.Usage) string) colSpec {
	return colSpec{info: ColumnInfo{Name: name, Type: string(typ)}, numeric: true, timeDerived: true, cellIndex: -1, metric: f}
}

// cpuCell is millicores as kubectl top shows them ("250m").
func cpuCell(_ map[string]any, u source.Usage) string { return strconv.FormatInt(u.CPU, 10) + "m" }

// memCell is bytes, formatted by the bytes type.
func memCell(_ map[string]any, u source.Usage) string { return strconv.FormatInt(u.Memory, 10) }

// cpuOf and memOf are the usage in the units quantities are compared in
// (cores, bytes).
func cpuOf(u source.Usage) float64 { return float64(u.CPU) / 1000 }
func memOf(u source.Usage) float64 { return float64(u.Memory) }

// percentOf is usage as a percentage of what of(obj) says ("" without one).
func percentOf(use func(source.Usage) float64, of func(obj map[string]any) (float64, bool)) func(map[string]any, source.Usage) string {
	return func(obj map[string]any, u source.Usage) string {
		total, ok := of(obj)
		if !ok || total <= 0 {
			return ""
		}
		return strconv.FormatFloat(math.Round(use(u)/total*100), 'f', 0, 64) + "%"
	}
}

// containersSum sums a resource's requests or limits over a pod's
// containers (as k9s does: init containers left out). None set: no total.
func containersSum(kind, name string) func(obj map[string]any) (float64, bool) {
	return func(obj map[string]any) (float64, bool) {
		spec, _ := obj["spec"].(map[string]any)
		cs, _ := spec["containers"].([]any)
		var sum float64
		found := false
		for _, c := range cs {
			res, _ := c.(map[string]any)["resources"].(map[string]any)
			set, _ := res[kind].(map[string]any)
			if f, ok := quantity(set[name]); ok {
				sum += f
				found = true
			}
		}
		return sum, found
	}
}

// allocatable is a node's allocatable amount of a resource.
func allocatable(name string) func(obj map[string]any) (float64, bool) {
	return func(obj map[string]any) (float64, bool) {
		st, _ := obj["status"].(map[string]any)
		alloc, _ := st["allocatable"].(map[string]any)
		return quantity(alloc[name])
	}
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

// ShowsMetrics reports whether a metric column is shown (its usage is to
// be polled).
func (v *View) ShowsMetrics() bool {
	for _, c := range v.cols {
		if c.metric != nil {
			return true
		}
	}
	return false
}

// SetUsage sets the current usage by namespace/name ("/name" for nodes)
// and re-renders the metric cells of the live rows; err (with nil usage)
// is why there is none, shown in the status line. In the past it only
// keeps them for when the pane comes back to live.
func (v *View) SetUsage(usage map[string]source.Usage, err string) {
	v.usage, v.usageErr = usage, err
	if !v.at.IsZero() || !v.ShowsMetrics() {
		return
	}
	for _, e := range v.entries {
		v.renderMetrics(e)
	}
	v.sorted = nil
}

// renderMetrics updates only an entry's metric cells (a poll leaves the
// others as they are), then its match: grep sees the cells.
func (v *View) renderMetrics(e *entry) {
	obj := e.item.Object.Object
	u, ok := v.usage[e.item.Object.GetNamespace()+"/"+e.item.Object.GetName()]
	changed := false
	for i, c := range v.cols {
		if c.metric == nil {
			continue
		}
		cell := ""
		if ok {
			cell = format(c.metric(obj, u), c.info.Type)
		}
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
