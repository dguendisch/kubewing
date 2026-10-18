package source

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

// A minimal API server for kubectl's pod describer: discovery, the pod, its events.
func describeServer(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch p := r.URL.Path; {
		case p == "/api":
			fmt.Fprint(w, `{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[{"clientCIDR":"0.0.0.0/0","serverAddress":"x"}]}`)
		case p == "/apis":
			fmt.Fprint(w, `{"kind":"APIGroupList","apiVersion":"v1","groups":[]}`)
		case p == "/api/v1":
			fmt.Fprint(w, `{"kind":"APIResourceList","groupVersion":"v1","resources":[
				{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list"],"shortNames":["po"]},
				{"name":"events","singularName":"event","namespaced":true,"kind":"Event","verbs":["list"]}]}`)
		case p == "/api/v1/namespaces/shop/pods/web-0":
			fmt.Fprint(w, `{"kind":"Pod","apiVersion":"v1","metadata":{"name":"web-0","namespace":"shop","uid":"u1","labels":{"app":"web"}},
				"spec":{"nodeName":"node-a","containers":[{"name":"app","image":"nginx:1.27"}]},
				"status":{"phase":"Running","podIP":"10.0.0.7"}}`)
		case p == "/api/v1/namespaces/shop/events":
			fmt.Fprint(w, `{"kind":"EventList","apiVersion":"v1","metadata":{},"items":[
				{"metadata":{"name":"e1","namespace":"shop"},"involvedObject":{"kind":"Pod","name":"web-0","namespace":"shop","uid":"u1"},
				 "reason":"Pulled","message":"Successfully pulled image nginx:1.27","type":"Normal","count":1,"source":{"component":"kubelet"}}]}`)
		default:
			t.Logf("unhandled %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	}))
}

func TestDescribePodWithEvents(t *testing.T) {
	srv := describeServer(t)
	defer srv.Close()
	c, err := newCluster("test", &rest.Config{Host: srv.URL}, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	res := Resolved{GVR: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true}
	out, err := c.Describe(context.Background(), res, "shop", "web-0")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Name:", "web-0", "Namespace:", "shop", "app=web", "node-a", "nginx:1.27", "10.0.0.7", "Events:", "Pulled", "Successfully pulled image"} {
		if !strings.Contains(out, want) {
			t.Errorf("describe output lacks %q:\n%s", want, out)
		}
	}
}
