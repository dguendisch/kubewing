package bridge

import (
	"strings"
	"testing"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
	"github.com/dguendisch/kubewing/internal/view"
)

func blameSetup(t *testing.T) (*Service, *eventLog, OpenResult) {
	t.Helper()
	tp, err := tape.Load("../../testdata/tapes/e2e-blame.yaml")
	if err != nil {
		t.Fatal(err)
	}
	op := &tape.Opener{Tapes: map[string]*tape.Tape{"e2e-blame": tp}}
	log := &eventLog{events: map[string][]any{}}
	cfg := config.Defaults("")
	svc := New(source.NewRegistry(op), log, Options{Actor: op, Config: &cfg})
	res, err := svc.Open("source: {resource: e2e-blame}")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(res.Pane) })
	svc.SetViewport(res.Pane, 0, 10)
	waitRow(t, log, res.Pane, "b-web", func(view.RowData) bool { return true })
	return svc, log, res
}

// owners maps each line's text to its first owner's manager.
func owners(t *testing.T, text string, r BlameResult) map[string]string {
	t.Helper()
	lines := strings.Split(text, "\n")
	out := map[string]string{}
	for _, l := range r.Lines {
		out[strings.TrimSpace(lines[l.Line])] = l.Owners[0].Manager
	}
	return out
}

func TestBlameNamesTheManagerOfEachLine(t *testing.T) {
	svc, _, res := blameSetup(t)
	d, err := svc.Object(res.Pane, "b-web")
	if err != nil {
		t.Fatal(err)
	}
	// the watch strips them: the view never shows managedFields
	if strings.Contains(d.YAML, "managedFields") {
		t.Fatalf("YAML has managedFields:\n%s", d.YAML)
	}
	r, err := svc.Blame(res.Pane, "b-web", d.YAML)
	if err != nil {
		t.Fatal(err)
	}
	got := owners(t, d.YAML, r)
	want := map[string]string{
		"labels:":             "kubectl-client-side-apply",
		"app: web":            "kubectl-client-side-apply",
		"replicas: 3":         "autoscaler",
		"- image: nginx:1.27": "kubectl-client-side-apply",
		"name: app":           "kubectl-client-side-apply",
		"- image: envoy:1.30": "sidecar-injector",
		"name: proxy":         "sidecar-injector",
		"readyReplicas: 3":    "kube-controller-manager",
	}
	for line, m := range want {
		if got[line] != m {
			t.Errorf("%q blamed on %q, want %q (all: %v)", line, got[line], m, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("blamed %d lines, want %d: %v", len(got), len(want), got)
	}
	if r.Missing {
		t.Error("missing set")
	}
}

func TestBlameWithoutManagedFieldsIsMissing(t *testing.T) {
	svc, _, res := blameSetup(t)
	d, err := svc.Object(res.Pane, "b-bare")
	if err != nil {
		t.Fatal(err)
	}
	r, err := svc.Blame(res.Pane, "b-bare", d.YAML)
	if err != nil || !r.Missing || len(r.Lines) != 0 {
		t.Errorf("blame = %+v, %v", r, err)
	}
}

func TestBlameFollowsAnEdit(t *testing.T) {
	svc, log, res := blameSetup(t)
	es, err := svc.EditOpen(res.Pane, "b-web")
	if err != nil {
		t.Fatal(err)
	}
	// the editor's text as typed: unparseable mid-typing is an error, a new line has no owner
	if _, err := svc.Blame(res.Pane, "b-web", es.YAML+"\n  broken: [\n"); err == nil {
		t.Error("no error for YAML that doesn't parse")
	}
	edited := strings.Replace(es.YAML, "replicas: 3", "replicas: 5", 1)
	p, err := svc.Prepare("edit", res.Pane, "b-web")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.EditApply(p.Token, es.Session, edited); err != nil {
		t.Fatal(err)
	}
	var d view.Detail
	waitRow(t, log, res.Pane, "b-web", func(view.RowData) bool {
		d, err = svc.Object(res.Pane, "b-web")
		return err == nil && strings.Contains(d.YAML, "replicas: 5")
	})
	// a new resourceVersion: read again, the edit's field is kubewing's now
	r, err := svc.Blame(res.Pane, "b-web", d.YAML)
	if err != nil {
		t.Fatal(err)
	}
	got := owners(t, d.YAML, r)
	if got["replicas: 5"] != "kubewing" || got["name: proxy"] != "sidecar-injector" {
		t.Errorf("after the edit: %v", got)
	}
}

func TestBlameOfTypedTextWithoutAnOwnedLine(t *testing.T) {
	svc, _, res := blameSetup(t)
	es, err := svc.EditOpen(res.Pane, "b-web")
	if err != nil {
		t.Fatal(err)
	}
	typed := strings.Replace(es.YAML, "replicas: 3", "paused: true", 1)
	r, err := svc.Blame(res.Pane, "b-web", typed)
	if err != nil {
		t.Fatal(err)
	}
	if got := owners(t, typed, r); got["paused: true"] != "" {
		t.Errorf("paused blamed on %q", got["paused: true"])
	}
}
