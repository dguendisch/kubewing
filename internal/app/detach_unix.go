//go:build !windows

package app

import (
	"os"
	"syscall"
)

// a session of its own: no controlling terminal, so no SIGHUP when it closes
func detachAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// locked: someone holds an flock on path. A free lock is taken and released
// at once, before Wails takes it for this process.
func locked(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false // never created: nobody runs
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}
