package bridge

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/kubectl/pkg/util"
	"k8s.io/kubectl/pkg/util/podutils"

	"github.com/dguendisch/kubewing/internal/source"
)

// Port-forward to a service works like `kubectl port-forward svc/x`: the
// service's selector picks one pod (the most active, as kubectl ranks
// them), each service port is forwarded to its target port on that pod (a
// named target port looked up in the pod's containers), and the forward
// stays on that pod: it ends when the pod goes, there is no failover.

func (r row) isService() bool { return r.kind() == "Service" && r.item.Object.GetAPIVersion() == "v1" }

// servicePortInfo lists a service's ports in spec order; Target is the
// target port (a number or a container port name; the port itself when unset).
func servicePortInfo(r row) []PortInfo {
	list, _, _ := unstructured.NestedSlice(r.item.Object.Object, "spec", "ports")
	var out []PortInfo
	for _, p := range list {
		m := asMap(p)
		n, ok := intOf(m["port"])
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(m, "name")
		proto, _, _ := unstructured.NestedString(m, "protocol")
		if proto == "" {
			proto = "TCP"
		}
		target := strconv.FormatInt(n, 10)
		switch v := m["targetPort"].(type) {
		case string:
			target = v
		default:
			if t, ok := intOf(v); ok && t != 0 {
				target = strconv.FormatInt(t, 10)
			}
		}
		out = append(out, PortInfo{Port: n, Name: name, Protocol: proto, Target: target})
	}
	return out
}

// intOf reads a JSON number: int64 from the cluster source, float64 from
// plain encoding/json.
func intOf(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case float64:
		return int64(n), true
	}
	return 0, false
}

// serviceForwardWait bounds how long picking a service's pod waits for
// the pods watch's first list.
const serviceForwardWait = 10 * time.Second

// servicePod picks the pod a forward to a service goes to and translates
// the port specs ("local:servicePort", ":servicePort") to it. ports maps
// each forwarded pod port back to its service port, for display.
func (s *Service) servicePod(r row, specs []string) (pod string, out []string, ports map[uint16]uint16, err error) {
	var svc corev1.Service
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(r.item.Object.Object, &svc); err != nil {
		return "", nil, nil, fmt.Errorf("service %s: %w", r.name(), err)
	}
	if len(svc.Spec.Selector) == 0 {
		return "", nil, nil, fmt.Errorf("service %s has no selector, so no pods to forward to", svc.Name)
	}
	// TCP only: a port declared for UDP alone can't be carried (as kubectl refuses it)
	tcp, udp := map[int32]bool{}, map[int32]bool{}
	for _, p := range svc.Spec.Ports {
		if p.Protocol == corev1.ProtocolUDP {
			udp[p.Port] = true
		} else {
			tcp[p.Port] = true
		}
	}
	type spec struct {
		local string
		port  int32
	}
	parsed := make([]spec, len(specs))
	for i, p := range specs {
		local, remote, _ := strings.Cut(p, ":")
		n, err := strconv.ParseInt(remote, 10, 32)
		if err != nil {
			return "", nil, nil, fmt.Errorf("port %q: not a number", p)
		}
		if udp[int32(n)] && !tcp[int32(n)] {
			return "", nil, nil, fmt.Errorf("port %d is UDP only: port-forward carries TCP", n)
		}
		parsed[i] = spec{local: local, port: int32(n)}
	}

	best, err := s.activePod(r, labels.SelectorFromSet(svc.Spec.Selector).String())
	if err != nil {
		return "", nil, nil, err
	}
	if best.Status.Phase != corev1.PodRunning {
		return "", nil, nil, fmt.Errorf("pod %s of service %s is not running (%s)", best.Name, svc.Name, best.Status.Phase)
	}
	ports = map[uint16]uint16{}
	for _, p := range parsed {
		cp, err := util.LookupContainerPortNumberByServicePort(svc, *best, p.port)
		if err != nil {
			return "", nil, nil, err
		}
		out = append(out, fmt.Sprintf("%s:%d", p.local, cp))
		ports[uint16(cp)] = uint16(p.port)
	}
	return best.Name, out, ports, nil
}

// activePod is the most active pod the selector matches in the row's
// namespace, ranked like kubectl does (running and ready over pending, ready
// longer, fewer restarts, older).
func (s *Service) activePod(r row, selector string) (*corev1.Pod, error) {
	resource := "pods"
	if rel, err := s.relator(); err == nil {
		if res, _, err := rel.ResolveKind(r.cluster, "v1", "Pod"); err == nil {
			resource = res
		}
	}
	sub, err := s.reg.SubscribeWith(source.Key{Cluster: r.cluster, Resource: resource, Namespace: r.namespace(), LabelSelector: selector}, s.normalizer())
	if err != nil {
		return nil, err
	}
	defer sub.Close()
	ev, err := firstList(sub, serviceForwardWait)
	if err != nil {
		return nil, err
	}
	pods := make([]*corev1.Pod, 0, len(ev.Items))
	for _, it := range ev.Items {
		var p corev1.Pod
		if it.Object == nil || runtime.DefaultUnstructuredConverter.FromUnstructured(it.Object.Object, &p) != nil {
			continue
		}
		pods = append(pods, &p)
	}
	if len(pods) == 0 {
		return nil, fmt.Errorf("service %s has no pods (selector %s)", r.name(), selector)
	}
	sort.Sort(sort.Reverse(podutils.ActivePods(pods)))
	return pods[0], nil
}
