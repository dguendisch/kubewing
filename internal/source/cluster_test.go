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

	"k8s.io/apimachinery/pkg/api/meta"
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

// A response that isn't a Status ("field label not supported" as plain text,
// a proxy's page): client-go only says "unknown reason"; the event carries
// what the server said too, on the lines after it.
func TestWatchErrorKeepsTheServersAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `field label not supported: involvedObject.kind`, http.StatusBadRequest)
	}))
	defer srv.Close()

	c := &Cluster{Config: &rest.Config{Host: srv.URL}, http: srv.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out := make(chan Event, 1)
	go c.Watch(ctx, Resolved{GVR: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, Namespaced: true}, "ns", "", "involvedObject.kind=Pod", out)

	ev := <-out
	first, rest, _ := strings.Cut(ev.Err, "\n")
	if ev.Type != Error || !strings.Contains(first, "unknown reason") {
		t.Fatalf("event = %s %q", ev.Type, ev.Err)
	}
	if !strings.Contains(rest, "field label not supported: involvedObject.kind") || !strings.Contains(rest, "HTTP 400 BadRequest") {
		t.Fatalf("details = %q", rest)
	}
}

func TestErrTextPlainErrors(t *testing.T) {
	if got := errText(fmt.Errorf("dial tcp: refused")); got != "dial tcp: refused" {
		t.Fatalf("plain error = %q", got)
	}
}

func TestAmbiguousPluralAcrossGroups(t *testing.T) {
	m := meta.NewDefaultRESTMapper(nil)
	add := func(group, version, kind string) {
		m.Add(schema.GroupVersionKind{Group: group, Version: version, Kind: kind}, meta.RESTScopeNamespace)
	}
	add("machine.sapcloud.io", "v1alpha1", "Machine")
	add("cluster.x-k8s.io", "v1beta1", "Machine")
	add("druid.gardener.cloud", "v1alpha1", "Etcd")
	// several versions of one group are still one type
	add("apps", "v1", "Deployment")
	add("apps", "v1beta1", "Deployment")
	for plural, want := range map[string]bool{"machines": true, "etcds": false, "deployments": false, "unknowns": false} {
		if got := ambiguous(m, plural); got != want {
			t.Errorf("ambiguous(%s) = %v, want %v", plural, got, want)
		}
	}
}

// A reconnect drops the context's connection, under every name it was
// reached by ("" and the current context's name are one).
func TestReconnectDropsConnection(t *testing.T) {
	c := &Cluster{Context: "dev"}
	o := &ClusterOpener{clusters: map[string]*Cluster{"": c, "dev": c, "prod": {Context: "prod"}}}
	got := o.Reconnect("dev")
	if len(got) != 2 || got[0] != "dev" || got[1] != "" {
		t.Fatalf("names = %q", got)
	}
	if o.Connected("dev") || o.Connected("") || !o.Connected("prod") {
		t.Fatal("wrong connections dropped")
	}
	// never connected: nothing to drop, its watches still restart
	if got := o.Reconnect("stage"); len(got) != 1 || got[0] != "stage" {
		t.Fatalf("names = %q", got)
	}
}

// A paginated list reports its progress after each page the server says
// more remain after (not after the last), then the whole list as one Relist;
// a filtered list, which the server doesn't count, reports none; Tables
// without the count are counted once by a metadata list.
func TestListReportsProgress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("watch") == "true" {
			<-r.Context().Done()
			return
		}
		if q.Get("limit") != "500" && !strings.Contains(r.Header.Get("Accept"), "as=PartialObjectMetadataList") {
			t.Errorf("limit = %q", q.Get("limit"))
		}
		filtered := q.Get("labelSelector") != ""
		// "uncounted": an aggregated API server whose Tables drop the count, its metadata lists keep it
		uncounted := r.URL.Path == "/api/v1/namespaces/uncounted/pods"
		if strings.Contains(r.Header.Get("Accept"), "as=PartialObjectMetadataList") {
			if !uncounted || q.Get("limit") != "1" || q.Get("continue") != "" || filtered {
				t.Errorf("unexpected count: %s %s", r.URL.Path, r.URL.RawQuery)
			}
			fmt.Fprint(w, `{"kind":"PartialObjectMetadataList","apiVersion":"meta.k8s.io/v1","metadata":{"resourceVersion":"10","continue":"x","remainingItemCount":5},"items":[{"metadata":{"name":"a"}}]}`)
			return
		}
		meta := func(cont string, remaining int) string {
			if cont == "" {
				return `{"resourceVersion":"10"}`
			}
			if filtered || uncounted {
				return fmt.Sprintf(`{"resourceVersion":"10","continue":%q}`, cont)
			}
			return fmt.Sprintf(`{"resourceVersion":"10","continue":%q,"remainingItemCount":%d}`, cont, remaining)
		}
		switch q.Get("continue") {
		case "":
			fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":%s,%s,"rows":[%s,%s]}`, meta("p2", 3), cols, tableRow("a", "ua", "1", "0"), tableRow("b", "ub", "1", "0"))
		case "p2":
			fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":%s,%s,"rows":[%s,%s]}`, meta("p3", 1), cols, tableRow("c", "uc", "1", "0"), tableRow("d", "ud", "1", "0"))
		default:
			fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":%s,%s,"rows":[%s]}`, meta("", 0), cols, tableRow("e", "ue", "1", "0"))
		}
	}))
	defer srv.Close()

	for _, tc := range []struct {
		name, ns, labels string
		want             []Loaded
	}{
		{"unfiltered", "ns", "", []Loaded{{Items: 2, Total: 5}, {Items: 4, Total: 5}}},
		{"filtered", "ns", "app=web", nil},
		// counted once, by a metadata list, after the first page
		{"table without the count", "uncounted", "", []Loaded{{Items: 2, Total: 6}, {Items: 4, Total: 6}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &Cluster{Config: &rest.Config{Host: srv.URL}, http: srv.Client()}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			out := make(chan Event, 10)
			go c.Watch(ctx, Resolved{GVR: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, Namespaced: true}, tc.ns, tc.labels, "", out)
			var got []Loaded
			for {
				select {
				case ev := <-out:
					switch ev.Type {
					case Progress:
						got = append(got, *ev.Loaded)
						continue
					case Relist:
						if len(ev.Items) != 5 {
							t.Fatalf("relist: %d items", len(ev.Items))
						}
						if fmt.Sprint(got) != fmt.Sprint(tc.want) {
							t.Fatalf("progress = %v, want %v", got, tc.want)
						}
						return
					default:
						t.Fatalf("unexpected %s (%s)", ev.Type, ev.Err)
					}
				case <-ctx.Done():
					t.Fatal("timeout")
				}
			}
		})
	}
}
