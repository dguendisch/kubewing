package source

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	resourcehelper "k8s.io/component-helpers/resource"
)

// UnfinishedPods selects the pods kubectl describe node counts in its
// "Allocated resources" (watched with spec.nodeName set by the caller, or
// cluster-wide and summed by node).
const UnfinishedPods = "status.phase!=Succeeded,status.phase!=Failed"

// Resources is a pod's effective requests and limits.
type Resources struct {
	Requests, Limits Usage
	// which of them the pod sets at all (a percentage of an unset one has
	// no meaning; a sum adds 0 for it)
	ReqCPU, ReqMemory, LimCPU, LimMemory bool
}

// Allocation is what a node's unfinished pods request and are limited to
// (a pod without a limit adds nothing to Limits, as in kubectl's sum).
type Allocation struct {
	Requests, Limits Usage
}

// Add adds a pod's resources.
func (a *Allocation) Add(r Resources, sign int64) {
	a.Requests.CPU += sign * r.Requests.CPU
	a.Requests.Memory += sign * r.Requests.Memory
	a.Limits.CPU += sign * r.Limits.CPU
	a.Limits.Memory += sign * r.Limits.Memory
}

// PodResources computes a pod's effective requests and limits as the
// scheduler and kubectl describe node count them (component-helpers):
// containers summed, sidecars added, a plain init container as the max of
// it and the rest, pod-level resources replacing them, overhead added. ok
// is false if the object isn't a pod.
func PodResources(obj map[string]any) (Resources, bool) {
	var pod corev1.Pod
	if runtime.DefaultUnstructuredConverter.FromUnstructured(obj, &pod) != nil {
		return Resources{}, false
	}
	opts := resourcehelper.PodResourcesOptions{}
	req, lim := resourcehelper.PodRequests(&pod, opts), resourcehelper.PodLimits(&pod, opts)
	r := Resources{
		Requests: Usage{CPU: req.Cpu().MilliValue(), Memory: req.Memory().Value()},
		Limits:   Usage{CPU: lim.Cpu().MilliValue(), Memory: lim.Memory().Value()},
	}
	_, r.ReqCPU = req[corev1.ResourceCPU]
	_, r.ReqMemory = req[corev1.ResourceMemory]
	_, r.LimCPU = lim[corev1.ResourceCPU]
	_, r.LimMemory = lim[corev1.ResourceMemory]
	return r, true
}
