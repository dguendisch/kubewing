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
)

// A cluster names a kubeconfig context. A plain name ("dev"; "" for the
// current context) is one of kubewing's own kubeconfig ($KUBECONFIG, else
// ~/.kube/config, read anew each time as kubectl does). "@1/dev" is one of
// another kubeconfig, registered while kubewing runs (a terminal with its own
// $KUBECONFIG launched kubewing again), "@1/" its current context. The
// references are process-local: another kubewing doesn't know them.
var kubeconfigs struct {
	mu    sync.Mutex
	files [][]string // files[i] is "@i+1"
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
	i := slices.IndexFunc(kubeconfigs.files, func(f []string) bool { return slices.Equal(f, files) })
	if i < 0 {
		kubeconfigs.files = append(kubeconfigs.files, slices.Clone(files))
		i = len(kubeconfigs.files) - 1
	}
	return "@" + strconv.Itoa(i+1)
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

// Kubeconfig returns the files of a cluster's kubeconfig.
func Kubeconfig(cluster string) (ref string, files []string, err error) {
	ref, _ = SplitCluster(cluster)
	if ref == "" {
		return "", ownKubeconfig(), nil
	}
	n, _ := strconv.Atoi(ref[1:])
	kubeconfigs.mu.Lock()
	defer kubeconfigs.mu.Unlock()
	if n < 1 || n > len(kubeconfigs.files) {
		return ref, nil, fmt.Errorf("unknown kubeconfig %s", ref)
	}
	return ref, slices.Clone(kubeconfigs.files[n-1]), nil
}

// clientConfig loads a cluster's kubeconfig with its context as the current one.
func clientConfig(cluster string) (clientcmd.ClientConfig, error) {
	ref, ctx := SplitCluster(cluster)
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if ref != "" {
		_, files, err := Kubeconfig(cluster)
		if err != nil {
			return nil, err
		}
		rules = &clientcmd.ClientConfigLoadingRules{Precedence: files, WarnIfAllMissing: true}
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{CurrentContext: ctx}), nil
}
