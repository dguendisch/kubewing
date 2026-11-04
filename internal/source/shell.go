package source

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Shell implements Actor.
func (o *ClusterOpener) Shell(ctx context.Context, cluster, namespace string, env []string, s ExecStreams) error {
	kubeconfig, cleanup, err := ShellKubeconfig(cluster, namespace)
	if err != nil {
		return err
	}
	defer cleanup()
	return RunShell(ctx, kubeconfig, env, s)
}

// ShellKubeconfig writes a kubeconfig for a local shell on a cluster and
// returns its $KUBECONFIG and a cleanup that removes it. The file is the
// shell's own (0600, in a fresh 0700 directory): its current context is the
// cluster's, with namespace as the context's namespace ("" = the context's
// own). kubectl config use-context/set-context in the shell write there, not
// into the user's kubeconfig.
//
// A kubeconfig of files gets an overlay holding only the context (cluster and
// user are references), in front of the files, so no credentials are copied.
// One built in memory (a Gardener target's) is written whole: it has no files.
func ShellKubeconfig(cluster, namespace string) (env string, cleanup func(), err error) {
	cc, err := clientConfig(cluster)
	if err != nil {
		return "", nil, err
	}
	raw, err := cc.RawConfig()
	if err != nil {
		return "", nil, err
	}
	_, name := SplitCluster(cluster)
	if name == "" {
		name = raw.CurrentContext
	}
	c, ok := raw.Contexts[name]
	if !ok || c == nil {
		return "", nil, fmt.Errorf("kubeconfig has no context %q", name)
	}
	c = c.DeepCopy()
	if namespace != "" {
		c.Namespace = namespace
	}
	_, files, err := Kubeconfig(cluster)
	if err != nil {
		return "", nil, err
	}
	out := clientcmdapi.NewConfig()
	if e, ok := entry(cluster); ok && e.raw != nil {
		out = raw.DeepCopy()
		files = nil
	}
	out.CurrentContext = name
	out.Contexts[name] = c
	dir, err := os.MkdirTemp("", "kubewing-shell-")
	if err != nil {
		return "", nil, err
	}
	cleanup = func() { _ = os.RemoveAll(dir) }
	path := filepath.Join(dir, "kubeconfig")
	if err := clientcmd.WriteToFile(*out, path); err != nil {
		cleanup()
		return "", nil, err
	}
	return strings.Join(append([]string{path}, files...), string(filepath.ListSeparator)), cleanup, nil
}

// shellEnv is kubewing's environment for a local shell: $KUBECONFIG, the
// terminal's identity (xterm.js, not the terminal kubewing was launched
// from), a UTF-8 locale when none is set (launched from the Dock), and env
// ("K=V", e.g. its own $GCTL_SESSION_ID), which replaces what's inherited.
func shellEnv(environ []string, kubeconfig string, env []string) []string {
	out := []string{}
	locale := false
	set := map[string]bool{}
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		set[k] = true
	}
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case set[k], k == "KUBECONFIG", k == "TERM", k == "COLORTERM", strings.HasPrefix(k, "TERM_"), strings.HasPrefix(k, "ITERM_"), strings.HasPrefix(k, "LC_TERMINAL"):
			continue
		case k == "LANG", k == "LC_ALL", k == "LC_CTYPE":
			locale = true
		}
		out = append(out, kv)
	}
	out = append(out, env...)
	out = append(out, "KUBECONFIG="+kubeconfig, "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=kubewing")
	if !locale {
		out = append(out, "LANG=en_US.UTF-8")
	}
	return out
}
