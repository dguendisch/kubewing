package source

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// A cluster names a kubeconfig context. A plain name ("dev"; "" for the
// current context) is one of kubewing's own kubeconfig ($KUBECONFIG, else
// ~/.kube/config, read anew each time as kubectl does). "@1/dev" is one of
// another kubeconfig, registered while kubewing runs (a terminal with its own
// $KUBECONFIG launched kubewing again, a file or Gardener target picked in
// the clusters dialog), "@1/" its current context. The references are
// process-local: another kubewing doesn't know them.
var kubeconfigs struct {
	mu      sync.Mutex
	entries []kubeconfigEntry // entries[i] is "@i+1"
}

// kubeconfigEntry is a registered kubeconfig: files read anew each time, or
// one built in memory (a Gardener target's), known by its key.
type kubeconfigEntry struct {
	files []string
	key   string
	raw   *clientcmdapi.Config
}

// KubeconfigFiles lists the files kubectl reads with $KUBECONFIG = env in
// directory dir: env's entries, absolute and without repeats, else
// ~/.kube/config.
func KubeconfigFiles(env, dir string) []string {
	if env == "" {
		return []string{clientcmd.RecommendedHomeFile}
	}
	out := []string{}
	for _, f := range filepath.SplitList(env) {
		if f == "" {
			continue
		}
		if !filepath.IsAbs(f) {
			f = filepath.Join(dir, f)
		}
		if f = filepath.Clean(f); !slices.Contains(out, f) {
			out = append(out, f)
		}
	}
	return out
}

func ownKubeconfig() []string {
	wd, _ := os.Getwd()
	return KubeconfigFiles(os.Getenv(clientcmd.RecommendedConfigPathEnvVar), wd)
}

// RegisterKubeconfig returns the reference of the kubeconfig made of files:
// "" for kubewing's own, else "@n", the same n for the same files.
func RegisterKubeconfig(files []string) string {
	if slices.Equal(files, ownKubeconfig()) {
		return ""
	}
	kubeconfigs.mu.Lock()
	defer kubeconfigs.mu.Unlock()
	i := slices.IndexFunc(kubeconfigs.entries, func(e kubeconfigEntry) bool { return e.raw == nil && slices.Equal(e.files, files) })
	if i < 0 {
		kubeconfigs.entries = append(kubeconfigs.entries, kubeconfigEntry{files: slices.Clone(files)})
		i = len(kubeconfigs.entries) - 1
	}
	return "@" + strconv.Itoa(i+1)
}

// RegisterConfig returns the reference of a kubeconfig built in memory,
// known by key: the same "@n" for the same key, its config replaced by raw
// (a target picked again gets fresh addresses and CA, its open connections
// stay as they are until a reconnect).
func RegisterConfig(key string, raw *clientcmdapi.Config) string {
	kubeconfigs.mu.Lock()
	defer kubeconfigs.mu.Unlock()
	i := slices.IndexFunc(kubeconfigs.entries, func(e kubeconfigEntry) bool { return e.raw != nil && e.key == key })
	if i < 0 {
		kubeconfigs.entries = append(kubeconfigs.entries, kubeconfigEntry{key: key})
		i = len(kubeconfigs.entries) - 1
	}
	kubeconfigs.entries[i].raw = raw.DeepCopy()
	return "@" + strconv.Itoa(i+1)
}

// ConfigKey returns the key of a cluster's in-memory kubeconfig ("" for
// one of files, or kubewing's own).
func ConfigKey(cluster string) string {
	e, ok := entry(cluster)
	if !ok || e.raw == nil {
		return ""
	}
	return e.key
}

func entry(cluster string) (kubeconfigEntry, bool) {
	ref, _ := SplitCluster(cluster)
	if ref == "" {
		return kubeconfigEntry{}, false
	}
	n, _ := strconv.Atoi(ref[1:])
	kubeconfigs.mu.Lock()
	defer kubeconfigs.mu.Unlock()
	if n < 1 || n > len(kubeconfigs.entries) {
		return kubeconfigEntry{}, false
	}
	return kubeconfigs.entries[n-1], true
}

// SplitCluster returns a cluster's kubeconfig reference ("" = kubewing's
// own) and context name ("" = that kubeconfig's current context).
func SplitCluster(cluster string) (kubeconfig, context string) {
	if ref, ctx, ok := strings.Cut(cluster, "/"); ok && len(ref) > 1 && ref[0] == '@' {
		if _, err := strconv.Atoi(ref[1:]); err == nil {
			return ref, ctx
		}
	}
	return "", cluster
}

// JoinCluster is the cluster of a context in a kubeconfig (see SplitCluster).
func JoinCluster(kubeconfig, context string) string {
	if kubeconfig == "" {
		return context
	}
	return kubeconfig + "/" + context
}

// Kubeconfig returns the files of a cluster's kubeconfig (none for one built
// in memory).
func Kubeconfig(cluster string) (ref string, files []string, err error) {
	ref, _ = SplitCluster(cluster)
	if ref == "" {
		return "", ownKubeconfig(), nil
	}
	e, ok := entry(cluster)
	if !ok {
		return ref, nil, fmt.Errorf("unknown kubeconfig %s", ref)
	}
	return ref, slices.Clone(e.files), nil
}

// clientConfig loads a cluster's kubeconfig with its context as the current one.
func clientConfig(cluster string) (clientcmd.ClientConfig, error) {
	ref, ctx := SplitCluster(cluster)
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if ref != "" {
		e, ok := entry(cluster)
		if !ok {
			return nil, fmt.Errorf("unknown kubeconfig %s", ref)
		}
		if e.raw != nil {
			if ctx == "" {
				ctx = e.raw.CurrentContext
			}
			return clientcmd.NewNonInteractiveClientConfig(*e.raw, ctx, &clientcmd.ConfigOverrides{}, nil), nil
		}
		rules = &clientcmd.ClientConfigLoadingRules{Precedence: e.files, WarnIfAllMissing: true}
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{CurrentContext: ctx}), nil
}
