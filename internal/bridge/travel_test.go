package bridge

import (
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/source"
)

// Time-travel through the bridge: entering starts recording, steps move
// between changes, stopping recording goes back to live.
func TestTimeTravel(t *testing.T) {
	svc := New(source.NewRegistry(stormOpener{n: 3}), &recorder{}, Options{})
	res, err := svc.Open("source: {resource: pods, namespace: ns}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	pn, _ := svc.pane(res.Pane)
	if _, err := svc.Timeline(res.Pane); err == nil {
		t.Fatal("timeline without recording")
	}
	start := time.Now().UTC()
	tl, err := svc.SetTime(res.Pane, start.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	if !pn.sub.History.Recording() || tl.At == "" {
		t.Fatalf("not recording or not in the past: %+v", tl)
	}
	time.Sleep(50 * time.Millisecond) // the storm goes on behind
	st, err := svc.Step(res.Pane, 1)
	if err != nil || !st.Moved || st.Timeline.At <= tl.At || len(st.Timeline.Changes) == 0 {
		t.Fatalf("step: %+v %v", st, err)
	}
	if _, err := svc.FieldHistory(res.Pane, "u1", 0, 0, "yaml"); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetRecording(res.Pane, false); err != nil {
		t.Fatal(err)
	}
	pn.mu.Lock()
	live := pn.view.At().IsZero()
	pn.mu.Unlock()
	if !live {
		t.Fatal("still in the past after recording stopped")
	}
	if _, err := svc.SetTime(res.Pane, ""); err != nil {
		t.Fatalf("back to live without recording: %v", err)
	}
	if _, err := svc.SetTime(res.Pane, "soon"); err == nil {
		t.Fatal("bad time accepted")
	}
}
