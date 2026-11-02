package gardener

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// patterns as a landscape's gardenctl-v2.yaml has them: shoot--p--s with
// an optional garden prefix, dashboard URLs, API server hosts
func testConfig(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	kc := filepath.Join(dir, "garden.yaml")
	if err := os.WriteFile(kc, []byte("apiVersion: v1\nkind: Config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "gardenctl-v2.yaml")
	if err := os.WriteFile(path, []byte(`gardens:
- identity: landscape-dev
  name: dev
  kubeconfig: `+kc+`
  patterns:
  - "^((dev|landscape-dev)/)?shoot--(?P<project>[^.]+)--(?P<shoot>[^.]+)$"
  - "(dev\\.dashboard\\.example)(/namespace/(?P<namespace>[^/]+))?(/shoots/(?P<shoot>[^/]+))?"
  - "(?P<shoot>[^.]+)\\.(?P<project>[^.]+)\\.shoot\\.dev\\.example"
- identity: landscape-live
  kubeconfig: `+kc+`
  patterns:
  - "^((live|landscape-live)/)?shoot--(?P<project>[^.]+)--(?P<shoot>[^.]+)$"
  - "(live\\.dashboard\\.example)(/namespace/(?P<namespace>[^/]+))?(/shoots/(?P<shoot>[^/]+))?"
- identity: broken
  kubeconfig: ~/does/not/exist
  patterns: ["(", "^broken/(?P<seed>.+)$"]
`), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMatch(t *testing.T) {
	c := testConfig(t)
	shoot := func(g, p, ns, s string) []Target {
		t := Target{Garden: g, Project: p, Namespace: ns, Shoot: s}
		cp := t
		cp.ControlPlane = true
		return []Target{t, cp}
	}
	for _, tc := range []struct {
		in   string
		want []Target
	}{
		{"https://dev.dashboard.example/namespace/garden-foo/shoots/bar/", shoot("landscape-dev", "", "garden-foo", "bar")},
		{"https://dev.dashboard.example/namespace/garden-foo/shoots/", []Target{{Garden: "landscape-dev", Namespace: "garden-foo"}}},
		{"api.bar.foo.shoot.dev.example", shoot("landscape-dev", "foo", "", "bar")},
		{"live/shoot--foo--bar", shoot("landscape-live", "foo", "", "bar")},
		// without a prefix every garden matches: one target each, not an error as in gardenctl
		{"shoot--foo--bar", append(shoot("landscape-dev", "foo", "", "bar"), shoot("landscape-live", "foo", "", "bar")...)},
		{"  live/shoot--foo--bar\n", shoot("landscape-live", "foo", "", "bar")},
		{"broken/soil", []Target{{Garden: "broken", Seed: "soil"}}},
		{"nothing", nil},
		{"", nil},
	} {
		got, _ := c.Match(tc.in)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("Match(%q) =\n%+v\nwant\n%+v", tc.in, got, tc.want)
		}
	}
	// a broken pattern is reported; the garden's other patterns still match
	if _, err := c.Match("x"); err == nil || !strings.Contains(err.Error(), "garden broken") {
		t.Errorf("broken pattern: %v", err)
	}
}

func TestConfig(t *testing.T) {
	c := testConfig(t)
	if g, ok := c.Garden("dev"); !ok || g.Identity != "landscape-dev" {
		t.Errorf("by alias: %+v %v", g, ok)
	}
	if g, _ := c.Garden("landscape-live"); g.Problem() != "" {
		t.Errorf("problem: %q", g.Problem())
	}
	g, _ := c.Garden("broken")
	if !strings.HasPrefix(g.Kubeconfig, "/") || !strings.Contains(g.Problem(), "not found") {
		t.Errorf("~ not expanded or no problem: %q %q", g.Kubeconfig, g.Problem())
	}
	if c, err := LoadConfig(filepath.Join(t.TempDir(), "none.yaml")); err != nil || len(c.Gardens) != 0 {
		t.Errorf("missing file: %+v %v", c, err)
	}
}

func TestProjectName(t *testing.T) {
	for in, want := range map[Target]string{
		{Project: "p"}:            "p",
		{Namespace: "garden-foo"}: "foo",
		{Namespace: "garden"}:     "garden",
		{}:                        "",
	} {
		if got := in.ProjectName(); got != want {
			t.Errorf("%+v: %q, want %q", in, got, want)
		}
	}
}

func TestSessions(t *testing.T) {
	dir := t.TempDir()
	write := func(id, body string, age int) {
		p := filepath.Join(dir, id)
		_ = os.MkdirAll(p, 0o700)
		f := filepath.Join(p, "target.yaml")
		if err := os.WriteFile(f, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		at := mtime.AddDate(0, 0, -age)
		_ = os.Chtimes(f, at, at)
	}
	write("a", "garden: g\nproject: p\nshoot: s\nseed: soil\n", 3)
	write("b", "garden: g\nproject: p\nshoot: s\nseed: soil\ncontrolPlane: true\n", 1)
	write("c", "garden: g\nseed: soil\n", 0)           // a seed: not supported
	write("d", "garden: g\nproject: p\nshoot: s\n", 2) // a repeat of a (older one dropped)
	write("e", "{{{", 0)
	got := Sessions(dir)
	var ts []Target
	for _, s := range got {
		ts = append(ts, s.Target)
	}
	want := []Target{{Garden: "g", Project: "p", Shoot: "s", ControlPlane: true}, {Garden: "g", Project: "p", Shoot: "s"}}
	if !reflect.DeepEqual(ts, want) {
		t.Errorf("Sessions = %+v, want %+v", ts, want)
	}
	if Sessions("") != nil {
		t.Error("no dir")
	}
}
