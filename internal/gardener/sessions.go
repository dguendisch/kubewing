package gardener

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"slices"
	"time"

	"sigs.k8s.io/yaml"
)

// SessionTarget is the target of a gardenctl session (a terminal), as of
// when it was last set.
type SessionTarget struct {
	Target
	Set time.Time
}

// Sessions reads the targets of gardenctl's sessions (dir/<session>/target.yaml),
// the latest first, without repeats. Targets kubewing can't open (no
// garden) are left out.
func Sessions(dir string) []SessionTarget {
	if dir == "" {
		return nil
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*", "target.yaml"))
	var out []SessionTarget
	for _, f := range files {
		fi, err := os.Stat(f)
		if err != nil {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var t Target
		if yaml.Unmarshal(b, &t) != nil || t.Garden == "" {
			continue
		}
		// gardenctl notes a shoot's seed too; kubewing finds it again
		if t.Shoot != "" {
			t.Seed = ""
		}
		out = append(out, SessionTarget{Target: t, Set: fi.ModTime()})
	}
	slices.SortStableFunc(out, func(a, b SessionTarget) int { return b.Set.Compare(a.Set) })
	seen := map[Target]bool{}
	return slices.DeleteFunc(out, func(s SessionTarget) bool {
		if seen[s.Target] {
			return true
		}
		seen[s.Target] = true
		return false
	})
}

// sessionTarget is gardenctl's target.yaml.
type sessionTarget struct {
	Garden       string `json:"garden,omitempty"`
	Project      string `json:"project,omitempty"`
	Seed         string `json:"seed,omitempty"`
	Shoot        string `json:"shoot,omitempty"`
	ControlPlane bool   `json:"controlPlane,omitempty"`
}

// NewSession is a gardenctl session of its own for a local shell: a fresh
// id (the shell's $GCTL_SESSION_ID), with target t written to
// dir/<id>/target.yaml as `gardenctl target` writes it (t.Garden "" = no
// target). The cleanup removes the session directory, also what gardenctl
// put there (its kubeconfigs). dir "" = gardenctl's sessions are unknown:
// only the id.
func NewSession(dir string, t Target) (id string, cleanup func(), err error) {
	id = "kubewing-" + rand.Text()
	cleanup = func() {}
	if dir == "" {
		return id, cleanup, nil
	}
	sd := filepath.Join(dir, id)
	cleanup = func() { _ = os.RemoveAll(sd) }
	if t.Garden == "" {
		return id, cleanup, nil
	}
	st := sessionTarget{Garden: t.Garden, Shoot: t.Shoot, ControlPlane: t.ControlPlane && t.Shoot != "", Seed: t.Seed}
	if t.Shoot != "" || t.Seed == "" {
		// gardenctl refuses a project with a seed but no shoot
		st.Project = t.ProjectName()
	}
	b, err := yaml.Marshal(st)
	if err != nil {
		return "", nil, err
	}
	if err := os.MkdirAll(sd, 0o700); err != nil {
		return "", nil, err
	}
	if err := os.WriteFile(filepath.Join(sd, "target.yaml"), b, 0o600); err != nil {
		cleanup()
		return "", nil, err
	}
	return id, cleanup, nil
}
