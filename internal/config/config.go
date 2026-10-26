// Package config loads the user's hand-edited files in ~/.kubewing/
// (config.yaml, keybindings.yaml, themes/*.yaml). kubewing only reads them:
// the files it writes there are its own history.yaml (see HistoryStore) and
// columns.yaml (see ColumnStore).
// Missing files mean defaults;
// invalid parts fall back to defaults and are reported in Effective.Errors,
// so one typo never prevents the app from starting.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"

	"k8s.io/apimachinery/pkg/api/resource"
	"sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/normalize"
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
	// Theme names themes/<name>.yaml; "" or "default" uses the built-in theme.
	Theme string `json:"theme,omitempty"`
	Diff  Diff   `json:"diff"`
	// Contexts are per-context safety rules; the first matching rule wins.
	Contexts []ContextRule `json:"contexts"`
	Debug    Debug         `json:"debug"`
	OpsPod   OpsPod        `json:"opsPod"`
	Terminal Terminal      `json:"terminal"`
	History  HistoryLimits `json:"history"`
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
}

// Scrollback bounds and default (lines).
const (
	DefaultScrollback = 10000
	MinScrollback     = 100
	MaxScrollback     = 1_000_000
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
var Actions = []string{"delete", "exec", "debug", "opspod", "edit"}

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
}

// Defaults is the configuration used without any files.
func Defaults(dir string) Effective {
	return Effective{
		Dir:         dir,
		Config:      Config{Diff: Diff{Ignore: []normalize.Rule{}}, Contexts: []ContextRule{}, Terminal: Terminal{Scrollback: DefaultScrollback}},
		Keybindings: []Binding{},
		Theme:       map[string]string{},
		Errors:      []string{},
	}
}

// Load reads dir. dir == "" means no config at all (defaults, no errors).
func Load(dir string) Effective {
	e := Defaults(dir)
	if dir == "" {
		return e
	}
	errf := func(file, format string, args ...any) {
		e.Errors = append(e.Errors, file+": "+fmt.Sprintf(format, args...))
	}

	var c Config
	if read(dir, "config.yaml", &c, errf) {
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
		e.Config.Theme = c.Theme
		switch n := c.Terminal.Scrollback; {
		case n == 0: // unset: the default
		case n < MinScrollback || n > MaxScrollback:
			errf("config.yaml", "terminal.scrollback: %d is not between %d and %d lines", n, MinScrollback, MaxScrollback)
		default:
			e.Config.Terminal.Scrollback = n
		}
		if _, err := c.History.Parse(); err != nil {
			errf("config.yaml", "%v", err)
		} else {
			e.Config.History = c.History
		}
		e.Config.OpsPod = c.OpsPod
		e.Config.Debug.Image = c.Debug.Image
		if p := c.Debug.Profile; p != "" && !slices.Contains(DebugProfiles, p) {
			errf("config.yaml", "debug.profile: unknown profile %q (known: %v)", p, DebugProfiles)
		} else {
			e.Config.Debug.Profile = p
		}
	}

	var bs []Binding
	if read(dir, "keybindings.yaml", &bs, errf) {
		for i, b := range bs {
			if b.Key == "" || b.Command == "" {
				errf("keybindings.yaml", "[%d]: key and command are required", i)
				continue
			}
			e.Keybindings = append(e.Keybindings, b)
		}
	}

	if t := e.Config.Theme; t != "" && t != "default" {
		file := "themes/" + t + ".yaml"
		var tokens map[string]string
		if _, err := os.Stat(filepath.Join(dir, file)); errors.Is(err, fs.ErrNotExist) {
			errf("config.yaml", "theme %q: %s not found", t, file)
		} else if read(dir, file, &tokens, errf) {
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

// read decodes dir/file into v. A missing file is not an error (returns
// false). Unknown fields are reported, and the file is then read leniently
// so the known parts still apply.
func read(dir, file string, v any, errf func(file, format string, args ...any)) bool {
	b, err := os.ReadFile(filepath.Join(dir, file))
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
