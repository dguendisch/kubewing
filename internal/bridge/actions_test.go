package bridge

import (
	"encoding/base64"
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
	if d, err := svc.Describe(res.Pane, "s-web-0"); err != nil || !strings.Contains(d, "Name:         web-0") || !strings.Contains(d, "Events:") {
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
		strings.Join(pod.Containers, ",") != "app,sidecar" || len(pod.Ports) != 2 || pod.Ports[0] != 8080 || pod.Ports[1] != 9090 {
		t.Errorf("pod: %+v", pod)
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
