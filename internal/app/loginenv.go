package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// envMarker brackets the environment in the login shell's output, so whatever
// its profile prints (a banner, a motd) isn't taken for variables.
const envMarker = "__kubewing_env_7f3a__"

// loginEnvTimeout bounds the login shell: a profile that waits for input or
// the network must not keep the window from opening.
const loginEnvTimeout = 10 * time.Second

// LoginEnv makes a kubewing started by launchd (the Dock, Finder, `open`) see
// the environment a terminal would give it: launchd's is minimal (PATH
// /usr/bin:/bin:/usr/sbin:/sbin), so exec credential plugins like kubectl or
// kubectl-gardenlogin, which client-go looks up on kubewing's PATH, aren't
// found, and $KUBECONFIG, $GCTL_HOME or $KUBEWING_HOME are missing. It asks
// the user's login shell, interactive like a new Terminal tab (so .zshrc
// counts too), for its environment and adopts it. Started from a terminal (or
// detached from one) the environment is the terminal's already, and nothing
// happens. Call it first, before anything reads the environment.
func LoginEnv() error {
	if !launchedByLaunchd() {
		return nil
	}
	env, err := loginShellEnv(loginShell(), loginEnvTimeout)
	if err != nil {
		return err
	}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		_ = os.Setenv(k, v)
	}
	return nil
}

// launchedByLaunchd: the parent is launchd (pid 1) and this isn't the
// process Detach started, which ends up as launchd's child too once the
// terminal's kubewing exits, but has the terminal's environment.
func launchedByLaunchd() bool {
	return os.Getppid() == 1 && os.Getenv(detachedEnv) == ""
}

func loginShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/zsh"
}

// loginShellEnv runs shell as an interactive login shell and returns its
// environment as KEY=value, without the variables that only describe that
// shell (PWD, SHLVL, ...).
func loginShellEnv(shell string, timeout time.Duration) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// `command env`: not an alias or function of that name; -0: values may hold newlines
	script := "printf '%s' " + envMarker + "; command env -0; printf '%s' " + envMarker
	cmd := exec.CommandContext(ctx, shell, "-i", "-l", "-c", script)
	cmd.Stdin = nil // /dev/null: a profile asking for input gets EOF
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, errors.New(shell + ": no environment within " + timeout.String())
	}
	env, perr := parseLoginEnv(out)
	if perr != nil {
		if err != nil {
			return nil, errors.New(shell + ": " + err.Error())
		}
		return nil, errors.New(shell + ": " + perr.Error())
	}
	// a non-zero exit (some rc file's last command failed) with the environment printed is fine
	return env, nil
}

// skipLoginEnv: the shell's own state, not the user's environment.
var skipLoginEnv = map[string]bool{"PWD": true, "OLDPWD": true, "SHLVL": true, "_": true}

func parseLoginEnv(out []byte) ([]string, error) {
	_, rest, ok := bytes.Cut(out, []byte(envMarker))
	if !ok {
		return nil, errors.New("printed no environment")
	}
	body, _, ok := bytes.Cut(rest, []byte(envMarker))
	if !ok {
		return nil, errors.New("printed no environment")
	}
	var env []string
	for _, kv := range strings.Split(string(body), "\x00") {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" || skipLoginEnv[k] {
			continue
		}
		env = append(env, kv)
	}
	if len(env) == 0 {
		return nil, errors.New("printed an empty environment")
	}
	return env, nil
}
