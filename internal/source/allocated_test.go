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
	if r.Requests["cpu"] != 610 || r.Requests["memory"] != 64<<20 {
		t.Fatalf("requests = %+v", r.Requests)
	}
	// only app sets a cpu limit; overhead is added to set limits
	if _, mem := r.Limits["memory"]; r.Limits["cpu"] != 1010 || mem {
		t.Fatalf("limits = %+v", r.Limits)
	}

	// a sidecar (restartPolicy Always) adds to the rest instead
	sidecar := c("proxy", map[string]any{"cpu": "200m"}, nil)
	sidecar["restartPolicy"] = "Always"
	pod["spec"].(map[string]any)["initContainers"] = []any{sidecar}
	delete(pod["spec"].(map[string]any), "overhead")
	if r, _ := PodResources(pod); r.Requests["cpu"] != 350 {
		t.Fatalf("with a sidecar: %+v", r.Requests)
	}
}

// Ephemeral storage and extended resources are summed like cpu and memory;
// a node's allocation counts its pods too.
func TestAllocationAdd(t *testing.T) {
	pod := map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "p"},
		"spec": map[string]any{"containers": []any{map[string]any{"name": "c", "resources": map[string]any{
			"requests": map[string]any{"ephemeral-storage": "1Gi", "nvidia.com/gpu": "2"},
			"limits":   map[string]any{"ephemeral-storage": "2Gi", "nvidia.com/gpu": "2"},
		}}}},
	}
	r, _ := PodResources(pod)
	var a Allocation
	a.Add(r, 1)
	a.Add(r, 1)
	c := a.Clone()
	a.Add(r, -1)
	if a.Pods != 1 || a.Requests["ephemeral-storage"] != 1<<30 || a.Limits["ephemeral-storage"] != 2<<30 || a.Requests["nvidia.com/gpu"] != 2 {
		t.Fatalf("allocation = %+v", a)
	}
	// a clone doesn't change with the original
	if c.Pods != 2 || c.Requests["nvidia.com/gpu"] != 4 {
		t.Fatalf("clone = %+v", c)
	}
}
