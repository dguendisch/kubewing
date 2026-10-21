package source

import (
	"context"
	"fmt"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// OpsPodContainer is the ops pod's one container.
const OpsPodContainer = "ops-pod"

// OpsPodLabel marks ops pods kubewing created (app=opspod, as the ops-toolbelt scripts do).
const OpsPodLabel = "app"

// opsPodCleanupTimeout bounds deleting the ops pod after the session.
const opsPodCleanupTimeout = 30 * time.Second

// OpsPod implements Actor.
func (o *ClusterOpener) OpsPod(ctx context.Context, cluster string, p OpsPodSpec, s ExecStreams) error {
	c, err := o.cluster(cluster)
	if err != nil {
		return err
	}
	return c.OpsPod(ctx, p, s)
}

// OpsPod does what ops-toolbelt's ops-pod script does: a privileged pod
// pinned to the node (hostPID, every taint tolerated; optionally the
// node's / at /host and the host network), a shell in it once it runs
// (chrooted into /host with Chroot) and the pod deleted when the shell ends,
// also when ctx is cancelled (pane closed, app quit).
func (c *Cluster) OpsPod(ctx context.Context, p OpsPodSpec, s ExecStreams) error {
	cs, err := kubernetes.NewForConfigAndClient(c.Config, c.http)
	if err != nil {
		return err
	}
	pods := cs.CoreV1().Pods(p.Namespace)
	if _, err := pods.Create(ctx, OpsPodManifest(p), metav1.CreateOptions{}); err != nil {
		return err
	}
	defer func() {
		// the session's ctx may be gone already: cleanup gets its own
		dctx, cancel := context.WithTimeout(context.Background(), opsPodCleanupTimeout)
		defer cancel()
		if err := pods.Delete(dctx, p.Name, metav1.DeleteOptions{}); err != nil {
			log.Printf("ops pod %s/%s: delete: %v", p.Namespace, p.Name, err)
		}
	}()
	if err := c.waitRunning(ctx, cs, p.Namespace, p.Name, OpsPodContainer, "", p.Progress); err != nil {
		return err
	}
	if p.Started != nil {
		p.Started()
	}
	return c.Exec(ctx, p.Namespace, p.Name, OpsPodContainer, OpsPodShell(p.Chroot), s)
}

// OpsPodShell is what runs in the ops pod: bash, else sh; with chroot in
// the node's root file system (mounted at /host), so it's the node's shell.
func OpsPodShell(chroot bool) []string {
	shell := "command -v bash >/dev/null 2>&1 && exec bash || exec sh"
	if chroot {
		return []string{"chroot", "/host", "sh", "-c", shell}
	}
	return []string{"sh", "-c", shell}
}

// OpsPodManifest is the ops pod for p (ops-toolbelt's hacks/ops-pod). Pure.
func OpsPodManifest(p OpsPodSpec) *corev1.Pod {
	pod := &corev1.Pod{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      p.Name,
			Namespace: p.Namespace,
			Labels: map[string]string{
				OpsPodLabel: "opspod",
				// Gardener seeds: reach the seed's API server through network policies
				"networking.gardener.cloud/to-seed-apiserver": "allowed",
			},
			Annotations: map[string]string{"sidecar.istio.io/inject": "false"},
		},
		Spec: corev1.PodSpec{
			// bound directly, not scheduled: works on cordoned and full nodes too
			NodeName:                      p.Node,
			Tolerations:                   []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
			EnableServiceLinks:            ptr(false),
			HostPID:                       true,
			HostNetwork:                   p.HostNetwork,
			RestartPolicy:                 corev1.RestartPolicyNever,
			TerminationGracePeriodSeconds: ptr[int64](1), // sleep as PID 1 ignores SIGTERM
			Containers: []corev1.Container{{
				Name:    OpsPodContainer,
				Image:   p.Image,
				Command: []string{"sleep", "43200"},
				Stdin:   true,
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1m"), corev1.ResourceMemory: resource.MustParse("1Mi")},
					Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("1Gi")},
				},
				SecurityContext: &corev1.SecurityContext{Privileged: ptr(true)},
			}},
		},
	}
	if p.HostRoot || p.Chroot {
		prop := corev1.MountPropagationHostToContainer
		pod.Spec.Containers[0].VolumeMounts = []corev1.VolumeMount{{Name: "host-root", MountPath: "/host", MountPropagation: &prop}}
		pod.Spec.Volumes = []corev1.Volume{{Name: "host-root", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/"}}}}
	}
	return pod
}

// OpsPodSpec describes an ops pod.
type OpsPodSpec struct {
	Name, Namespace, Node, Image string
	// HostRoot mounts the node's / at /host.
	HostRoot bool
	// Chroot runs the shell in /host: the node's tools and files (implies HostRoot).
	Chroot bool
	// HostNetwork puts the pod into the node's network namespace.
	HostNetwork bool
	// Started is called once the pod runs, before the shell starts.
	Started func()
	// Progress reports what happens until then (scheduling, image pull …), one line each.
	Progress func(line string)
}

// String is the pod's settings in a few words (session header, logs).
func (p OpsPodSpec) String() string {
	s := fmt.Sprintf("%s on %s", p.Image, p.Node)
	switch {
	case p.Chroot:
		s += ", chroot /host"
	case p.HostRoot:
		s += ", host root at /host"
	}
	if p.HostNetwork {
		s += ", host network"
	}
	return s
}
