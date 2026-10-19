package source

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

func tableRow(name, uid, rv, restarts string) string {
	return fmt.Sprintf(`{"cells":[%q,%q],"object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":%q,"namespace":"ns","uid":%q,"resourceVersion":%q,"managedFields":[{"manager":"x"}]}}}`,
		name, restarts, name, uid, rv)
}

const cols = `"columnDefinitions":[{"name":"Name","type":"string","priority":0},{"name":"Restarts","type":"integer","priority":0}]`

func TestWatchListWatchRelist(t *testing.T) {
	var lists, watches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept"), "as=Table") || r.URL.Query().Get("includeObject") != "Object" {
			t.Errorf("missing table negotiation: %s %s", r.Header.Get("Accept"), r.URL.RawQuery)
		}
		if r.URL.Path != "/api/v1/namespaces/ns/pods" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.URL.Query().Get("watch") != "true" {
			n := lists.Add(1)
			fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{"resourceVersion":"%d0"},%s,"rows":[%s]}`,
				n, cols, tableRow("a", "ua", "1", "0"))
			return
		}
		fl := w.(http.Flusher)
		switch watches.Add(1) {
		case 1:
			if got := r.URL.Query().Get("resourceVersion"); got != "10" {
				t.Errorf("watch rv = %s, want 10", got)
			}
			fmt.Fprintf(w, `{"type":"MODIFIED","object":{"kind":"Table","apiVersion":"meta.k8s.io/v1",%s,"rows":[%s]}}`+"\n", cols, tableRow("a", "ua", "11", "1"))
			fmt.Fprintf(w, `{"type":"BOOKMARK","object":{"kind":"Table","apiVersion":"meta.k8s.io/v1","rows":[{"object":{"kind":"Pod","apiVersion":"v1","metadata":{"resourceVersion":"15"}}}]}}`+"\n")
			fl.Flush()
		case 2:
			if got := r.URL.Query().Get("resourceVersion"); got != "15" {
				t.Errorf("resumed watch rv = %s, want 15 (bookmark)", got)
			}
			fmt.Fprint(w, `{"type":"ERROR","object":{"kind":"Status","code":410,"message":"too old"}}`+"\n")
		default:
			<-r.Context().Done()
		}
	}))
	defer srv.Close()

	c := &Cluster{Config: &rest.Config{Host: srv.URL}, http: srv.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out := make(chan Event, 10)
	go c.Watch(ctx, Resolved{GVR: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, Namespaced: true}, "ns", "", "", out)

	want := []EventType{Relist, Modified, Relist}
	for i, w := range want {
		select {
		case ev := <-out:
			if ev.Type != w {
				t.Fatalf("event %d: got %s (%s), want %s", i, ev.Type, ev.Err, w)
			}
			if ev.Type == Relist {
				if len(ev.Columns) != 2 || len(ev.Items) != 1 {
					t.Fatalf("relist: %d cols %d items", len(ev.Columns), len(ev.Items))
				}
				if _, ok := ev.Items[0].Object.Object["metadata"].(map[string]any)["managedFields"]; ok {
					t.Fatal("managedFields not stripped")
				}
			}
			if ev.Type == Modified && ev.Item.Cells[1] != "1" {
				t.Fatalf("modified cells = %v", ev.Item.Cells)
			}
		case <-ctx.Done():
			t.Fatalf("timeout waiting for event %d (%s)", i, w)
		}
	}
}

func TestDecodePlainList(t *testing.T) {
	d, err := decodeTableOrList([]byte(`{"kind":"FooList","apiVersion":"x/v1","metadata":{"resourceVersion":"7"},"items":[{"kind":"Foo","apiVersion":"x/v1","metadata":{"name":"f"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if d.rv != "7" || len(d.items) != 1 || d.items[0].Object.GetName() != "f" || d.columns != nil {
		t.Fatalf("%+v", d)
	}
}

// Whole numbers stay int64 as in tapes (YAML) and client-go; plain
// encoding/json would make them float64, which int-typed readers (container
// ports) silently skip.
func TestDecodeKeepsInts(t *testing.T) {
	table := `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{"resourceVersion":"1"},"columnDefinitions":[],"rows":[{"cells":[],"object":
		{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p"},"spec":{"containers":[{"name":"c","ports":[{"containerPort":8080}]}]},"status":{"ratio":0.5}}}]}`
	list := `{"kind":"PodList","apiVersion":"v1","metadata":{},"items":[{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p"},"spec":{"containers":[{"name":"c","ports":[{"containerPort":8080}]}]},"status":{"ratio":0.5}}]}`
	for name, body := range map[string]string{"table": table, "list": list} {
		d, err := decodeTableOrList([]byte(body))
		if err != nil || len(d.items) != 1 {
			t.Fatalf("%s: %v %+v", name, err, d)
		}
		o := d.items[0].Object.Object
		port := o["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)["ports"].([]any)[0].(map[string]any)["containerPort"]
		if _, ok := port.(int64); !ok {
			t.Errorf("%s: containerPort is %T, want int64", name, port)
		}
		if r := o["status"].(map[string]any)["ratio"]; r != 0.5 {
			t.Errorf("%s: ratio = %#v, want float64 0.5", name, r)
		}
	}
}
