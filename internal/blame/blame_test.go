package blame

import (
	"encoding/json"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

// a deployment as the YAML view shows it (keys sorted, managedFields stripped)
const deploy = `apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web
  name: web
  namespace: shop
spec:
  replicas: 3
  template:
    spec:
      containers:
      - args:
        - --port=8080
        - --verbose
        image: nginx:1.27
        name: app
      - image: envoy:1.30
        name: sidecar
      volumes:
      - emptyDir: {}
        name: cache
status:
  conditions:
  - status: "True"
    type: Available
  readyReplicas: 3
`

const fields = `[
  {"manager": "kubectl-client-side-apply", "operation": "Update", "time": "2026-11-01T10:00:00Z", "fieldsType": "FieldsV1",
   "fieldsV1": {"f:metadata": {"f:labels": {".": {}, "f:app": {}}},
                "f:spec": {"f:template": {"f:spec": {
                  "f:containers": {"k:{\"name\":\"app\"}": {".": {}, "f:args": {}, "f:image": {}, "f:name": {}}},
                  "f:volumes": {".": {}, "k:{\"name\":\"cache\"}": {".": {}, "f:emptyDir": {}, "f:name": {}}}}}}}},
  {"manager": "hpa", "operation": "Update", "subresource": "scale", "time": "2026-11-03T10:00:00Z", "fieldsType": "FieldsV1",
   "fieldsV1": {"f:spec": {"f:replicas": {}}}},
  {"manager": "istio-injector", "operation": "Update", "time": "2026-11-02T10:00:00Z", "fieldsType": "FieldsV1",
   "fieldsV1": {"f:spec": {"f:template": {"f:spec": {"f:containers": {"k:{\"name\":\"sidecar\"}": {".": {}, "f:image": {}, "f:name": {}}}}}}}},
  {"manager": "kube-controller-manager", "operation": "Update", "subresource": "status", "time": "2026-11-04T10:00:00Z", "fieldsType": "FieldsV1",
   "fieldsV1": {"f:status": {"f:conditions": {".": {}, "k:{\"type\":\"Available\"}": {".": {}, "f:status": {}, "f:type": {}}}, "f:readyReplicas": {}}}}
]`

func entries(t *testing.T) []Entry {
	t.Helper()
	var e []Entry
	if err := json.Unmarshal([]byte(fields), &e); err != nil {
		t.Fatal(err)
	}
	return e
}

// shown renders the blame as "line text  ← manager, manager" per line.
func shown(t *testing.T, text string, lines []Line) string {
	t.Helper()
	at := map[int][]Owner{}
	for _, l := range lines {
		at[l.Line] = l.Owners
	}
	var b strings.Builder
	for i, s := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		b.WriteString(s)
		if o := at[i]; len(o) > 0 {
			names := make([]string, len(o))
			for j, x := range o {
				names[j] = x.Manager
			}
			b.WriteString("  ← " + strings.Join(names, ", "))
		}
		b.WriteByte('\n')
	}
	return b.String()
}

func TestLinesBlameEachFieldOnItsManager(t *testing.T) {
	lines, err := Lines(deploy, entries(t))
	if err != nil {
		t.Fatal(err)
	}
	want := `apiVersion: apps/v1
kind: Deployment
metadata:
  labels:  ← kubectl-client-side-apply
    app: web  ← kubectl-client-side-apply
  name: web
  namespace: shop
spec:
  replicas: 3  ← hpa
  template:
    spec:
      containers:
      - args:  ← kubectl-client-side-apply
        - --port=8080
        - --verbose
        image: nginx:1.27  ← kubectl-client-side-apply
        name: app  ← kubectl-client-side-apply
      - image: envoy:1.30  ← istio-injector
        name: sidecar  ← istio-injector
      volumes:  ← kubectl-client-side-apply
      - emptyDir: {}  ← kubectl-client-side-apply
        name: cache  ← kubectl-client-side-apply
status:
  conditions:  ← kube-controller-manager
  - status: "True"  ← kube-controller-manager
    type: Available  ← kube-controller-manager
  readyReplicas: 3  ← kube-controller-manager
`
	if got := shown(t, deploy, lines); got != want {
		t.Errorf("blame:\n%s\nwant:\n%s", got, want)
	}
	// a field's details: operation, subresource, time
	for _, l := range lines {
		if l.Line == 8 {
			if o := l.Owners[0]; o.Operation != "Update" || o.Subresource != "scale" || o.Time != "2026-11-03T10:00:00Z" {
				t.Errorf("replicas owner = %+v", o)
			}
		}
	}
}

func TestLinesSharedFieldNewestOwnerFirst(t *testing.T) {
	text := "data:\n  mode: blue\n"
	e := []Entry{
		{Manager: "old", Operation: "Apply", Time: "2026-01-01T00:00:00Z", FieldsV1: json.RawMessage(`{"f:data":{"f:mode":{}}}`)},
		{Manager: "new", Operation: "Apply", Time: "2026-06-01T00:00:00Z", FieldsV1: json.RawMessage(`{"f:data":{"f:mode":{}}}`)},
	}
	lines, err := Lines(text, e)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].Line != 1 || len(lines[0].Owners) != 2 || lines[0].Owners[0].Manager != "new" || lines[0].Owners[1].Manager != "old" {
		t.Errorf("lines = %+v", lines)
	}
}

func TestLinesSetsByValueAndIndex(t *testing.T) {
	text := "metadata:\n  finalizers:\n  - a\n  - b\nspec:\n  ports:\n  - 80\n  - 443\n"
	e := []Entry{
		{Manager: "ctl", Operation: "Update", FieldsV1: json.RawMessage(`{"f:metadata":{"f:finalizers":{".":{},"v:\"b\"":{}}},"f:spec":{"f:ports":{"i:0":{}}}}`)},
	}
	lines, err := Lines(text, e)
	if err != nil {
		t.Fatal(err)
	}
	got := map[int]string{}
	for _, l := range lines {
		got[l.Line] = l.Owners[0].Manager
	}
	want := map[int]string{1: "ctl", 3: "ctl", 6: "ctl"}
	if len(got) != len(want) {
		t.Fatalf("lines %v, want %v", got, want)
	}
	for k := range want {
		if got[k] != "ctl" {
			t.Errorf("line %d not blamed: %v", k, got)
		}
	}
}

// the editor's text as typed: a field added there has no owner yet, the rest keep theirs
func TestLinesFollowTheTextAsTyped(t *testing.T) {
	typed := strings.Replace(deploy, "  replicas: 3\n", "  paused: true\n  replicas: 3\n", 1)
	lines, err := Lines(typed, entries(t))
	if err != nil {
		t.Fatal(err)
	}
	at := map[int]string{}
	for _, l := range lines {
		at[l.Line] = l.Owners[0].Manager
	}
	if _, ok := at[8]; ok {
		t.Errorf("the new line 8 (paused) has an owner: %v", at[8])
	}
	if at[9] != "hpa" {
		t.Errorf("replicas (now line 9) = %q, want hpa", at[9])
	}
}

func TestLinesNumbersMatchAcrossIntAndFloat(t *testing.T) {
	text := "spec:\n  ports:\n  - port: 443\n    protocol: TCP\n"
	e := []Entry{{Manager: "m", FieldsV1: json.RawMessage(`{"f:spec":{"f:ports":{"k:{\"port\":443,\"protocol\":\"TCP\"}":{".":{},"f:port":{},"f:protocol":{}}}}}`)}}
	lines, err := Lines(text, e)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0].Line != 2 || lines[1].Line != 3 {
		t.Errorf("lines = %+v", lines)
	}
}

func TestLinesSkipsOtherFieldsTypes(t *testing.T) {
	lines, err := Lines("a: 1\n", []Entry{{Manager: "x", FieldsType: "FieldsV2", FieldsV1: json.RawMessage(`{"f:a":{}}`)}})
	if err != nil || len(lines) != 0 {
		t.Errorf("lines = %+v, err %v", lines, err)
	}
}

func TestLinesRefusesTextThatDoesntParse(t *testing.T) {
	if _, err := Lines("a: [", entries(t)); err == nil {
		t.Error("no error for broken YAML")
	}
}

func TestEntriesFromAnObject(t *testing.T) {
	var obj map[string]any
	if err := yaml.Unmarshal([]byte(`metadata:
  managedFields:
  - manager: kubectl
    operation: Apply
    time: "2026-11-01T10:00:00Z"
    fieldsType: FieldsV1
    fieldsV1: {"f:data": {"f:mode": {}}}
`), &obj); err != nil {
		t.Fatal(err)
	}
	e, err := Entries(obj)
	if err != nil {
		t.Fatal(err)
	}
	if len(e) != 1 || e[0].Manager != "kubectl" || e[0].Operation != "Apply" || string(e[0].FieldsV1) != `{"f:data":{"f:mode":{}}}` {
		t.Errorf("entries = %+v", e)
	}
	if e, err := Entries(map[string]any{"metadata": map[string]any{}}); err != nil || e != nil {
		t.Errorf("no managedFields: %v, %v", e, err)
	}
}
