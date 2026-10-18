package bridge

import (
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/source"
)

// A stage-only Update keeps the view: no new subscription, diff state intact.
func TestUpdateStagesInPlace(t *testing.T) {
	reg := source.NewRegistry(stormOpener{n: 3})
	svc := New(reg, &recorder{}, Options{})
	res, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	waitPrev := func() {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			pn, _ := svc.pane(res.Pane)
			pn.mu.Lock()
			ok := pn.view.HasPrev("u1")
			pn.mu.Unlock()
			if ok {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("no previous version of u1")
	}
	waitPrev()
	pn, _ := svc.pane(res.Pane)
	before := pn.view
	if err := svc.Update(res.Pane, `source: {resource: pods, namespace: ns}
stages: [{filter: 'o.metadata.name == "pod-00001"'}]`); err != nil {
		t.Fatal(err)
	}
	pn.mu.Lock()
	same, prev := pn.view == before, pn.view.HasPrev("u1")
	pn.mu.Unlock()
	if !same || !prev {
		t.Fatalf("view rebuilt (same=%v) or diff state lost (prev=%v)", same, prev)
	}
	if reg.Active() != 1 {
		t.Fatalf("active watches = %d", reg.Active())
	}
	// an invalid filter is refused and changes nothing
	if err := svc.Update(res.Pane, "source: {resource: pods, namespace: ns}\nstages: [{filter: 'o.'}]"); err == nil {
		t.Fatal("want error")
	}
	if pn.p.Stages[0].Filter != `o.metadata.name == "pod-00001"` {
		t.Fatalf("stages = %+v", pn.p.Stages)
	}
}

func TestPreviewAndFieldKeys(t *testing.T) {
	svc := New(source.NewRegistry(stormOpener{n: 3}), &recorder{}, Options{})
	res, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	deadline := time.Now().Add(3 * time.Second)
	for {
		pv, err := svc.Preview(res.Pane, Draft{Field: "filter", Value: `o.metadata.name.endsWith("1")`})
		if err != nil {
			t.Fatal(err)
		}
		if pv.Objects == 3 {
			if pv.Matched != 1 {
				t.Fatalf("preview = %+v", pv)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not synced: %+v", pv)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// no selector applied: everything is loaded, so the count is exact
	if pv, _ := svc.Preview(res.Pane, Draft{Field: "labels", Value: "app=x"}); pv.AtLeast || pv.Matched != 0 || pv.Objects != 3 {
		t.Fatalf("labels preview = %+v", pv)
	}
	if _, err := svc.Preview(res.Pane, Draft{Field: "nope"}); err == nil {
		t.Fatal("want error for unknown field")
	}
	fk, err := svc.FieldKeys(res.Pane, "spec")
	if err != nil || fk.Objects != 3 || len(fk.Keys) != 1 || fk.Keys[0].Key != "gen" {
		t.Fatalf("field keys = %+v, %v", fk, err)
	}
}
