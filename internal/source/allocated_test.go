package source

import "testing"

func TestPodResources(t *testing.T) {
	c := func(name string, req, lim map[string]any) map[string]any {
		res := map[string]any{}
		if req != nil {
			res["requests"] = req
		}
		if lim != nil {
			res["limits"] = lim
		}
		return map[string]any{"name": name, "resources": res}
	}
	pod := map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "p"},
		"spec": map[string]any{
			"containers": []any{
				c("app", map[string]any{"cpu": "100m", "memory": "64Mi"}, map[string]any{"cpu": "1"}),
				c("side", map[string]any{"cpu": "50m"}, nil),
			},
			"initContainers": []any{
				// runs alone: counts as max(it, the rest) = 600m
				c("migrate", map[string]any{"cpu": "600m"}, nil),
			},
			"overhead": map[string]any{"cpu": "10m"},
		},
	}
	r, ok := PodResources(pod)
	if !ok {
		t.Fatal("not a pod")
	}
	if r.Requests.CPU != 610 || r.Requests.Memory != 64<<20 {
		t.Fatalf("requests = %+v", r.Requests)
	}
	// only app sets a cpu limit; overhead is added to set limits
	if r.Limits.CPU != 1010 || r.Limits.Memory != 0 || !r.LimCPU || r.LimMemory {
		t.Fatalf("limits = %+v (cpu set %v, memory set %v)", r.Limits, r.LimCPU, r.LimMemory)
	}

	// a sidecar (restartPolicy Always) adds to the rest instead
	sidecar := c("proxy", map[string]any{"cpu": "200m"}, nil)
	sidecar["restartPolicy"] = "Always"
	pod["spec"].(map[string]any)["initContainers"] = []any{sidecar}
	delete(pod["spec"].(map[string]any), "overhead")
	if r, _ := PodResources(pod); r.Requests.CPU != 350 {
		t.Fatalf("with a sidecar: %+v", r.Requests)
	}
}
