//go:build unix

package bridge

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/gardener"
)

// A native app is long-lived: a directory checked earlier may have been
// removed and replaced. Both reading recent targets and writing a shell's
// target must recheck it, as gardenctl does when it creates a manager.
func TestGardenctlSessionDirectoryRechecked(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		name := "shared directory"
		if symlink {
			name = "symlink"
		}
		t.Run(name, func(t *testing.T) {
			dir, err := gardener.PrepareSessions(filepath.Join(t.TempDir(), "garden-test", "sessions"))
			if err != nil {
				t.Fatal(err)
			}
			target := gardener.Target{Garden: "g", Project: "p", Shoot: "s"}
			cfg := config.Defaults("")
			svc := New(nil, nil, Options{Config: &cfg, Gardener: &Gardener{
				Paths: gardener.Paths{Sessions: dir}, ShellSessions: dir,
			}})
			svc.opened[openedKey("cluster", "", false)] = target
			id, cleanup := svc.gardenctlSession("cluster", "")
			if _, err := os.Stat(filepath.Join(dir, id, "target.yaml")); err != nil {
				t.Fatal("trusted shell target", err)
			}
			if got := svc.Clusters(); len(got.Errors) != 0 || len(got.Recent) != 1 {
				t.Fatalf("trusted targets: %+v", got)
			}
			cleanup()

			root := filepath.Dir(dir)
			if err := os.Rename(root, root+"-retired"); err != nil {
				t.Fatal(err)
			}
			if symlink {
				if err := os.Symlink(t.TempDir(), root); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(root, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(root, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			planted := filepath.Join(dir, "planted", "target.yaml")
			if err := os.MkdirAll(filepath.Dir(planted), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(planted, []byte("garden: attacker\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := svc.Clusters(); len(got.Errors) == 0 || len(got.Recent) != 0 {
				t.Fatalf("untrusted targets read: %+v", got)
			}
			id, cleanup = svc.gardenctlSession("cluster", "")
			t.Cleanup(cleanup)
			if id == "" {
				t.Fatal("unsafe state must not prevent an independent shell session")
			}
			if _, err := os.Stat(filepath.Join(dir, id, "target.yaml")); !os.IsNotExist(err) {
				t.Fatalf("target written in an untrusted directory: %v", err)
			}
			if entries, err := os.ReadDir(dir); err != nil || len(entries) != 1 || entries[0].Name() != "planted" {
				t.Fatalf("untrusted directory written: %v, %v", entries, err)
			}
		})
	}
}
