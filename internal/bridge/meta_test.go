package bridge

import (
	"strings"
	"testing"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
	"github.com/dguendisch/kubewing/internal/view"
)

func TestLabelAndAnnotate(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-web-1", func(view.RowData) bool { return true })

	if err := svc.Label("forged", MetaChanges{Set: map[string]string{"tier": "web"}}); err == nil {
		t.Fatal("label without a prepared token must be refused")
	}
	m, err := svc.RowMeta(res.Pane, "s-web-1")
	if err != nil || m.Labels["app"] != "web" {
		t.Fatalf("row meta: %+v %v", m, err)
	}
	p, err := svc.Prepare(safety.Label, res.Pane, "s-web-1")
	if err != nil {
		t.Fatal(err)
	}
	if p.NeedsConfirm || p.Summary != "label e2e-static/web-1 -n shop on tape" {
		t.Errorf("pending: %+v", p)
	}
	if err := svc.Label(p.Token, MetaChanges{Set: map[string]string{"tier": "web"}, Remove: []string{"app"}}); err != nil {
		t.Fatal(err)
	}
	waitRow(t, log, res.Pane, "s-web-1", func(view.RowData) bool {
		d, err := svc.Object(res.Pane, "s-web-1")
		return err == nil && strings.Contains(d.YAML, "tier: web") && !strings.Contains(d.YAML, "app: web")
	})
	if err := svc.Label(p.Token, MetaChanges{Set: map[string]string{"x": "y"}}); err == nil {
		t.Error("token reuse must be refused")
	}

	// a delete token doesn't annotate
	del, _ := svc.Prepare(safety.Delete, res.Pane, "s-web-1")
	if err := svc.Annotate(del.Token, MetaChanges{Set: map[string]string{"a": "b"}}); err == nil || !strings.Contains(err.Error(), "issued for delete") {
		t.Errorf("annotate with a delete token: %v", err)
	}
	p, _ = svc.Prepare(safety.Annotate, res.Pane, "s-web-1")
	// annotation values are free text
	if err := svc.Annotate(p.Token, MetaChanges{Set: map[string]string{"example.com/note": "drained for maintenance, back at 14:00"}}); err != nil {
		t.Fatal(err)
	}
	waitRow(t, log, res.Pane, "s-web-1", func(view.RowData) bool {
		m, err := svc.RowMeta(res.Pane, "s-web-1")
		return err == nil && m.Annotations["example.com/note"] == "drained for maintenance, back at 14:00"
	})
}

func TestMetaPatch(t *testing.T) {
	for _, c := range []struct {
		name, kind string
		c          MetaChanges
		want, err  string
	}{
		{name: "set and remove", kind: safety.Label, c: MetaChanges{Set: map[string]string{"b": "2", "a": "1"}, Remove: []string{"old"}},
			want: `{"metadata":{"labels":{"a":"1","b":"2","old":null},"uid":"u1"}}`},
		{name: "annotation", kind: safety.Annotate, c: MetaChanges{Set: map[string]string{"note": "two words"}},
			want: `{"metadata":{"annotations":{"note":"two words"},"uid":"u1"}}`},
		{name: "empty value", kind: safety.Label, c: MetaChanges{Set: map[string]string{"flag": ""}},
			want: `{"metadata":{"labels":{"flag":""},"uid":"u1"}}`},
		{name: "nothing", kind: safety.Label, err: "no changes"},
		{name: "bad label value", kind: safety.Label, c: MetaChanges{Set: map[string]string{"a": "two words"}}, err: `label value "two words"`},
		{name: "bad key", kind: safety.Annotate, c: MetaChanges{Remove: []string{"-x"}}, err: `annotation key "-x"`},
		{name: "both", kind: safety.Label, c: MetaChanges{Set: map[string]string{"a": "1"}, Remove: []string{"a"}}, err: `label "a" is both set and removed`},
	} {
		t.Run(c.name, func(t *testing.T) {
			b, err := metaPatch(c.kind, c.c, "u1")
			if c.err != "" {
				if err == nil || !strings.Contains(err.Error(), c.err) {
					t.Fatalf("err = %v, want %q", err, c.err)
				}
				return
			}
			if err != nil || string(b) != c.want {
				t.Errorf("patch = %s, %v; want %s", b, err, c.want)
			}
		})
	}
}

func TestScale(t *testing.T) {
	tp, err := tape.Load("../../testdata/tapes/e2e-deploys.yaml")
	if err != nil {
		t.Fatal(err)
	}
	op := &tape.Opener{Tapes: map[string]*tape.Tape{"e2e-deploys": tp}}
	cfg := config.Defaults("")
	cfg.Config.Contexts = []config.ContextRule{{Match: "tape", Confirm: []string{"scale"}}}
	log := &eventLog{events: map[string][]any{}}
	svc := New(source.NewRegistry(op), log, Options{Actor: op, Config: &cfg})
	res, err := svc.Open("source: {resource: e2e-deploys}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	svc.SetViewport(res.Pane, 0, 10)
	waitRow(t, log, res.Pane, "d-web", func(view.RowData) bool { return true })

	info, err := svc.RowInfo(res.Pane, "d-web")
	if err != nil || info.Replicas == nil || *info.Replicas != 3 {
		t.Fatalf("row info: %+v %v", info, err)
	}
	p, err := svc.Prepare(safety.Scale, res.Pane, "d-web")
	if err != nil {
		t.Fatal(err)
	}
	if !p.NeedsConfirm {
		t.Error("confirm: [scale] must ask")
	}
	if err := svc.Scale(p.Token, -1); err == nil {
		t.Error("negative replicas must be refused")
	}
	p, _ = svc.Prepare(safety.Scale, res.Pane, "d-web")
	if err := svc.Scale(p.Token, 0); err != nil {
		t.Fatal(err)
	}
	waitRow(t, log, res.Pane, "d-web", func(view.RowData) bool {
		i, err := svc.RowInfo(res.Pane, "d-web")
		return err == nil && i.Replicas != nil && *i.Replicas == 0
	})
}

func TestScaleNeedsReplicas(t *testing.T) {
	svc, log, res := deleteSetup(t, nil)
	waitRow(t, log, res.Pane, "s-cfg", func(view.RowData) bool { return true })
	if info, _ := svc.RowInfo(res.Pane, "s-cfg"); info.Replicas != nil {
		t.Errorf("a config map has no replicas: %+v", info)
	}
	if _, err := svc.Prepare(safety.Scale, res.Pane, "s-cfg"); err == nil || err.Error() != "configmap has no replicas to scale" {
		t.Errorf("prepare scale on a config map: %v", err)
	}
}

func TestReadOnlyContextRefusesMetaAndScale(t *testing.T) {
	svc, log, res := deleteSetup(t, []config.ContextRule{{Match: "tape", ReadOnly: true}})
	waitRow(t, log, res.Pane, "s-web-1", func(view.RowData) bool { return true })
	for _, k := range []string{safety.Label, safety.Annotate} {
		if _, err := svc.Prepare(k, res.Pane, "s-web-1"); err == nil || !strings.Contains(err.Error(), "read-only") {
			t.Errorf("%s on read-only: %v", k, err)
		}
	}
}
