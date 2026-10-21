package source

import (
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// The pod ops-toolbelt's hacks/ops-pod creates, in its flavors.
func TestOpsPodManifest(t *testing.T) {
	plain := OpsPodManifest(OpsPodSpec{Name: "ops-pod-x", Namespace: "kube-system", Node: "n1", Image: "ops-toolbelt"})
	s, c := plain.Spec, plain.Spec.Containers[0]
	if plain.Namespace != "kube-system" || s.NodeName != "n1" || !s.HostPID || s.HostNetwork || s.RestartPolicy != corev1.RestartPolicyNever {
		t.Errorf("spec: %+v", s)
	}
	// every taint tolerated (NoSchedule, NoExecute, dedicated etcd pools)
	if len(s.Tolerations) != 1 || s.Tolerations[0].Operator != corev1.TolerationOpExists || s.Tolerations[0].Key != "" || s.Tolerations[0].Effect != "" {
		t.Errorf("tolerations: %+v", s.Tolerations)
	}
	if c.Name != OpsPodContainer || c.Image != "ops-toolbelt" || !*c.SecurityContext.Privileged || !slices.Equal(c.Command, []string{"sleep", "43200"}) {
		t.Errorf("container: %+v", c)
	}
	if len(s.Volumes) != 0 || len(c.VolumeMounts) != 0 {
		t.Errorf("no host root asked for: %+v %+v", s.Volumes, c.VolumeMounts)
	}
	if plain.Labels["app"] != "opspod" || plain.Labels["networking.gardener.cloud/to-seed-apiserver"] != "allowed" || plain.Annotations["sidecar.istio.io/inject"] != "false" {
		t.Errorf("metadata: %+v %+v", plain.Labels, plain.Annotations)
	}

	for _, p := range []OpsPodSpec{{HostRoot: true}, {Chroot: true}} {
		m := OpsPodManifest(p)
		v, vm := m.Spec.Volumes, m.Spec.Containers[0].VolumeMounts
		if len(v) != 1 || v[0].HostPath == nil || v[0].HostPath.Path != "/" || len(vm) != 1 || vm[0].MountPath != "/host" ||
			*vm[0].MountPropagation != corev1.MountPropagationHostToContainer {
			t.Errorf("%+v: host root: %+v %+v", p, v, vm)
		}
	}
	if !OpsPodManifest(OpsPodSpec{HostNetwork: true}).Spec.HostNetwork {
		t.Error("host network")
	}
}

func TestOpsPodShell(t *testing.T) {
	if got := strings.Join(OpsPodShell(false), " "); got != "sh -c command -v bash >/dev/null 2>&1 && exec bash || exec sh" {
		t.Errorf("plain: %q", got)
	}
	if got := OpsPodShell(true); !slices.Equal(got[:2], []string{"chroot", "/host"}) {
		t.Errorf("chroot: %q", got)
	}
	if got := (OpsPodSpec{Image: "i", Node: "n", Chroot: true, HostNetwork: true}).String(); got != "i on n, chroot /host, host network" {
		t.Errorf("summary: %q", got)
	}
}
