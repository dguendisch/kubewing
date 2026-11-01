package source

import (
	"maps"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	resourcehelper "k8s.io/component-helpers/resource"
)

// UnfinishedPods selects the pods kubectl describe node counts in its
// "Allocated resources" (watched with spec.nodeName set by the caller, or
// cluster-wide and summed by node).
const UnfinishedPods = "status.phase!=Succeeded,status.phase!=Failed"

// Amounts are resource amounts by resource name ("cpu", "memory",
// "ephemeral-storage", "nvidia.com/gpu" …): cpu in millicores, the others
// in their unit (bytes, a count).
type Amounts map[string]int64

// Resources is a pod's effective requests and limits; a resource the pod
// doesn't set isn't in them (a percentage of an unset one has no meaning;
// a sum adds 0 for it).
type Resources struct {
	Requests, Limits Amounts
}

// Allocation is what a node's unfinished pods request and are limited to
// (a pod without a limit adds nothing to Limits, as in kubectl's sum), and
// how many there are.
type Allocation struct {
	Requests, Limits Amounts
	Pods             int64
}

// Add adds a pod's resources (sign -1: takes them out).
func (a *Allocation) Add(r Resources, sign int64) {
	add := func(to *Amounts, from Amounts) {
		if *to == nil {
			*to = Amounts{}
		}
		for k, v := range from {
			(*to)[k] += sign * v
		}
	}
	add(&a.Requests, r.Requests)
	add(&a.Limits, r.Limits)
	a.Pods += sign
}

// Clone is a copy that doesn't share its maps.
func (a Allocation) Clone() Allocation {
	return Allocation{Requests: maps.Clone(a.Requests), Limits: maps.Clone(a.Limits), Pods: a.Pods}
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
	return Resources{Requests: amounts(resourcehelper.PodRequests(&pod, opts)), Limits: amounts(resourcehelper.PodLimits(&pod, opts))}, true
}

func amounts(l corev1.ResourceList) Amounts {
	out := make(Amounts, len(l))
	for name, q := range l {
		if name == corev1.ResourceCPU {
			out[string(name)] = q.MilliValue()
		} else {
			out[string(name)] = q.Value()
		}
	}
	return out
}
