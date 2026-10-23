package view

// healthy reports whether obj has nothing to look at: not being deleted and,
// by kind, a ready pod or a workload whose rollout is complete (see
// healthyPod, healthyWorkload). Other kinds are never healthy, so never
// hidden; the frontend's healthKinds lists the same kinds.
func healthy(obj map[string]any) bool {
	meta, _ := obj["metadata"].(map[string]any)
	if meta["deletionTimestamp"] != nil {
		return false
	}
	spec, _ := obj["spec"].(map[string]any)
	status, _ := obj["status"].(map[string]any)
	switch obj["kind"] {
	case "Pod":
		return healthyPod(spec, status)
	case "Deployment", "StatefulSet":
		return healthyWorkload(meta, spec, status, "replicas", "updatedReplicas", "readyReplicas", "availableReplicas")
	case "ReplicaSet":
		// a ReplicaSet doesn't roll out: its pods are all of its one template
		return healthyWorkload(meta, spec, status, "replicas", "readyReplicas", "availableReplicas")
	case "DaemonSet":
		return number(status["numberMisscheduled"]) == 0 &&
			healthyWorkload(meta, nil, status, "currentNumberScheduled", "updatedNumberScheduled", "numberReady", "numberAvailable")
	}
	return false
}

// healthyWorkload reports whether the controller has seen the latest spec
// (observedGeneration) and every count in status equals the desired one:
// spec.replicas (default 1), or for a DaemonSet (spec nil)
// desiredNumberScheduled. Counts the API omits are 0, as it omits zeros.
// This is what kubectl rollout status waits for.
func healthyWorkload(meta, spec, status map[string]any, counts ...string) bool {
	if number(status["observedGeneration"]) < number(meta["generation"]) {
		return false
	}
	want := number(status["desiredNumberScheduled"])
	if spec != nil {
		want = 1
		if r, ok := spec["replicas"]; ok {
			want = number(r)
		}
	}
	for _, c := range counts {
		if number(status[c]) != want {
			return false
		}
	}
	return true
}

// number reads a JSON number as decoded into an unstructured object (int64,
// or float64 from plain JSON); anything else is 0.
func number(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	}
	return 0
}

// healthyPod: Running and every container (including restartable init
// containers, i.e. sidecars) has a status that is ready. A container without
// a status yet counts as not ready, as in kubectl's READY column.
func healthyPod(spec, status map[string]any) bool {
	if status["phase"] != "Running" {
		return false
	}
	return allReady(containerNames(spec["containers"], false), status["containerStatuses"], true) &&
		allReady(containerNames(spec["initContainers"], true), status["initContainerStatuses"], false)
}

// containerNames lists the container names in a pod spec list; sidecarsOnly keeps
// only init containers with restartPolicy Always.
func containerNames(list any, sidecarsOnly bool) []string {
	l, _ := list.([]any)
	var out []string
	for _, c := range l {
		m, _ := c.(map[string]any)
		if sidecarsOnly && m["restartPolicy"] != "Always" {
			continue
		}
		if n, _ := m["name"].(string); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// allReady reports whether every named container has a ready status. For
// the main containers (all) every status counts too, and there must be at
// least one (a Running pod always has a container); for init containers only
// the named sidecars do (the others completed).
func allReady(want []string, statuses any, all bool) bool {
	l, _ := statuses.([]any)
	ready := map[string]bool{}
	for _, c := range l {
		m, _ := c.(map[string]any)
		n, _ := m["name"].(string)
		ready[n] = m["ready"] == true
		if all && !ready[n] {
			return false
		}
	}
	if all && len(ready) == 0 {
		return false
	}
	for _, n := range want {
		if !ready[n] {
			return false
		}
	}
	return true
}
