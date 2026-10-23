package view

import (
	"slices"
	"testing"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

func podWith(phase string, spec, status map[string]any) map[string]any {
	if status == nil {
		status = map[string]any{}
	}
	status["phase"] = phase
	return map[string]any{"kind": "Pod", "metadata": map[string]any{"name": "p"}, "spec": spec, "status": status}
}

func cs(name string, ready bool) map[string]any { return map[string]any{"name": name, "ready": ready} }

func TestHealthyPod(t *testing.T) {
	two := map[string]any{"containers": []any{map[string]any{"name": "a"}, map[string]any{"name": "b"}}}
	sidecar := map[string]any{
		"initContainers": []any{map[string]any{"name": "setup"}, map[string]any{"name": "proxy", "restartPolicy": "Always"}},
		"containers":     []any{map[string]any{"name": "a"}},
	}
	deleting := podWith("Running", two, map[string]any{"containerStatuses": []any{cs("a", true), cs("b", true)}})
	deleting["metadata"] = map[string]any{"name": "p", "deletionTimestamp": "2026-01-01T00:00:00Z"}
	cases := map[string]struct {
		obj  map[string]any
		want bool
	}{
		"all ready":       {podWith("Running", two, map[string]any{"containerStatuses": []any{cs("a", true), cs("b", true)}}), true},
		"one not ready":   {podWith("Running", two, map[string]any{"containerStatuses": []any{cs("a", true), cs("b", false)}}), false},
		"status missing":  {podWith("Running", two, map[string]any{"containerStatuses": []any{cs("a", true)}}), false},
		"no statuses":     {podWith("Running", two, nil), false},
		"pending":         {podWith("Pending", two, map[string]any{"containerStatuses": []any{cs("a", true), cs("b", true)}}), false},
		"succeeded":       {podWith("Succeeded", two, nil), false},
		"terminating":     {deleting, false},
		"sidecar ready":   {podWith("Running", sidecar, map[string]any{"containerStatuses": []any{cs("a", true)}, "initContainerStatuses": []any{cs("setup", false), cs("proxy", true)}}), true},
		"sidecar unready": {podWith("Running", sidecar, map[string]any{"containerStatuses": []any{cs("a", true)}, "initContainerStatuses": []any{cs("setup", false), cs("proxy", false)}}), false},
		"not a pod":       {map[string]any{"kind": "Node", "status": map[string]any{"phase": "Running"}}, false},
	}
	for name, c := range cases {
		if got := healthyPod(c.obj); got != c.want {
			t.Errorf("%s: healthyPod = %v, want %v", name, got, c.want)
		}
	}
}

func TestHideHealthyStage(t *testing.T) {
	ready := func(uid, name string, ok bool) source.Item {
		it := stagePod(uid, name, "Running", "api", 0)
		it.Object.Object["status"].(map[string]any)["containerStatuses"] = []any{cs("c", ok)}
		return it
	}
	v := stageView(t)
	v.Apply(source.Event{Type: source.Relist, Items: []source.Item{
		ready("a", "api-0", true),
		ready("b", "api-1", false),
		stagePod("c", "api-2", "Pending", "api", 0),
	}}, t0)
	if err := v.SetStages([]pipeline.Stage{{HideHealthy: true}}); err != nil {
		t.Fatal(err)
	}
	if got := names(v); !slices.Equal(got, []string{"api-1", "api-2"}) {
		t.Fatalf("rows = %v", got)
	}
	// the draft CEL preview keeps the stage
	if pv := v.PreviewFilter(`o.status.phase == "Running"`); pv.Matched != 1 {
		t.Fatalf("preview = %+v", pv)
	}
	// becoming ready hides a pod live
	v.Apply(source.Event{Type: source.Modified, Item: ready("b", "api-1", true)}, t0)
	if got := names(v); !slices.Equal(got, []string{"api-2"}) {
		t.Fatalf("rows after ready = %v", got)
	}
	_ = v.SetStages(nil)
	if got := names(v); len(got) != 3 {
		t.Fatalf("rows after toggle off = %v", got)
	}
}
