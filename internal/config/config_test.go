package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/dguendisch/kubewing/internal/health"
	"github.com/dguendisch/kubewing/internal/normalize"
	"github.com/dguendisch/kubewing/internal/relations"
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
			Font:  Font{Size: DefaultFontSize},
			Diff:  Diff{Ignore: []normalize.Rule{{Path: "status.observedGeneration", Kinds: []string{"Deployment"}}}},
			Contexts: []ContextRule{
				{Match: "*prod*", Label: "PROD", Color: "prod", ReadOnly: true, Confirm: []string{"delete", "exec", "edit"}, Strict: true},
				{Match: "kind-*", Label: "kind", Color: "#3b8eea"},
			},
			Debug:    Debug{Image: "nicolaka/netshoot", Profile: "netadmin"},
			OpsPod:   OpsPod{Image: "ops-toolbelt:latest", Namespace: "kube-system", Chroot: &yes, HostNetwork: &no},
			Terminal: Terminal{Scrollback: 50000},
			Logs:     Logs{Tail: DefaultLogTail, MaxStreams: DefaultLogStreams, Buffer: DefaultLogBuffer},
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

// Log tail defaults apply when unset, valid values override, and
// out-of-range ones are reported and fall back to the default.
func TestLogsConfig(t *testing.T) {
	// unset: the defaults
	def := Load(write(t, map[string]string{"config.yaml": "theme: default\n"}))
	if got, want := def.Config.Logs, (Logs{Tail: DefaultLogTail, MaxStreams: DefaultLogStreams, Buffer: DefaultLogBuffer}); got != want {
		t.Errorf("defaults: %+v, want %+v", got, want)
	}
	// valid overrides
	ok := Load(write(t, map[string]string{"config.yaml": "logs: {tail: 500, maxStreams: 10, buffer: 2000}\n"}))
	if got, want := ok.Config.Logs, (Logs{Tail: 500, MaxStreams: 10, Buffer: 2000}); got != want {
		t.Errorf("overrides: %+v, want %+v", got, want)
	}
	// out of range: reported, defaults kept
	bad := Load(write(t, map[string]string{"config.yaml": "logs: {tail: 999999, maxStreams: 0, buffer: 5}\n"}))
	if got, want := bad.Config.Logs, (Logs{Tail: DefaultLogTail, MaxStreams: DefaultLogStreams, Buffer: DefaultLogBuffer}); got != want {
		t.Errorf("out-of-range: %+v, want %+v", got, want)
	}
	// maxStreams 0 means unset (the default), so only tail and buffer are flagged
	wantErrs := []string{
		"logs.tail: 999999 is not between 1 and 10000",
		"logs.buffer: 5 is not between 1000 and 5000000",
	}
	for _, w := range wantErrs {
		if !hasError(bad.Errors, w) {
			t.Errorf("missing error %q in %v", w, bad.Errors)
		}
	}
}

// launch.wait: off unless set.
func TestLaunchConfig(t *testing.T) {
	if Load(write(t, map[string]string{"config.yaml": "theme: default\n"})).Config.Launch.Wait {
		t.Error("unset: want detach (wait false)")
	}
	if !Load(write(t, map[string]string{"config.yaml": "launch: {wait: true}\n"})).Config.Launch.Wait {
		t.Error("launch.wait: true not applied")
	}
}

func TestUpdateConfig(t *testing.T) {
	for _, c := range []struct {
		yaml string
		days int
		pre  bool
		errs int
	}{
		{"theme: default\n", 1, false, 0},
		{"update: {checkDays: 7}\n", 7, false, 0},
		{"update: {checkDays: 0}\n", 0, false, 0},
		{"update: {checkDays: -1, prereleases: true}\n", 1, true, 1},
		{"update: {checkDays: 1000}\n", 1, false, 1},
	} {
		e := Load(write(t, map[string]string{"config.yaml": c.yaml}))
		if got := e.Config.Update.Days(); got != c.days || e.Config.Update.Prereleases != c.pre || len(e.Errors) != c.errs {
			t.Errorf("%q: days %d, prereleases %v, errors %v", c.yaml, got, e.Config.Update.Prereleases, e.Errors)
		}
	}
	if d := Defaults("").Config.Update.Days(); d != DefaultUpdateCheckDays {
		t.Errorf("defaults: %d days", d)
	}
}

// safety: a badge and a colored frame unless set; an unknown label mode is reported and dropped.
func TestSafetyConfig(t *testing.T) {
	if s := Load(write(t, map[string]string{"config.yaml": "contexts: []\n"})).Config.Safety; s.Label != "" || s.Frame != nil || s.Chip != nil {
		t.Errorf("defaults: %+v", s)
	}
	e := Load(write(t, map[string]string{"config.yaml": "safety: {label: landscape, frame: false, chip: false}\n"}))
	if s := e.Config.Safety; s.Label != "landscape" || s.Frame == nil || *s.Frame || s.Chip == nil || *s.Chip || len(e.Errors) != 0 {
		t.Errorf("set: %+v %v", s, e.Errors)
	}
	e = Load(write(t, map[string]string{"config.yaml": "safety: {label: chip}\n"}))
	if e.Config.Safety.Label != "" || len(e.Errors) != 1 || !strings.Contains(e.Errors[0], "safety.label") {
		t.Errorf("unknown: %+v %v", e.Config.Safety, e.Errors)
	}
}

// focusFollowsMouse: off unless set.
func TestFocusFollowsMouseConfig(t *testing.T) {
	if Load(write(t, map[string]string{"config.yaml": "theme: default\n"})).Config.FocusFollowsMouse {
		t.Error("unset: want off")
	}
	if !Load(write(t, map[string]string{"config.yaml": "focusFollowsMouse: true\n"})).Config.FocusFollowsMouse {
		t.Error("focusFollowsMouse: true not applied")
	}
}

// terminal.copyOnSelect: off unless set.
func TestCopyOnSelectConfig(t *testing.T) {
	if Load(write(t, map[string]string{"config.yaml": "theme: default\n"})).Config.Terminal.CopyOnSelect {
		t.Error("unset: want off")
	}
	if !Load(write(t, map[string]string{"config.yaml": "terminal: {copyOnSelect: true}\n"})).Config.Terminal.CopyOnSelect {
		t.Error("terminal.copyOnSelect: true not applied")
	}
}

func hasError(errs []string, sub string) bool {
	for _, e := range errs {
		if strings.Contains(e, sub) {
			return true
		}
	}
	return false
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
	// the incomplete entry stays (reported here, skipped by the frontend): its problems keep their numbers
	if diff := cmp.Diff([]Binding{{Key: "", Command: "row.up"}, {Key: "Meta+K", Command: "row.up"}}, got.Keybindings); diff != "" {
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

func TestBuiltinTheme(t *testing.T) {
	if diff := cmp.Diff([]string{"blue"}, BuiltinThemes()); diff != "" {
		t.Error(diff)
	}
	blue, _ := builtinTheme("blue")
	got := Load(write(t, map[string]string{"config.yaml": "theme: blue\n"}))
	if len(got.Errors) != 0 {
		t.Errorf("errors:\n%s", strings.Join(got.Errors, "\n"))
	}
	if diff := cmp.Diff(blue, got.Theme); diff != "" {
		t.Error(diff)
	}
	if got.Theme["accent"] == "" || got.Theme["shadow"] == "" {
		t.Errorf("blue sets no accent or shadow: %v", got.Theme)
	}

	// a themes/blue.yaml of one's own changes single tokens of the built-in one
	got = Load(write(t, map[string]string{"config.yaml": "theme: blue\n", "themes/blue.yaml": "accent: \"#ff0000\"\nshadow: \"#0000\"\n"}))
	want := map[string]string{}
	for k, v := range blue {
		want[k] = v
	}
	want["accent"], want["shadow"] = "#ff0000", "#0000"
	if diff := cmp.Diff(want, got.Theme); diff != "" || len(got.Errors) != 0 {
		t.Errorf("%s %v", diff, got.Errors)
	}
	// a fresh copy each time: the override didn't leak into the built-in
	if again, _ := builtinTheme("blue"); again["accent"] != blue["accent"] {
		t.Error("built-in theme changed")
	}

	// an unknown name lists the built-in ones
	got = Load(write(t, map[string]string{"config.yaml": "theme: nope\n"}))
	if len(got.Errors) != 1 || !strings.Contains(got.Errors[0], "(built-in: blue)") {
		t.Errorf("errors: %v", got.Errors)
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

func TestRefs(t *testing.T) {
	if Load("").Rules() != relations.DefaultRules {
		t.Error("no config: the built-in rules")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "refs.yaml"), []byte(`rules:
- {id: widget-config, kinds: [e2e.kubewing/Widget], path: "spec.configs[*]", name: ref, target: ConfigMap}
- {id: broken, path: "a..b", target: Secret}
disable: [node-name]
`), 0o644); err != nil {
		t.Fatal(err)
	}
	e := Load(dir)
	if len(e.Errors) != 1 || !strings.Contains(e.Errors[0], "refs.yaml: rules[1] (broken)") {
		t.Errorf("errors %v", e.Errors)
	}
	root, _ := relations.ParseYAML("spec: {configs: [{ref: a}], nodeName: n}")
	if got := e.Rules().Match(root, "e2e.kubewing", "Widget", "shop"); len(got) != 1 || got[0].Name != "a" {
		t.Errorf("refs = %+v", got)
	}
}

func TestHealth(t *testing.T) {
	if Load("").HealthRules() != health.Default {
		t.Error("no config: the built-in rules")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, HealthFile), []byte(`rules:
- {id: widget, kinds: [e2e.kubewing/Widget], conditions: {Ready: "True"}}
- {id: broken, kinds: [Pod], cel: "o.status.("}
disable: [node]
`), 0o644); err != nil {
		t.Fatal(err)
	}
	e := Load(dir)
	if len(e.Errors) != 1 || !strings.Contains(e.Errors[0], "health.yaml: rules[1] (broken)") {
		t.Errorf("errors %v", e.Errors)
	}
	w := map[string]any{"apiVersion": "e2e.kubewing/v1", "kind": "Widget", "status": map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True"}}}}
	if !e.HealthRules().Healthy(w) {
		t.Error("widget not healthy")
	}
	if e.HealthRules().Title("", "Node") != "" {
		t.Error("node rule not disabled")
	}
}

// font: family checked for CSS-breaking characters, size within bounds; broken parts fall back.
func TestFontConfig(t *testing.T) {
	installed := map[string]bool{"JetBrainsMono Nerd Font": true, "Fira Code": true, "Menlo": true, "Monaco": true}
	orig := fontInstalled
	fontInstalled = func(name string) bool { return installed[name] }
	t.Cleanup(func() { fontInstalled = orig })
	for _, c := range []struct {
		yaml      string
		family    string
		size      int
		ligatures bool
		errs      int
	}{
		{"theme: default\n", "", DefaultFontSize, false, 0},
		{"font: {family: JetBrainsMono Nerd Font, size: 14, ligatures: true}\n", "JetBrainsMono Nerd Font", 14, true, 0},
		{"font: {family: '\"Fira Code\", Menlo'}\n", `"Fira Code", Menlo`, DefaultFontSize, false, 0},
		{"font: {family: \"  Monaco \"}\n", "Monaco", DefaultFontSize, false, 0},
		{"font: {family: \"Menlo; color: red\"}\n", "", DefaultFontSize, false, 1},
		{"font: {family: \"a,,b\"}\n", "", DefaultFontSize, false, 1},
		{"font: {family: \"\\\"Fira\"}\n", "", DefaultFontSize, false, 1},
		{"font: {size: 7}\n", "", DefaultFontSize, false, 1},
		{"font: {size: 25, family: Monaco}\n", "Monaco", DefaultFontSize, false, 1},
		{"font: {size: 8}\n", "", 8, false, 0},
	} {
		e := Load(write(t, map[string]string{"config.yaml": c.yaml}))
		f := e.Config.Font
		if f.Family != c.family || f.Size != c.size || f.Ligatures != c.ligatures || len(e.Errors) != c.errs {
			t.Errorf("%q: got %+v, errors %v", c.yaml, f, e.Errors)
		}
	}
}

// font.family: reported when none of its fonts is installed (the default font shows), not when one is.
func TestFontInstalledCheck(t *testing.T) {
	orig := fontInstalled
	fontInstalled = func(name string) bool { return name == "Comic Mono" }
	t.Cleanup(func() { fontInstalled = orig })
	for _, c := range []struct{ family, err string }{
		{"Comic Mono", ""},
		{"Missing, Comic Mono", ""},
		{"Missing, monospace", ""},
		{"\"monospace\"", `"monospace" is not installed`},
		{"Missing", `font.family: "Missing" is not installed, using the default font`},
		{"'A', B", `font.family: none of "A", "B" is installed, using the default font`},
	} {
		e := Load(write(t, map[string]string{"config.yaml": "font: {family: " + yamlQuote(c.family) + "}\n"}))
		if c.err == "" && len(e.Errors) != 0 || c.err != "" && (len(e.Errors) != 1 || !strings.Contains(e.Errors[0], c.err)) {
			t.Errorf("%q: errors %v, want %q", c.family, e.Errors, c.err)
		}
		// still applied: the default stack stands behind it in the frontend
		if e.Config.Font.Family != c.family {
			t.Errorf("%q: family %q not kept", c.family, e.Config.Font.Family)
		}
	}
}

// the settings editor's live check doesn't ask the system: only loading (startup, reload, save) does
func TestFontInstalledNotChecked(t *testing.T) {
	orig := fontInstalled
	fontInstalled = func(string) bool { t.Error("Check asked whether a font is installed"); return false }
	t.Cleanup(func() { fontInstalled = orig })
	if errs, _ := Check(t.TempDir(), File, "font: {family: Missing}\n"); len(errs) != 0 {
		t.Errorf("Check: %v", errs)
	}
}

func yamlQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
