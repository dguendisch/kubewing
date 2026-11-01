package view

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/history"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

// topPod is a pod with one container requesting 500m/256Mi, limited to 1/1Gi.
func topPod(uid, name string) source.Item {
	it := stagePod(uid, name, "Running", "api", 0)
	c := it.Object.Object["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
	c["resources"] = map[string]any{
		"requests": map[string]any{"cpu": "500m", "memory": "256Mi"},
		"limits":   map[string]any{"cpu": "1", "memory": "1Gi"},
	}
	it.Cells = []any{name, "Running", "2h", ""}
	return it
}

func topView(t *testing.T, opts Options, cols ...pipeline.Column) *View {
	t.Helper()
	opts.Kind = "Pod"
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods"}, Render: pipeline.Render{Columns: cols}}, opts)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

var topColumns = []pipeline.Column{{Name: "NAME"}, {Name: "CPU"}, {Name: "%CPU/R"}, {Name: "%CPU/L"}, {Name: "MEM"}, {Name: "%MEM/R"}, {Name: "%MEM/L"}}

// Metric columns are offered for pods (not by default) and filled from the usage.
func TestMetricColumns(t *testing.T) {
	v := topView(t, Options{})
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{topPod("a", "api-0")}}, t0)
	if v.ShowsMetrics() {
		t.Fatal("metric columns shown by default")
	}
	ch := v.ColumnChoices()
	var metric []string
	for _, o := range ch.Options {
		if o.Metric == "usage" {
			metric = append(metric, o.Name)
		}
	}
	if want := []string{"CPU", "%CPU/R", "%CPU/L", "MEM", "%MEM/R", "%MEM/L"}; !slices.Equal(metric, want) {
		t.Fatalf("metric options = %v", metric)
	}
	if slices.Contains(ch.Defaults, "CPU") {
		t.Fatalf("defaults = %v", ch.Defaults)
	}

	if err := v.SetRender(pipeline.Render{Columns: topColumns}); err != nil {
		t.Fatal(err)
	}
	if !v.ShowsMetrics() {
		t.Fatal("ShowsMetrics = false")
	}
	if got := cells(v)["a"]; !slices.Equal(got, []string{"api-0", "", "", "", "", "", ""}) {
		t.Fatalf("before a poll = %q", got)
	}
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 250, Memory: 128 << 20}}})
	if got := cells(v)["a"]; !slices.Equal(got, []string{"api-0", "250m", "50%", "25%", "128.0Mi", "50%", "12%"}) {
		t.Fatalf("cells = %q", got)
	}
}

// A poll is not a change: no markers, no "changed, not visible".
func TestMetricColumnsNotDiffed(t *testing.T) {
	v := topView(t, Options{}, topColumns...)
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{topPod("a", "api-0")}}, t0)
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 250, Memory: 1}}})
	v.Frame(t0)
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 900, Memory: 1}}})
	// the object changes too: still only its own columns are marked
	v.Apply(source.Event{Type: source.Modified, Item: topPod("a", "api-0")}, t0.Add(time.Second))
	f, ok := v.Frame(t0.Add(time.Second))
	if !ok || len(f.Rows) != 1 {
		t.Fatalf("frame = %+v", f)
	}
	if r := f.Rows[0]; r.Cells[1] != "900m" || len(r.Changed) != 0 || r.Hidden || r.Mark != MarkNone {
		t.Fatalf("row = %+v", r)
	}
}

// Sorted numerically, a pod without usage last; grep sees the cells.
func TestMetricColumnsSortAndGrep(t *testing.T) {
	v := topView(t, Options{}, topColumns...)
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{topPod("a", "api-0"), topPod("b", "api-1"), topPod("c", "api-2")}}, t0)
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 90}, "ns/api-1": {CPU: 1200}}})
	if err := v.SetStages([]pipeline.Stage{{Sort: []string{"-CPU"}}}); err != nil {
		t.Fatal(err)
	}
	if got := names(v); !slices.Equal(got, []string{"api-1", "api-0", "api-2"}) {
		t.Fatalf("by -CPU = %v", got)
	}
	if err := v.SetStages([]pipeline.Stage{{Sort: []string{"%CPU/R"}}}); err != nil {
		t.Fatal(err)
	}
	// 18% < 240% (as numbers, not text)
	if got := names(v); !slices.Equal(got, []string{"api-0", "api-1", "api-2"}) {
		t.Fatalf("by %%CPU/R = %v", got)
	}
	if err := v.SetStages([]pipeline.Stage{{Grep: "1200m"}}); err != nil {
		t.Fatal(err)
	}
	if got := names(v); !slices.Equal(got, []string{"api-1"}) {
		t.Fatalf("grep = %v", got)
	}
	// the next poll re-evaluates the grep
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 1200}}})
	if got := names(v); !slices.Equal(got, []string{"api-0"}) {
		t.Fatalf("grep after a poll = %v", got)
	}
}

// Nodes: usage against allocatable; percentages truncated, as kubectl.
func TestNodeMetricColumns(t *testing.T) {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "nodes"}, Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME"}, {Name: "CPU"}, {Name: "%CPU"}, {Name: "MEM"}, {Name: "%MEM"}}}}, Options{Kind: "Node"})
	if err != nil {
		t.Fatal(err)
	}
	node := item(map[string]any{
		"apiVersion": "v1", "kind": "Node",
		"metadata": map[string]any{"name": "n1", "uid": "n1"},
		"status":   map[string]any{"allocatable": map[string]any{"cpu": "4", "memory": "8Gi"}},
	})
	node.Cells = []any{"n1"}
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs[:1], Items: []source.Item{node}}, t0)
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"/n1": {CPU: 1000, Memory: 2 << 30}}})
	if got := cells(v)["n1"]; !slices.Equal(got, []string{"n1", "1000m", "25%", "2.0Gi", "25%"}) {
		t.Fatalf("cells = %q", got)
	}
}

// No metrics-server: empty cells and the reason in the status.
func TestMetricsUnavailable(t *testing.T) {
	v := topView(t, Options{}, topColumns...)
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{topPod("a", "api-0")}}, t0)
	v.SetMetrics(Metrics{UsageErr: "metrics unavailable: the server could not find the requested resource"})
	f, _ := v.Frame(t0)
	if f.Status == nil || f.Status.MetricsError == "" {
		t.Fatalf("status = %+v", f.Status)
	}
	if got := cells(v)["a"][1]; got != "" {
		t.Fatalf("cpu = %q", got)
	}
	// without metric columns shown, no hint
	if err := v.SetRender(pipeline.Render{}); err != nil {
		t.Fatal(err)
	}
	if f, _ := v.Frame(t0); f.Status == nil || f.Status.MetricsError != "" {
		t.Fatalf("status without metric columns = %+v", f.Status)
	}
}

// The past has no usage: empty metric cells; back to live, they're there again.
func TestMetricColumnsInThePast(t *testing.T) {
	r := &recorder{Store: history.New(history.Limits{}), on: true}
	v := topView(t, Options{History: r}, topColumns...)
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs, Items: []source.Item{r.item(topPod("a", "api-0"), t0)}}, t0)
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 250}}})
	if err := v.SetTime(t0); err != nil {
		t.Fatal(err)
	}
	if got := cells(v)["a"][1]; got != "" {
		t.Fatalf("cpu in the past = %q", got)
	}
	// a poll while in the past doesn't fill them
	v.SetMetrics(Metrics{Usage: map[string]source.Usage{"ns/api-0": {CPU: 300}}})
	if got := cells(v)["a"][1]; got != "" {
		t.Fatalf("cpu in the past after a poll = %q", got)
	}
	if err := v.SetTime(time.Time{}); err != nil {
		t.Fatal(err)
	}
	if got := cells(v)["a"][1]; got != "300m" {
		t.Fatalf("cpu live again = %q", got)
	}
}

// Nodes: their pods' requests and limits of allocatable, as kubectl describe
// node; a node no pod runs on has 0%, one with nothing summed yet (the
// watch not synced) nothing. No metrics-server needed: no hint.
func TestNodeAllocationColumns(t *testing.T) {
	cols := []pipeline.Column{{Name: "NAME"}, {Name: "%CPU REQ"}, {Name: "%CPU LIM"}, {Name: "%MEM REQ"}, {Name: "%MEM LIM"}}
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "nodes"}, Render: pipeline.Render{Columns: cols}}, Options{Kind: "Node"})
	if err != nil {
		t.Fatal(err)
	}
	node := func(name string) source.Item {
		it := item(map[string]any{
			"apiVersion": "v1", "kind": "Node",
			"metadata": map[string]any{"name": name, "uid": name},
			// allocatable wins over capacity
			"status": map[string]any{"allocatable": map[string]any{"cpu": "3870m", "memory": "15Gi"}, "capacity": map[string]any{"cpu": "4", "memory": "16Gi"}},
		})
		it.Cells = []any{name}
		return it
	}
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs[:1], Items: []source.Item{node("n1"), node("n2")}}, t0)
	if !v.ShowsAllocation() || v.ShowsUsage() {
		t.Fatalf("allocation %v, usage %v", v.ShowsAllocation(), v.ShowsUsage())
	}
	if got := cells(v)["n1"]; !slices.Equal(got, []string{"n1", "", "", "", ""}) {
		t.Fatalf("before the sums = %q", got)
	}
	for _, o := range v.ColumnChoices().Options {
		if strings.HasSuffix(o.Name, " REQ") && o.Metric != "alloc" {
			t.Fatalf("%s: group %q", o.Name, o.Metric)
		}
	}
	v.SetMetrics(Metrics{AllocLoading: true})
	if f, _ := v.Frame(t0); f.Status == nil || !f.Status.AllocLoading {
		t.Fatalf("status while loading = %+v", f.Status)
	}
	v.SetMetrics(Metrics{Alloc: map[string]source.Allocation{"n1": {
		Requests: source.Amounts{"cpu": 3809, "memory": 15340778266},
		Limits:   source.Amounts{"cpu": 2000, "memory": 10896 << 20},
	}}})
	// as in kubectl describe node: 3809m of 3870m is 98%, 2 is 51%; 15340778266 of 15Gi 95%
	if got := cells(v)["n1"]; !slices.Equal(got, []string{"n1", "98%", "51%", "95%", "70%"}) {
		t.Fatalf("n1 = %q", got)
	}
	if got := cells(v)["n2"]; !slices.Equal(got, []string{"n2", "0%", "0%", "0%", "0%"}) {
		t.Fatalf("n2 = %q", got)
	}
	if f, _ := v.Frame(t0); f.Status != nil && f.Status.MetricsError != "" {
		t.Fatalf("status = %+v", f.Status)
	}
}

func allocNode(name string, allocatable map[string]any) source.Item {
	it := item(map[string]any{
		"apiVersion": "v1", "kind": "Node",
		"metadata": map[string]any{"name": name, "uid": name},
		"status":   map[string]any{"allocatable": allocatable},
	})
	it.Cells = []any{name}
	return it
}

// Nodes: ephemeral storage and pod slots of allocatable, as kubectl
// describe node; the pod count as a number too.
func TestNodeEphemeralAndPodColumns(t *testing.T) {
	cols := []pipeline.Column{{Name: "NAME"}, {Name: "%EPH REQ"}, {Name: "%EPH LIM"}, {Name: "PODS"}, {Name: "%PODS"}}
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "nodes"}, Render: pipeline.Render{Columns: cols}}, Options{Kind: "Node"})
	if err != nil {
		t.Fatal(err)
	}
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs[:1], Items: []source.Item{
		allocNode("n1", map[string]any{"cpu": "4", "ephemeral-storage": "100Gi", "pods": "110"}),
		allocNode("n2", map[string]any{"cpu": "4", "pods": "110"}),
	}}, t0)
	if !v.ShowsAllocation() {
		t.Fatal("ShowsAllocation = false")
	}
	v.SetMetrics(Metrics{Alloc: map[string]source.Allocation{"n1": {
		Requests: source.Amounts{"ephemeral-storage": 30 << 30},
		Limits:   source.Amounts{"ephemeral-storage": 55 << 30},
		Pods:     99,
	}}})
	if got := cells(v)["n1"]; !slices.Equal(got, []string{"n1", "30%", "55%", "99", "90%"}) {
		t.Fatalf("n1 = %q", got)
	}
	// no ephemeral storage in allocatable: no percentage; no pods: 0
	if got := cells(v)["n2"]; !slices.Equal(got, []string{"n2", "", "", "0", "0%"}) {
		t.Fatalf("n2 = %q", got)
	}
}

// Extended resources and huge pages get a requests column once a node has
// some allocatable (not before, not "0", not kubernetes.io's own); a
// configured one is resolved when a node with it shows up.
func TestNodeExtendedColumns(t *testing.T) {
	cols := []pipeline.Column{{Name: "NAME"}, {Name: "%nvidia.com/gpu REQ"}}
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "nodes"}, Render: pipeline.Render{Columns: cols}}, Options{Kind: "Node"})
	if err != nil {
		t.Fatal(err)
	}
	extended := func() (out []string) {
		for _, o := range v.ColumnChoices().Options {
			if strings.Contains(o.Name, "/") || strings.Contains(o.Name, "hugepages") {
				out = append(out, o.Name+":"+o.Metric+":"+map[bool]string{true: "missing"}[o.Missing])
			}
		}
		return out
	}
	v.Apply(source.Event{Type: source.Relist, Columns: podDefs[:1], Items: []source.Item{
		allocNode("n1", map[string]any{"cpu": "4", "hugepages-2Mi": "0", "attachable-volumes-aws-ebs": "25", "kubernetes.io/batch": "1"}),
	}}, t0)
	if v.ShowsAllocation() {
		t.Fatal("a column of a resource no node has is shown")
	}
	// configured, not resolvable yet: still switched with requests/limits
	if got := extended(); !slices.Equal(got, []string{"%nvidia.com/gpu REQ:alloc:missing"}) {
		t.Fatalf("before a gpu node = %v", got)
	}
	v.Apply(source.Event{Type: source.Added, Item: allocNode("gpu-1", map[string]any{"cpu": "8", "nvidia.com/gpu": "4", "hugepages-1Gi": "2Gi"})}, t0)
	if !v.ShowsAllocation() {
		t.Fatal("ShowsAllocation = false after a gpu node")
	}
	if got := extended(); !slices.Equal(got, []string{"%nvidia.com/gpu REQ:alloc:", "%hugepages-1Gi REQ:alloc:"}) {
		t.Fatalf("after a gpu node = %v", got)
	}
	v.SetMetrics(Metrics{Alloc: map[string]source.Allocation{"gpu-1": {Requests: source.Amounts{"nvidia.com/gpu": 3}}}})
	if got := cells(v); !slices.Equal(got["gpu-1"], []string{"gpu-1", "75%"}) || !slices.Equal(got["n1"], []string{"n1", ""}) {
		t.Fatalf("cells = %q", got)
	}
}
