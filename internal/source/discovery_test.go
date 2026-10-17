package source

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
)

func TestResourceTypesFiltersAndSorts(t *testing.T) {
	lw := metav1.Verbs{"get", "list", "watch"}
	got := resourceTypes([]*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{
			{Name: "pods", SingularName: "pod", Kind: "Pod", Namespaced: true, ShortNames: []string{"po"}, Verbs: lw},
			{Name: "pods/log", Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"get"}},
			{Name: "bindings", Kind: "Binding", Namespaced: true, Verbs: metav1.Verbs{"create"}},
			{Name: "namespaces", Kind: "Namespace", Verbs: lw},
		}},
		{GroupVersion: "authorization.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "selfsubjectaccessreviews", Kind: "SelfSubjectAccessReview", Verbs: metav1.Verbs{"create"}},
		}},
		{GroupVersion: "apps/v1", APIResources: []metav1.APIResource{
			{Name: "deployments", Kind: "Deployment", Namespaced: true, ShortNames: []string{"deploy"}, Verbs: lw},
		}},
	})
	var names []string
	for _, r := range got {
		names = append(names, r.Qualified())
	}
	if want := []string{"deployments.apps", "namespaces", "pods"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("types = %v, want %v (no subresources, no non-listables)", names, want)
	}
	if p := got[2]; p.Kind != "Pod" || p.Singular != "pod" || !p.Namespaced || p.ShortNames[0] != "po" || p.Version != "v1" {
		t.Fatalf("pods = %+v", p)
	}
}

func TestNamespacesMetadataOnlyPaged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/namespaces" || r.URL.Query().Get("includeObject") != "Metadata" {
			t.Errorf("unexpected request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		row := func(n string) string {
			return fmt.Sprintf(`{"cells":[%q],"object":{"kind":"PartialObjectMetadata","apiVersion":"meta.k8s.io/v1","metadata":{"name":%q}}}`, n, n)
		}
		if r.URL.Query().Get("continue") == "" {
			fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{"continue":"c1"},"rows":[%s,%s]}`, row("kube-system"), row("default"))
			return
		}
		fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{},"rows":[%s]}`, row("garden"))
	}))
	defer srv.Close()
	c := &Cluster{Config: &rest.Config{Host: srv.URL}, http: srv.Client()}
	got, err := c.Namespaces(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"default", "garden", "kube-system"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("namespaces = %v, want %v", got, want)
	}
}

func TestChangesSignalsAfterInitialList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("includeObject") != "Metadata" {
			t.Errorf("change watch must be metadata-only: %s", r.URL.RawQuery)
		}
		row := func(n string) string {
			return fmt.Sprintf(`{"cells":[%q],"object":{"kind":"PartialObjectMetadata","apiVersion":"meta.k8s.io/v1","metadata":{"name":%q,"uid":%q,"resourceVersion":"2"}}}`, n, n, n)
		}
		if r.URL.Query().Get("watch") != "true" {
			fmt.Fprintf(w, `{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{"resourceVersion":"1"},"rows":[%s]}`, row("x"))
			return
		}
		if r.URL.Query().Get("resourceVersion") == "1" {
			if r.URL.Path == "/api/v1/namespaces" {
				// namespace updates can't change names: not a signal
				fmt.Fprintf(w, `{"type":"MODIFIED","object":{"kind":"Table","apiVersion":"meta.k8s.io/v1","rows":[%s]}}`+"\n", row("x"))
			}
			fmt.Fprintf(w, `{"type":"ADDED","object":{"kind":"Table","apiVersion":"meta.k8s.io/v1","rows":[%s]}}`+"\n", row("y"))
			w.(http.Flusher).Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := &Cluster{Config: &rest.Config{Host: srv.URL}, http: srv.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out := make(chan Change, 8)
	go c.Changes(ctx, out)
	var got Change
	for got != ResourcesChanged|NamespacesChanged {
		select {
		case ch := <-out:
			got |= ch
		case <-ctx.Done():
			t.Fatalf("signals = %b, want both", got)
		}
	}
	select {
	case ch := <-out:
		t.Fatalf("extra signal %b (initial list or namespace MODIFIED must not signal)", ch)
	case <-time.After(100 * time.Millisecond):
	}
}
