// Package config loads the user's hand-edited files in ~/.kubewing/
// (config.yaml, keybindings.yaml, refs.yaml, health.yaml, themes/*.yaml). kubewing only reads them,
// except config.yaml and keybindings.yaml saved from the settings editor (see WriteFile): the files it
// writes there are its own history.yaml (see HistoryStore) and columns.yaml (see ColumnStore).
// Missing files mean defaults;
// invalid parts fall back to defaults and are reported in Effective.Errors,
// so one typo never prevents the app from starting.
package config

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/api/resource"
	"sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/health"
	"github.com/dguendisch/kubewing/internal/normalize"
	"github.com/dguendisch/kubewing/internal/relations"
)

// Dir is $KUBEWING_HOME, else ~/.kubewing.
func Dir() string {
	if d := os.Getenv("KUBEWING_HOME"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".kubewing")
}

// Config mirrors config.yaml.
type Config struct {
	// Theme names themes/<name>.yaml or a built-in theme (BuiltinThemes); "" or "default" uses the default theme.
	Theme string `json:"theme,omitempty"`
	Font  Font   `json:"font"`
	Diff  Diff   `json:"diff"`
	// Contexts are per-context safety rules; the first matching rule wins.
	Contexts []ContextRule `json:"contexts"`
	// Safety is how rules show (their enforcement is Contexts').
	Safety   Safety        `json:"safety"`
	Debug    Debug         `json:"debug"`
	OpsPod   OpsPod        `json:"opsPod"`
	Terminal Terminal      `json:"terminal"`
	Logs     Logs          `json:"logs"`
	History  HistoryLimits `json:"history"`
	Launch   Launch        `json:"launch"`
	Update   Update        `json:"update"`
	// FocusFollowsMouse focuses the pane under the mouse pointer, without a
	// click. Default off.
	FocusFollowsMouse bool `json:"focusFollowsMouse,omitempty"`
}

// Font configures the one font of the whole app: tables, YAML, terminals,
// logs and the rest of the UI.
type Font struct {
	// Family is an installed font ("JetBrainsMono Nerd Font") or a
	// comma-separated list of them, the first one installed wins; the
	// default stack (SF Mono, Menlo) always comes after it. "" = the
	// default stack alone. The frontend reports one that isn't installed.
	Family string `json:"family,omitempty"`
	// Size is the base size in px (smaller UI text is 1-2px less); 0 = 12.
	Size int `json:"size,omitempty"`
	// Ligatures joins character sequences ("->", "!=", "=>") into one glyph
	// in fonts that have them. Default off: text reads as typed.
	Ligatures bool `json:"ligatures,omitempty"`
}

// Font size bounds and default (px).
const (
	DefaultFontSize = 12
	MinFontSize     = 8
	MaxFontSize     = 24
)

// fontFamily is a font name or a comma-separated list of names, optionally
// quoted: nothing that could end the CSS value (;{}<>\) or a quote inside one.
var fontFamily = regexp.MustCompile(`^\s*("[^"]+"|'[^']+'|[^"',;{}<>\\]+)(\s*,\s*("[^"]+"|'[^']+'|[^"',;{}<>\\]+))*\s*$`)

// fontInstalled tells whether a font is installed (a family as Font Book
// lists it, or a font's full name); a variable for tests.
var fontInstalled = systemFontInstalled

// cssGenerics are CSS's generic families: always there, never looked up.
var cssGenerics = []string{"serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"}

// missingFonts says which fonts of a family list aren't installed when none
// of them is ("" when one is, or the list is empty): the default stack shows
// then. Unquoted generic families count as installed.
func missingFonts(family string) string {
	var names []string
	for _, f := range strings.Split(family, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if len(f) > 1 && (f[0] == '"' || f[0] == '\'') && f[len(f)-1] == f[0] {
			f = f[1 : len(f)-1]
		} else if slices.Contains(cssGenerics, strings.ToLower(f)) {
			return ""
		}
		if fontInstalled(f) {
			return ""
		}
		names = append(names, fmt.Sprintf("%q", f))
	}
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0] + " is not installed"
	default:
		return "none of " + strings.Join(names, ", ") + " is installed"
	}
}

// Safety is how safety rules show.
type Safety struct {
	// Label: "badge" (default) a chip of its own in the pane header; "landscape"
	// on a Gardener cluster whose rule matched its landscape, the landscape's
	// name in the breadcrumb becomes the chip, reading the rule's label.
	Label string `json:"label,omitempty"`
	// Frame colors the pane frame in the rule's color; nil = true.
	Frame *bool `json:"frame,omitempty"`
	// Chip: with Label "landscape", false shows the landscape's label as its
	// text in the rule's color, without the chip's tint and border; nil = true.
	Chip *bool `json:"chip,omitempty"`
}

// SafetyLabels are the values of safety.label.
var SafetyLabels = []string{"badge", "landscape"}

// Launch configures a launch from a terminal.
type Launch struct {
	// Wait keeps kubewing in the foreground: the shell waits for it and its
	// log goes to the terminal (-wait overrides it). Default: it detaches, the
	// terminal gets its prompt back and the log goes to kubewing.log in the
	// state directory.
	Wait bool `json:"wait,omitempty"`
}

// Update configures the update check (kubewing's GitHub releases).
type Update struct {
	// CheckDays is how many days pass between automatic checks; 0 turns them
	// off (the menu's "Check for Updates…" still works). Unset = daily.
	CheckDays *int `json:"checkDays,omitempty"`
	// Prereleases offers release candidates too. Default off: finals only.
	Prereleases bool `json:"prereleases,omitempty"`
}

// Update check interval bounds and default (days).
const (
	DefaultUpdateCheckDays = 1
	MaxUpdateCheckDays     = 365
)

// Days is the check interval in days, 0 = off.
func (u Update) Days() int {
	if u.CheckDays == nil {
		return DefaultUpdateCheckDays
	}
	return *u.CheckDays
}

// HistoryLimits bound recorded history (per source, while recording): how
// much memory it may take; how far back it reaches follows from that. A
// reload applies it to running recordings too. (Not history.yaml: see History.)
type HistoryLimits struct {
	// Budget is a quantity of bytes ("512Mi", "1Gi"); "" = 512Mi. It caps
	// the whole history of a source: its objects' newest copies and the
	// changes; the oldest changes go first.
	Budget string `json:"budget,omitempty"`
}

// Parse returns the budget in bytes (0 = the default); invalid values are reported by Load.
func (h HistoryLimits) Parse() (budget int64, err error) {
	if h.Budget == "" {
		return 0, nil
	}
	q, err := resource.ParseQuantity(h.Budget)
	if err != nil || q.Value() < 1<<20 || q.Value() > 64<<30 {
		return 0, fmt.Errorf("history.budget: %q is not a size between 1Mi and 64Gi", h.Budget)
	}
	return q.Value(), nil
}

// OpsPod configures ops pods on nodes (ops-toolbelt's ops-pod).
type OpsPod struct {
	// Image prefills the ops pod dialog, e.g. the ops-toolbelt image.
	Image string `json:"image,omitempty"`
	// Namespace the pods are created in; "" = default.
	Namespace string `json:"namespace,omitempty"`
	// Chroot, HostRoot and HostNetwork are the dialog's checkboxes' defaults
	// until a pod ran (then the last used ones, see History); unset = off,
	// on, on (see DefaultOpsPodSettings).
	Chroot      *bool `json:"chroot,omitempty"`
	HostRoot    *bool `json:"hostRoot,omitempty"`
	HostNetwork *bool `json:"hostNetwork,omitempty"`
}

// OpsPodSettings are the ops pod dialog's namespace and checkboxes.
type OpsPodSettings struct {
	// Namespace "" = default.
	Namespace   string `json:"namespace"`
	Chroot      bool   `json:"chroot"`
	HostRoot    bool   `json:"hostRoot"`
	HostNetwork bool   `json:"hostNetwork"`
}

// DefaultOpsPodSettings: the node's / at /host and its network, no chroot.
var DefaultOpsPodSettings = OpsPodSettings{HostRoot: true, HostNetwork: true}

// Settings applies the configured defaults over DefaultOpsPodSettings.
func (o OpsPod) Settings() OpsPodSettings {
	s := DefaultOpsPodSettings
	s.Namespace = o.Namespace
	for _, f := range []struct {
		from *bool
		to   *bool
	}{{o.Chroot, &s.Chroot}, {o.HostRoot, &s.HostRoot}, {o.HostNetwork, &s.HostNetwork}} {
		if f.from != nil {
			*f.to = *f.from
		}
	}
	s.HostRoot = s.HostRoot || s.Chroot // chroot needs the mount
	return s
}

// Terminal configures terminal panes (exec, debug).
type Terminal struct {
	// Scrollback is how many lines a terminal keeps beyond the screen.
	Scrollback int `json:"scrollback"`
	// CopyOnSelect copies a mouse selection to the clipboard as the button is
	// released, in terminals and log panes alike.
	CopyOnSelect bool `json:"copyOnSelect,omitempty"`
}

// Scrollback bounds and default (lines).
const (
	DefaultScrollback = 10000
	MinScrollback     = 100
	MaxScrollback     = 1_000_000
)

// Logs configures the multi-pod log tail (stern-like).
type Logs struct {
	// Tail is how many lines to fetch per container before following.
	Tail int `json:"tail,omitempty"`
	// MaxStreams caps concurrently followed containers (stern's --max-log-requests).
	MaxStreams int `json:"maxStreams,omitempty"`
	// Buffer is how many lines the frontend keeps per log pane (the live
	// filter and timestamp toggle re-render from it).
	Buffer int `json:"buffer,omitempty"`
}

// Log tail bounds and defaults.
const (
	DefaultLogTail    = 100
	MaxLogTail        = 10000
	DefaultLogStreams = 50
	MaxLogStreams     = 500
	DefaultLogBuffer  = 50000
	MinLogBuffer      = 1000
	MaxLogBuffer      = 5_000_000
)

// Debug configures debug containers (kubectl debug).
type Debug struct {
	// Image prefills the debug dialog, e.g. "nicolaka/netshoot".
	Image string `json:"image,omitempty"`
	// Profile is the default security profile (see DebugProfiles); "" = general.
	Profile string `json:"profile,omitempty"`
}

// DebugProfiles are kubectl debug's --profile values.
var DebugProfiles = []string{"general", "baseline", "restricted", "netadmin", "sysadmin"}

// Diff configures change detection.
type Diff struct {
	// Ignore adds noise rules on top of normalize.DefaultRules.
	Ignore []normalize.Rule `json:"ignore"`
}

// Actions that a context rule can require confirmation for.
var Actions = []string{"delete", "exec", "debug", "opspod", "edit", "terminal", "label", "annotate", "scale", "restart"}

// ContextRule applies to kubeconfig contexts whose name matches Match.
type ContextRule struct {
	// Match is a glob (path.Match syntax) on the context name, e.g. "*prod*".
	Match string `json:"match"`
	Label string `json:"label,omitempty"`
	// Color is a theme token name (e.g. "prod") or a hex color.
	Color    string `json:"color,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
	// Confirm lists actions that need confirmation (see Actions).
	Confirm []string `json:"confirm,omitempty"`
	// Strict makes confirmations type-to-confirm (the object name).
	Strict bool `json:"strict,omitempty"`
}

// Binding mirrors one keybindings.yaml entry. Command "none" unbinds the
// key; command ids and contexts are validated by the frontend, which owns them.
// Effective.Keybindings has every entry, incomplete ones (reported here) too.
type Binding struct {
	Key     string   `json:"key"`
	Command string   `json:"command"`
	When    []string `json:"when,omitempty"`
}

// Effective is the loaded configuration served to the frontend.
type Effective struct {
	Dir         string    `json:"dir"`
	Config      Config    `json:"config"`
	Keybindings []Binding `json:"keybindings"`
	// Theme maps token names (theme.css without "--color-") to colors.
	Theme  map[string]string `json:"theme"`
	Errors []string          `json:"errors"`
	// Refs are the field reference rules: refs.yaml's before the built-in
	// ones; nil without refs.yaml (see Rules).
	Refs *relations.Rules `json:"-"`
	// Health are the health rules (hide healthy): health.yaml's before the
	// built-in ones; nil without health.yaml (see HealthRules).
	Health *health.Rules `json:"-"`
}

// HealthRules are the health rules in effect.
func (e Effective) HealthRules() *health.Rules {
	if e.Health == nil {
		return health.Default
	}
	return e.Health
}

// Rules are the field reference rules in effect.
func (e Effective) Rules() *relations.Rules {
	if e.Refs == nil {
		return relations.DefaultRules
	}
	return e.Refs
}

// Defaults is the configuration used without any files.
func Defaults(dir string) Effective {
	return Effective{
		Dir:         dir,
		Config:      Config{Font: Font{Size: DefaultFontSize}, Diff: Diff{Ignore: []normalize.Rule{}}, Contexts: []ContextRule{}, Terminal: Terminal{Scrollback: DefaultScrollback}, Logs: Logs{Tail: DefaultLogTail, MaxStreams: DefaultLogStreams, Buffer: DefaultLogBuffer}},
		Keybindings: []Binding{},
		Theme:       map[string]string{},
		Errors:      []string{},
	}
}

// File is the settings file's name (config.yaml), the one ⌘, edits.
const File = "config.yaml"

// KeysFile is the key overrides' file name (keybindings.yaml), the one
// Settings ▸ Keyboard Shortcuts… edits.
const KeysFile = "keybindings.yaml"

// Reference is a config.yaml with every setting, its default (or an
// example) and what it does: the reference shown beside the editor, and
// commented out, the start of a new file (see Starter).
//
// HealthFile holds the user's health rules (hide healthy).
const HealthFile = "health.yaml"

//go:embed reference.yaml
var Reference string

//go:embed themes/*.yaml
var builtinThemes embed.FS

// BuiltinThemes names the themes shipped with kubewing (besides the default), sorted.
func BuiltinThemes() []string {
	entries, _ := builtinThemes.ReadDir("themes")
	var names []string
	for _, e := range entries {
		names = append(names, strings.TrimSuffix(e.Name(), ".yaml"))
	}
	return names
}

// builtinTheme returns a fresh copy of a built-in theme's tokens.
func builtinTheme(name string) (map[string]string, bool) {
	b, err := builtinThemes.ReadFile("themes/" + name + ".yaml")
	if err != nil {
		return nil, false
	}
	var tokens map[string]string
	if err := yaml.UnmarshalStrict(b, &tokens); err != nil {
		panic(fmt.Sprintf("built-in theme %s: %v", name, err))
	}
	return tokens, true
}

// Starter is a new config.yaml: Reference with every setting commented
// out, so it changes nothing; uncommenting a line (⌘/ in the editor)
// brings back the reference's line as it was.
func Starter() string {
	lines := strings.Split(strings.TrimRight(Reference, "\n"), "\n")
	for i, l := range lines {
		if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
			lines[i] = "# " + l
		}
	}
	return "# kubewing settings: uncomment a line (⌘/) to change it, ⌘S saves and applies.\n" + strings.Join(lines, "\n") + "\n"
}

// Check loads dir as if file had text as its content: the problems of that
// file (as Load reports them, without the file name; nil = none) and the
// configuration it would give. The keybindings' command ids and contexts are
// the frontend's to check (see Binding).
func Check(dir, file, text string) ([]string, Effective) {
	e := load(dir, func(f string) ([]byte, error) {
		if f == file {
			return []byte(text), nil
		}
		return os.ReadFile(filepath.Join(dir, f))
	})
	var errs []string
	for _, err := range e.Errors {
		// "config.yaml: …", "keybindings.yaml: [0]: …"
		if rest, ok := strings.CutPrefix(err, file+": "); ok {
			errs = append(errs, rest)
		}
	}
	return errs, e
}

// Load reads dir. dir == "" means no config at all (defaults, no errors).
//
// Unlike Check, it also asks the system whether font.family is installed:
// on load and save only, not on every keystroke of the settings editor.
func Load(dir string) Effective {
	e := load(dir, func(file string) ([]byte, error) { return os.ReadFile(filepath.Join(dir, file)) })
	if missing := missingFonts(e.Config.Font.Family); missing != "" {
		e.Errors = append(e.Errors, File+": font.family: "+missing+", using the default font")
	}
	return e
}

func load(dir string, readFile func(file string) ([]byte, error)) Effective {
	e := Defaults(dir)
	if dir == "" {
		return e
	}
	errf := func(file, format string, args ...any) {
		e.Errors = append(e.Errors, file+": "+fmt.Sprintf(format, args...))
	}
	read := func(file string, v any) bool { return decode(readFile, file, v, errf) }

	var c Config
	if read(File, &c) {
		for i, r := range c.Diff.Ignore {
			if r.Path == "" {
				errf("config.yaml", "diff.ignore[%d]: path is required", i)
				continue
			}
			e.Config.Diff.Ignore = append(e.Config.Diff.Ignore, r)
		}
		for i, r := range c.Contexts {
			if err := validRule(r); err != nil {
				errf("config.yaml", "contexts[%d]: %v", i, err)
				continue
			}
			e.Config.Contexts = append(e.Config.Contexts, r)
		}
		if l := c.Safety.Label; l != "" && !slices.Contains(SafetyLabels, l) {
			errf("config.yaml", "safety.label: unknown %q (known: %v)", l, SafetyLabels)
		} else {
			e.Config.Safety.Label = l
		}
		e.Config.Safety.Frame = c.Safety.Frame
		e.Config.Safety.Chip = c.Safety.Chip
		e.Config.Theme = c.Theme
		if f := c.Font.Family; f != "" && !fontFamily.MatchString(f) {
			errf("config.yaml", "font.family: %q is not a font name or a comma-separated list of them", f)
		} else {
			e.Config.Font.Family = strings.TrimSpace(f)
		}
		switch n := c.Font.Size; {
		case n == 0: // unset: the default
		case n < MinFontSize || n > MaxFontSize:
			errf("config.yaml", "font.size: %d is not between %d and %d px", n, MinFontSize, MaxFontSize)
		default:
			e.Config.Font.Size = n
		}
		e.Config.Font.Ligatures = c.Font.Ligatures
		switch n := c.Terminal.Scrollback; {
		case n == 0: // unset: the default
		case n < MinScrollback || n > MaxScrollback:
			errf("config.yaml", "terminal.scrollback: %d is not between %d and %d lines", n, MinScrollback, MaxScrollback)
		default:
			e.Config.Terminal.Scrollback = n
		}
		e.Config.Terminal.CopyOnSelect = c.Terminal.CopyOnSelect
		for _, f := range []struct {
			name     string
			val      int
			min, max int
			to       *int
		}{
			{"logs.tail", c.Logs.Tail, 1, MaxLogTail, &e.Config.Logs.Tail},
			{"logs.maxStreams", c.Logs.MaxStreams, 1, MaxLogStreams, &e.Config.Logs.MaxStreams},
			{"logs.buffer", c.Logs.Buffer, MinLogBuffer, MaxLogBuffer, &e.Config.Logs.Buffer},
		} {
			switch {
			case f.val == 0: // unset: the default stays
			case f.val < f.min || f.val > f.max:
				errf("config.yaml", "%s: %d is not between %d and %d", f.name, f.val, f.min, f.max)
			default:
				*f.to = f.val
			}
		}
		if _, err := c.History.Parse(); err != nil {
			errf("config.yaml", "%v", err)
		} else {
			e.Config.History = c.History
		}
		if d := c.Update.CheckDays; d != nil && (*d < 0 || *d > MaxUpdateCheckDays) {
			errf("config.yaml", "update.checkDays: %d is not between 0 (off) and %d days", *d, MaxUpdateCheckDays)
			e.Config.Update.Prereleases = c.Update.Prereleases
		} else {
			e.Config.Update = c.Update
		}
		e.Config.OpsPod = c.OpsPod
		e.Config.Launch = c.Launch
		e.Config.FocusFollowsMouse = c.FocusFollowsMouse
		e.Config.Debug.Image = c.Debug.Image
		if p := c.Debug.Profile; p != "" && !slices.Contains(DebugProfiles, p) {
			errf("config.yaml", "debug.profile: unknown profile %q (known: %v)", p, DebugProfiles)
		} else {
			e.Config.Debug.Profile = p
		}
	}

	var bs []Binding
	if read(KeysFile, &bs) {
		// every entry, incomplete ones too: the frontend numbers its problems by position
		// (and skips those reported here)
		for i, b := range bs {
			if b.Key == "" || b.Command == "" {
				errf(KeysFile, "[%d]: key and command are required", i)
			}
		}
		if bs != nil {
			e.Keybindings = bs
		}
	}

	var refs relations.RulesFile
	if read("refs.yaml", &refs) {
		rs, errs := relations.Compile(refs)
		for _, err := range errs {
			errf("refs.yaml", "%v", err)
		}
		e.Refs = rs
	}

	var hf health.RulesFile
	if read(HealthFile, &hf) {
		rs, errs := health.Compile(hf)
		for _, err := range errs {
			errf(HealthFile, "%v", err)
		}
		e.Health = rs
	}

	if t := e.Config.Theme; t != "" && t != "default" {
		file := "themes/" + t + ".yaml"
		builtin, isBuiltin := builtinTheme(t)
		_, statErr := os.Stat(filepath.Join(dir, file))
		missing := errors.Is(statErr, fs.ErrNotExist)
		// a built-in theme first, a file of the same name changes single tokens on top of it
		var tokens map[string]string
		if isBuiltin {
			tokens = builtin
		}
		if missing && !isBuiltin {
			errf("config.yaml", "theme %q: %s not found (built-in: %s)", t, file, strings.Join(BuiltinThemes(), ", "))
		} else if !missing {
			var own map[string]string
			if read(file, &own) {
				if tokens == nil {
					tokens = map[string]string{}
				}
				for k, v := range own {
					tokens[k] = v
				}
			}
		}
		for _, k := range sortedKeys(tokens) {
			switch v := tokens[k]; {
			case !tokenName.MatchString(k):
				errf(file, "%q: not a token name", k)
			case !color.MatchString(v):
				errf(file, "%s: %q is not a color", k, v)
			default:
				e.Theme[k] = v
			}
		}
	}
	return e
}

var (
	tokenName = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	color     = regexp.MustCompile(`^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\([^()]*\))$`)
)

func validRule(r ContextRule) error {
	if r.Match == "" {
		return errors.New("match is required")
	}
	if _, err := path.Match(r.Match, ""); err != nil {
		return fmt.Errorf("match %q: %w", r.Match, err)
	}
	if r.Color != "" && !tokenName.MatchString(r.Color) && !color.MatchString(r.Color) {
		return fmt.Errorf("color %q is neither a theme token nor a color", r.Color)
	}
	for _, a := range r.Confirm {
		if !slices.Contains(Actions, a) {
			return fmt.Errorf("confirm: unknown action %q (known: %v)", a, Actions)
		}
	}
	return nil
}

// decode reads file and decodes it into v. A missing file is not an error
// (returns false). Unknown fields are reported, and the file is then read
// leniently so the known parts still apply.
func decode(readFile func(string) ([]byte, error), file string, v any, errf func(file, format string, args ...any)) bool {
	b, err := readFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return false
	}
	if err != nil {
		errf(file, "%v", err)
		return false
	}
	if err := yaml.UnmarshalStrict(b, v); err == nil {
		return true
	} else if lerr := yaml.Unmarshal(b, v); lerr != nil {
		errf(file, "%v", lerr)
		return false
	} else {
		errf(file, "%v", err)
		return true
	}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
