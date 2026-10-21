package bridge

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
)

// NodeInfo is one node, for the ops pod dialog's completion.
type NodeInfo struct {
	Name string `json:"name"`
	// Ready is the Ready condition's status (True, False, Unknown; "" = not reported).
	Ready string `json:"ready,omitempty"`
	// Unschedulable: cordoned (the ops pod still lands there: it's bound, not scheduled).
	Unschedulable bool `json:"unschedulable,omitempty"`
	// Pool is the worker pool (Gardener's worker.gardener.cloud/pool label).
	Pool string `json:"pool,omitempty"`
	Zone string `json:"zone,omitempty"`
}

// NodeList answers the ops pod dialog: a context's nodes, from the shared
// nodes watch (so an open nodes pane's data, no extra list call).
type NodeList struct {
	Context string     `json:"context"`
	Nodes   []NodeInfo `json:"nodes"`
	// Loading: the watch hasn't listed yet; ask again.
	Loading bool   `json:"loading,omitempty"`
	Error   string `json:"error,omitempty"`
}

// nodesLease is how long a node watch the dialog started outlives the last
// Nodes call: the dialog polls while open, so it stays live while needed.
const nodesLease = 30 * time.Second

// nodeWatch is a subscription to a context's shared nodes watch, kept up
// to date from its events.
type nodeWatch struct {
	sub *source.Subscription

	mu     sync.Mutex
	items  map[string]*unstructured.Unstructured
	synced bool
	err    string
	used   time.Time
}

// Nodes lists the nodes of a context ("" = current). The first call
// subscribes to the shared nodes watch, which an open nodes pane may
// already run; it's released again after nodesLease without calls.
func (s *Service) Nodes(cluster string) NodeList {
	w, err := s.nodeWatch(cluster)
	name, _ := s.contextName(cluster)
	if err != nil {
		return NodeList{Context: name, Nodes: []NodeInfo{}, Error: err.Error()}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.used = s.opts.Clock.Now()
	out := NodeList{Context: name, Nodes: []NodeInfo{}, Loading: !w.synced && w.err == "", Error: w.err}
	for _, n := range w.items {
		out.Nodes = append(out.Nodes, nodeInfo(n))
	}
	sort.Slice(out.Nodes, func(i, j int) bool { return out.Nodes[i].Name < out.Nodes[j].Name })
	return out
}

func (s *Service) nodeWatch(cluster string) (*nodeWatch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if w, ok := s.nodes[cluster]; ok {
		return w, nil
	}
	sub, err := s.reg.Subscribe(source.Key{Cluster: cluster, Resource: "nodes"})
	if err != nil {
		return nil, err
	}
	w := &nodeWatch{sub: sub, items: map[string]*unstructured.Unstructured{}, used: s.opts.Clock.Now()}
	s.nodes[cluster] = w
	go s.runNodeWatch(cluster, w)
	return w, nil
}

func (s *Service) runNodeWatch(cluster string, w *nodeWatch) {
	idle := time.NewTicker(nodesLease / 3)
	defer idle.Stop()
	for {
		select {
		case ev, ok := <-w.sub.Events:
			if !ok {
				return
			}
			w.mu.Lock()
			switch ev.Type {
			case source.Relist:
				w.items = make(map[string]*unstructured.Unstructured, len(ev.Items))
				for _, it := range ev.Items {
					w.items[it.Object.GetName()] = it.Object
				}
				w.synced, w.err = true, ""
			case source.Added, source.Modified:
				w.items[ev.Item.Object.GetName()] = ev.Item.Object
			case source.Deleted:
				delete(w.items, ev.Item.Object.GetName())
			case source.Error:
				w.err = ev.Err
			}
			w.mu.Unlock()
		case <-idle.C:
			w.mu.Lock()
			stale := s.opts.Clock.Now().Sub(w.used) > nodesLease
			w.mu.Unlock()
			if stale {
				s.dropNodeWatch(cluster, w)
				return
			}
		}
	}
}

func (s *Service) dropNodeWatch(cluster string, w *nodeWatch) {
	s.mu.Lock()
	if s.nodes[cluster] == w {
		delete(s.nodes, cluster)
	}
	s.mu.Unlock()
	w.sub.Close()
}

// node returns a watched node by name.
func (w *nodeWatch) node(name string) (*unstructured.Unstructured, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n, ok := w.items[name]
	return n, ok
}

func nodeInfo(n *unstructured.Unstructured) NodeInfo {
	info := NodeInfo{Name: n.GetName()}
	info.Unschedulable, _, _ = unstructured.NestedBool(n.Object, "spec", "unschedulable")
	conds, _, _ := unstructured.NestedSlice(n.Object, "status", "conditions")
	for _, c := range conds {
		if t, _, _ := unstructured.NestedString(asMap(c), "type"); t == "Ready" {
			info.Ready, _, _ = unstructured.NestedString(asMap(c), "status")
		}
	}
	l := n.GetLabels()
	info.Pool = l["worker.gardener.cloud/pool"]
	info.Zone = l["topology.kubernetes.io/zone"]
	return info
}

// OpsPodTarget is what the ops pod dialog starts with: the node of the
// selected row (a node, or the node a pod runs on), if any.
type OpsPodTarget struct {
	Node string `json:"node,omitempty"`
}

// OpsPodTargetFor derives the dialog's node from a row: a node itself, a
// pod's spec.nodeName (as ops-toolbelt's ops-pod <pod> does); else none.
func (s *Service) OpsPodTargetFor(paneID, key string) (OpsPodTarget, error) {
	r, err := s.row(paneID, key)
	if err != nil {
		return OpsPodTarget{}, err
	}
	switch {
	case r.isNode():
		return OpsPodTarget{Node: r.name()}, nil
	case r.isPod():
		n, _, _ := unstructured.NestedString(r.item.Object.Object, "spec", "nodeName")
		return OpsPodTarget{Node: n}, nil
	}
	return OpsPodTarget{}, nil
}

func (r row) isNode() bool { return r.kind() == "Node" && r.item.Object.GetAPIVersion() == "v1" }

// OpsPodOptions configure an ops pod (see source.OpsPodSpec).
type OpsPodOptions struct {
	Image string `json:"image"`
	// Namespace the pod is created in; "" = default.
	Namespace string `json:"namespace"`
	// HostRoot mounts the node's / at /host; Chroot also runs the shell in it.
	HostRoot    bool `json:"hostRoot"`
	Chroot      bool `json:"chroot"`
	HostNetwork bool `json:"hostNetwork"`
}

// opsPodTarget is the prepared ops pod's node (the safety token's target).
type opsPodTarget struct {
	cluster, node string
}

// PrepareOpsPod checks an ops pod on a node of a context ("" = current)
// against the safety policy. The node must be one the nodes watch knows
// (Nodes subscribes to it); with the watch still listing, any name is taken
// and the API server decides.
func (s *Service) PrepareOpsPod(cluster, node string) (safety.Pending, error) {
	if s.opts.Actor == nil {
		return safety.Pending{}, fmt.Errorf("%s is not available", safety.OpsPod)
	}
	node = strings.TrimSpace(node)
	if node == "" {
		return safety.Pending{}, fmt.Errorf("an ops pod needs a node")
	}
	ctxName, err := s.contextName(cluster)
	if err != nil {
		return safety.Pending{}, err
	}
	a := safety.Action{Kind: safety.OpsPod, Context: ctxName, Resource: "nodes", Name: node}
	if w, err := s.nodeWatch(cluster); err == nil {
		w.mu.Lock()
		synced := w.synced
		w.mu.Unlock()
		n, ok := w.node(node)
		if synced && !ok {
			return safety.Pending{}, fmt.Errorf("no node %q on %s", node, ctxName)
		}
		if ok {
			a.UID = string(n.GetUID())
		}
	}
	return s.guard.Prepare(a, opsPodTarget{cluster: cluster, node: node})
}

// OpsPodResult describes a started ops pod session.
type OpsPodResult struct {
	Session   string `json:"session"`
	Pod       string `json:"pod"`
	Namespace string `json:"namespace"`
	Node      string `json:"node"`
	Image     string `json:"image"`
	Context   string `json:"context"`
	// Settings in a few words, for the terminal header ("host root at /host, host network").
	Settings string `json:"settings,omitempty"`
}

// DefaultOpsPodNamespace is where ops pods go without a namespace.
const DefaultOpsPodNamespace = "default"

var dns1123 = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// OpsPodStart redeems a prepared ops pod and starts a session: the pod is
// created, its progress shows until it runs, then the shell. The pod is
// deleted when the session ends (shell exits, pane closed, app quit).
func (s *Service) OpsPodStart(token string, o OpsPodOptions, cols, rows int) (OpsPodResult, error) {
	a, target, err := s.guard.Redeem(token, safety.OpsPod)
	if err != nil {
		return OpsPodResult{}, err
	}
	t := target.(opsPodTarget)
	o.Image = strings.TrimSpace(o.Image)
	if o.Image == "" || strings.ContainsAny(o.Image, " \t") {
		return OpsPodResult{}, fmt.Errorf("an ops pod needs an image, not %q", o.Image)
	}
	if o.Namespace = strings.TrimSpace(o.Namespace); o.Namespace == "" {
		o.Namespace = DefaultOpsPodNamespace
	}
	if !dns1123.MatchString(o.Namespace) {
		return OpsPodResult{}, fmt.Errorf("%q is not a namespace name", o.Namespace)
	}
	spec := source.OpsPodSpec{
		Name: opsPodName(s.opts.User), Namespace: o.Namespace, Node: t.node, Image: o.Image,
		HostRoot: o.HostRoot || o.Chroot, Chroot: o.Chroot, HostNetwork: o.HostNetwork,
	}
	settings := strings.TrimPrefix(strings.TrimPrefix(spec.String(), spec.Image+" on "+spec.Node), ", ")
	id := s.startSession(cols, rows, func(ctx context.Context, st source.ExecStreams) error {
		spec := spec // the session's own copy
		dim := func(format string, args ...any) { fmt.Fprintf(st.Stdout, "\x1b[2m"+format+"\x1b[0m\r\n", args...) }
		dim("creating %s/%s (%s) …", spec.Namespace, spec.Name, spec)
		spec.Progress = func(line string) { dim("%s", line) }
		// remembered once it runs (the image shared with debug containers): a typo isn't offered again
		spec.Started = func() {
			last := config.OpsPodSettings{Namespace: o.Namespace, Chroot: spec.Chroot, HostRoot: spec.HostRoot, HostNetwork: spec.HostNetwork}
			if err := s.opts.History.AddOpsPod(o.Image, last); err != nil {
				log.Printf("history: %v", err)
			}
		}
		err := s.opts.Actor.OpsPod(ctx, t.cluster, spec, st)
		dim("deleting %s/%s", spec.Namespace, spec.Name)
		return err
	})
	return OpsPodResult{Session: id, Pod: spec.Name, Namespace: spec.Namespace, Node: a.Name, Image: o.Image, Context: a.Context, Settings: settings}, nil
}

// opsPodName: "ops-pod-kubewing-<user>-<hex>", the user as the ops-pod
// script's $(whoami), made a valid name (lower case, [a-z0-9-], ≤ 30
// characters); without one "ops-pod-kubewing-<hex>".
func opsPodName(user string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	if u := sanitizeName(user); u != "" {
		return fmt.Sprintf("ops-pod-kubewing-%s-%x", u, b)
	}
	return fmt.Sprintf("ops-pod-kubewing-%x", b)
}

var notNameChars = regexp.MustCompile(`[^a-z0-9-]+`)

func sanitizeName(s string) string {
	s = notNameChars.ReplaceAllString(strings.ToLower(s), "-")
	if len(s) > 30 {
		s = s[:30]
	}
	return strings.Trim(s, "-")
}

// OpsPodDefaults are the ops pod dialog's initial values: the last pod
// that started (history.yaml), else config.yaml's opsPod, else the
// defaults (host root and host network on). The image is the configured
// one, else the last one that started.
type OpsPodDefaults struct {
	Image string `json:"image"`
	config.OpsPodSettings
	// Remembered: the settings are the last used ones, not the configured.
	Remembered bool `json:"remembered,omitempty"`
}

// OpsPodDefaults see type OpsPodDefaults.
func (s *Service) OpsPodDefaults() OpsPodDefaults {
	cfg := s.Config().Config.OpsPod
	h := s.opts.History.Get()
	d := OpsPodDefaults{Image: cfg.Image, OpsPodSettings: cfg.Settings()}
	if d.Image == "" && len(h.DebugImages) > 0 {
		d.Image = h.DebugImages[0]
	}
	if h.OpsPod != nil {
		d.OpsPodSettings, d.Remembered = *h.OpsPod, true
	}
	return d
}

// opsPodNodes is for tests: the contexts with a running node watch.
func (s *Service) opsPodNodes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.nodes))
	for c := range s.nodes {
		out = append(out, c)
	}
	slices.Sort(out)
	return out
}
