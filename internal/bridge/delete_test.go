package bridge

import (
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
	"github.com/dguendisch/kubewing/internal/view"
)

func deleteSetup(t *testing.T, rules []config.ContextRule) (*Service, *eventLog, OpenResult) {
	t.Helper()
	tp, err := tape.Load("../../testdata/tapes/e2e-static.yaml")
	if err != nil {
		t.Fatal(err)
	}
	op := &tape.Opener{Tapes: map[string]*tape.Tape{"e2e-static": tp}}
	cfg := config.Defaults("")
	cfg.Config.Contexts = rules
	log := &eventLog{events: map[string][]any{}}
	svc := New(source.NewRegistry(op), log, Options{Actor: op, Config: &cfg})
	res, err := svc.Open("source: {resource: e2e-static}")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(res.Pane) })
	svc.SetViewport(res.Pane, 0, 10)
	return svc, log, res
}

// lastRow returns the latest frame row for key on pane.
func lastRow(log *eventLog, pane, key string) (view.RowData, bool) {
	var row view.RowData
	found := false
	for _, e := range log.get(FrameEvent) {
		f := e.(FramePayload)
		if f.Pane != pane {
			continue
		}
		for _, r := range f.Frame.Rows {
			if r.Key == key {
				row, found = r, true
			}
		}
	}
	return row, found
}

func waitRow(t *testing.T, log *eventLog, pane, key string, ok func(view.RowData) bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if r, found := lastRow(log, pane, key); found && ok(r) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	r, _ := lastRow(log, pane, key)
	t.Fatalf("row %s never matched; last: %+v", key, r)
}

func TestDeleteNeedsPreparedToken(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	if res.Context != "tape" {
		t.Errorf("OpenResult.Context = %q, want the resolved context", res.Context)
	}
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })

	if err := svc.Delete("forged"); err == nil {
		t.Fatal("delete without a prepared token must be refused")
	}
	p, err := svc.Prepare("delete", res.Pane, "s-web-0")
	if err != nil {
		t.Fatal(err)
	}
	if !p.NeedsConfirm || p.Action.Resource != "e2e-static" || p.Action.Name != "web-0" || p.Action.UID != "s-web-0" || p.Action.Context != "tape" || p.Action.Namespace != "shop" {
		t.Errorf("pending: %+v", p)
	}
	if err := svc.Delete(p.Token); err != nil {
		t.Fatal(err)
	}
	waitRow(t, log, res.Pane, "s-web-0", func(r view.RowData) bool { return r.Mark == view.MarkDeleted })
	if err := svc.Delete(p.Token); err == nil {
		t.Error("token reuse must be refused")
	}
	if _, err := svc.Prepare("delete", res.Pane, "s-web-0"); err == nil || !strings.Contains(err.Error(), "gone") {
		t.Errorf("deleting a tombstone: %v", err)
	}
}

func TestReadOnlyContextRefusesDelete(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", Label: "PROD", ReadOnly: true}})
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })
	r, err := svc.ContextRule("")
	if err != nil || !r.ReadOnly || r.Label != "PROD" || r.Context != "tape" {
		t.Errorf("rule for the current context: %+v %v", r, err)
	}
	if _, err := svc.Prepare("delete", res.Pane, "s-web-0"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("prepare on read-only: %v", err)
	}
}
