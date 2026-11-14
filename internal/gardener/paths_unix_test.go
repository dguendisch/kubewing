//go:build unix

package gardener

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

func TestDefaultPaths(t *testing.T) {
	home, tmp := t.TempDir(), t.TempDir()
	alias := filepath.Join(t.TempDir(), "tmp-link")
	if err := os.Symlink(tmp, alias); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(tmp)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("TMPDIR", alias)
	t.Setenv("UID", "999999") // gardenctl uses the effective uid, not this variable
	t.Setenv("GCTL_HOME", "")
	t.Setenv("GCTL_CONFIG_NAME", "")
	sessions := filepath.Join(resolved, fmt.Sprintf("garden-%d", os.Geteuid()), "sessions")
	for _, c := range []struct{ name, home, config, want string }{
		{"defaults", "", "", filepath.Join(home, ".garden", "gardenctl-v2.yaml")},
		{"home", filepath.Join(home, "custom"), "", filepath.Join(home, "custom", "gardenctl-v2.yaml")},
		{"name", "", "landscape", filepath.Join(home, ".garden", "landscape.yaml")},
		{"both", filepath.Join(home, "custom"), "landscape", filepath.Join(home, "custom", "landscape.yaml")},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("GCTL_HOME", c.home)
			t.Setenv("GCTL_CONFIG_NAME", c.config)
			if got := DefaultPaths(); got != (Paths{Config: c.want, Sessions: sessions}) {
				t.Errorf("DefaultPaths = %+v", got)
			}
		})
	}
	if _, err := os.Stat(filepath.Dir(sessions)); !os.IsNotExist(err) {
		t.Errorf("finding paths creates no state: %v", err)
	}
}

// Reading recent targets and writing a local shell's target use the same
// new location, never the abandoned pre-2.19 directory.
func TestDefaultSessionTargets(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	legacy := filepath.Join(tmp, "garden", "sessions", "old")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(legacy, "target.yaml")
	if err := os.WriteFile(old, []byte("garden: old-garden\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := DefaultPaths()
	sessions, err := PrepareSessions(p.Sessions)
	if err != nil {
		t.Fatal(err)
	}
	if sessions != p.Sessions {
		t.Errorf("prepared path %q, want %q", sessions, p.Sessions)
	}
	for _, dir := range []string{filepath.Dir(sessions), sessions} {
		if info, err := os.Lstat(dir); err != nil || info.Mode().Perm() != 0o700 {
			t.Errorf("directory %s: %v, %v", dir, info, err)
		}
	}
	target := Target{Garden: "new-garden", Project: "p", Shoot: "s", ControlPlane: true}
	id, cleanup, err := NewSession(sessions, target)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	got, err := Sessions(p.Sessions)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !reflect.DeepEqual(got[0].Target, target) {
		t.Errorf("recent targets: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(sessions, id, "target.yaml")); err != nil {
		t.Fatal(err)
	}
	cleanup()
	if _, err := os.Stat(filepath.Join(sessions, id)); !os.IsNotExist(err) {
		t.Errorf("shell cleanup: %v", err)
	}
	if b, err := os.ReadFile(old); err != nil || string(b) != "garden: old-garden\n" {
		t.Errorf("legacy state changed: %q, %v", b, err)
	}
}

func TestPrepareSessionsRejectsUntrustedDirectories(t *testing.T) {
	for _, c := range []struct {
		name  string
		level string
		mode  os.FileMode
		link  bool
	}{
		{"shared root", "root", 0o755, false},
		{"inaccessible root", "root", 0o500, false},
		{"root symlink", "root", 0, true},
		{"shared sessions", "sessions", 0o755, false},
		{"sessions symlink", "sessions", 0, true},
		{"writable parent", "parent", 0o777, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "garden-test")
			sessions := filepath.Join(root, "sessions")
			bad := parent
			if c.level != "parent" {
				bad = root
				if c.level == "sessions" {
					if err := os.Mkdir(root, 0o700); err != nil {
						t.Fatal(err)
					}
					bad = sessions
				}
				if c.link {
					if err := os.Symlink(t.TempDir(), bad); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Mkdir(bad, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if !c.link {
				if err := os.Chmod(bad, c.mode); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(bad, 0o700) })
			}
			if path, err := PrepareSessions(sessions); err == nil || path != "" {
				t.Fatalf("untrusted directory accepted: %q, %v", path, err)
			}
			info, err := os.Lstat(bad)
			if err != nil || (c.link && info.Mode()&os.ModeSymlink == 0) || (!c.link && info.Mode().Perm() != c.mode) {
				t.Errorf("untrusted directory modified: %v, %v", info, err)
			}
			if c.level == "parent" {
				if _, err := os.Stat(root); !os.IsNotExist(err) {
					t.Errorf("created root under an untrusted parent: %v", err)
				}
			}
		})
	}
}

func TestPrepareSessionsResolvesTempSymlink(t *testing.T) {
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o777|os.ModeSticky); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "tmp-link")
	if err := os.Symlink(parent, alias); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(resolved, "garden-test", "sessions")
	if got, err := PrepareSessions(filepath.Join(alias, "garden-test", "sessions")); err != nil || got != want {
		t.Fatalf("resolved sessions = %q, %v; want %q", got, err, want)
	}
	if got, err := PrepareSessions(want); err != nil || got != want {
		t.Errorf("existing private directory = %q, %v", got, err)
	}
}

// Synthetic ownership exercises the attacker-owned-directory checks without
// needing root privileges to chown a real directory.
type sessionDirOwner struct {
	os.FileInfo
	uid uint32
}

func (i sessionDirOwner) Sys() any { return &syscall.Stat_t{Uid: i.uid} }

func TestSessionDirectoryOwnership(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Geteuid())
	for _, private := range []bool{false, true} {
		if err := checkSessionPermissions(dir, sessionDirOwner{FileInfo: info, uid: uid + 1}, private); err == nil {
			t.Errorf("attacker-owned directory accepted (private=%v)", private)
		}
		if err := checkSessionPermissions(dir, sessionDirOwner{FileInfo: info, uid: uid}, private); err != nil {
			t.Errorf("user-owned directory rejected (private=%v): %v", private, err)
		}
	}
	if err := checkSessionPermissions(dir, sessionDirOwner{FileInfo: info, uid: 0}, false); err != nil {
		t.Errorf("root-owned ancestor rejected: %v", err)
	}
	if uid != 0 {
		if err := checkSessionPermissions(dir, sessionDirOwner{FileInfo: info, uid: 0}, true); err == nil {
			t.Error("root-owned private directory accepted for a non-root user")
		}
	}
}
