package bridge

import (
	"cmp"
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

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	sigsyaml "sigs.k8s.io/yaml"

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

// watchLease is how long a watch the dialog started outlives the last
// call (Nodes, PersistentVolumes): the dialog polls while open, so it
// stays live while needed.
const watchLease = 30 * time.Second

// leasedWatch is a subscription to a context's shared watch on a
// cluster-scoped resource (nodes, persistentvolumes), kept up to date from
// its events.
type leasedWatch struct {
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
	w, err := s.leasedWatch(cluster, "nodes")
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

// watchKey identifies a leased watch: context and resource.
type watchKey struct{ cluster, resource string }

func (s *Service) leasedWatch(cluster, resource string) (*leasedWatch, error) {
	k := watchKey{cluster, resource}
	s.mu.Lock()
	defer s.mu.Unlock()
	if w, ok := s.leased[k]; ok {
		return w, nil
	}
	sub, err := s.reg.Subscribe(source.Key{Cluster: cluster, Resource: resource})
	if err != nil {
		return nil, err
	}
	w := &leasedWatch{sub: sub, items: map[string]*unstructured.Unstructured{}, used: s.opts.Clock.Now()}
	s.leased[k] = w
	go s.runLeasedWatch(k, w)
	return w, nil
}

func (s *Service) runLeasedWatch(k watchKey, w *leasedWatch) {
	idle := time.NewTicker(watchLease / 3)
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
			stale := s.opts.Clock.Now().Sub(w.used) > watchLease
			w.mu.Unlock()
			if stale {
				s.dropLeasedWatch(k, w)
				return
			}
		}
	}
}

func (s *Service) dropLeasedWatch(k watchKey, w *leasedWatch) {
	s.mu.Lock()
	if s.leased[k] == w {
		delete(s.leased, k)
	}
	s.mu.Unlock()
	w.sub.Close()
}

// get returns a watched object by name.
func (w *leasedWatch) get(name string) (*unstructured.Unstructured, bool) {
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
	// Namespace the pod is created in; "" = default (with a PV: its claim's).
	Namespace string `json:"namespace"`
	// HostRoot mounts the node's / at /host; Chroot also runs the shell in it.
	HostRoot    bool `json:"hostRoot"`
	Chroot      bool `json:"chroot"`
	HostNetwork bool `json:"hostNetwork"`
	// PV is a persistent volume to mount at MountPath ("" = none, default path /pv).
	PV        string `json:"pv,omitempty"`
	MountPath string `json:"mountPath,omitempty"`
	ReadOnly  bool   `json:"readOnly,omitempty"`
	// YAML, if set, is the pod as edited in the dialog: created instead of the options' pod.
	YAML string `json:"yaml,omitempty"`
}

// PVInfo is one persistent volume, for the ops pod dialog's completion.
type PVInfo struct {
	Name string `json:"name"`
	// Phase: Available, Bound, Released, Failed.
	Phase string `json:"phase,omitempty"`
	// Claim is the bound claim as namespace/name ("" = none).
	Claim        string   `json:"claim,omitempty"`
	Capacity     string   `json:"capacity,omitempty"`
	StorageClass string   `json:"storageClass,omitempty"`
	AccessModes  []string `json:"accessModes,omitempty"`
}

// PVList answers the ops pod dialog: a context's persistent volumes, from
// the shared persistentvolumes watch (as Nodes).
type PVList struct {
	Context string   `json:"context"`
	PVs     []PVInfo `json:"pvs"`
	Loading bool     `json:"loading,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// PersistentVolumes lists the persistent volumes of a context ("" = current).
func (s *Service) PersistentVolumes(cluster string) PVList {
	w, err := s.leasedWatch(cluster, "persistentvolumes")
	name, _ := s.contextName(cluster)
	if err != nil {
		return PVList{Context: name, PVs: []PVInfo{}, Error: err.Error()}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.used = s.opts.Clock.Now()
	out := PVList{Context: name, PVs: []PVInfo{}, Loading: !w.synced && w.err == "", Error: w.err}
	for _, pv := range w.items {
		out.PVs = append(out.PVs, pvInfo(pv))
	}
	sort.Slice(out.PVs, func(i, j int) bool { return out.PVs[i].Name < out.PVs[j].Name })
	return out
}

func pvInfo(pv *unstructured.Unstructured) PVInfo {
	o := pv.Object
	info := PVInfo{Name: pv.GetName()}
	info.Phase, _, _ = unstructured.NestedString(o, "status", "phase")
	info.Capacity, _, _ = unstructured.NestedString(o, "spec", "capacity", "storage")
	info.StorageClass, _, _ = unstructured.NestedString(o, "spec", "storageClassName")
	info.AccessModes, _, _ = unstructured.NestedStringSlice(o, "spec", "accessModes")
	ns, _, _ := unstructured.NestedString(o, "spec", "claimRef", "namespace")
	claim, _, _ := unstructured.NestedString(o, "spec", "claimRef", "name")
	if claim != "" && info.Phase == "Bound" {
		info.Claim = ns + "/" + claim
	}
	return info
}

// volume resolves the options' PV to its bound claim, from the leased watch.
func (s *Service) volume(cluster string, o OpsPodOptions) (*source.OpsPodVolume, string, error) {
	pv := strings.TrimSpace(o.PV)
	if pv == "" {
		return nil, "", nil
	}
	w, err := s.leasedWatch(cluster, "persistentvolumes")
	if err != nil {
		return nil, "", err
	}
	obj, ok := w.get(pv)
	if !ok {
		return nil, "", fmt.Errorf("no persistent volume %q (still listing? try again)", pv)
	}
	info := pvInfo(obj)
	if info.Claim == "" {
		return nil, "", fmt.Errorf("persistent volume %s is %s, not bound to a claim: pods mount volumes only through their claim", pv, strings.ToLower(cmp.Or(info.Phase, "unknown")))
	}
	ns, claim, _ := strings.Cut(info.Claim, "/")
	path := cmp.Or(strings.TrimSpace(o.MountPath), "/pv")
	if !strings.HasPrefix(path, "/") || path == "/" || path == "/host" || strings.HasPrefix(path, "/host/") {
		return nil, "", fmt.Errorf("mount path %q: absolute, not / and not under /host", path)
	}
	return &source.OpsPodVolume{PV: pv, Claim: claim, MountPath: path, ReadOnly: o.ReadOnly}, ns, nil
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
	if w, err := s.leasedWatch(cluster, "nodes"); err == nil {
		w.mu.Lock()
		synced := w.synced
		w.mu.Unlock()
		n, ok := w.get(node)
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

// opsPodSpec builds the pod for the options on a prepared node. The
// namespace is the PV claim's if a PV is mounted (pods mount claims of
// their own namespace only); a different namespace typed with it is an error.
func (s *Service) opsPodSpec(t opsPodTarget, o OpsPodOptions) (source.OpsPodSpec, error) {
	o.Image = strings.TrimSpace(o.Image)
	if o.Image == "" || strings.ContainsAny(o.Image, " \t") {
		return source.OpsPodSpec{}, fmt.Errorf("an ops pod needs an image, not %q", o.Image)
	}
	o.Namespace = strings.TrimSpace(o.Namespace)
	vol, claimNS, err := s.volume(t.cluster, o)
	if err != nil {
		return source.OpsPodSpec{}, err
	}
	if vol != nil {
		if o.Namespace != "" && o.Namespace != claimNS {
			return source.OpsPodSpec{}, fmt.Errorf("persistent volume %s is claimed in namespace %s: the pod must run there, not in %s", vol.PV, claimNS, o.Namespace)
		}
		o.Namespace = claimNS
	}
	if o.Namespace == "" {
		o.Namespace = DefaultOpsPodNamespace
	}
	if !dns1123.MatchString(o.Namespace) {
		return source.OpsPodSpec{}, fmt.Errorf("%q is not a namespace name", o.Namespace)
	}
	return source.OpsPodSpec{
		Name: opsPodName(s.opts.User), Namespace: o.Namespace, Node: t.node, Image: o.Image,
		HostRoot: o.HostRoot || o.Chroot, Chroot: o.Chroot, HostNetwork: o.HostNetwork, Volume: vol,
	}, nil
}

// OpsPodManifest renders, as YAML, the pod an ops pod with these options on
// node would be, for the dialog's "show YAML" (to read or edit before
// starting). It creates nothing, so it needs no token: editing may take
// longer than a token lives. Starting prepares and checks as always.
func (s *Service) OpsPodManifest(cluster, node string, o OpsPodOptions) (string, error) {
	spec, err := s.opsPodSpec(opsPodTarget{cluster: cluster, node: strings.TrimSpace(node)}, o)
	if err != nil {
		return "", err
	}
	b, err := sigsyaml.Marshal(source.OpsPodManifest(spec))
	if err != nil {
		return "", err
	}
	y := strings.Replace(string(b), "status: {}\n", "", 1)
	// offer priorityClassName as a comment right after nodeName (both spec-level):
	// a full node may evict a best-effort pod otherwise. Uncomment to keep it.
	if i := strings.Index(y, "  nodeName:"); i >= 0 {
		if nl := strings.IndexByte(y[i:], '\n'); nl >= 0 {
			at := i + nl + 1
			y = y[:at] + "  # priorityClassName: system-cluster-critical  # uncomment to survive on a full node\n" + y[at:]
		}
	}
	return y, nil
}

// editedPod decodes the dialog's edited YAML. What the safety token was
// issued for and what the session needs stay as kubewing decided: a v1 Pod
// on the prepared node, with the ops-pod container (the shell runs there),
// name and namespace as rendered (the name is how the pod is deleted again).
// Anything else (resources, env, volumes, priorityClassName …) is the
// user's. Unknown fields are refused, so a typo doesn't silently vanish.
func editedPod(yaml string, spec source.OpsPodSpec) (*corev1.Pod, error) {
	var pod corev1.Pod
	if err := sigsyaml.UnmarshalStrict([]byte(yaml), &pod); err != nil {
		return nil, fmt.Errorf("edited YAML: %w", err)
	}
	switch {
	case pod.APIVersion != "v1" || pod.Kind != "Pod":
		return nil, fmt.Errorf("edited YAML: must stay a v1 Pod, not %s %s", pod.APIVersion, pod.Kind)
	case pod.Spec.NodeName != spec.Node:
		return nil, fmt.Errorf("edited YAML: spec.nodeName must stay %s (the node the ops pod was prepared for)", spec.Node)
	case !slices.ContainsFunc(pod.Spec.Containers, func(c corev1.Container) bool { return c.Name == source.OpsPodContainer }):
		return nil, fmt.Errorf("edited YAML: the shell runs in container %q; keep it", source.OpsPodContainer)
	case pod.Name != spec.Name || pod.Namespace != spec.Namespace:
		return nil, fmt.Errorf("edited YAML: name and namespace must stay %s/%s (change the namespace in the dialog)", spec.Namespace, spec.Name)
	}
	return &pod, nil
}

// fullSpec is the pod OpsPodStart creates: the options' pod, or the edited
// YAML (checked by editedPod) with the name it was rendered with.
func (s *Service) fullSpec(t opsPodTarget, o OpsPodOptions) (source.OpsPodSpec, error) {
	spec, err := s.opsPodSpec(t, o)
	if err != nil || strings.TrimSpace(o.YAML) == "" {
		return spec, err
	}
	// the rendered name: what the user saw and kept
	var meta struct {
		Metadata struct{ Name string } `json:"metadata"`
	}
	if sigsyaml.Unmarshal([]byte(o.YAML), &meta) == nil && strings.HasPrefix(meta.Metadata.Name, "ops-pod-kubewing-") {
		spec.Name = meta.Metadata.Name
	}
	if spec.Pod, err = editedPod(o.YAML, spec); err != nil {
		return source.OpsPodSpec{}, err
	}
	spec.Image = cmp.Or(opsContainer(spec.Pod).Image, spec.Image)
	return spec, nil
}

// CheckOpsPod runs OpsPodStart's checks (image, namespace, PV, edited
// YAML) without creating anything, so the dialog can stay open with what's
// wrong instead of failing after it closed. OpsPodStart checks again.
func (s *Service) CheckOpsPod(cluster, node string, o OpsPodOptions) error {
	_, err := s.fullSpec(opsPodTarget{cluster: cluster, node: strings.TrimSpace(node)}, o)
	return err
}

// OpsPodStart redeems a prepared ops pod and starts a session: the pod is
// created (as edited in the dialog's YAML, if it was), its progress shows
// until it runs, then the shell. The pod is deleted when the session ends
// (shell exits, pane closed, app quit).
func (s *Service) OpsPodStart(token string, o OpsPodOptions, cols, rows int) (OpsPodResult, error) {
	a, target, err := s.guard.Redeem(token, safety.OpsPod)
	if err != nil {
		return OpsPodResult{}, err
	}
	t := target.(opsPodTarget)
	spec, err := s.fullSpec(t, o)
	if err != nil {
		return OpsPodResult{}, err
	}
	settings := strings.TrimPrefix(strings.TrimPrefix(spec.String(), spec.Image+" on "+spec.Node), ", ")
	id := s.startSession(cols, rows, func(ctx context.Context, st source.ExecStreams) error {
		spec := spec // the session's own copy
		dim := func(format string, args ...any) { fmt.Fprintf(st.Stdout, "\x1b[2m"+format+"\x1b[0m\r\n", args...) }
		dim("creating %s/%s (%s) …", spec.Namespace, spec.Name, spec)
		spec.Progress = func(line string) { dim("%s", line) }
		// remembered once it runs (the image shared with debug containers): a typo isn't offered again
		spec.Started = func() {
			last := config.OpsPodSettings{Namespace: spec.Namespace, Chroot: spec.Chroot, HostRoot: spec.HostRoot, HostNetwork: spec.HostNetwork}
			if err := s.opts.History.AddOpsPod(spec.Image, last); err != nil {
				log.Printf("history: %v", err)
			}
		}
		err := s.opts.Actor.OpsPod(ctx, t.cluster, spec, st)
		dim("deleting %s/%s", spec.Namespace, spec.Name)
		return err
	})
	return OpsPodResult{Session: id, Pod: spec.Name, Namespace: spec.Namespace, Node: a.Name, Image: spec.Image, Context: a.Context, Settings: settings}, nil
}

func opsContainer(p *corev1.Pod) *corev1.Container {
	for i := range p.Spec.Containers {
		if p.Spec.Containers[i].Name == source.OpsPodContainer {
			return &p.Spec.Containers[i]
		}
	}
	return &corev1.Container{}
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
	out := []string{}
	for k := range s.leased {
		if k.resource == "nodes" {
			out = append(out, k.cluster)
		}
	}
	slices.Sort(out)
	return out
}
