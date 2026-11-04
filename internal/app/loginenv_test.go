//go:build !windows

package app

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParseLoginEnv(t *testing.T) {
	out := "Last login: today\nwelcome\n" + envMarker + "PATH=/opt/bin:/usr/bin\x00MULTI=a\nb\x00PWD=/x\x00SHLVL=2\x00_=/usr/bin/env\x00EMPTY=\x00" + envMarker + "bye\n"
	env, err := parseLoginEnv([]byte(out))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"PATH=/opt/bin:/usr/bin", "MULTI=a\nb", "EMPTY="}
	if !slices.Equal(env, want) {
		t.Fatalf("env = %q, want %q", env, want)
	}
	for _, bad := range []string{"", "no markers", envMarker + "PATH=/x", envMarker + envMarker} {
		if _, err := parseLoginEnv([]byte(bad)); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

// A real shell: its profile's PATH and variables come through, its chatter doesn't.
func TestLoginShellEnv(t *testing.T) {
	home := t.TempDir()
	// sh -l reads $ENV as the interactive startup file (and the profile when a login shell)
	rc := filepath.Join(home, "rc")
	if err := os.WriteFile(rc, []byte("echo hello from rc\nexport PATH=/plugins/bin:$PATH\nexport KW_TEST='x y'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ENV", rc)
	t.Setenv("HOME", home)
	env, err := loginShellEnv("/bin/sh", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var path string
	for _, kv := range env {
		if p, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = p
		}
	}
	if !strings.HasPrefix(path, "/plugins/bin:") {
		t.Errorf("PATH = %q, want the rc file's", path)
	}
	if !slices.Contains(env, "KW_TEST=x y") {
		t.Errorf("KW_TEST missing in %q", env)
	}
}

func TestLoginShellEnvTimeout(t *testing.T) {
	rc := filepath.Join(t.TempDir(), "rc")
	if err := os.WriteFile(rc, []byte("sleep 30\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ENV", rc)
	start := time.Now()
	if _, err := loginShellEnv("/bin/sh", 300*time.Millisecond); err == nil {
		t.Fatal("no error")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("took %v", d)
	}
}
