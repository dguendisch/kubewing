//go:build !windows

package source

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// ShellCommand is the local shell: the user's login shell ($SHELL, else
// /bin/zsh), as a login shell like a new Terminal tab, so the profile's PATH
// (kubectl, gardenctl, plugins) is there even when kubewing was launched
// from the Dock.
func ShellCommand() []string {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh"
	}
	return []string{sh, "-l"}
}

// RunShell runs ShellCommand in a PTY with $KUBECONFIG = kubeconfig and env
// ("K=V") added, in the home directory, until it exits or ctx ends (a
// hang-up, as a closed terminal window sends).
func RunShell(ctx context.Context, kubeconfig string, env []string, s ExecStreams) error {
	return runPTY(ctx, ShellCommand(), shellEnv(os.Environ(), kubeconfig, env), s)
}

func runPTY(ctx context.Context, argv, env []string, s ExecStreams) error {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGHUP) }
	cmd.WaitDelay = 2 * time.Second
	var size *pty.Winsize
	select {
	case sz, ok := <-s.Resize:
		if ok {
			size = &pty.Winsize{Cols: sz.Cols, Rows: sz.Rows}
		}
	default:
	}
	tty, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return err
	}
	go func() {
		for sz := range s.Resize {
			_ = pty.Setsize(tty, &pty.Winsize{Cols: sz.Cols, Rows: sz.Rows})
		}
	}()
	go func() { _, _ = io.Copy(tty, s.Stdin) }()
	copied := make(chan struct{})
	go func() {
		_, _ = io.Copy(s.Stdout, tty) // ends with EIO once no process holds the terminal
		close(copied)
	}()
	err = cmd.Wait()
	// the shell's last output; a background job still holding the terminal doesn't keep the
	// session (closing the terminal hangs it up)
	select {
	case <-copied:
	case <-time.After(200 * time.Millisecond):
	}
	_ = tty.Close()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Exited() {
			return exitStatus(ws.ExitStatus())
		}
	}
	return err
}

// exitStatus is a shell's non-zero exit code (the bridge reports ExitStatus).
type exitStatus int

func (e exitStatus) Error() string   { return "exit status " + strconv.Itoa(int(e)) }
func (e exitStatus) ExitStatus() int { return int(e) }
