package health

import (
	"strings"
	"testing"
)

func cond(t, s string) map[string]any { return map[string]any{"type": t, "status": s} }

func obj(av, kind string, gen int64, spec, status map[string]any) map[string]any {
	return map[string]any{"apiVersion": av, "kind": kind, "metadata": map[string]any{"name": "x", "generation": gen}, "spec": spec, "status": status}
}

func TestBuiltinRules(t *testing.T) {
	mr := func(gen, observed int64, conds ...any) map[string]any {
		return obj("resources.gardener.cloud/v1alpha1", "ManagedResource", gen, nil, map[string]any{"observedGeneration": observed, "conditions": conds})
	}
	okMR := []any{cond("ResourcesApplied", "True"), cond("ResourcesHealthy", "True"), cond("ResourcesProgressing", "False")}
	node := func(spec map[string]any, ready string) map[string]any {
		return obj("v1", "Node", 0, spec, map[string]any{"conditions": []any{cond("MemoryPressure", "False"), cond("Ready", ready)}})
	}
	ext := func(gen, observed int64, state string) map[string]any {
		return obj("extensions.gardener.cloud/v1alpha1", "Infrastructure", gen, nil, map[string]any{"observedGeneration": observed, "lastOperation": map[string]any{"state": state}})
	}
	shoot := func(state string, conds ...any) map[string]any {
		return obj("core.gardener.cloud/v1beta1", "Shoot", 3, nil, map[string]any{"observedGeneration": int64(3), "lastOperation": map[string]any{"state": state}, "conditions": conds})
	}
	deleting := mr(1, 1, okMR...)
	deleting["metadata"].(map[string]any)["deletionTimestamp"] = "2026-01-01T00:00:00Z"
	cases := map[string]struct {
		obj  map[string]any
		want bool
	}{
		"mr healthy":           {mr(2, 2, okMR...), true},
		"mr not observed":      {mr(3, 2, okMR...), false},
		"mr progressing":       {mr(1, 1, cond("ResourcesApplied", "True"), cond("ResourcesHealthy", "True"), cond("ResourcesProgressing", "True")), false},
		"mr unhealthy":         {mr(1, 1, cond("ResourcesApplied", "True"), cond("ResourcesHealthy", "False"), cond("ResourcesProgressing", "False")), false},
		"mr apply failed":      {mr(1, 1, cond("ResourcesApplied", "False"), cond("ResourcesHealthy", "True"), cond("ResourcesProgressing", "False")), false},
		"mr no conditions yet": {mr(1, 0), false},
		"mr terminating":       {deleting, false},
		"node ready":           {node(nil, "True"), true},
		"node cordoned":        {node(map[string]any{"unschedulable": true}, "True"), false},
		"node uncordoned":      {node(map[string]any{"unschedulable": false}, "True"), true},
		"node not ready":       {node(nil, "Unknown"), false},
		"job complete":         {obj("batch/v1", "Job", 1, nil, map[string]any{"conditions": []any{cond("Complete", "True")}}), true},
		"job running":          {obj("batch/v1", "Job", 1, nil, map[string]any{"active": int64(1)}), false},
		"job failed":           {obj("batch/v1", "Job", 1, nil, map[string]any{"conditions": []any{cond("Failed", "True")}}), false},
		"pvc bound":            {obj("v1", "PersistentVolumeClaim", 0, nil, map[string]any{"phase": "Bound"}), true},
		"pvc pending":          {obj("v1", "PersistentVolumeClaim", 0, nil, map[string]any{"phase": "Pending"}), false},
		"ext succeeded":        {ext(2, 2, "Succeeded"), true},
		"ext processing":       {ext(2, 2, "Processing"), false},
		"ext not observed":     {ext(3, 2, "Succeeded"), false},
		"ext no status":        {obj("extensions.gardener.cloud/v1alpha1", "Worker", 1, nil, nil), false},
		"shoot healthy":        {shoot("Succeeded", cond("APIServerAvailable", "True"), cond("EveryNodeReady", "True")), true},
		"shoot degraded":       {shoot("Succeeded", cond("APIServerAvailable", "True"), cond("EveryNodeReady", "False")), false},
		"shoot reconciling":    {shoot("Processing", cond("APIServerAvailable", "True")), false},
		"seed healthy":         {obj("core.gardener.cloud/v1beta1", "Seed", 1, nil, map[string]any{"observedGeneration": int64(1), "lastOperation": map[string]any{"state": "Succeeded"}, "conditions": []any{cond("GardenletReady", "True")}}), true},
		"machine running":      {obj("machine.sapcloud.io/v1alpha1", "Machine", 0, nil, map[string]any{"currentStatus": map[string]any{"phase": "Running"}}), true},
		"machine pending":      {obj("machine.sapcloud.io/v1alpha1", "Machine", 0, nil, map[string]any{"currentStatus": map[string]any{"phase": "Pending"}}), false},
		"etcd ready":           {obj("druid.gardener.cloud/v1alpha1", "Etcd", 0, nil, map[string]any{"ready": true}), true},
		"etcd not ready":       {obj("druid.gardener.cloud/v1alpha1", "Etcd", 0, nil, map[string]any{"ready": false}), false},
		"etcd no status":       {obj("druid.gardener.cloud/v1alpha1", "Etcd", 0, nil, nil), false},
		// a kind of the same name in another group isn't the rule's
		"other group's Machine": {obj("cluster.x-k8s.io/v1beta1", "Machine", 0, nil, map[string]any{"currentStatus": map[string]any{"phase": "Running"}}), false},
		"no rule":               {obj("v1", "ConfigMap", 0, nil, nil), false},
		"no kind":               {map[string]any{"metadata": map[string]any{}}, false},
	}
	for name, c := range cases {
		if got := Default.Healthy(c.obj); got != c.want {
			t.Errorf("%s: healthy = %v, want %v", name, got, c.want)
		}
	}
}

func TestTitle(t *testing.T) {
	for _, c := range []struct{ group, kind, want string }{
		{"", "Pod", "pods that are Running with all containers ready"},
		{"apps", "StatefulSet", "statefulsets whose replicas are all current, up to date, ready and available"},
		{"core.gardener.cloud", "Seed", "seeds whose last operation succeeded, with every condition True"},
		{"resources.gardener.cloud", "ManagedResource", "managed resources applied, healthy and not progressing"},
		{"", "ConfigMap", ""},
		{"apps", "Pod", ""},
		{"", "", ""},
	} {
		if got := Default.Title(c.group, c.kind); got != c.want {
			t.Errorf("Title(%q, %q) = %q, want %q", c.group, c.kind, got, c.want)
		}
	}
	var nilRules *Rules
	if nilRules.Title("", "Pod") != "" || nilRules.Healthy(obj("v1", "Pod", 0, nil, nil)) {
		t.Error("nil rules: nothing healthy")
	}
}

func TestCompile(t *testing.T) {
	rs, errs := Compile(RulesFile{
		Rules: []Rule{
			// replaces the built-in node rule: Ready is enough
			{ID: "node", Kinds: []string{"Node"}, Conditions: map[string]string{"Ready": "True"}},
			{ID: "widget", Kinds: []string{"e2e.kubewing/*"}, CEL: `o.status.phase == "Up"`},
			{ID: "no-kinds", Conditions: map[string]string{"Ready": "True"}},
			{ID: "bad-cel", Kinds: []string{"Pod"}, CEL: "o.status.("},
			{ID: "not-bool", Kinds: []string{"Pod"}, CEL: `"x"`},
			{ID: "bad-builtin", Kinds: []string{"Pod"}, Builtin: "nope"},
			{ID: "empty", Kinds: []string{"Pod"}},
			{ID: "bad-glob", Kinds: []string{"["}, Generation: true},
			{ID: "bad-cond", Kinds: []string{"Pod"}, Conditions: map[string]string{"Ready": ""}},
			{Kinds: []string{"Pod"}, Generation: true},
			{ID: "widget", Kinds: []string{"Pod"}, Generation: true},
		},
		Disable: []string{"pvc", "nope"},
	})
	want := []string{
		"rules[2] (no-kinds): kinds is required",
		"rules[3] (bad-cel): cel:",
		"rules[4] (not-bool): cel: result is string",
		"rules[5] (bad-builtin): builtin: no check",
		"rules[6] (empty): nothing to check",
		"rules[7] (bad-glob): kinds:",
		"rules[8] (bad-cond): conditions:",
		"rules[9]: id is required",
		`rules[10]: id "widget" twice`,
		`disable: no built-in rule "nope"`,
	}
	if len(errs) != len(want) {
		t.Fatalf("errors = %v", errs)
	}
	for i, w := range want {
		if !strings.HasPrefix(errs[i].Error(), w) {
			t.Errorf("errors[%d] = %q, want prefix %q", i, errs[i], w)
		}
	}
	cordoned := obj("v1", "Node", 0, map[string]any{"unschedulable": true}, map[string]any{"conditions": []any{cond("Ready", "True")}})
	if !rs.Healthy(cordoned) {
		t.Error("the user's node rule replaces the built-in one")
	}
	if rs.Title("", "Node") != "healthy nodes" {
		t.Errorf("untitled rule: %q", rs.Title("", "Node"))
	}
	if !rs.Healthy(obj("e2e.kubewing/v1", "Widget", 0, nil, map[string]any{"phase": "Up"})) {
		t.Error("widget rule")
	}
	if rs.Title("", "PersistentVolumeClaim") != "" {
		t.Error("pvc rule not disabled")
	}
	if rs.Title("", "Pod") == "" {
		t.Error("built-in pod rule kept")
	}
	if !Default.Equal(mustCompile(t, RulesFile{})) || Default.Equal(rs) {
		t.Error("Equal")
	}
}

// the user's rule comes first: a broader glob of theirs wins over a built-in
func TestUserRulesFirst(t *testing.T) {
	rs := mustCompile(t, RulesFile{Rules: []Rule{{ID: "all-ext", Kinds: []string{"*.gardener.cloud/*"}, Generation: true}}})
	if !rs.Healthy(obj("core.gardener.cloud/v1beta1", "Shoot", 1, nil, map[string]any{"observedGeneration": int64(1)})) {
		t.Error("user rule should decide shoots")
	}
}

func mustCompile(t *testing.T, f RulesFile) *Rules {
	t.Helper()
	rs, errs := Compile(f)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	return rs
}
