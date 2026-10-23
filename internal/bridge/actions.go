package bridge

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/normalize"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
)

// Event names for object actions.
const (
	// SessionEvent carries exec output ({id, data: base64}) and, last, the exit ({id, exit}).
	SessionEvent = "kw:session"
	// PortForwardsEvent carries the full list of port-forwards whenever it changes.
	PortForwardsEvent = "kw:portforwards"
)

// Exec output is batched: at most every sessionFlush, or when sessionChunk
// bytes are pending, so a chatty command doesn't flood the bridge.
const (
	sessionFlush = 16 * time.Millisecond
	sessionChunk = 32 << 10
)

// DescribeResult is one describe run of a row, plus the previous run (the
// last time it was described in this session) for the describe diff.
type DescribeResult struct {
	Text string `json:"text"`
	// PrevNorm / CurNorm are the previous and this run, normalized for
	// diffing (relative times blanked, tables aligned); empty without a previous run.
	PrevNorm string `json:"prevNorm,omitempty"`
	CurNorm  string `json:"curNorm,omitempty"`
	// PrevAt is when the previous run was taken (RFC 3339).
	PrevAt string `json:"prevAt,omitempty"`
}

// describeKeep bounds the describe snapshots kept for diffing (LRU).
const describeKeep = 200

type describeSnap struct {
	text string
	at   time.Time
	used uint64
}

// Describe returns `kubectl describe` output for one row. Read-only: no
// token, allowed on read-only contexts. Each call is one "look": it is
// diffed against the previous look at the same object (by context + UID,
// so a recreated object starts fresh), then becomes the new baseline.
func (s *Service) Describe(paneID, key string) (DescribeResult, error) {
	if s.opts.Actor == nil {
		return DescribeResult{}, errors.New("describe is not available")
	}
	r, err := s.row(paneID, key)
	if err != nil {
		return DescribeResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	text, err := s.opts.Actor.Describe(ctx, r.cluster, r.res, r.namespace(), r.name())
	if err != nil {
		return DescribeResult{}, err
	}
	id := r.context + "/" + string(r.item.Object.GetUID())
	if r.item.Object.GetUID() == "" {
		id = r.context + "/" + r.namespace() + "/" + r.name()
	}
	res := DescribeResult{Text: text}
	s.mu.Lock()
	prev, ok := s.described[id]
	s.useq++
	s.described[id] = &describeSnap{text: text, at: s.opts.Clock.Now(), used: s.useq}
	if len(s.described) > describeKeep {
		var oldest string
		for k, v := range s.described {
			if oldest == "" || v.used < s.described[oldest].used {
				oldest = k
			}
		}
		delete(s.described, oldest)
	}
	s.mu.Unlock()
	if ok {
		res.PrevNorm, res.CurNorm = normalize.DescribePair(prev.text, text)
		res.PrevAt = prev.at.UTC().Format(time.RFC3339)
	}
	return res, nil
}

// RowInfo is what the UI needs to offer actions for one row (context
// menu): identity and capabilities, never the object itself.
type RowInfo struct {
	Key       string `json:"key"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Deleted   bool   `json:"deleted,omitempty"`
	// HasPrev: a previous version exists, so the diff view has something to show.
	HasPrev bool `json:"hasPrev,omitempty"`
	// Pod is true for v1 Pods (exec, port-forward).
	Pod        bool     `json:"pod,omitempty"`
	Containers []string `json:"containers,omitempty"`
	// ContainerInfo lists every container exec can enter, for the picker.
	ContainerInfo []ContainerInfo `json:"containerInfo,omitempty"`
	// Ports are the declared container ports (port-forward defaults).
	Ports []int64 `json:"ports,omitempty"`
	// PortInfo details them for the port-forward dialog's completion.
	PortInfo []PortInfo `json:"portInfo,omitempty"`
}

// PortInfo is one declared container port.
type PortInfo struct {
	Port      int64  `json:"port"`
	Name      string `json:"name,omitempty"`
	Protocol  string `json:"protocol,omitempty"` // TCP if unset, as Kubernetes defaults it
	Container string `json:"container"`
}

// ContainerInfo is one container of a pod (exec picker).
type ContainerInfo struct {
	Name string `json:"name"`
	// Kind is "container", "init", "sidecar" (an init container with
	// restartPolicy Always) or "ephemeral" (kubectl debug).
	Kind string `json:"kind"`
	// State from the pod status: running, waiting or terminated; "" = not reported.
	State string `json:"state,omitempty"`
	// Reason of a waiting/terminated state (CrashLoopBackOff, Completed …).
	Reason string `json:"reason,omitempty"`
	// Default is the container exec picks when none is given.
	Default bool `json:"default,omitempty"`
}

// RowInfo describes one row, including tombstones.
func (s *Service) RowInfo(paneID, key string) (RowInfo, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return RowInfo{}, err
	}
	pn.mu.Lock()
	it, ok := pn.view.Item(key)
	deleted, hasPrev := pn.view.Deleted(key), pn.view.HasPrev(key)
	r := row{cluster: pn.p.Source.Cluster, res: pn.res, typed: pn.p.Source.Resource, item: it}
	pn.mu.Unlock()
	if !ok {
		return RowInfo{}, fmt.Errorf("object %s not found", key)
	}
	info := RowInfo{Key: key, Kind: r.kind(), Name: r.name(), Namespace: r.namespace(), Deleted: deleted, HasPrev: hasPrev, Pod: r.isPod()}
	if info.Pod {
		info.Containers = containers(r)
		info.ContainerInfo = podContainers(r)
		def := defaultContainer(r, info.ContainerInfo)
		for i := range info.ContainerInfo {
			info.ContainerInfo[i].Default = info.ContainerInfo[i].Name == def
		}
		info.PortInfo = portInfo(r)
		for _, p := range info.PortInfo {
			if !slices.Contains(info.Ports, p.Port) {
				info.Ports = append(info.Ports, p.Port)
			}
		}
	}
	return info, nil
}

// portInfo lists the declared container ports in spec order.
func portInfo(r row) []PortInfo {
	list, _, _ := unstructured.NestedSlice(r.item.Object.Object, "spec", "containers")
	var out []PortInfo
	for _, c := range list {
		cname, _, _ := unstructured.NestedString(asMap(c), "name")
		ports, _, _ := unstructured.NestedSlice(asMap(c), "ports")
		for _, p := range ports {
			// int64 from the cluster source; float64 would be plain encoding/json
			var n int64
			switch v := asMap(p)["containerPort"].(type) {
			case int64:
				n = v
			case float64:
				n = int64(v)
			default:
				continue
			}
			name, _, _ := unstructured.NestedString(asMap(p), "name")
			proto, _, _ := unstructured.NestedString(asMap(p), "protocol")
			if proto == "" {
				proto = "TCP"
			}
			out = append(out, PortInfo{Port: n, Name: name, Protocol: proto, Container: cname})
		}
	}
	return out
}

// SessionPayload is one SessionEvent.
type SessionPayload struct {
	ID   string `json:"id"`
	Data string `json:"data,omitempty"` // base64
	// Exit is set on the last event: "0", an exit code, or an error message.
	Exit string `json:"exit,omitempty"`
}

// ExecResult describes a started exec session.
type ExecResult struct {
	Session   string   `json:"session"`
	Container string   `json:"container"`
	Pod       string   `json:"pod"`
	Context   string   `json:"context"`
	Others    []string `json:"containers"` // every container exec can enter (see podContainers)
}

type session struct {
	id    string
	stdin *io.PipeWriter
	// input feeds stdin through one writer goroutine: keystrokes stay in
	// order (a goroutine per write would race on the pipe) and SessionInput
	// never blocks on a remote that isn't reading yet
	input  chan []byte
	resize chan source.TerminalSize
	cancel context.CancelFunc

	mu     sync.Mutex
	closed bool
}

// ExecShell is run in the container: bash if there, else sh.
var ExecShell = []string{"sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}

// ExecStart redeems a prepared exec and starts a TTY session in the pod.
// container "" picks the kubectl.kubernetes.io/default-container annotation,
// else the first container. Init, sidecar and ephemeral containers can be
// named too, as with kubectl exec -c.
func (s *Service) ExecStart(token, container string, cols, rows int) (ExecResult, error) {
	a, target, err := s.guard.Redeem(token, safety.Exec)
	if err != nil {
		return ExecResult{}, err
	}
	r := target.(row)
	cs := podContainers(r)
	all := make([]string, len(cs))
	for i, c := range cs {
		all[i] = c.Name
	}
	if container == "" {
		container = defaultContainer(r, cs)
	} else if len(all) > 0 && !slices.Contains(all, container) {
		return ExecResult{}, fmt.Errorf("pod %s has no container %q (has %s)", a.Name, container, strings.Join(all, ", "))
	}

	id := s.startSession(cols, rows, func(ctx context.Context, st source.ExecStreams) error {
		return s.opts.Actor.Exec(ctx, r.cluster, a.Namespace, a.Name, container, ExecShell, st)
	})
	return ExecResult{Session: id, Container: container, Pod: a.Name, Context: a.Context, Others: all}, nil
}

// startSession runs a TTY session (exec, debug) in the background: output
// goes out as SessionEvents, the last one carrying the exit.
func (s *Service) startSession(cols, rows int, run func(context.Context, source.ExecStreams) error) string {
	s.mu.Lock()
	s.next++
	id := fmt.Sprintf("s%d", s.next)
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	inR, inW := io.Pipe()
	ss := &session{id: id, stdin: inW, input: make(chan []byte, 1024), resize: make(chan source.TerminalSize, 4), cancel: cancel}
	go func() {
		for b := range ss.input {
			if _, err := inW.Write(b); err != nil {
				return // the remote ended; endSession closes input
			}
		}
	}()
	if cols > 0 && rows > 0 {
		ss.resize <- source.TerminalSize{Cols: uint16(cols), Rows: uint16(rows)}
	}
	s.mu.Lock()
	s.sessions[id] = ss
	s.mu.Unlock()

	out := newBatcher(func(b []byte) {
		s.emit.Emit(SessionEvent, SessionPayload{ID: id, Data: base64.StdEncoding.EncodeToString(b)})
	})
	s.running.Add(1)
	go func() {
		defer s.running.Done()
		err := run(ctx, source.ExecStreams{Stdin: inR, Stdout: out, Resize: ss.resize})
		out.Close()
		_ = inR.Close()
		s.endSession(ss)
		s.emit.Emit(SessionEvent, SessionPayload{ID: id, Exit: exitText(ctx, err)})
	}()
	return id
}

// DebugOptions configure a debug container (kubectl debug --image,
// --target, --profile).
type DebugOptions struct {
	Image string `json:"image"`
	// Target shares that container's processes; "" = the pod's default container, "-" = none.
	Target string `json:"target"`
	// Profile: one of config.DebugProfiles; "" = general.
	Profile string `json:"profile"`
}

// DebugResult describes a started debug session.
type DebugResult struct {
	Session string `json:"session"`
	// Container is the new ephemeral container's name.
	Container string `json:"container"`
	Target    string `json:"target,omitempty"`
	Image     string `json:"image"`
	Pod       string `json:"pod"`
	Context   string `json:"context"`
}

// DebugStart redeems a prepared debug and starts a session in a new
// ephemeral container: output shows while the image is pulled, then the
// container's TTY. The container stays in the pod after the session ends.
func (s *Service) DebugStart(token string, o DebugOptions, cols, rows int) (DebugResult, error) {
	a, target, err := s.guard.Redeem(token, safety.Debug)
	if err != nil {
		return DebugResult{}, err
	}
	r := target.(row)
	o.Image = strings.TrimSpace(o.Image)
	if o.Image == "" || strings.ContainsAny(o.Image, " \t") {
		return DebugResult{}, fmt.Errorf("debug needs an image (e.g. busybox), not %q", o.Image)
	}
	if o.Profile == "" {
		o.Profile = "general"
	}
	if !slices.Contains(config.DebugProfiles, o.Profile) {
		return DebugResult{}, fmt.Errorf("unknown profile %q (known: %s)", o.Profile, strings.Join(config.DebugProfiles, ", "))
	}
	cs := podContainers(r)
	switch o.Target {
	case "-":
		o.Target = ""
	case "":
		o.Target = defaultContainer(r, cs)
	default:
		if !slices.ContainsFunc(cs, func(c ContainerInfo) bool { return c.Name == o.Target && c.Kind != "ephemeral" }) {
			return DebugResult{}, fmt.Errorf("pod %s has no container %q to target", a.Name, o.Target)
		}
	}
	name := debugName(cs)
	// remembered once it runs: a typo or an image that can't be pulled isn't offered again
	id := s.startSession(cols, rows, func(ctx context.Context, st source.ExecStreams) error {
		dim := func(format string, args ...any) { fmt.Fprintf(st.Stdout, "\x1b[2m"+format+"\x1b[0m\r\n", args...) }
		dim("starting %s (%s) in %s …", name, o.Image, a.Name)
		spec := source.DebugSpec{
			Name: name, Image: o.Image, Target: o.Target, Profile: o.Profile,
			Progress: func(line string) { dim("%s", line) },
			// remembered once it runs: a typo or an image that can't be pulled isn't offered again
			Started: func() {
				if err := s.opts.History.AddDebugImage(o.Image); err != nil {
					log.Printf("history: %v", err)
				}
			},
		}
		return s.opts.Actor.Debug(ctx, r.cluster, a.Namespace, a.Name, spec, st)
	})
	return DebugResult{Session: id, Container: name, Target: o.Target, Image: o.Image, Pod: a.Name, Context: a.Context}, nil
}

// DebugImages are the images of recently started debug containers, newest first.
func (s *Service) DebugImages() []string { return s.opts.History.Get().DebugImages }

// RemoveDebugImage forgets an image (✕ or ⇧⌫ in the debug dialog) and returns what's left.
func (s *Service) RemoveDebugImage(image string) ([]string, error) {
	if err := s.opts.History.RemoveDebugImage(image); err != nil {
		return nil, err
	}
	return s.DebugImages(), nil
}

// debugName is a container name not used in the pod yet, as kubectl picks it.
func debugName(cs []ContainerInfo) string {
	for {
		b := make([]byte, 5)
		_, _ = rand.Read(b)
		n := "debugger-"
		for _, c := range b {
			n += string("bcdfghjklmnpqrstvwxz2456789"[int(c)%27])
		}
		if !slices.ContainsFunc(cs, func(c ContainerInfo) bool { return c.Name == n }) {
			return n
		}
	}
}

func exitText(ctx context.Context, err error) string {
	var coded interface{ ExitStatus() int }
	switch {
	case err == nil, ctx.Err() != nil: // closed by us
		return "0"
	case errors.As(err, &coded):
		return strconv.Itoa(coded.ExitStatus())
	}
	return err.Error()
}

func containers(r row) []string {
	list, _, _ := unstructured.NestedSlice(r.item.Object.Object, "spec", "containers")
	var out []string
	for _, c := range list {
		if n, _, _ := unstructured.NestedString(asMap(c), "name"); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// podContainers lists a pod's containers, then its init and ephemeral
// containers, in spec order, with their state from the pod status.
func podContainers(r row) []ContainerInfo {
	obj := r.item.Object.Object
	state := map[string]ContainerInfo{}
	for _, f := range []string{"containerStatuses", "initContainerStatuses", "ephemeralContainerStatuses"} {
		list, _, _ := unstructured.NestedSlice(obj, "status", f)
		for _, s := range list {
			name, _, _ := unstructured.NestedString(asMap(s), "name")
			st := asMap(asMap(s)["state"])
			for _, k := range []string{"running", "waiting", "terminated"} {
				if v, ok := st[k]; ok {
					reason, _, _ := unstructured.NestedString(asMap(v), "reason")
					state[name] = ContainerInfo{State: k, Reason: reason}
					break
				}
			}
		}
	}
	kinds := map[string]string{"containers": "container", "initContainers": "init", "ephemeralContainers": "ephemeral"}
	var out []ContainerInfo
	for _, f := range []string{"containers", "initContainers", "ephemeralContainers"} {
		list, _, _ := unstructured.NestedSlice(obj, "spec", f)
		for _, c := range list {
			name, _, _ := unstructured.NestedString(asMap(c), "name")
			if name == "" {
				continue
			}
			kind := kinds[f]
			if p, _, _ := unstructured.NestedString(asMap(c), "restartPolicy"); kind == "init" && p == "Always" {
				kind = "sidecar"
			}
			out = append(out, ContainerInfo{Name: name, Kind: kind, State: state[name].State, Reason: state[name].Reason})
		}
	}
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// defaultContainer is the kubectl.kubernetes.io/default-container annotation
// if it names one of cs, else the first regular container.
func defaultContainer(r row, cs []ContainerInfo) string {
	d := r.item.Object.GetAnnotations()["kubectl.kubernetes.io/default-container"]
	if len(cs) == 0 {
		return d
	}
	first := ""
	for _, c := range cs {
		if d != "" && c.Name == d {
			return d
		}
		if first == "" && c.Kind == "container" {
			first = c.Name
		}
	}
	return first
}

func (s *Service) session(id string) (*session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, ok := s.sessions[id]
	if !ok {
		return nil, fmt.Errorf("unknown session %s", id)
	}
	return ss, nil
}

// SessionInput sends keystrokes (base64) to a session.
func (s *Service) SessionInput(id, data string) error {
	ss, err := s.session(id)
	if err != nil {
		return err
	}
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return err
	}
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.closed {
		return nil
	}
	select {
	case ss.input <- b:
	default: // a remote that stopped reading: drop, as a full TTY buffer would
	}
	return nil
}

// SessionResize reports a new terminal size.
func (s *Service) SessionResize(id string, cols, rows int) error {
	ss, err := s.session(id)
	if err != nil {
		return err
	}
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.closed || cols <= 0 || rows <= 0 {
		return nil
	}
	select {
	case ss.resize <- source.TerminalSize{Cols: uint16(cols), Rows: uint16(rows)}:
	default: // a burst of resizes: the latest one that fits is enough
	}
	return nil
}

// SessionClose ends a session (its terminal pane closed).
func (s *Service) SessionClose(id string) error {
	ss, err := s.session(id)
	if err != nil {
		return nil // already ended
	}
	ss.cancel()
	s.endSession(ss)
	return nil
}

func (s *Service) endSession(ss *session) {
	ss.mu.Lock()
	if !ss.closed {
		ss.closed = true
		close(ss.resize)
		close(ss.input)
		_ = ss.stdin.Close()
	}
	ss.mu.Unlock()
	s.mu.Lock()
	delete(s.sessions, ss.id)
	s.mu.Unlock()
}

// batcher buffers writes and flushes them every sessionFlush or at sessionChunk bytes.
type batcher struct {
	mu    sync.Mutex
	buf   []byte
	flush func([]byte)
	timer *time.Timer
	done  bool
}

func newBatcher(flush func([]byte)) *batcher { return &batcher{flush: flush} }

func (b *batcher) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.done {
		return 0, io.ErrClosedPipe
	}
	b.buf = append(b.buf, p...)
	if len(b.buf) >= sessionChunk {
		b.emitLocked()
	} else if b.timer == nil {
		b.timer = time.AfterFunc(sessionFlush, func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			b.emitLocked()
		})
	}
	return len(p), nil
}

func (b *batcher) emitLocked() {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	if len(b.buf) == 0 {
		return
	}
	out := b.buf
	b.buf = nil
	b.flush(out)
}

// Close flushes what's left.
func (b *batcher) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.emitLocked()
	b.done = true
}

// PortForwardInfo describes a running port-forward.
type PortForwardInfo struct {
	ID        string        `json:"id"`
	Context   string        `json:"context"`
	Namespace string        `json:"namespace"`
	Pod       string        `json:"pod"`
	Ports     []source.Port `json:"ports"`
	// Error is set once the forward ended on its own (pod gone …); it then
	// stays in the list until stopped, so the user sees why.
	Error string `json:"error,omitempty"`
}

type forward struct {
	info PortForwardInfo
	f    *source.Forward
}

// PortForwardStart forwards local ports (on 127.0.0.1) to the pod of a row.
// ports are "local:remote" or "remote"/":remote" for a random local port.
// It doesn't change cluster state, so it needs no token and works on
// read-only contexts.
func (s *Service) PortForwardStart(paneID, key string, ports []string) (PortForwardInfo, error) {
	if s.opts.Actor == nil {
		return PortForwardInfo{}, errors.New("port-forward is not available")
	}
	r, err := s.row(paneID, key)
	if err != nil {
		return PortForwardInfo{}, err
	}
	if !r.isPod() {
		return PortForwardInfo{}, fmt.Errorf("port-forward needs a pod, not %s", strings.ToLower(r.kind()))
	}
	if len(ports) == 0 {
		return PortForwardInfo{}, errors.New("no ports given")
	}
	norm := make([]string, len(ports))
	for i, p := range ports {
		if !strings.Contains(p, ":") {
			p = ":" + p
		}
		norm[i] = p
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f, err := s.opts.Actor.PortForward(ctx, r.cluster, r.namespace(), r.name(), norm)
	if err != nil {
		return PortForwardInfo{}, err
	}
	s.mu.Lock()
	s.next++
	fw := &forward{f: f, info: PortForwardInfo{ID: fmt.Sprintf("f%d", s.next), Context: r.context, Namespace: r.namespace(), Pod: r.name(), Ports: f.Ports}}
	s.forwards[fw.info.ID] = fw
	s.mu.Unlock()
	go func() {
		<-f.Done
		s.mu.Lock()
		if _, ok := s.forwards[fw.info.ID]; ok {
			if err := f.Err(); err != nil {
				fw.info.Error = err.Error()
			} else {
				fw.info.Error = "ended"
			}
		}
		s.mu.Unlock()
		s.emitForwards()
	}()
	s.emitForwards()
	return fw.info, nil
}

// PortForwards lists port-forwards, oldest first.
func (s *Service) PortForwards() []PortForwardInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]PortForwardInfo, 0, len(s.forwards))
	for _, f := range s.forwards {
		out = append(out, f.info)
	}
	slices.SortFunc(out, func(a, b PortForwardInfo) int {
		ai, _ := strconv.Atoi(a.ID[1:])
		bi, _ := strconv.Atoi(b.ID[1:])
		return ai - bi
	})
	return out
}

// PortForwardStop stops (and removes) a port-forward.
func (s *Service) PortForwardStop(id string) error {
	s.mu.Lock()
	fw, ok := s.forwards[id]
	delete(s.forwards, id)
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown port-forward %s", id)
	}
	fw.f.Stop()
	s.emitForwards()
	return nil
}

func (s *Service) emitForwards() { s.emit.Emit(PortForwardsEvent, s.PortForwards()) }

// shutdownWait bounds how long Shutdown waits for sessions to clean up
// (ops pods being deleted) before the app quits anyway.
const shutdownWait = 10 * time.Second

// Shutdown ends all sessions and port-forwards (app quit) and waits, up to
// shutdownWait, for the sessions to clean up: ops pods are deleted.
func (s *Service) Shutdown() {
	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for _, ss := range s.sessions {
		sessions = append(sessions, ss)
	}
	forwards := s.forwards
	s.forwards = map[string]*forward{}
	leased := s.leased
	s.leased = map[watchKey]*leasedWatch{}
	s.mu.Unlock()
	for _, ss := range sessions {
		ss.cancel()
		s.endSession(ss)
	}
	for _, f := range forwards {
		f.f.Stop()
	}
	for _, w := range leased {
		w.sub.Close()
	}
	done := make(chan struct{})
	go func() {
		s.running.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownWait):
		log.Printf("shutdown: sessions still cleaning up after %s", shutdownWait)
	}
}
