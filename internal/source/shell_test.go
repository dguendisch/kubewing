package source

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// A shell's kubeconfig on files: an overlay of the context alone (no
// credentials copied) in front of the files, current context and namespace
// the pane's; removed by cleanup.
func TestShellKubeconfigOverlay(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "config")
	writeKubeconfig(t, f, "a", "a", "b")
	ref := RegisterKubeconfig([]string{f})
	env, cleanup, err := ShellKubeconfig(ref+"/b", "kube-system")
	if err != nil {
		t.Fatal(err)
	}
	paths := filepath.SplitList(env)
	if len(paths) != 2 || paths[1] != f {
		t.Fatalf("KUBECONFIG %q: want the overlay, then %s", env, f)
	}
	overlay, err := clientcmd.LoadFromFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(overlay.Clusters) != 0 || len(overlay.AuthInfos) != 0 {
		t.Errorf("the overlay copies clusters/users: %+v", overlay)
	}
	if st, _ := os.Stat(paths[0]); st.Mode().Perm() != 0o600 {
		t.Errorf("overlay mode %v", st.Mode().Perm())
	}
	// what kubectl in the shell sees: the files merged, the overlay first
	merged, err := (&clientcmd.ClientConfigLoadingRules{Precedence: paths}).Load()
	if err != nil {
		t.Fatal(err)
	}
	if c := merged.Contexts["b"]; merged.CurrentContext != "b" || c.Namespace != "kube-system" || c.Cluster != "c" || c.AuthInfo != "u" {
		t.Errorf("merged: current %q, context %+v", merged.CurrentContext, c)
	}
	if merged.Contexts["a"].Namespace != "ns-a" {
		t.Errorf("other contexts must stay as they are: %+v", merged.Contexts["a"])
	}
	cleanup()
	if _, err := os.Stat(paths[0]); !os.IsNotExist(err) {
		t.Errorf("cleanup left %s", paths[0])
	}
}

// Without a namespace the context keeps its own; an in-memory kubeconfig
// (a Gardener target's) is written whole, with no files behind it.
func TestShellKubeconfigInMemory(t *testing.T) {
	raw := clientcmdapi.NewConfig()
	raw.Clusters["x"] = &clientcmdapi.Cluster{Server: "https://127.0.0.1:2"}
	raw.AuthInfos["x"] = &clientcmdapi.AuthInfo{Token: "t"}
	raw.Contexts["garden/shoot--p--s"] = &clientcmdapi.Context{Cluster: "x", AuthInfo: "x", Namespace: "own"}
	raw.CurrentContext = "garden/shoot--p--s"
	ref := RegisterConfig("test-shell-in-memory", raw)
	env, cleanup, err := ShellKubeconfig(ref+"/", "")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if strings.Contains(env, string(filepath.ListSeparator)) {
		t.Fatalf("an in-memory kubeconfig has no files: %q", env)
	}
	got, err := clientcmd.LoadFromFile(env)
	if err != nil {
		t.Fatal(err)
	}
	if got.CurrentContext != "garden/shoot--p--s" || got.Contexts[got.CurrentContext].Namespace != "own" || got.AuthInfos["x"].Token != "t" {
		t.Errorf("written: %+v", got)
	}
	if _, _, err := ShellKubeconfig(ref+"/nope", ""); err == nil {
		t.Error("an unknown context must fail")
	}
}

func TestShellEnv(t *testing.T) {
	got := shellEnv([]string{"HOME=/h", "KUBECONFIG=/old", "GCTL_SESSION_ID=theirs", "TERM=screen", "TERM_PROGRAM=iTerm.app", "ITERM_SESSION_ID=1", "LC_TERMINAL=iTerm2", "PATH=/bin"}, "/k", []string{"GCTL_SESSION_ID=own"})
	want := []string{"HOME=/h", "PATH=/bin", "GCTL_SESSION_ID=own", "KUBECONFIG=/k", "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=kubewing", "LANG=en_US.UTF-8"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v\nwant %v", got, want)
	}
	if got := shellEnv([]string{"LANG=de_DE.UTF-8"}, "/k", nil); got[len(got)-1] != "TERM_PROGRAM=kubewing" {
		t.Errorf("a set locale is kept, none added: %v", got)
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// A real PTY: the size arrives, $KUBECONFIG is the shell's, input goes in,
// the exit code comes back.
func TestRunPTY(t *testing.T) {
	needPTY(t)
	inR, inW := io.Pipe()
	resize := make(chan TerminalSize, 1)
	resize <- TerminalSize{Cols: 91, Rows: 17}
	out := &lockedBuf{}
	done := make(chan error, 1)
	go func() {
		done <- runPTY(context.Background(), []string{"/bin/sh"}, shellEnv([]string{"PATH=/bin:/usr/bin", "PS1=$ "}, "/tmp/kc", nil), ExecStreams{Stdin: inR, Stdout: out, Resize: resize})
	}()
	go func() { _, _ = io.WriteString(inW, "stty size; echo kc=$KUBECONFIG; exit 3\n") }()
	select {
	case err := <-done:
		var coded interface{ ExitStatus() int }
		if !asExit(err, &coded) || coded.ExitStatus() != 3 {
			t.Errorf("exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("shell didn't exit; output %q", out.String())
	}
	close(resize)
	if o := out.String(); !strings.Contains(o, "17 91") || !strings.Contains(o, "kc=/tmp/kc") {
		t.Errorf("output %q", o)
	}
}

// Cancelling hangs the shell up, as closing its pane does.
func TestRunPTYCancel(t *testing.T) {
	needPTY(t)
	inR, _ := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runPTY(ctx, []string{"/bin/sh"}, []string{"PATH=/bin:/usr/bin"}, ExecStreams{Stdin: inR, Stdout: io.Discard})
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled shell must end")
	}
}

// needPTY skips where no PTY can be opened (the macOS sandbox denies /dev/ptmx).
func needPTY(t *testing.T) {
	t.Helper()
	p, tty, err := pty.Open()
	if err != nil {
		t.Skipf("no PTY here (%v): run outside the sandbox", err)
	}
	_ = p.Close()
	_ = tty.Close()
}

func asExit(err error, target *interface{ ExitStatus() int }) bool {
	c, ok := err.(interface{ ExitStatus() int })
	if ok {
		*target = c
	}
	return ok
}
