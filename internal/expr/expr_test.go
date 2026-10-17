package expr

import "testing"

var pod = map[string]any{
	"metadata": map[string]any{"name": "etcd-0", "labels": map[string]any{"app": "etcd"}},
	"spec":     map[string]any{"containers": []any{map[string]any{"name": "etcd", "image": "etcd:3.5"}}},
	"status": map[string]any{
		"phase": "Running",
		"containerStatuses": []any{
			map[string]any{"name": "etcd", "restartCount": int64(4)},
			map[string]any{"name": "sidecar", "restartCount": int64(1)},
		},
	},
}

func TestCEL(t *testing.T) {
	cases := []struct {
		src  string
		want any
	}{
		{`o.metadata.name`, "etcd-0"},
		{`o.status.containerStatuses.map(c, c.restartCount).sum()`, int64(5)},
		{`o.status.containerStatuses.exists(c, c.restartCount > 3)`, true},
		{`o.status.missing`, nil},
		{`o.metadata.labels.app == "etcd"`, true},
	}
	for _, c := range cases {
		p, err := Compile(c.src)
		if err != nil {
			t.Fatal(err)
		}
		got, err := p.Eval(pod)
		if err != nil {
			t.Fatalf("%s: %v", c.src, err)
		}
		if got != c.want {
			t.Errorf("%s = %#v, want %#v", c.src, got, c.want)
		}
	}
}

func TestCompileError(t *testing.T) {
	if _, err := Compile(`o.metadata.name ==`); err == nil {
		t.Fatal("expected syntax error")
	}
}

func TestPath(t *testing.T) {
	cases := map[string]any{
		"metadata.name":            "etcd-0",
		"spec.containers[0].image": "etcd:3.5",
		"spec.containers[5].image": nil,
		"metadata.nope.deeper":     nil,
		"status.phase":             "Running",
	}
	for src, want := range cases {
		p, err := CompilePath(src)
		if err != nil {
			t.Fatal(err)
		}
		if got := p.Get(pod); got != want {
			t.Errorf("%s = %#v, want %#v", src, got, want)
		}
	}
	for _, bad := range []string{"a..b", "a[x]", "a[1"} {
		if _, err := CompilePath(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}
