//go:build !windows

package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The detached child: Detach re-runs the test binary with its arguments, so
// it lands here (with -test.run=TestDetach) and reports itself.
func TestMain(m *testing.M) {
	if os.Getenv(detachedEnv) != "" {
		sid, _ := syscall.Getsid(0)
		fmt.Printf("child pid=%d sid=%d fromTerminal=%v env=%q\n", os.Getpid(), sid, FromTerminal(), os.Getenv(detachedEnv))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// The child runs in a session of its own, logs to the file, and knows it was detached.
func TestDetach(t *testing.T) {
	log := filepath.Join(t.TempDir(), "state", LogFile)
	if err := Detach(log); err != nil {
		t.Fatal(err)
	}
	var out string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		b, _ := os.ReadFile(log)
		if out = string(b); strings.Contains(out, "child ") {
			break
		}
	}
	if !strings.HasPrefix(out, "--- ") {
		t.Fatalf("no launch header: %q", out)
	}
	var pid, sid int
	var fromTerminal bool
	var env string
	line := out[strings.Index(out, "child "):]
	if _, err := fmt.Sscanf(line, "child pid=%d sid=%d fromTerminal=%t env=%q", &pid, &sid, &fromTerminal, &env); err != nil {
		t.Fatalf("%v: %q", err, out)
	}
	if mine, _ := syscall.Getsid(0); sid != pid || sid == mine {
		t.Errorf("child session %d (pid %d), mine %d: want a session of its own", sid, pid, mine)
	}
	if fromTerminal || env != "" {
		t.Errorf("child: fromTerminal=%v, %s=%q; want false and unset", fromTerminal, detachedEnv, env)
	}
}

// A full log moves to .1; the new one starts empty.
func TestOpenLogRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), LogFile)
	if err := os.WriteFile(path, make([]byte, maxLog), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := openLog(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if fi, err := os.Stat(path); err != nil || fi.Size() != 0 {
		t.Errorf("new log: %v, %v", fi, err)
	}
	if fi, err := os.Stat(path + ".1"); err != nil || fi.Size() != maxLog {
		t.Errorf("rotated log: %v, %v", fi, err)
	}
}

// locked: a held flock counts, a free or missing lock file doesn't (and stays free).
func TestLocked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	if locked(path) {
		t.Error("missing file: want not locked")
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if locked(path) {
		t.Error("unlocked file: want not locked")
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("probe left the lock taken: %v", err)
	}
	if !locked(path) {
		t.Error("held lock: want locked")
	}
}
