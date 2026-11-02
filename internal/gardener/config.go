// Package gardener picks Gardener clusters the way gardenctl-v2 does: its
// config (~/.garden/gardenctl-v2.yaml: gardens, their kubeconfigs and
// patterns), its pattern matching (dashboard URLs, API hosts, shoot--p--s)
// and its shoot kubeconfigs (gardenlogin), without gardenctl or Gardener's Go
// modules. Lookups in the garden go through kubewing's own connections
// (Lookup), so the garden's login happens once.
package gardener

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/yaml"
)

// Paths are where gardenctl keeps its config and per-terminal sessions.
type Paths struct {
	// Config is gardenctl-v2.yaml.
	Config string
	// Sessions holds a directory per terminal session with its target.yaml; "" = none.
	Sessions string
}

// DefaultPaths are gardenctl's: $GCTL_HOME (else ~/.garden) with
// $GCTL_CONFIG_NAME.yaml (else gardenctl-v2.yaml); sessions in the
// temporary directory, as gardenctl keeps them.
func DefaultPaths() Paths {
	home := os.Getenv("GCTL_HOME")
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = filepath.Join(h, ".garden")
		}
	}
	name := os.Getenv("GCTL_CONFIG_NAME")
	if name == "" {
		name = "gardenctl-v2"
	}
	return Paths{Config: filepath.Join(home, name+".yaml"), Sessions: filepath.Join(os.TempDir(), "garden", "sessions")}
}

// Config is the part of gardenctl-v2.yaml kubewing reads.
type Config struct {
	Gardens []Garden `json:"gardens"`
}

// Garden is a gardenctl garden.
type Garden struct {
	// Identity is the garden's cluster identity, which gardenlogin looks the garden up by.
	Identity string `json:"identity"`
	// Alias is a second name for it (gardenctl's "name").
	Alias string `json:"name,omitempty"`
	// Kubeconfig is the garden's kubeconfig file (~ expanded); Context its context there ("" = current).
	Kubeconfig string   `json:"kubeconfig"`
	Context    string   `json:"context,omitempty"`
	Patterns   []string `json:"patterns,omitempty"`
	// AccessLevels default gardenlogin's --access-level (admin, viewer, auto).
	AccessLevels *AccessLevels `json:"kubeconfigAccessLevelDefaults,omitempty"`
}

// AccessLevels are the default access levels of shoot and seed kubeconfigs.
type AccessLevels struct {
	Shoots string `json:"shoots,omitempty"`
	Seeds  string `json:"seeds,omitempty"`
}

// LoadConfig reads gardenctl's config; a missing file is no gardens.
func LoadConfig(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := yaml.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	for i := range c.Gardens {
		c.Gardens[i].Kubeconfig = expandHome(c.Gardens[i].Kubeconfig)
	}
	return c, nil
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[1:])
		}
	}
	return p
}

// Garden returns a garden by identity, else by alias.
func (c Config) Garden(name string) (Garden, bool) {
	for _, g := range c.Gardens {
		if g.Identity == name {
			return g, true
		}
	}
	for _, g := range c.Gardens {
		if g.Alias != "" && g.Alias == name {
			return g, true
		}
	}
	return Garden{}, false
}

// Server is the API server of the garden's kubeconfig context.
func (g Garden) Server() (string, error) {
	raw, err := clientcmd.LoadFromFile(g.Kubeconfig)
	if err != nil {
		return "", err
	}
	ctx := g.Context
	if ctx == "" {
		ctx = raw.CurrentContext
	}
	if c, ok := raw.Contexts[ctx]; ok && c != nil {
		if cl, ok := raw.Clusters[c.Cluster]; ok && cl != nil {
			return cl.Server, nil
		}
	}
	return "", fmt.Errorf("garden %s: no cluster for context %q in %s", g.Identity, ctx, g.Kubeconfig)
}

// Problem says why a garden can't be used ("" = it can).
func (g Garden) Problem() string {
	if g.Kubeconfig == "" {
		return "no kubeconfig in gardenctl-v2.yaml"
	}
	if _, err := os.Stat(g.Kubeconfig); err != nil {
		return "kubeconfig " + g.Kubeconfig + " not found"
	}
	return ""
}

// Target is a Gardener cluster to open: a garden, a project in it, a shoot,
// a shoot's control plane (on its seed) or a seed.
type Target struct {
	Garden string `json:"garden"`
	// Project or Namespace (its namespace) narrow a garden to a project, and find a shoot.
	Project   string `json:"project,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Shoot     string `json:"shoot,omitempty"`
	// ControlPlane: the shoot's control plane, its namespace on the seed.
	ControlPlane bool `json:"controlPlane,omitempty"`
	// Seed is a seed target without Shoot; a resolved control plane's seed.
	Seed string `json:"seed,omitempty"`
}

// ProjectName is the project, known or guessed from the namespace (a
// project's namespace is garden-<project>, project garden's is garden).
func (t Target) ProjectName() string {
	if t.Project != "" {
		return t.Project
	}
	if t.Namespace == "garden" {
		return "garden"
	}
	return strings.TrimPrefix(t.Namespace, "garden-")
}

// Match returns the targets a value (a dashboard URL, an API server host,
// shoot--p--s …) stands for by the gardens' patterns, as gardenctl matches
// them: the first pattern of a garden that matches, its named groups
// project, namespace, shoot and seed. Where gardenctl refuses a value
// several gardens match, every garden's target is returned. A shoot comes
// twice: itself and its control plane. Pure: nothing is looked up.
func (c Config) Match(value string) ([]Target, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	var out []Target
	var errs []error
	for _, g := range c.Gardens {
		t, ok, err := matchGarden(g, value)
		if err != nil {
			errs = append(errs, err)
		}
		if !ok {
			continue
		}
		if t.Shoot != "" {
			cp := t
			cp.ControlPlane = true
			out = append(out, t, cp)
		} else {
			out = append(out, t)
		}
	}
	return out, errors.Join(errs...)
}

func matchGarden(g Garden, value string) (Target, bool, error) {
	var errs []error
	for _, p := range g.Patterns {
		r, err := regexp.Compile(p)
		if err != nil {
			errs = append(errs, fmt.Errorf("garden %s: pattern %q: %w", g.Identity, p, err))
			continue
		}
		m := r.FindStringSubmatch(value)
		if m == nil {
			continue
		}
		t := Target{Garden: g.Identity}
		for i, name := range r.SubexpNames() {
			switch name {
			case "project":
				t.Project = m[i]
			case "namespace":
				t.Namespace = m[i]
			case "shoot":
				t.Shoot = m[i]
			case "seed":
				t.Seed = m[i]
			}
		}
		return t, true, errors.Join(errs...)
	}
	return Target{}, false, errors.Join(errs...)
}
