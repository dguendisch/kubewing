// Session-directory logic mirrors gardenctl's internal/util (v2.19.1):
// factory.go (DefaultGardenTempDir, FactoryImpl.Manager), privatedir*.go
// (EnsurePrivateDir, checkPrivate, checkTrustedParents).
// https://github.com/gardener/gardenctl-v2/tree/v2.19.1/internal/util
// Kept local because internal packages cannot be imported; keep in sync.
package gardener

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"

	"sigs.k8s.io/yaml"
)

// PrepareSessions creates gardenctl's private temporary root and sessions
// directory, resolving parent symlinks as gardenctl does. Untrusted
// existing directories are rejected, never repaired. dir "" = no sessions.
func PrepareSessions(dir string) (string, error) {
	if dir == "" {
		return "", nil
	}
	root, err := preparePrivateDir(filepath.Dir(dir))
	if err != nil {
		return "", err
	}
	return preparePrivateDir(filepath.Join(root, filepath.Base(dir)))
}

func preparePrivateDir(dir string) (string, error) {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	// A private root is only trustworthy if another user cannot replace it
	// or one of its ancestors (a root/user-owned sticky directory is safe).
	for p := parent; ; p = filepath.Dir(p) {
		if err := checkSessionDirectory(p, false); err != nil {
			return "", err
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	dir = filepath.Join(parent, filepath.Base(absolute))
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	if err := checkSessionDirectory(dir, true); err != nil {
		return "", err
	}
	return dir, nil
}

func checkSessionDirectory(dir string, private bool) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("refusing gardenctl directory %s: not a directory (or a symlink)", dir)
	}
	return checkSessionPermissions(dir, info, private)
}

// SessionTarget is the target of a gardenctl session (a terminal), as of
// when it was last set.
type SessionTarget struct {
	Target
	Set time.Time
}

// Sessions reads the targets of gardenctl's sessions (dir/<session>/target.yaml),
// the latest first, without repeats. Targets kubewing can't open (no
// garden) are left out. The directory is validated before every read.
func Sessions(dir string) ([]SessionTarget, error) {
	if dir == "" {
		return nil, nil
	}
	dir, err := PrepareSessions(dir)
	if err != nil {
		return nil, err
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
	}), nil
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
// only the id. The directory is validated before every use.
func NewSession(dir string, t Target) (id string, cleanup func(), err error) {
	id = "kubewing-" + rand.Text()
	cleanup = func() {}
	if dir == "" {
		return id, cleanup, nil
	}
	dir, err = PrepareSessions(dir)
	if err != nil {
		return "", nil, err
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
