// Package config loads the user's hand-edited files in ~/.kubewing/
// (config.yaml, keybindings.yaml, themes/*.yaml). kubewing only reads them:
// the one file it writes there is its own history.yaml (see HistoryStore).
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
}

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
var Actions = []string{"delete", "exec", "debug"}

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
		Config:      Config{Diff: Diff{Ignore: []normalize.Rule{}}, Contexts: []ContextRule{}},
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
