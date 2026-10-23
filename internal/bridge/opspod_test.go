package bridge

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
	"github.com/dguendisch/kubewing/internal/view"
)

// opsPodSetup: the static pods pane, plus the nodes tape on the same opener.
func opsPodSetup(t *testing.T, rules []config.ContextRule) (*Service, *tape.Opener, *eventLog, OpenResult) {
	t.Helper()
	pods, err := tape.Load("../../testdata/tapes/e2e-static.yaml")
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := tape.Load("../../testdata/tapes/nodes.yaml")
	if err != nil {
		t.Fatal(err)
	}
	pvs, err := tape.Load("../../testdata/tapes/persistentvolumes.yaml")
	if err != nil {
		t.Fatal(err)
	}
	op := &tape.Opener{Tapes: map[string]*tape.Tape{"e2e-static": pods, "nodes": nodes, "persistentvolumes": pvs}}
	cfg := config.Defaults("")
	cfg.Config.Contexts = rules
	log := &eventLog{events: map[string][]any{}}
	svc := New(source.NewRegistry(op), log, Options{Actor: op, Config: &cfg, User: "D012345@corp"})
	res, err := svc.Open("source: {resource: e2e-static}")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(res.Pane) })
	svc.SetViewport(res.Pane, 0, 10)
	return svc, op, log, res
}

func waitNodes(t *testing.T, svc *Service, cluster string) NodeList {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if l := svc.Nodes(cluster); !l.Loading {
			return l
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("nodes still loading")
	return NodeList{}
}

func TestNodesShareTheNodesPanesWatch(t *testing.T) {
	svc, _, log, _ := opsPodSetup(t, nil)
	nodesPane, err := svc.Open("source: {resource: nodes}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(nodesPane.Pane)
	svc.SetViewport(nodesPane.Pane, 0, 10)
	waitRow(t, log, nodesPane.Pane, "n-1", func(view.RowData) bool { return true })
	before := svc.reg.Active()
	l := waitNodes(t, svc, "")
	if svc.reg.Active() != before {
		t.Errorf("the dialog started its own watch (%d → %d)", before, svc.reg.Active())
	}
	if l.Context != "tape" || len(l.Nodes) != 3 {
		t.Fatalf("nodes: %+v", l)
	}
	want := []NodeInfo{
		{Name: "ip-10-0-1-11.ec2.internal", Ready: "True", Pool: "worker-a", Zone: "eu-1a"},
		{Name: "ip-10-0-2-22.ec2.internal", Ready: "True", Unschedulable: true, Pool: "worker-a", Zone: "eu-1b"},
		{Name: "ip-10-0-3-33.ec2.internal", Ready: "Unknown", Pool: "etcd", Zone: "eu-1c"},
	}
	if fmt.Sprint(l.Nodes) != fmt.Sprint(want) {
		t.Errorf("nodes:\n%+v\nwant\n%+v", l.Nodes, want)
	}
	// the nodes pane closes: the dialog's lease keeps the watch alive
	svc.Close(nodesPane.Pane)
	if svc.reg.Active() != before {
		t.Errorf("the dialog's lease must keep the shared watch (%d active)", svc.reg.Active())
	}
	if got := svc.opsPodNodes(); len(got) != 1 || got[0] != "" {
		t.Errorf("node watches: %q, want the current context's", got)
	}
	svc.Shutdown()
	if got := svc.opsPodNodes(); len(got) != 0 {
		t.Errorf("node watches after shutdown: %v", got)
	}
}

func TestOpsPodDefaultsAndName(t *testing.T) {
	svc, _, _, _ := opsPodSetup(t, nil)
	// nothing ran, nothing configured: host root and host network on
	if got := svc.OpsPodDefaults(); got != (OpsPodDefaults{OpsPodSettings: config.DefaultOpsPodSettings}) {
		t.Errorf("fresh: %+v", got)
	}
	for user, want := range map[string]string{"jdoe": "ops-pod-kubewing-jdoe-", `CORP\J.Doe`: "ops-pod-kubewing-corp-j-doe-", "": "ops-pod-kubewing-", "---": "ops-pod-kubewing-"} {
		got := opsPodName(user)
		if !strings.HasPrefix(got, want) || len(got) != len(want)+8 || !dns1123.MatchString(got) {
			t.Errorf("%q: %q, want %s<8 hex>", user, got, want)
		}
	}
	if got := opsPodName(strings.Repeat("a", 80)); len(got) > 63 {
		t.Errorf("long user: %q", got)
	}
}

func TestOpsPodTargetFromRow(t *testing.T) {
	svc, _, log, res := opsPodSetup(t, nil)
	waitRow(t, log, res.Pane, "s-cfg", func(view.RowData) bool { return true })
	for key, want := range map[string]string{"s-web-3": "ip-10-0-2-22.ec2.internal", "s-web-1": "", "s-cfg": ""} {
		if got, err := svc.OpsPodTargetFor(res.Pane, key); err != nil || got.Node != want {
			t.Errorf("%s: %+v %v, want %q", key, got, err, want)
		}
	}
	nodesPane, _ := svc.Open("source: {resource: nodes}")
	defer svc.Close(nodesPane.Pane)
	svc.SetViewport(nodesPane.Pane, 0, 10)
	waitRow(t, log, nodesPane.Pane, "n-3", func(view.RowData) bool { return true })
	if got, _ := svc.OpsPodTargetFor(nodesPane.Pane, "n-3"); got.Node != "ip-10-0-3-33.ec2.internal" {
		t.Errorf("node row: %+v", got)
	}
}

func TestOpsPodSession(t *testing.T) {
	svc, op, log, _ := opsPodSetup(t, []config.ContextRule{{Match: "tape", Confirm: []string{"opspod"}}})
	waitNodes(t, svc, "")
	if _, err := svc.PrepareOpsPod("", "nope"); err == nil || !strings.Contains(err.Error(), `no node "nope" on tape`) {
		t.Errorf("unknown node: %v", err)
	}
	if _, err := svc.PrepareOpsPod("", " "); err == nil {
		t.Error("an empty node must be refused")
	}
	if _, err := svc.OpsPodStart("forged", OpsPodOptions{Image: "x"}, 0, 0); err == nil {
		t.Error("an ops pod without a prepared token must be refused")
	}
	node := "ip-10-0-1-11.ec2.internal"
	p, err := svc.PrepareOpsPod("", node)
	if err != nil {
		t.Fatal(err)
	}
	if !p.NeedsConfirm || p.Summary != "node shell on node "+node+" on tape" || p.Action.UID != "n-1" {
		t.Errorf("prepared: %+v", p)
	}
	r, err := svc.OpsPodStart(p.Token, OpsPodOptions{Image: " ops-toolbelt ", Chroot: true, HostNetwork: true}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if r.Namespace != "default" || r.Node != node || r.Image != "ops-toolbelt" || !strings.HasPrefix(r.Pod, "ops-pod-kubewing-d012345-corp-") || r.Settings != "chroot /host, host network" {
		t.Errorf("result: %+v", r)
	}
	out, _ := waitOutput(t, log, r.Session, func(out, _ string) bool { return strings.HasSuffix(out, node+":"+r.Pod+"$ ") })
	if !strings.Contains(out, "creating default/"+r.Pod+" (ops-toolbelt on "+node+", chroot /host, host network)") || !strings.Contains(out, `runs "chroot /host sh -c`) {
		t.Errorf("output: %q", out)
	}
	// the pod exists while the shell runs: chroot implies the host root mount
	pod := op.OpsPods()["default/"+r.Pod]
	if pod == nil || pod.Spec.NodeName != node || !pod.Spec.HostNetwork || len(pod.Spec.Volumes) != 1 {
		t.Fatalf("pod during the session: %+v", pod)
	}
	input(t, svc, r.Session, "exit\r")
	out, exit := waitOutput(t, log, r.Session, func(_, exit string) bool { return exit != "" })
	if exit != "0" || !strings.Contains(out, "deleting default/"+r.Pod) {
		t.Errorf("exit %q, output %q", exit, out)
	}
	if len(op.OpsPods()) != 0 {
		t.Errorf("pod left after the shell: %v", op.OpsPods())
	}
	// one image history with debug containers; the settings are the dialog's next defaults
	if got := svc.DebugImages(); fmt.Sprint(got) != "[ops-toolbelt]" {
		t.Errorf("history: %v", got)
	}
	want := OpsPodDefaults{Image: "ops-toolbelt", OpsPodSettings: config.OpsPodSettings{Namespace: "default", Chroot: true, HostRoot: true, HostNetwork: true}, Remembered: true}
	if got := svc.OpsPodDefaults(); got != want {
		t.Errorf("defaults after a pod ran: %+v", got)
	}

	for _, c := range []struct {
		o    OpsPodOptions
		want string
	}{
		{OpsPodOptions{Image: ""}, "needs an image"},
		{OpsPodOptions{Image: "a b"}, "needs an image"},
		{OpsPodOptions{Image: "x", Namespace: "Kube_System"}, "not a namespace name"},
	} {
		p, _ := svc.PrepareOpsPod("", node)
		if _, err := svc.OpsPodStart(p.Token, c.o, 0, 0); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: %v, want %q", c.o, err, c.want)
		}
	}
	// an image that never runs: the session ends with the reason, the pod is gone, nothing remembered
	p, _ = svc.PrepareOpsPod("", node)
	r, _ = svc.OpsPodStart(p.Token, OpsPodOptions{Image: "fail/nope", Namespace: "kube-system"}, 0, 0)
	if _, exit := waitOutput(t, log, r.Session, func(_, exit string) bool { return exit != "" }); !strings.Contains(exit, "ImagePullBackOff") {
		t.Errorf("failed start: %q", exit)
	}
	if len(op.OpsPods()) != 0 || fmt.Sprint(svc.DebugImages()) != "[ops-toolbelt]" {
		t.Errorf("after a failed start: pods %v, history %v", op.OpsPods(), svc.DebugImages())
	}
}

// Quitting the app deletes running ops pods before Shutdown returns.
func TestShutdownDeletesOpsPods(t *testing.T) {
	svc, op, log, _ := opsPodSetup(t, nil)
	waitNodes(t, svc, "")
	p, _ := svc.PrepareOpsPod("", "ip-10-0-2-22.ec2.internal")
	r, err := svc.OpsPodStart(p.Token, OpsPodOptions{Image: "busybox"}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	waitOutput(t, log, r.Session, func(out, _ string) bool { return strings.HasSuffix(out, "$ ") })
	if len(op.OpsPods()) != 1 {
		t.Fatalf("pods: %v", op.OpsPods())
	}
	svc.Shutdown()
	if len(op.OpsPods()) != 0 {
		t.Errorf("pods after shutdown: %v", op.OpsPods())
	}
}

func TestOpsPodRefusedOnReadOnly(t *testing.T) {
	svc, _, _, _ := opsPodSetup(t, []config.ContextRule{{Match: "tape", ReadOnly: true}})
	waitNodes(t, svc, "")
	if _, err := svc.PrepareOpsPod("", "ip-10-0-1-11.ec2.internal"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("ops pod on read-only: %v", err)
	}
}

func waitPVs(t *testing.T, svc *Service) PVList {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if l := svc.PersistentVolumes(""); !l.Loading {
			return l
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("persistent volumes still loading")
	return PVList{}
}

func TestOpsPodPersistentVolume(t *testing.T) {
	svc, op, log, _ := opsPodSetup(t, nil)
	waitNodes(t, svc, "")
	l := waitPVs(t, svc)
	want := []PVInfo{
		{Name: "pv-etcd-main", Phase: "Bound", Claim: "garden/main-etcd-0", Capacity: "25Gi", StorageClass: "gp3", AccessModes: []string{"ReadWriteOnce"}},
		{Name: "pv-old", Phase: "Released", Capacity: "5Gi", StorageClass: "efs", AccessModes: []string{"ReadWriteMany"}},
		{Name: "pv-spare", Phase: "Available", Capacity: "1Gi", StorageClass: "gp3", AccessModes: []string{"ReadWriteOnce"}},
	}
	if fmt.Sprint(l.PVs) != fmt.Sprint(want) {
		t.Errorf("pvs:\n%+v\nwant\n%+v", l.PVs, want)
	}
	node := "ip-10-0-1-11.ec2.internal"
	for _, c := range []struct {
		o    OpsPodOptions
		want string
	}{
		{OpsPodOptions{Image: "x", PV: "pv-spare"}, "pv-spare is available, not bound to a claim"},
		{OpsPodOptions{Image: "x", PV: "pv-old"}, "pv-old is released, not bound"},
		{OpsPodOptions{Image: "x", PV: "nope"}, `no persistent volume "nope"`},
		{OpsPodOptions{Image: "x", PV: "pv-etcd-main", Namespace: "shop"}, "claimed in namespace garden: the pod must run there, not in shop"},
		{OpsPodOptions{Image: "x", PV: "pv-etcd-main", MountPath: "data"}, `mount path "data"`},
		{OpsPodOptions{Image: "x", PV: "pv-etcd-main", MountPath: "/host/x"}, "not under /host"},
	} {
		if _, err := svc.OpsPodManifest("", node, c.o); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: %v, want %q", c.o, err, c.want)
		}
	}
	// the claim's namespace; the default mount path
	y, err := svc.OpsPodManifest("", node, OpsPodOptions{Image: "x", PV: "pv-etcd-main", ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"namespace: garden", "claimName: main-etcd-0", "mountPath: /pv", "readOnly: true", "nodeName: " + node} {
		if !strings.Contains(y, w) {
			t.Errorf("manifest lacks %q:\n%s", w, y)
		}
	}
	if strings.Contains(y, "status:") {
		t.Errorf("manifest has a status:\n%s", y)
	}
	// priorityClassName is offered as a commented line just after nodeName (uncomment to survive a full node)
	if !strings.Contains(y, "# priorityClassName: system-cluster-critical") {
		t.Errorf("manifest lacks the priorityClassName comment:\n%s", y)
	}
	if ni := strings.Index(y, "nodeName:"); ni >= 0 && !strings.Contains(y[ni:], "# priorityClassName") {
		t.Errorf("priorityClassName comment not after nodeName:\n%s", y)
	}
	p, _ := svc.PrepareOpsPod("", node)
	r, err := svc.OpsPodStart(p.Token, OpsPodOptions{Image: "x", PV: "pv-etcd-main", MountPath: "/data"}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	waitOutput(t, log, r.Session, func(out, _ string) bool { return strings.HasSuffix(out, "$ ") })
	pod := op.OpsPods()["garden/"+r.Pod]
	if pod == nil || pod.Spec.Volumes[0].PersistentVolumeClaim.ClaimName != "main-etcd-0" || r.Settings != "pv-etcd-main at /data" {
		t.Fatalf("pod %+v, settings %q", pod, r.Settings)
	}
	_ = svc.SessionClose(r.Session)
}

func TestOpsPodEditedYAML(t *testing.T) {
	svc, op, log, _ := opsPodSetup(t, nil)
	waitNodes(t, svc, "")
	node := "ip-10-0-1-11.ec2.internal"
	o := OpsPodOptions{Image: "busybox", Namespace: "kube-system", HostRoot: true}
	y, err := svc.OpsPodManifest("", node, o)
	if err != nil {
		t.Fatal(err)
	}
	// the rendered name is kept; anything else may change
	edited := strings.Replace(y, "  nodeName: ", "  priorityClassName: system-cluster-critical\n  nodeName: ", 1)
	edited = strings.Replace(edited, "image: busybox", "image: busybox:edited", 1)
	start := func(yaml string) (OpsPodResult, error) {
		p, err := svc.PrepareOpsPod("", node)
		if err != nil {
			t.Fatal(err)
		}
		return svc.OpsPodStart(p.Token, OpsPodOptions{Image: o.Image, Namespace: o.Namespace, HostRoot: true, YAML: yaml}, 0, 0)
	}
	r, err := start(edited)
	if err != nil {
		t.Fatal(err)
	}
	waitOutput(t, log, r.Session, func(out, _ string) bool { return strings.HasSuffix(out, "$ ") })
	pod := op.OpsPods()["kube-system/"+r.Pod]
	if pod == nil || pod.Spec.PriorityClassName != "system-cluster-critical" || r.Image != "busybox:edited" || !strings.Contains(y, "name: "+r.Pod) {
		t.Fatalf("edited pod: %+v, result %+v", pod, r)
	}
	if !strings.HasSuffix(r.Settings, "edited YAML") {
		t.Errorf("settings: %q", r.Settings)
	}
	_ = svc.SessionClose(r.Session)

	for _, c := range []struct{ yaml, want string }{
		{strings.Replace(y, "nodeName: "+node, "nodeName: other", 1), "spec.nodeName must stay " + node},
		{strings.Replace(y, "kind: Pod", "kind: Deployment", 1), "must stay a v1 Pod"},
		{strings.Replace(y, "name: ops-pod\n", "name: renamed\n", 1), `container "ops-pod"`},
		{strings.Replace(y, "namespace: kube-system", "namespace: default", 1), "name and namespace must stay"},
		{strings.Replace(y, "  nodeName: ", "  nodeNmae: x\n  nodeName: ", 1), "unknown field"},
		{"{not: [yaml", "edited YAML"},
	} {
		if _, err := start(c.yaml); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v, want %q", err, c.want)
		}
		// the dialog's check finds the same, before anything is prepared
		if err := svc.CheckOpsPod("", node, OpsPodOptions{Image: o.Image, Namespace: o.Namespace, HostRoot: true, YAML: c.yaml}); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("check: %v, want %q", err, c.want)
		}
	}
	if err := svc.CheckOpsPod("", node, OpsPodOptions{Image: o.Image, Namespace: o.Namespace, HostRoot: true, YAML: edited}); err != nil {
		t.Errorf("check of a good edit: %v", err)
	}
}
