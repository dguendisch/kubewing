package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/dguendisch/kubewing/internal/normalize"
)

func write(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestMissingDirIsDefaults(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nope")
	if diff := cmp.Diff(Defaults(dir), Load(dir)); diff != "" {
		t.Error(diff)
	}
	if diff := cmp.Diff(Defaults(""), Load("")); diff != "" {
		t.Error(diff)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("Load must never create the config dir")
	}
}

var yes, no = true, false

func TestOpsPodSettings(t *testing.T) {
	if got := (OpsPod{}).Settings(); got != DefaultOpsPodSettings || !got.HostRoot || !got.HostNetwork || got.Chroot {
		t.Errorf("defaults: %+v", got)
	}
	// false turns a default off; chroot brings the mount along
	got := OpsPod{Namespace: "ops", Chroot: &yes, HostRoot: &no, HostNetwork: &no}.Settings()
	if got != (OpsPodSettings{Namespace: "ops", Chroot: true, HostRoot: true}) {
		t.Errorf("configured: %+v", got)
	}
}

func TestValid(t *testing.T) {
	dir := write(t, map[string]string{
		"config.yaml": `
theme: solar
diff:
  ignore:
    - {path: status.observedGeneration, kinds: [Deployment]}
contexts:
  - {match: "*prod*", label: PROD, color: prod, readOnly: true, confirm: [delete, exec, edit], strict: true}
  - {match: "kind-*", label: kind, color: "#3b8eea"}
debug: {image: nicolaka/netshoot, profile: netadmin}
opsPod: {image: ops-toolbelt:latest, namespace: kube-system, chroot: true, hostNetwork: false}
terminal: {scrollback: 50000}
`,
		"keybindings.yaml": `
- {key: "Meta+K", command: row.up, when: [table]}
- {key: "J", command: none, when: [table]}
`,
		"themes/solar.yaml": `
bg: "#002b36"
accent: "rgb(203, 75, 22)"
`,
	})
	got := Load(dir)
	want := Effective{
		Dir: dir,
		Config: Config{
			Theme: "solar",
			Diff:  Diff{Ignore: []normalize.Rule{{Path: "status.observedGeneration", Kinds: []string{"Deployment"}}}},
			Contexts: []ContextRule{
				{Match: "*prod*", Label: "PROD", Color: "prod", ReadOnly: true, Confirm: []string{"delete", "exec", "edit"}, Strict: true},
				{Match: "kind-*", Label: "kind", Color: "#3b8eea"},
			},
			Debug:    Debug{Image: "nicolaka/netshoot", Profile: "netadmin"},
			OpsPod:   OpsPod{Image: "ops-toolbelt:latest", Namespace: "kube-system", Chroot: &yes, HostNetwork: &no},
			Terminal: Terminal{Scrollback: 50000},
		},
		Keybindings: []Binding{
			{Key: "Meta+K", Command: "row.up", When: []string{"table"}},
			{Key: "J", Command: "none", When: []string{"table"}},
		},
		Theme:  map[string]string{"bg": "#002b36", "accent": "rgb(203, 75, 22)"},
		Errors: []string{},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Error(diff)
	}
}

// Broken parts are reported and dropped; everything else still applies.
func TestPartiallyInvalid(t *testing.T) {
	dir := write(t, map[string]string{
		"config.yaml": `
theme: missing
colour: red
diff:
  ignore: [{path: ""}, {path: status.ok}]
contexts:
  - {match: "[", label: broken}
  - {match: "a*", color: "not a color!"}
  - {match: "b*", confirm: [reboot]}
  - {label: nomatch}
  - {match: "*", label: ok}
debug: {image: busybox, profile: root}
terminal: {scrollback: 5}
`,
		"keybindings.yaml": `
- {key: "", command: row.up}
- {key: "Meta+K", command: row.up}
`,
	})
	got := Load(dir)
	if diff := cmp.Diff([]ContextRule{{Match: "*", Label: "ok"}}, got.Config.Contexts); diff != "" {
		t.Error(diff)
	}
	if diff := cmp.Diff([]normalize.Rule{{Path: "status.ok"}}, got.Config.Diff.Ignore); diff != "" {
		t.Error(diff)
	}
	if diff := cmp.Diff([]Binding{{Key: "Meta+K", Command: "row.up"}}, got.Keybindings); diff != "" {
		t.Error(diff)
	}
	if len(got.Theme) != 0 {
		t.Errorf("theme: %v", got.Theme)
	}
	// an unknown profile falls back to kubectl's default; the image still applies
	if got.Config.Debug != (Debug{Image: "busybox"}) {
		t.Errorf("debug: %+v", got.Config.Debug)
	}
	if got.Config.Terminal.Scrollback != DefaultScrollback {
		t.Errorf("out-of-range scrollback must fall back to the default: %d", got.Config.Terminal.Scrollback)
	}
	wantErrs := []string{
		`unknown field "colour"`,
		"diff.ignore[0]: path is required",
		`contexts[0]: match "["`,
		`contexts[1]: color "not a color!"`,
		`contexts[2]: confirm: unknown action "reboot"`,
		"contexts[3]: match is required",
		"terminal.scrollback: 5 is not between 100 and 1000000 lines",
		`debug.profile: unknown profile "root"`,
		"keybindings.yaml: [0]: key and command are required",
		`theme "missing": themes/missing.yaml not found`,
	}
	if len(got.Errors) != len(wantErrs) {
		t.Fatalf("errors:\n%s", strings.Join(got.Errors, "\n"))
	}
	for i, w := range wantErrs {
		if !strings.Contains(got.Errors[i], w) {
			t.Errorf("error %d: %q does not contain %q", i, got.Errors[i], w)
		}
	}
}

func TestBadTheme(t *testing.T) {
	dir := write(t, map[string]string{
		"config.yaml":      "theme: x\n",
		"themes/x.yaml":    "bg: \"#000\"\nBad_Name: \"#fff\"\nfg: blue\n",
		"keybindings.yaml": "not: a list\n",
	})
	got := Load(dir)
	if diff := cmp.Diff(map[string]string{"bg": "#000"}, got.Theme); diff != "" {
		t.Error(diff)
	}
	if len(got.Errors) != 3 {
		t.Errorf("errors:\n%s", strings.Join(got.Errors, "\n"))
	}
}

func TestHistoryLimits(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) {
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("history: {budget: 64Mi}\n")
	e := Load(dir)
	b, err := e.Config.History.Parse()
	if err != nil || b != 64<<20 || len(e.Errors) != 0 {
		t.Fatalf("%v %v %v", b, err, e.Errors)
	}
	for _, bad := range []string{"history: {budget: 10}\n", "history: {budget: 1Ti}\n", "history: {budget: lots}\n"} {
		write(bad)
		e := Load(dir)
		if len(e.Errors) != 1 || !strings.Contains(e.Errors[0], "history.budget") {
			t.Errorf("%q: errors %v", bad, e.Errors)
		}
		if b, _ := e.Config.History.Parse(); b != 0 {
			t.Errorf("%q: kept %v", bad, b)
		}
	}
	// window is gone: an old config says so, the rest still loads
	write("history: {window: 1h, budget: 64Mi}\n")
	e = Load(dir)
	if b, _ := e.Config.History.Parse(); len(e.Errors) != 1 || !strings.Contains(e.Errors[0], `unknown field "window"`) || b != 64<<20 {
		t.Errorf("old window: errors %v, budget %v", e.Errors, b)
	}
}
