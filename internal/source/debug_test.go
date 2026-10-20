package source

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"
)

// The profiles as kubectl debug applies them to an ephemeral container.
func TestDebugSecurityContext(t *testing.T) {
	for profile, want := range map[string]string{
		"":           "capabilities:\n  add:\n  - SYS_PTRACE\n",
		"general":    "capabilities:\n  add:\n  - SYS_PTRACE\n",
		"baseline":   "null\n",
		"restricted": "allowPrivilegeEscalation: false\ncapabilities:\n  drop:\n  - ALL\nrunAsNonRoot: true\nseccompProfile:\n  type: RuntimeDefault\n",
		"netadmin":   "capabilities:\n  add:\n  - NET_ADMIN\n  - NET_RAW\n",
		"sysadmin":   "privileged: true\n",
	} {
		sc, err := debugSecurityContext(profile)
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := yaml.Marshal(sc); string(got) != want {
			t.Errorf("%q:\n%s\nwant:\n%s", profile, got, want)
		}
	}
	if _, err := debugSecurityContext("root"); err == nil {
		t.Error("unknown profile must fail")
	}
}

func TestDebugState(t *testing.T) {
	pod := func(st corev1.ContainerState) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p"}, Status: corev1.PodStatus{EphemeralContainerStatuses: []corev1.ContainerStatus{
			{Name: "other", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
			{Name: "dbg", State: st},
		}}}
	}
	if done, err := debugState(&corev1.Pod{}, "dbg"); done || err != nil {
		t.Errorf("no status yet: %v %v", done, err)
	}
	if done, err := debugState(pod(corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ContainerCreating"}}), "dbg"); done || err != nil {
		t.Errorf("creating: %v %v", done, err)
	}
	if done, err := debugState(pod(corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}), "dbg"); !done || err != nil {
		t.Errorf("running: %v %v", done, err)
	}
	_, err := debugState(pod(corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff", Message: "pull access denied"}}), "dbg")
	if err == nil || !strings.Contains(err.Error(), "ImagePullBackOff: pull access denied") {
		t.Errorf("bad image: %v", err)
	}
	_, err = debugState(pod(corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", Message: "exec format error"}}), "dbg")
	if err == nil || !strings.Contains(err.Error(), "terminated: Error exec format error") {
		t.Errorf("terminated: %v", err)
	}
}

func TestDebugProgressLines(t *testing.T) {
	e := &corev1.Event{Reason: "Pulling", Message: `Pulling image "busybox"`, Count: 1}
	if got := eventLine(e); got != `Pulling: Pulling image "busybox"` {
		t.Errorf("event: %q", got)
	}
	e = &corev1.Event{Reason: "BackOff", Message: `Back-off pulling image "nope"`, Count: 3}
	if got := eventLine(e); got != `BackOff: Back-off pulling image "nope" (x3)` {
		t.Errorf("repeated event: %q", got)
	}
	p := &corev1.Pod{Status: corev1.PodStatus{EphemeralContainerStatuses: []corev1.ContainerStatus{
		{Name: "dbg", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ContainerCreating"}}},
	}}}
	if got := waitingLine(p, "dbg"); got != "waiting: ContainerCreating" {
		t.Errorf("waiting: %q", got)
	}
	if got := waitingLine(p, "other"); got != "" {
		t.Errorf("unknown container: %q", got)
	}
}
