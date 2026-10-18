package source

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

func TestDeleteSendsUIDPrecondition(t *testing.T) {
	var got metav1.DeleteOptions
	var path, method string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, got = r.Method, r.URL.Path, metav1.DeleteOptions{}
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &got); err != nil {
			t.Errorf("body %s: %v", b, err)
		}
		if got.Preconditions != nil && *got.Preconditions.UID != "u1" {
			w.WriteHeader(http.StatusConflict)
			io.WriteString(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Conflict","message":"Precondition failed: UID in precondition: u2, UID in object meta: u1","code":409}`)
			return
		}
		io.WriteString(w, `{"kind":"Status","apiVersion":"v1","status":"Success"}`)
	}))
	defer srv.Close()
	c := &Cluster{Config: &rest.Config{Host: srv.URL}, http: srv.Client()}
	res := Resolved{GVR: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, Namespaced: true}

	if err := c.Delete(context.Background(), res, "ns", "a", "u1"); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodDelete || path != "/api/v1/namespaces/ns/pods/a" {
		t.Errorf("%s %s", method, path)
	}
	if got.Preconditions == nil || *got.Preconditions.UID != "u1" || *got.PropagationPolicy != metav1.DeletePropagationBackground {
		t.Errorf("options: %+v", got)
	}

	// recreated under the same name: the stale UID must not delete the new object
	err := c.Delete(context.Background(), res, "ns", "a", "u2")
	if err == nil || !strings.Contains(err.Error(), "Precondition failed") {
		t.Errorf("stale uid: %v", err)
	}

	cs := Resolved{GVR: schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"}}
	if err := c.Delete(context.Background(), cs, "ignored", "r", ""); err != nil {
		t.Fatal(err)
	}
	if path != "/apis/rbac.authorization.k8s.io/v1/clusterroles/r" || got.Preconditions != nil {
		t.Errorf("cluster-scoped: %s %+v", path, got)
	}
}
