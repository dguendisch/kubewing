package bridge

import (
	"strings"
	"testing"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/view"
)

func TestEditRoundTrip(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-settings", func(view.RowData) bool { return true })

	es, err := svc.EditOpen(res.Pane, "s-settings")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(es.YAML, "mode: blue") || !strings.Contains(es.YAML, `resourceVersion: "7"`) {
		t.Fatalf("opened YAML:\n%s", es.YAML)
	}
	if _, err := svc.EditCheck(es.Session, es.YAML); err == nil || err.Error() != "no changes" {
		t.Errorf("unchanged YAML: %v", err)
	}
	edited := strings.Replace(es.YAML, "mode: blue", "mode: green", 1)
	pv, err := svc.EditCheck(es.Session, edited)
	if err != nil {
		t.Fatal(err)
	}
	// only the change and the conflict check are sent; resourceVersion is normalized out of the preview
	if pv.Patch != `{"data":{"mode":"green"},"metadata":{"resourceVersion":"7"}}` {
		t.Errorf("patch = %s", pv.Patch)
	}
	if !strings.Contains(pv.PrevNorm, "mode: blue") || !strings.Contains(pv.CurNorm, "mode: green") || strings.Contains(pv.CurNorm, "resourceVersion") || pv.NoChange {
		t.Errorf("preview: %+v", pv)
	}
	// the dry run wrote nothing
	if again, _ := svc.EditOpen(res.Pane, "s-settings"); !strings.Contains(again.YAML, "mode: blue") {
		t.Errorf("dry run persisted:\n%s", again.YAML)
	}

	p, err := svc.Prepare("edit", res.Pane, "s-settings")
	if err != nil {
		t.Fatal(err)
	}
	if p.NeedsConfirm || p.Summary != "edit e2e-static/settings -n shop on tape" {
		t.Errorf("pending: %+v", p)
	}
	if err := svc.EditApply(p.Token, es.Session, edited); err != nil {
		t.Fatal(err)
	}
	waitRow(t, log, res.Pane, "s-settings", func(view.RowData) bool {
		d, err := svc.Object(res.Pane, "s-settings")
		return err == nil && strings.Contains(d.YAML, "mode: green")
	})
	if _, err := svc.EditCheck(es.Session, edited); err == nil || !strings.Contains(err.Error(), "no longer open") {
		t.Errorf("session after apply: %v", err)
	}
}

func TestEditRefusals(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-locked", func(view.RowData) bool { return true })

	es, err := svc.EditOpen(res.Pane, "s-settings")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ from, to, want string }{
		{"name: settings", "name: other", "name and namespace must stay shop/settings"},
		{"kind: ConfigMap", "kind: Secret", "must stay a v1 ConfigMap"},
		{"uid: s-settings", "uid: x", "metadata.uid must stay s-settings"},
		{"mode: blue", "mode: [", "edited YAML:"},
	} {
		if _, err := svc.EditCheck(es.Session, strings.Replace(es.YAML, c.from, c.to, 1)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s → %s: %v, want %q", c.from, c.to, err, c.want)
		}
	}

	// someone else changes the object: the stale editor's write is a conflict, not an overwrite
	other, _ := svc.EditOpen(res.Pane, "s-settings")
	p, _ := svc.Prepare("edit", res.Pane, "s-settings")
	if err := svc.EditApply(p.Token, other.Session, strings.Replace(other.YAML, "replicas: \"3\"", "replicas: \"4\"", 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EditCheck(es.Session, strings.Replace(es.YAML, "mode: blue", "mode: red", 1)); err == nil || !strings.Contains(err.Error(), "has been modified") {
		t.Errorf("stale edit: %v", err)
	}

	// the fake webhook refuses in the dry run already
	locked, err := svc.EditOpen(res.Pane, "s-locked")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EditCheck(locked.Session, strings.Replace(locked.YAML, "mode: blue", "mode: red", 1)); err == nil || !strings.Contains(err.Error(), "locked by policy") {
		t.Errorf("webhook: %v", err)
	}

	// a token for another object doesn't write this one
	p, _ = svc.Prepare("edit", res.Pane, "s-cfg")
	if err := svc.EditApply(p.Token, locked.Session, strings.Replace(locked.YAML, "mode: blue", "mode: red", 1)); err == nil || !strings.Contains(err.Error(), "prepared edit was for shop/cfg") {
		t.Errorf("foreign token: %v", err)
	}
	// nor does another kind's
	p, _ = svc.Prepare("delete", res.Pane, "s-settings")
	if err := svc.EditApply(p.Token, es.Session, es.YAML); err == nil || !strings.Contains(err.Error(), "issued for delete") {
		t.Errorf("delete token: %v", err)
	}
}

func TestEditReadOnlyContext(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", Label: "PROD", ReadOnly: true}})
	waitRow(t, log, res.Pane, "s-settings", func(view.RowData) bool { return true })
	if _, err := svc.EditOpen(res.Pane, "s-settings"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("open on read-only: %v", err)
	}
	if _, err := svc.Prepare("edit", res.Pane, "s-settings"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("prepare on read-only: %v", err)
	}
}

func TestEditConfirmRule(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", Confirm: []string{"edit"}}})
	waitRow(t, log, res.Pane, "s-settings", func(view.RowData) bool { return true })
	p, err := svc.Prepare("edit", res.Pane, "s-settings")
	if err != nil || !p.NeedsConfirm {
		t.Errorf("confirm: [edit]: %+v %v", p, err)
	}
}
