package source

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/strategicpatch"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// debugStartTimeout bounds waiting for the debug container to run (image pull …).
const debugStartTimeout = 5 * time.Minute

// Debug implements Actor.
func (o *ClusterOpener) Debug(ctx context.Context, cluster, namespace, pod string, d DebugSpec, s ExecStreams) error {
	c, err := o.cluster(cluster)
	if err != nil {
		return err
	}
	return c.Debug(ctx, namespace, pod, d, s)
}

// Debug does what `kubectl debug -it <pod> --image … --target … --profile …`
// does: a strategic merge patch on the ephemeralcontainers subresource
// (the profile sets the security context), then attach.
func (c *Cluster) Debug(ctx context.Context, namespace, pod string, d DebugSpec, s ExecStreams) error {
	cs, err := kubernetes.NewForConfigAndClient(c.Config, c.http)
	if err != nil {
		return err
	}
	pods := cs.CoreV1().Pods(namespace)
	cur, err := pods.Get(ctx, pod, metav1.GetOptions{})
	if err != nil {
		return err
	}
	sc, err := debugSecurityContext(d.Profile)
	if err != nil {
		return err
	}
	next := cur.DeepCopy()
	next.Spec.EphemeralContainers = append(next.Spec.EphemeralContainers, corev1.EphemeralContainer{
		EphemeralContainerCommon: corev1.EphemeralContainerCommon{
			Name: d.Name, Image: d.Image, Stdin: true, TTY: true, SecurityContext: sc,
			TerminationMessagePolicy: corev1.TerminationMessageReadFile,
		},
		TargetContainerName: d.Target,
	})
	from, err := json.Marshal(cur)
	if err != nil {
		return err
	}
	to, err := json.Marshal(next)
	if err != nil {
		return err
	}
	patch, err := strategicpatch.CreateTwoWayMergePatch(from, to, cur)
	if err != nil {
		return err
	}
	if _, err := pods.Patch(ctx, pod, types.StrategicMergePatchType, patch, metav1.PatchOptions{}, "ephemeralcontainers"); err != nil {
		// a 404 without details: the subresource is missing, not the pod
		if se, ok := err.(*apierrors.StatusError); ok && se.Status().Reason == metav1.StatusReasonNotFound && (se.ErrStatus.Details == nil || se.ErrStatus.Details.Name == "") {
			return fmt.Errorf("ephemeral containers are disabled on this cluster: %w", err)
		}
		return err
	}
	if err := c.waitRunning(ctx, cs, namespace, pod, d.Name, d.Progress); err != nil {
		return err
	}
	if d.Started != nil {
		d.Started()
	}
	req := cs.CoreV1().RESTClient().Post().Resource("pods").Namespace(namespace).Name(pod).SubResource("attach").
		VersionedParams(&corev1.PodAttachOptions{Container: d.Name, Stdin: true, Stdout: true, TTY: true}, scheme.ParameterCodec)
	ex, err := executor(c.Config, req.URL())
	if err != nil {
		return err
	}
	return ex.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin: s.Stdin, Stdout: s.Stdout, Tty: true, TerminalSizeQueue: sizeQueue(s.Resize),
	})
}

// waitRunning watches the pod until the ephemeral container runs, and
// meanwhile the events about that container (image pull …), each reported
// through progress once. A container that terminated right away, or can't
// start (bad image), is an error naming the reason.
func (c *Cluster) waitRunning(ctx context.Context, cs *kubernetes.Clientset, namespace, pod, name string, progress func(string)) error {
	ctx, cancel := context.WithTimeout(ctx, debugStartTimeout)
	defer cancel()
	if progress == nil {
		progress = func(string) {}
	}
	w, err := cs.CoreV1().Pods(namespace).Watch(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("metadata.name", pod).String()})
	if err != nil {
		return err
	}
	defer w.Stop()
	// events are best effort: without the permission to watch them only the state shows
	var events <-chan watch.Event
	ew, err := cs.CoreV1().Events(namespace).Watch(ctx, metav1.ListOptions{FieldSelector: fields.Set{
		"involvedObject.name":      pod,
		"involvedObject.fieldPath": "spec.ephemeralContainers{" + name + "}",
	}.AsSelector().String()})
	if err == nil {
		defer ew.Stop()
		events = ew.ResultChan()
	}
	seen := map[string]bool{}
	say := func(line string) {
		if line != "" && !seen[line] {
			seen[line] = true
			progress(line)
		}
	}
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("debug container %s didn't start within %s", name, debugStartTimeout)
		case ev, ok := <-events:
			if !ok {
				events = nil // a nil channel blocks: go on with the pod watch alone
				continue
			}
			if e, ok := ev.Object.(*corev1.Event); ok && ev.Type != watch.Deleted {
				say(eventLine(e))
			}
		case ev, ok := <-w.ResultChan():
			if !ok {
				return fmt.Errorf("watch on pod %s ended before debug container %s started", pod, name)
			}
			p, ok := ev.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			if ev.Type == watch.Deleted {
				return fmt.Errorf("pod %s was deleted", pod)
			}
			done, err := debugState(p, name)
			if done || err != nil {
				return err
			}
			say(waitingLine(p, name))
		}
	}
}

// eventLine: "Pulling: Pulling image "busybox"" (a repeated event once, with its count).
func eventLine(e *corev1.Event) string {
	line := e.Reason + ": " + e.Message
	if e.Count > 1 {
		line += fmt.Sprintf(" (x%d)", e.Count)
	}
	return line
}

// waitingLine is the container's waiting state, e.g. "waiting: ContainerCreating".
func waitingLine(p *corev1.Pod, name string) string {
	for _, st := range p.Status.EphemeralContainerStatuses {
		if st.Name == name && st.State.Waiting != nil {
			line := "waiting: " + st.State.Waiting.Reason
			if m := st.State.Waiting.Message; m != "" {
				line += ": " + m
			}
			return line
		}
	}
	return ""
}

// debugState: true once the container runs; an error if it can't.
func debugState(p *corev1.Pod, name string) (bool, error) {
	for _, st := range p.Status.EphemeralContainerStatuses {
		if st.Name != name {
			continue
		}
		switch s := st.State; {
		case s.Running != nil:
			return true, nil
		case s.Terminated != nil:
			return false, fmt.Errorf("debug container %s terminated: %s %s", name, s.Terminated.Reason, s.Terminated.Message)
		case s.Waiting != nil && unstartable[s.Waiting.Reason]:
			return false, fmt.Errorf("debug container %s: %s: %s", name, s.Waiting.Reason, s.Waiting.Message)
		}
	}
	return false, nil
}

// Waiting reasons that won't resolve on their own.
var unstartable = map[string]bool{"ImagePullBackOff": true, "InvalidImageName": true, "CreateContainerConfigError": true, "CreateContainerError": true}
