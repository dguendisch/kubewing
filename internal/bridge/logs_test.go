package bridge

import (
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/logs"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
	"github.com/dguendisch/kubewing/internal/view"
)

func logsSetup(t *testing.T) (*Service, *eventLog, OpenResult) {
	t.Helper()
	tp, err := tape.Load("../../testdata/tapes/e2e-pod-logs.yaml")
	if err != nil {
		t.Fatal(err)
	}
	op := &tape.Opener{Tapes: map[string]*tape.Tape{"e2e-pod-logs": tp}, Speed: 50}
	cfg := config.Defaults("")
	log := &eventLog{events: map[string][]any{}}
	svc := New(source.NewRegistry(op), log, Options{Actor: op, Config: &cfg})
	res, err := svc.Open("source: {resource: e2e-pod-logs, namespace: shop}")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(res.Pane) })
	svc.SetViewport(res.Pane, 0, 10)
	return svc, log, res
}

// logLines collects a session's log lines (text) and its stream set.
func logLines(log *eventLog, id string) (texts []string, streams []logs.Stream, exit string) {
	for _, e := range log.get(LogsEvent) {
		p := e.(LogsPayload)
		if p.ID != id {
			continue
		}
		for _, l := range p.Lines {
			texts = append(texts, l.Text)
		}
		if p.Streams != nil {
			streams = p.Streams
		}
		if p.Exit != "" {
			exit = p.Exit
		}
	}
	return
}

func waitLogs(t *testing.T, log *eventLog, id string, ok func(texts []string, streams []logs.Stream) bool) ([]string, []logs.Stream) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		texts, streams, _ := logLines(log, id)
		if ok(texts, streams) {
			return texts, streams
		}
		time.Sleep(10 * time.Millisecond)
	}
	texts, streams, _ := logLines(log, id)
	t.Fatalf("logs %s never matched; texts=%v streams=%v", id, texts, streams)
	return nil, nil
}

// follow is the dialog's default: every container, the configured tail, following.
var follow = LogsOptions{Follow: true}

func contains(texts []string, sub string) bool {
	for _, s := range texts {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// A pod row tails just that pod, by name.
func TestLogsStartPodRow(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	r, err := svc.LogsStart(res.Pane, "lg-api-0", LogsRow, follow)
	if err != nil {
		t.Fatal(err)
	}
	if r.Title != "api-0" {
		t.Errorf("title = %q, want api-0", r.Title)
	}
	texts, streams := waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool {
		return contains(texts, "api-0 app serving request /healthz")
	})
	if contains(texts, "api-1") {
		t.Errorf("a pod-row tail must not include other pods: %v", texts)
	}
	if len(streams) != 1 || streams[0].Pod != "api-0" {
		t.Errorf("streams = %+v, want one for api-0", streams)
	}
	if err := svc.SessionClose(r.Session); err != nil {
		t.Fatal(err)
	}
}

// A whole-pane tail follows every pod the pods pane currently shows (its
// filters applied). It shares the pane's watch, so it sees the current set
// (api-1 was deleted during the tape; api-2 was added and remains).
func TestLogsStartWholePane(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-2", func(view.RowData) bool { return true })
	r, err := svc.LogsStart(res.Pane, "", LogsPane, follow)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(r.Title, "pods") {
		t.Errorf("title = %q, want it to start with pods", r.Title)
	}
	// every current pod of the pane shows: api-0, api-2 and worker-0
	_, streams := waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool {
		return contains(texts, "api-0 app ready") && contains(texts, "api-2 app ready") && contains(texts, "worker-0 app processing job 1")
	})
	for _, s := range streams {
		if s.Pod == "api-1" {
			t.Errorf("api-1 was deleted; it must not be followed: %+v", streams)
		}
	}
	svc.SessionClose(r.Session)
}

// A whole-pane tail honors the pane's own filters: a label-selector pane
// tails only the matching pods.
func TestLogsStartWholePaneFiltered(t *testing.T) {
	svc, log, res := logsSetup(t)
	_ = res
	api, err := svc.Open("source: {resource: e2e-pod-logs, namespace: shop, labelSelector: app=api}")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(api.Pane) })
	svc.SetViewport(api.Pane, 0, 10)
	waitRow(t, log, api.Pane, "lg-api-0", func(view.RowData) bool { return true })
	r, err := svc.LogsStart(api.Pane, "", LogsPane, follow)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.Title, "app=api") {
		t.Errorf("title = %q, want it to name the selector", r.Title)
	}
	texts, _ := waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool {
		return contains(texts, "api-0 app ready")
	})
	if contains(texts, "worker-0") {
		t.Errorf("a pane filtered to app=api must not tail worker-0: %v", texts)
	}
	svc.SessionClose(r.Session)
}

// Shutdown ends running log sessions.
func TestLogsShutdownEndsSession(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	r, err := svc.LogsStart(res.Pane, "lg-api-0", LogsRow, follow)
	if err != nil {
		t.Fatal(err)
	}
	waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool { return len(texts) > 0 })
	svc.Shutdown()
	// the session carries a final exit event
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, exit := logLines(log, r.Session); exit != "" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("log session never ended on shutdown")
}

// A row with no pods (a config map) can't be tailed.
func TestLogsStartNoPods(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-worker-0", func(view.RowData) bool { return true })
	// worker-0 is a pod, so it works; a whole-pane tail on a non-pods pane
	// is the case we check elsewhere. Here: an unknown key fails cleanly.
	if _, err := svc.LogsStart(res.Pane, "nope", LogsRow, follow); err == nil {
		t.Error("unknown row must fail")
	}
}

// The dialog lists the containers of the pods a tail would follow; the
// whole pane's are those of every pod it shows.
func TestLogsTargets(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	g, err := svc.LogsTargets(res.Pane, "lg-api-0", LogsRow)
	if err != nil {
		t.Fatal(err)
	}
	if g.Title != "api-0" || len(g.Containers) != 1 || g.Containers[0] != "app" || g.Tail != config.DefaultLogTail {
		t.Errorf("targets = %+v, want api-0 with [app] and the configured tail", g)
	}
	if g, err = svc.LogsTargets(res.Pane, "", LogsPane); err != nil || len(g.Containers) != 1 {
		t.Errorf("whole pane targets = %+v, %v", g, err)
	}
	if _, err := svc.LogsTargets(res.Pane, "nope", LogsRow); err == nil {
		t.Error("unknown row must fail")
	}
}

// Not following reads what each container has once, then the session ends
// on its own (no exit code: "0").
func TestLogsStartNoFollow(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	r, err := svc.LogsStart(res.Pane, "lg-api-0", LogsRow, LogsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if texts, streams, exit := logLines(log, r.Session); exit != "" {
			if exit != "0" || !contains(texts, "api-0 app serving request /healthz") {
				t.Errorf("exit = %q, texts = %v", exit, texts)
			}
			if len(streams) != 1 || streams[0].State != logs.Ended {
				t.Errorf("streams = %+v, want one ended", streams)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a log read without follow never ended")
}

// The dialog's history choice: the last lines, or since a duration ago.
func TestLogsStartHistory(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	// the last line only
	r, err := svc.LogsStart(res.Pane, "lg-api-0", LogsRow, LogsOptions{Tail: 1, Follow: true})
	if err != nil {
		t.Fatal(err)
	}
	texts, _ := waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool { return contains(texts, "serving request") })
	if contains(texts, "starting") || contains(texts, "ready") {
		t.Errorf("tail 1 must show only the last line: %v", texts)
	}
	svc.SessionClose(r.Session)
	// the tape's lines are a second apart, ending just before "now": 2s back covers the last two
	r, err = svc.LogsStart(res.Pane, "lg-api-0", LogsRow, LogsOptions{Since: "2s", Follow: true})
	if err != nil {
		t.Fatal(err)
	}
	texts, _ = waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool { return contains(texts, "serving request") })
	if contains(texts, "starting") || !contains(texts, "ready") {
		t.Errorf("since 2s must show the last two lines: %v", texts)
	}
	svc.SessionClose(r.Session)
}

// The dialog's choices are checked before anything starts.
func TestLogsStartBadOptions(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	for _, o := range []LogsOptions{
		{Since: "ten minutes"},
		{Since: "-1m"},
		{Since: "1m", All: true},
		{Tail: -1},
		{Containers: []string{" "}},
	} {
		if _, err := svc.LogsStart(res.Pane, "lg-api-0", LogsRow, o); err == nil {
			t.Errorf("%+v must be refused", o)
		}
	}
}

// Marked pod rows tail together: one tail over the marked pods, not the
// cursor row's, and no other pod of the pane.
func TestLogsStartMarkedPods(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-worker-0", func(view.RowData) bool { return true })
	for _, k := range []string{"lg-api-0", "lg-worker-0"} {
		if _, err := svc.Mark(res.Pane, view.MarkOp{Op: "toggle", Key: k}); err != nil {
			t.Fatal(err)
		}
	}
	g, err := svc.LogsTargets(res.Pane, "", LogsMarked)
	if err != nil {
		t.Fatal(err)
	}
	if g.Title != "api-0, worker-0" || len(g.Containers) != 1 {
		t.Errorf("targets = %+v, want both pods named, one container", g)
	}
	r, err := svc.LogsStart(res.Pane, "", LogsMarked, follow)
	if err != nil {
		t.Fatal(err)
	}
	texts, streams := waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool {
		return contains(texts, "api-0 app ready") && contains(texts, "worker-0 app processing job 1")
	})
	// api-2 appears later in the tape: not marked, so not followed
	time.Sleep(1500 * time.Millisecond)
	texts, streams, _ = logLines(log, r.Session)
	if contains(texts, "api-1") || contains(texts, "api-2") {
		t.Errorf("only the marked pods: %v", texts)
	}
	if len(streams) != 2 {
		t.Errorf("streams = %+v, want api-0 and worker-0", streams)
	}
	svc.SessionClose(r.Session)
}

// Without marks a marked tail fails as the other batch actions do (the
// frontend then tails the cursor row).
func TestLogsMarkedNone(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-api-0", func(view.RowData) bool { return true })
	if _, err := svc.LogsTargets(res.Pane, "", LogsMarked); err != ErrNoMarks {
		t.Errorf("err = %v, want ErrNoMarks", err)
	}
	if _, err := svc.LogsStart(res.Pane, "", "nope", follow); err == nil {
		t.Error("an unknown scope must fail")
	}
}

// Sources merge by pod UID: a pod two sources pick (a marked deployment and
// one of its pods) is followed once; owner and name picks keep only theirs.
func TestLogsSourcesMerge(t *testing.T) {
	mk := func(uid, name, owner string) source.Item {
		o := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": name, "namespace": "shop", "uid": uid}}}
		if owner != "" {
			o.SetOwnerReferences([]metav1.OwnerReference{{UID: types.UID(owner)}})
		}
		return source.Item{Object: o}
	}
	all := []source.Item{mk("u1", "web-0", "rs1"), mk("u2", "web-1", "rs1"), mk("u3", "db-0", "ss1")}
	owned := newPodSet(logsSource{ownerUID: "rs1"}, nil)
	named := newPodSet(logsSource{names: map[string]bool{"shop/web-0": true, "shop/db-0": true}}, nil)
	owned.apply(source.Event{Type: source.Relist, Items: all})
	named.apply(source.Event{Type: source.Relist, Items: all})
	got := map[string]int{}
	for _, it := range mergePods([]*podSet{owned, named}).Items {
		got[it.Object.GetName()]++
	}
	if len(got) != 3 || got["web-0"] != 1 {
		t.Errorf("merged = %v, want web-0, web-1, db-0 once each", got)
	}
	// a later pod of another owner isn't picked; a deleted one leaves
	if !owned.apply(source.Event{Type: source.Added, Item: mk("u4", "other-0", "rs2")}) || len(owned.items) != 2 {
		t.Errorf("owned = %v, want only rs1's", owned.items)
	}
	owned.apply(source.Event{Type: source.Deleted, Item: mk("u1", "web-0", "rs1")})
	if _, ok := owned.items["u1"]; ok || len(owned.items) != 1 {
		t.Errorf("owned after delete = %v", owned.items)
	}
	if owned.apply(source.Event{Type: source.Error, Err: "x"}) {
		t.Error("an error event changes nothing")
	}
}

func TestMarkedTitle(t *testing.T) {
	if s := markedTitle([]string{"a", "b", "c"}); s != "a, b, c" {
		t.Errorf("3 = %q", s)
	}
	if s := markedTitle([]string{"a", "b", "c", "d", "e"}); s != "a, b +3" {
		t.Errorf("5 = %q", s)
	}
}

// The dialog gets the pods a tail would follow (a pane per pod); Only
// narrows a tail of them to one.
func TestLogsPanePerPod(t *testing.T) {
	svc, log, res := logsSetup(t)
	waitRow(t, log, res.Pane, "lg-worker-0", func(view.RowData) bool { return true })
	for _, k := range []string{"lg-api-0", "lg-worker-0"} {
		if _, err := svc.Mark(res.Pane, view.MarkOp{Op: "toggle", Key: k}); err != nil {
			t.Fatal(err)
		}
	}
	g, err := svc.LogsTargets(res.Pane, "", LogsMarked)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Pods) != 2 || g.Pods[0] != (PodRef{"shop", "api-0"}) || g.Pods[1] != (PodRef{"shop", "worker-0"}) {
		t.Errorf("pods = %+v, want api-0 and worker-0", g.Pods)
	}
	o := follow
	o.Only = &PodRef{"shop", "worker-0"}
	r, err := svc.LogsStart(res.Pane, "", LogsMarked, o)
	if err != nil {
		t.Fatal(err)
	}
	if r.Title != "worker-0" {
		t.Errorf("title = %q, want worker-0", r.Title)
	}
	texts, streams := waitLogs(t, log, r.Session, func(texts []string, _ []logs.Stream) bool {
		return contains(texts, "worker-0 app processing job 1")
	})
	if contains(texts, "api-0") || len(streams) != 1 {
		t.Errorf("only worker-0: texts=%v streams=%+v", texts, streams)
	}
	svc.SessionClose(r.Session)
}
