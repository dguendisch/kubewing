package normalize

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func obj(m map[string]any) *unstructured.Unstructured { return &unstructured.Unstructured{Object: m} }

func node(rv, heartbeat, ready string) *unstructured.Unstructured {
	return obj(map[string]any{
		"apiVersion": "v1", "kind": "Node",
		"metadata": map[string]any{
			"name": "n1", "resourceVersion": rv,
			"managedFields": []any{map[string]any{"manager": "kubelet"}},
			"annotations": map[string]any{
				"kubectl.kubernetes.io/last-applied-configuration": "{}",
				"keep": "me",
			},
		},
		"status": map[string]any{"conditions": []any{
			map[string]any{"type": "Ready", "status": ready, "lastHeartbeatTime": heartbeat},
		}},
	})
}

func TestNoiseDoesNotChangeHash(t *testing.T) {
	n := New()
	a := Hash(n.Normalize(node("1", "t1", "True")))
	b := Hash(n.Normalize(node("2", "t2", "True")))
	if a != b {
		t.Fatalf("heartbeat/resourceVersion change altered hash: %s vs %s", a, b)
	}
	c := Hash(n.Normalize(node("3", "t3", "False")))
	if a == c {
		t.Fatal("meaningful change (Ready flip) did not alter hash")
	}
}

func TestNormalizeKeepsOtherFieldsAndDoesNotMutateInput(t *testing.T) {
	in := node("1", "t1", "True")
	out := New().Normalize(in)
	if _, ok := in.Object["metadata"].(map[string]any)["managedFields"]; !ok {
		t.Fatal("input was mutated")
	}
	ann := out.GetAnnotations()
	if _, ok := ann["kubectl.kubernetes.io/last-applied-configuration"]; ok {
		t.Fatal("escaped-dot path not removed")
	}
	if ann["keep"] != "me" {
		t.Fatal("unrelated annotation removed")
	}
}

func TestKindScopedRule(t *testing.T) {
	lease := func(renew string) *unstructured.Unstructured {
		return obj(map[string]any{"kind": "Lease", "spec": map[string]any{"renewTime": renew, "holderIdentity": "a"}})
	}
	other := obj(map[string]any{"kind": "Thing", "spec": map[string]any{"renewTime": "x"}})
	n := New()
	if Hash(n.Normalize(lease("1"))) != Hash(n.Normalize(lease("2"))) {
		t.Fatal("lease renewTime should be ignored")
	}
	if _, ok := n.Normalize(other).Object["spec"].(map[string]any)["renewTime"]; !ok {
		t.Fatal("kind-scoped rule applied to wrong kind")
	}
}

func TestUserRule(t *testing.T) {
	n := New(Rule{Path: "status.observedGeneration"})
	a := obj(map[string]any{"status": map[string]any{"observedGeneration": int64(1)}})
	b := obj(map[string]any{"status": map[string]any{"observedGeneration": int64(2)}})
	if Hash(n.Normalize(a)) != Hash(n.Normalize(b)) {
		t.Fatal("user rule not applied")
	}
}
