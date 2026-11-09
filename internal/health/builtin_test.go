package health

import "testing"

func podWith(phase string, spec, status map[string]any) map[string]any {
	if status == nil {
		status = map[string]any{}
	}
	status["phase"] = phase
	return map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": "p"}, "spec": spec, "status": status}
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
		"not a pod":       {map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "status": map[string]any{"phase": "Running"}}, false},
	}
	for name, c := range cases {
		if got := Default.Healthy(c.obj); got != c.want {
			t.Errorf("%s: healthy = %v, want %v", name, got, c.want)
		}
	}
}

func workload(kind string, generation int64, spec, status map[string]any) map[string]any {
	av := "apps/v1"
	if kind == "Job" {
		av = "batch/v1"
	}
	return map[string]any{"apiVersion": av, "kind": kind, "metadata": map[string]any{"name": "w", "generation": generation}, "spec": spec, "status": status}
}

func TestHealthyWorkload(t *testing.T) {
	three := map[string]any{"replicas": int64(3)}
	rollout := func(observed, replicas, updated, ready, available int64) map[string]any {
		return map[string]any{"observedGeneration": observed, "replicas": replicas, "updatedReplicas": updated, "readyReplicas": ready, "availableReplicas": available}
	}
	ds := func(desired, current, updated, ready, available, mis int64) map[string]any {
		return map[string]any{"observedGeneration": int64(2), "desiredNumberScheduled": desired, "currentNumberScheduled": current,
			"updatedNumberScheduled": updated, "numberReady": ready, "numberAvailable": available, "numberMisscheduled": mis}
	}
	deleting := workload("Deployment", 2, three, rollout(2, 3, 3, 3, 3))
	deleting["metadata"].(map[string]any)["deletionTimestamp"] = "2026-01-01T00:00:00Z"
	cases := map[string]struct {
		obj  map[string]any
		want bool
	}{
		"deploy complete":       {workload("Deployment", 2, three, rollout(2, 3, 3, 3, 3)), true},
		"deploy json floats":    {workload("Deployment", 2, map[string]any{"replicas": 3.0}, map[string]any{"observedGeneration": 2.0, "replicas": 3.0, "updatedReplicas": 3.0, "readyReplicas": 3.0, "availableReplicas": 3.0}), true},
		"deploy not observed":   {workload("Deployment", 3, three, rollout(2, 3, 3, 3, 3)), false},
		"deploy rolling":        {workload("Deployment", 2, three, rollout(2, 4, 1, 3, 3)), false},
		"deploy surge":          {workload("Deployment", 2, three, rollout(2, 4, 3, 3, 3)), false},
		"deploy unready":        {workload("Deployment", 2, three, rollout(2, 3, 3, 2, 3)), false},
		"deploy unavailable":    {workload("Deployment", 2, three, rollout(2, 3, 3, 3, 2)), false},
		"deploy replicas unset": {workload("Deployment", 1, map[string]any{}, rollout(1, 1, 1, 1, 1)), true},
		// the API omits zero counts
		"deploy scaled to 0": {workload("Deployment", 2, map[string]any{"replicas": int64(0)}, map[string]any{"observedGeneration": int64(2)}), true},
		"deploy terminating": {deleting, false},
		"sts complete":       {workload("StatefulSet", 1, three, rollout(1, 3, 3, 3, 3)), true},
		"sts partitioned":    {workload("StatefulSet", 1, three, rollout(1, 3, 2, 3, 3)), false},
		// a ReplicaSet has no updatedReplicas
		"rs complete":  {workload("ReplicaSet", 1, three, map[string]any{"observedGeneration": int64(1), "replicas": int64(3), "readyReplicas": int64(3), "availableReplicas": int64(3)}), true},
		"rs short":     {workload("ReplicaSet", 1, three, map[string]any{"observedGeneration": int64(1), "replicas": int64(3), "readyReplicas": int64(2), "availableReplicas": int64(2)}), false},
		"ds complete":  {workload("DaemonSet", 2, map[string]any{}, ds(4, 4, 4, 4, 4, 0)), true},
		"ds updating":  {workload("DaemonSet", 2, map[string]any{}, ds(4, 4, 3, 4, 4, 0)), false},
		"ds unready":   {workload("DaemonSet", 2, map[string]any{}, ds(4, 4, 4, 3, 3, 0)), false},
		"ds missing":   {workload("DaemonSet", 2, map[string]any{}, ds(4, 3, 3, 3, 3, 0)), false},
		"ds misplaced": {workload("DaemonSet", 2, map[string]any{}, ds(4, 4, 4, 4, 4, 1)), false},
		"job":          {workload("Job", 1, map[string]any{}, map[string]any{"succeeded": int64(1)}), false},
	}
	for name, c := range cases {
		if got := Default.Healthy(c.obj); got != c.want {
			t.Errorf("%s: healthy = %v, want %v", name, got, c.want)
		}
	}
}
