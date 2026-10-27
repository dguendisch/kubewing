package app

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"
)

// detachedEnv marks the process Detach starts, so it never detaches again.
const detachedEnv = "KUBEWING_DETACHED"

// LogFile is where a detached kubewing logs, in the state directory; one
// file for all of them (appended), the previous one kept as LogFile.1 once
// it reaches maxLog.
const LogFile = "kubewing.log"

const maxLog = 10 << 20

// FromTerminal reports whether this process was started from a terminal (and
// not by Detach): its output goes there and the shell waits for it. Output
// redirected or piped (`kubewing 2>&1 | tee`) isn't: that's wanted as it is.
func FromTerminal() bool {
	if os.Getenv(detachedEnv) != "" {
		os.Unsetenv(detachedEnv) // not for exec plugins and the like
		return false
	}
	return term.IsTerminal(int(os.Stdout.Fd())) && term.IsTerminal(int(os.Stderr.Fd()))
}

// Detach starts this kubewing again with the same arguments, working
// directory and environment ($KUBECONFIG), but in a session of its own:
// stdin /dev/null, output appended to logFile ("" = discarded). The caller
// then exits, so the terminal gets its prompt back, and closing that terminal
// doesn't end kubewing (no SIGHUP). On an error nothing was started.
func Detach(logFile string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	out, err := openLog(logFile)
	if err != nil {
		return err
	}
	defer out.Close()
	fmt.Fprintf(out, "--- %s %s\n", time.Now().Format(time.RFC3339), strings.Join(os.Args, " "))
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = append(os.Environ(), detachedEnv+"=1")
	cmd.Stdout, cmd.Stderr = out, out
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func openLog(path string) (*os.File, error) {
	if path == "" {
		return os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	if fi, err := os.Stat(path); err == nil && fi.Size() >= maxLog {
		os.Rename(path, path+".1") // a kubewing still writing there goes on in .1
	}
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
}
