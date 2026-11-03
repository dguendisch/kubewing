package bridge

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/view"
)

func markedKeys(t *testing.T, svc *Service, pane string) []string {
	t.Helper()
	rows, err := svc.Marked(pane)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, r := range rows {
		keys = append(keys, r.Key)
	}
	return keys
}

func TestMarkedRows(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-0", func(view.RowData) bool { return true })

	// rows by name: cfg, locked, settings, web-0 …; a range from web-0 up to the first row, then back to the third
	if n, err := svc.Mark(res.Pane, view.MarkOp{Op: "range", From: "s-web-0", To: 0}); err != nil || n != 4 {
		t.Fatal(err)
	}
	if got := markedKeys(t, svc, res.Pane); !slices.Equal(got, []string{"s-cfg", "s-locked", "s-settings", "s-web-0"}) {
		t.Fatalf("range: %v", got)
	}
	if _, err := svc.Mark(res.Pane, view.MarkOp{Op: "range", From: "s-web-0", To: 2}); err != nil {
		t.Fatal(err)
	}
	if got := markedKeys(t, svc, res.Pane); !slices.Equal(got, []string{"s-settings", "s-web-0"}) {
		t.Fatalf("range shrunk towards the anchor: %v", got)
	}
	if _, err := svc.Mark(res.Pane, view.MarkOp{Op: "clear"}); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"s-web-0", "s-web-1", "s-cfg"} {
		if _, err := svc.Mark(res.Pane, view.MarkOp{Op: "toggle", Key: k}); err != nil {
			t.Fatal(err)
		}
	}
	waitRow(t, log, res.Pane, "s-web-1", func(r view.RowData) bool { return r.Marked })

	// debug skips what isn't a pod; each token is bound to its pod
	b, err := svc.PrepareMarked("debug", res.Pane)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Pending) != 2 || len(b.Rows) != 2 || !slices.Equal(b.Skipped, []string{"cfg"}) || b.NeedsConfirm {
		t.Fatalf("debug batch: %+v", b)
	}
	if !slices.ContainsFunc(b.Rows[0].Containers, func(c ContainerInfo) bool { return c.Default }) {
		t.Errorf("containers with their default: %+v", b.Rows[0].Containers)
	}
	if _, err := svc.PrepareMarked("exec", res.Pane); err == nil {
		t.Error("exec must act on one row only")
	}
	if _, err := svc.PrepareMarked("scale", res.Pane); err == nil || !strings.Contains(err.Error(), "none of the marked rows") {
		t.Errorf("scale without replicas: %v", err)
	}

	// delete: one confirmation for all three; a deleted row (cfg, first in display order) loses its mark
	d, err := svc.PrepareMarked("delete", res.Pane)
	if err != nil {
		t.Fatal(err)
	}
	if !d.NeedsConfirm || d.Summary != "delete 3 e2e-static -n shop on tape" {
		t.Errorf("delete batch: %+v", d.Batch)
	}
	if err := svc.Delete(d.Pending[0].Token); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(markedKeys(t, svc, res.Pane)) != 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := markedKeys(t, svc, res.Pane); len(got) != 2 || slices.Contains(got, d.Rows[0].Key) {
		t.Errorf("after deleting %s: %v", d.Rows[0].Key, got)
	}

	// a filter that hides a marked row drops its mark
	if err := svc.Update(res.Pane, "source: {resource: e2e-static}\nstages: [{grep: web-1}]"); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for !slices.Equal(markedKeys(t, svc, res.Pane), []string{"s-web-1"}) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := markedKeys(t, svc, res.Pane); !slices.Equal(got, []string{"s-web-1"}) {
		t.Errorf("after grep: %v", got)
	}
}
