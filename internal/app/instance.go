package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/dguendisch/kubewing/internal/bridge"
	"github.com/dguendisch/kubewing/internal/source"
)

// LaunchEvent tells the frontend to open a tab for a later launch: a Launch.
const LaunchEvent = "kw:launch"

// Launch is where a tab opened by a later launch starts: that terminal's
// kubeconfig ($KUBECONFIG, else ~/.kube/config), at its current context and
// the namespace that sets.
type Launch struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace,omitempty"`
	// Error: the terminal's kubeconfig can't be read; the tab opens on Cluster all the same.
	Error string `json:"error,omitempty"`
}

// Keys of SecondInstanceData.AdditionalData.
const (
	launchKubeconfig = "kubeconfig"
	launchSet        = "kubeconfigSet" // "1": $KUBECONFIG is set (maybe to ""), else ~/.kube/config
)

// SingleInstance makes a later launch on the same config directory hand over
// to this process and exit: open gets a tab on that launch's kubeconfig
// instead of a second process starting with its own watches and windows. A
// launch with another config directory (-config, $KUBEWING_HOME) is a
// kubewing of its own and starts as before.
//
// The launch only sends its $KUBECONFIG and directory, never kubeconfig
// content; this process reads the files. Other users' and sandboxed apps can
// post the notification too, so it's encrypted with a key only this user can
// read (instance.key in the config directory): a forged one is dropped and
// can't make kubewing read a kubeconfig (exec plugins run commands).
func SingleInstance(configDir string, open func(Launch)) (*application.SingleInstanceOptions, error) {
	key, err := instanceKey(configDir)
	if err != nil {
		return nil, err
	}
	env, set := os.LookupEnv("KUBECONFIG")
	extra := map[string]string{launchKubeconfig: env}
	if set {
		extra[launchSet] = "1"
	}
	return &application.SingleInstanceOptions{
		UniqueID:       InstanceID(configDir),
		EncryptionKey:  key,
		AdditionalData: extra,
		OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
			open(ResolveLaunch(d.AdditionalData[launchKubeconfig], d.AdditionalData[launchSet] == "1", d.WorkingDir))
		},
	}, nil
}

// ResolveLaunch registers the kubeconfig of a launch with $KUBECONFIG = env
// (set: also when empty) in directory dir and returns where its tab starts.
func ResolveLaunch(env string, set bool, dir string) Launch {
	files := source.KubeconfigFiles(env, dir)
	if set && env == "" {
		files = source.KubeconfigFiles("", dir) // kubectl too: an empty $KUBECONFIG is ~/.kube/config
	}
	ref := source.RegisterKubeconfig(files)
	cluster := source.JoinCluster(ref, "")
	names, cur, ns, err := source.Contexts(cluster)
	if err != nil {
		return Launch{Cluster: cluster, Error: err.Error()}
	}
	if len(names) == 0 {
		// client-go reads missing files as empty
		return Launch{Cluster: cluster, Error: fmt.Sprintf("no contexts in %s", strings.Join(files, string(filepath.ListSeparator)))}
	}
	if cur == "" {
		return Launch{Cluster: cluster}
	}
	// by name: the terminal may switch contexts later, the tab stays on this one
	return Launch{Cluster: source.JoinCluster(ref, cur), Namespace: ns[cur]}
}

// InstanceID names the lock file and the notification of the kubewing running
// on configDir; a hash, since both are file and notification names.
func InstanceID(configDir string) string {
	if abs, err := filepath.Abs(configDir); err == nil && configDir != "" {
		configDir = abs
	}
	sum := sha256.Sum256([]byte(filepath.Clean(configDir)))
	return "io.github.dguendisch.kubewing." + hex.EncodeToString(sum[:8])
}

// KeyFile holds the key launches on a config directory share (0600).
const KeyFile = "instance.key"

// instanceKey reads configDir's launch key, creating it on first use. Without
// a config directory there's no place only this user can read: an error.
func instanceKey(configDir string) ([32]byte, error) {
	var key [32]byte
	if configDir == "" {
		return key, errors.New("no config directory for the instance key")
	}
	path := filepath.Join(configDir, KeyFile)
	if b, err := os.ReadFile(path); err == nil {
		if n, err := hex.Decode(key[:], b); err == nil && n == len(key) {
			return key, nil
		}
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return key, err
	}
	rand.Read(key[:])
	tmp, err := os.CreateTemp(configDir, "."+KeyFile+"-*")
	if err != nil {
		return key, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(hex.EncodeToString(key[:])); err != nil {
		tmp.Close()
		return key, err
	}
	if err := tmp.Close(); err != nil {
		return key, err
	}
	// first writer wins: two first launches at once must agree on the key
	if err := os.Link(tmp.Name(), path); err != nil {
		if b, rerr := os.ReadFile(path); rerr == nil {
			if n, derr := hex.Decode(key[:], b); derr == nil && n == len(key) {
				return key, nil
			}
		}
		if err := os.Rename(tmp.Name(), path); err != nil {
			return key, err
		}
	}
	return key, nil
}

// BringToFront shows w over other apps' windows, also when kubewing is hidden
// (⌘H) or w minimised; a maximised or fullscreen window stays so. Safe off the
// main thread (Wails calls OnSecondInstanceLaunch from a goroutine).
func BringToFront(a *application.App, w *application.WebviewWindow) {
	application.InvokeSync(a.Show) // AppKit: main thread only; Focus and UnMinimise dispatch themselves
	w.UnMinimise()
	w.Focus()
}

// KubeContexts lists the contexts of a cluster's kubeconfig ("" = kubewing's own).
func KubeContexts(cluster string) (bridge.ContextList, error) {
	ref, _ := source.SplitCluster(cluster)
	names, cur, ns, err := source.Contexts(source.JoinCluster(ref, ""))
	if err != nil {
		return bridge.ContextList{}, err
	}
	if ref == "" {
		return bridge.ContextList{Contexts: names, Current: cur, Namespaces: ns}, nil
	}
	// as clusters of that kubeconfig, so a pick stays in it
	list := bridge.ContextList{Contexts: make([]string, len(names)), Current: source.JoinCluster(ref, cur), Namespaces: map[string]string{}}
	for i, n := range names {
		list.Contexts[i] = source.JoinCluster(ref, n)
	}
	for n, v := range ns {
		list.Namespaces[source.JoinCluster(ref, n)] = v
	}
	_, files, _ := source.Kubeconfig(cluster)
	list.Kubeconfig = files
	return list, nil
}
