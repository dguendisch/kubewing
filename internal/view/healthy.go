package view

// healthyPod reports whether obj is a pod with nothing to look at: Running,
// not being deleted, and every container (including restartable init
// containers, i.e. sidecars) has a status that is ready. A container without
// a status yet counts as not ready, as in kubectl's READY column.
func healthyPod(obj map[string]any) bool {
	if obj["kind"] != "Pod" {
		return false
	}
	if meta, _ := obj["metadata"].(map[string]any); meta["deletionTimestamp"] != nil {
		return false
	}
	status, _ := obj["status"].(map[string]any)
	if status["phase"] != "Running" {
		return false
	}
	spec, _ := obj["spec"].(map[string]any)
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
