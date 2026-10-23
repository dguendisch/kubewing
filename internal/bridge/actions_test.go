package bridge

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
	"github.com/dguendisch/kubewing/internal/view"
)

// output collects a session's output and exit from the event log.
func output(log *eventLog, id string) (string, string) {
	var b strings.Builder
	exit := ""
	for _, e := range log.get(SessionEvent) {
		p := e.(SessionPayload)
		if p.ID != id {
			continue
		}
		d, _ := base64.StdEncoding.DecodeString(p.Data)
		b.Write(d)
		if p.Exit != "" {
			exit = p.Exit
		}
	}
	return b.String(), exit
}

func waitOutput(t *testing.T, log *eventLog, id string, ok func(out, exit string) bool) (string, string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if out, exit := output(log, id); ok(out, exit) {
			return out, exit
		}
		time.Sleep(10 * time.Millisecond)
	}
	out, exit := output(log, id)
	t.Fatalf("session %s: output %q exit %q", id, out, exit)
	return "", ""
}

func input(t *testing.T, svc *Service, id, s string) {
	t.Helper()
	if err := svc.SessionInput(id, base64.StdEncoding.EncodeToString([]byte(s))); err != nil {
		t.Fatal(err)
	}
}

func TestExecSession(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-1", func(view.RowData) bool { return true })
	if _, err := svc.ExecStart("forged", "", 80, 24); err == nil {
		t.Fatal("exec without a prepared token must be refused")
	}
	p, err := svc.Prepare("exec", res.Pane, "s-web-1")
	if err != nil {
		t.Fatal(err)
	}
	if p.NeedsConfirm {
		t.Errorf("exec on a context without exec confirmation: %+v", p)
	}
	er, err := svc.ExecStart(p.Token, "", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if er.Pod != "web-1" || er.Container != "app" || strings.Join(er.Others, ",") != "app,sidecar" {
		t.Errorf("exec result: %+v", er)
	}
	waitOutput(t, log, er.Session, func(out, _ string) bool { return strings.HasSuffix(out, "web-1:app$ ") })
	input(t, svc, er.Session, "hello\r")
	waitOutput(t, log, er.Session, func(out, _ string) bool { return strings.Contains(out, "hello\r\nhello\r\n") })
	if err := svc.SessionResize(er.Session, 120, 40); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	input(t, svc, er.Session, "size\r")
	waitOutput(t, log, er.Session, func(out, _ string) bool { return strings.Contains(out, "120x40") })
	input(t, svc, er.Session, "exit 3\r")
	_, exit := waitOutput(t, log, er.Session, func(_, exit string) bool { return exit != "" })
	if exit != "3" {
		t.Errorf("exit = %q, want 3", exit)
	}
	if err := svc.SessionInput(er.Session, "eA=="); err == nil {
		t.Error("an ended session must be gone")
	}
}

// Keystrokes sent one call each, faster than the shell reads, arrive in
// order (they used to race, one goroutine per write: "seq" became "esq").
func TestSessionInputKeepsOrder(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-1", func(view.RowData) bool { return true })
	p, err := svc.Prepare("exec", res.Pane, "s-web-1")
	if err != nil {
		t.Fatal(err)
	}
	er, err := svc.ExecStart(p.Token, "", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	line := "the quick brown fox jumps over the lazy dog 0123456789"
	for _, c := range line + "\r" { // before the prompt: nothing reads yet
		input(t, svc, er.Session, string(c))
	}
	waitOutput(t, log, er.Session, func(out, _ string) bool { return strings.Contains(out, line+"\r\n"+line+"\r\n") })
	_ = svc.SessionClose(er.Session)
}

func TestExecDefaultContainerAndClose(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })
	p, _ := svc.Prepare("exec", res.Pane, "s-web-0") // annotated default-container: sidecar
	er, err := svc.ExecStart(p.Token, "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if er.Container != "sidecar" {
		t.Errorf("default container: %+v", er)
	}
	p, _ = svc.Prepare("exec", res.Pane, "s-web-0")
	if _, err := svc.ExecStart(p.Token, "nope", 0, 0); err == nil || !strings.Contains(err.Error(), "no container") {
		t.Errorf("unknown container: %v", err)
	}
	// an init container (here a native sidecar) can be entered by name, as with kubectl exec -c
	p, _ = svc.Prepare("exec", res.Pane, "s-web-4")
	side, err := svc.ExecStart(p.Token, "proxy", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if side.Container != "proxy" || strings.Join(side.Others, ",") != "app,worker,setup,proxy" {
		t.Errorf("sidecar exec: %+v", side)
	}
	waitOutput(t, log, side.Session, func(out, _ string) bool { return strings.Contains(out, "web-4:proxy$ ") })
	_ = svc.SessionClose(side.Session)
	waitOutput(t, log, er.Session, func(out, _ string) bool { return strings.Contains(out, "$ ") })
	if err := svc.SessionClose(er.Session); err != nil {
		t.Fatal(err)
	}
	_, exit := waitOutput(t, log, er.Session, func(_, exit string) bool { return exit != "" })
	if exit != "0" {
		t.Errorf("closed session exit = %q", exit)
	}
}

func TestExecRefusedOnReadOnlyAndNonPods(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", ReadOnly: true}})
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })
	if _, err := svc.Prepare("exec", res.Pane, "s-web-0"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("exec on read-only: %v", err)
	}
	// describe and port-forward don't change the cluster: allowed on read-only
	if d, err := svc.Describe(res.Pane, "s-web-0"); err != nil || !strings.Contains(d.Text, "Name:         web-0") || !strings.Contains(d.Text, "Events:") {
		t.Errorf("describe on read-only: %q %v", d, err)
	}
	if _, err := svc.PortForwardStart(res.Pane, "s-web-0", []string{"8080"}); err != nil {
		t.Errorf("port-forward on read-only: %v", err)
	}

	svc2, log2, res2 := deleteSetup(t, nil)
	_ = svc2
	waitRow(t, log2, res2.Pane, "s-cfg", func(view.RowData) bool { return true })
	if _, err := svc2.Prepare("exec", res2.Pane, "s-cfg"); err == nil || !strings.Contains(err.Error(), "needs a pod") {
		t.Errorf("exec on a configmap: %v", err)
	}
	if _, err := svc2.PortForwardStart(res2.Pane, "s-cfg", []string{"80"}); err == nil || !strings.Contains(err.Error(), "needs a pod") {
		t.Errorf("port-forward on a configmap: %v", err)
	}
}

func TestPortForwardLifecycle(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })
	f, err := svc.PortForwardStart(res.Pane, "s-web-0", []string{"9090:80", "443"})
	if err != nil {
		t.Fatal(err)
	}
	want := []source.Port{{Local: 9090, Remote: 80}, {Local: 40001, Remote: 443}}
	if f.Pod != "web-0" || f.Namespace != "shop" || f.Context != "tape" || len(f.Ports) != 2 || f.Ports[0] != want[0] || f.Ports[1] != want[1] {
		t.Errorf("forward: %+v", f)
	}
	if l := svc.PortForwards(); len(l) != 1 || l[0].ID != f.ID {
		t.Errorf("list: %+v", l)
	}
	if err := svc.PortForwardStop(f.ID); err != nil {
		t.Fatal(err)
	}
	if l := svc.PortForwards(); len(l) != 0 {
		t.Errorf("after stop: %+v", l)
	}
	ev := log.get(PortForwardsEvent)
	if len(ev) < 2 || len(ev[0].([]PortForwardInfo)) != 1 || len(ev[len(ev)-1].([]PortForwardInfo)) != 0 {
		t.Errorf("events: %+v", ev)
	}
	if err := svc.PortForwardStop(f.ID); err == nil {
		t.Error("stopping twice must fail")
	}
}

func TestShutdownEndsEverything(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })
	p, _ := svc.Prepare("exec", res.Pane, "s-web-0")
	er, _ := svc.ExecStart(p.Token, "", 0, 0)
	svc.PortForwardStart(res.Pane, "s-web-0", []string{"80"})
	svc.Shutdown()
	waitOutput(t, log, er.Session, func(_, exit string) bool { return exit != "" })
	if l := svc.PortForwards(); len(l) != 0 {
		t.Errorf("forwards after shutdown: %+v", l)
	}
}

// the opener used by deleteSetup must implement every action
var _ source.Actor = (*tape.Opener)(nil)

func TestRowInfo(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-cfg", func(view.RowData) bool { return true })
	pod, err := svc.RowInfo(res.Pane, "s-web-1")
	if err != nil {
		t.Fatal(err)
	}
	if !pod.Pod || pod.Kind != "Pod" || pod.Name != "web-1" || pod.Namespace != "shop" || pod.Deleted || pod.HasPrev ||
		strings.Join(pod.Containers, ",") != "app,sidecar" || fmt.Sprint(pod.Ports) != "[8080 9090 5353]" {
		t.Errorf("pod: %+v", pod)
	}
	// name, protocol (TCP when unset) and container of each declared port, in spec order
	if want := "[{8080 http TCP app} {9090 metrics TCP app} {5353 dns UDP sidecar}]"; fmt.Sprint(pod.PortInfo) != want {
		t.Errorf("portInfo = %v, want %s", pod.PortInfo, want)
	}
	// web-1 has no container statuses: state unknown; the first container is the default
	if want := "[{app container   true} {sidecar container   false}]"; fmt.Sprint(pod.ContainerInfo) != want {
		t.Errorf("web-1 containerInfo = %v, want %s", pod.ContainerInfo, want)
	}
	// containers first, then init containers (restartPolicy Always = sidecar), with their state
	multi, _ := svc.RowInfo(res.Pane, "s-web-4")
	if want := "[{app container running  true} {worker container waiting CrashLoopBackOff false} {setup init terminated Completed false} {proxy sidecar running  false}]"; fmt.Sprint(multi.ContainerInfo) != want {
		t.Errorf("web-4 containerInfo = %v, want %s", multi.ContainerInfo, want)
	}
	// the annotation picks the default
	web0, _ := svc.RowInfo(res.Pane, "s-web-0")
	if c := web0.ContainerInfo; len(c) != 2 || c[0].Default || !c[1].Default {
		t.Errorf("web-0 default container: %+v", c)
	}
	cm, _ := svc.RowInfo(res.Pane, "s-cfg")
	if cm.Pod || cm.Kind != "ConfigMap" || cm.Containers != nil || cm.Ports != nil {
		t.Errorf("configmap: %+v", cm)
	}
	p, _ := svc.Prepare("delete", res.Pane, "s-web-2")
	if err := svc.Delete(p.Token); err != nil {
		t.Fatal(err)
	}
	waitRow(t, log, res.Pane, "s-web-2", func(r view.RowData) bool { return r.Mark == view.MarkDeleted })
	if gone, err := svc.RowInfo(res.Pane, "s-web-2"); err != nil || !gone.Deleted {
		t.Errorf("tombstone: %+v %v", gone, err)
	}
	if _, err := svc.RowInfo(res.Pane, "nope"); err == nil {
		t.Error("unknown key must fail")
	}
}

// fakeDescriber returns scripted describe output per call (a tape.Opener otherwise).
type fakeDescriber struct {
	*tape.Opener
	runs []string
	n    int
}

func (f *fakeDescriber) Describe(context.Context, string, source.Resolved, string, string) (string, error) {
	t := f.runs[min(f.n, len(f.runs)-1)]
	f.n++
	return t, nil
}

func TestDescribeDiffsAgainstThePreviousLook(t *testing.T) {
	tp, err := tape.Load("../../testdata/tapes/e2e-static.yaml")
	if err != nil {
		t.Fatal(err)
	}
	op := &tape.Opener{Tapes: map[string]*tape.Tape{"e2e-static": tp}}
	fd := &fakeDescriber{Opener: op, runs: []string{
		"Name:  web-0\nEvents:\n  Type    Reason  Age   From     Message\n  ----    ------  ----  ----     -------\n  Normal  Pulled  2m    kubelet  pulled",
		"Name:  web-0\nEvents:\n  Type     Reason     Age   From     Message\n  ----     ------     ----  ----     -------\n  Normal   Pulled     7m    kubelet  pulled\n  Warning  OOMKilled  5s    kubelet  killed",
	}}
	log := &eventLog{events: map[string][]any{}}
	cfg := config.Defaults("")
	svc := New(source.NewRegistry(op), log, Options{Actor: fd, Config: &cfg})
	res, err := svc.Open("source: {resource: e2e-static}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	svc.SetViewport(res.Pane, 0, 10)
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })

	first, err := svc.Describe(res.Pane, "s-web-0")
	if err != nil {
		t.Fatal(err)
	}
	if first.PrevNorm != "" || first.PrevAt != "" {
		t.Errorf("first look has nothing to compare: %+v", first)
	}
	second, _ := svc.Describe(res.Pane, "s-web-0")
	if second.PrevAt == "" || !strings.Contains(second.CurNorm, "OOMKilled") || strings.Contains(second.PrevNorm, "OOMKilled") {
		t.Errorf("second look: %+v", second)
	}
	// the aged Pulled event is the same line on both sides (ages blanked, columns aligned)
	line := func(text string) string {
		for _, l := range strings.Split(text, "\n") {
			if strings.Contains(l, "Pulled") {
				return l
			}
		}
		return ""
	}
	if line(second.PrevNorm) == "" || line(second.PrevNorm) != line(second.CurNorm) {
		t.Errorf("aged event must match:\n%s\n---\n%s", second.PrevNorm, second.CurNorm)
	}
	// another object has its own baseline
	other, _ := svc.Describe(res.Pane, "s-web-1")
	if other.PrevNorm != "" {
		t.Errorf("web-1's first look: %+v", other)
	}
}

func TestDebugSession(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", Confirm: []string{"debug"}}})
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })
	if _, err := svc.DebugStart("forged", DebugOptions{Image: "busybox"}, 0, 0); err == nil {
		t.Fatal("debug without a prepared token must be refused")
	}
	p, err := svc.Prepare("debug", res.Pane, "s-web-0")
	if err != nil {
		t.Fatal(err)
	}
	if !p.NeedsConfirm || p.Summary != "debug e2e-static/web-0 -n shop on tape" {
		t.Errorf("prepared: %+v", p)
	}
	// an exec token doesn't start a debug container
	ep, _ := svc.Prepare("exec", res.Pane, "s-web-0")
	if _, err := svc.DebugStart(ep.Token, DebugOptions{Image: "busybox"}, 0, 0); err == nil || !strings.Contains(err.Error(), "issued for exec") {
		t.Errorf("exec token for debug: %v", err)
	}
	// target "" = the default container (annotated: sidecar), profile "" = general
	dr, err := svc.DebugStart(p.Token, DebugOptions{Image: " nicolaka/netshoot "}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if dr.Pod != "web-0" || dr.Target != "sidecar" || dr.Image != "nicolaka/netshoot" || !strings.HasPrefix(dr.Container, "debugger-") || len(dr.Container) != 14 {
		t.Errorf("debug result: %+v", dr)
	}
	out, _ := waitOutput(t, log, dr.Session, func(out, _ string) bool { return strings.HasSuffix(out, "web-0:"+dr.Container+"$ ") })
	if !strings.Contains(out, "starting "+dr.Container+" (nicolaka/netshoot) in web-0") || !strings.Contains(out, `Pulling: Pulling image "nicolaka/netshoot"`) ||
		!strings.Contains(out, `profile general, target "sidecar"`) {
		t.Errorf("output: %q", out)
	}
	input(t, svc, dr.Session, "exit\r")
	if _, exit := waitOutput(t, log, dr.Session, func(_, exit string) bool { return exit != "" }); exit != "0" {
		t.Errorf("exit = %q", exit)
	}
	if got := svc.DebugImages(); fmt.Sprint(got) != "[nicolaka/netshoot]" {
		t.Errorf("history after a started debug: %v", got)
	}

	// no target, another profile
	p, _ = svc.Prepare("debug", res.Pane, "s-web-1")
	dr, err = svc.DebugStart(p.Token, DebugOptions{Image: "busybox", Target: "-", Profile: "netadmin"}, 0, 0)
	if err != nil || dr.Target != "" {
		t.Fatalf("untargeted: %+v %v", dr, err)
	}
	waitOutput(t, log, dr.Session, func(out, _ string) bool { return strings.Contains(out, `profile netadmin, target ""`) })
	_ = svc.SessionClose(dr.Session)

	// a container that can't start: the session ends with the reason
	p, _ = svc.Prepare("debug", res.Pane, "s-web-1")
	dr, _ = svc.DebugStart(p.Token, DebugOptions{Image: "fail/nope"}, 0, 0)
	if _, exit := waitOutput(t, log, dr.Session, func(_, exit string) bool { return exit != "" }); !strings.Contains(exit, "ImagePullBackOff") {
		t.Errorf("failed start: exit %q", exit)
	}
	// busybox started (newest first); the image that never ran isn't remembered
	if got := svc.DebugImages(); fmt.Sprint(got) != "[busybox nicolaka/netshoot]" {
		t.Errorf("history: %v", got)
	}
	if left, err := svc.RemoveDebugImage("busybox"); err != nil || fmt.Sprint(left) != "[nicolaka/netshoot]" {
		t.Errorf("remove: %v %v", left, err)
	}

	for _, c := range []struct {
		o    DebugOptions
		want string
	}{
		{DebugOptions{Image: ""}, "needs an image"},
		{DebugOptions{Image: "a b"}, "needs an image"},
		{DebugOptions{Image: "busybox", Profile: "root"}, `unknown profile "root"`},
		{DebugOptions{Image: "busybox", Target: "nope"}, `no container "nope" to target`},
	} {
		p, _ := svc.Prepare("debug", res.Pane, "s-web-1")
		if _, err := svc.DebugStart(p.Token, c.o, 0, 0); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: %v, want %q", c.o, err, c.want)
		}
	}
}

func TestDebugRefusedOnReadOnlyAndNonPods(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", ReadOnly: true}})
	waitRow(t, log, res.Pane, "s-cfg", func(view.RowData) bool { return true })
	if _, err := svc.Prepare("debug", res.Pane, "s-web-0"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("debug on read-only: %v", err)
	}
	svc2, log2, res2 := deleteSetup(t, nil)
	waitRow(t, log2, res2.Pane, "s-cfg", func(view.RowData) bool { return true })
	if _, err := svc2.Prepare("debug", res2.Pane, "s-cfg"); err == nil || !strings.Contains(err.Error(), "debug needs a pod, not configmap") {
		t.Errorf("debug on a configmap: %v", err)
	}
}
