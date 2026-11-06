//go:build !windows

package update

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// detach: a session of its own, so the helper outlives the app's exit.
func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// writable: this user may create and rename entries in dir.
func writable(dir string) bool { return unix.Access(dir, unix.W_OK) == nil }
