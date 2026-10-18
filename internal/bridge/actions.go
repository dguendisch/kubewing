package bridge

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

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

// Describe returns `kubectl describe` output for one row. Read-only: no
// token, allowed on read-only contexts.
func (s *Service) Describe(paneID, key string) (string, error) {
	if s.opts.Actor == nil {
		return "", errors.New("describe is not available")
	}
	r, err := s.row(paneID, key)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.opts.Actor.Describe(ctx, r.cluster, r.res, r.namespace(), r.name())
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
	// Ports are the declared container ports (port-forward defaults).
	Ports []int64 `json:"ports,omitempty"`
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
		info.Ports = containerPorts(r)
	}
	return info, nil
}

func containerPorts(r row) []int64 {
	list, _, _ := unstructured.NestedSlice(r.item.Object.Object, "spec", "containers")
	var out []int64
	for _, c := range list {
		ports, _, _ := unstructured.NestedSlice(asMap(c), "ports")
		for _, p := range ports {
			if n, ok, _ := unstructured.NestedInt64(asMap(p), "containerPort"); ok && !slices.Contains(out, n) {
				out = append(out, n)
			}
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
	Others    []string `json:"containers"` // all containers of the pod, for a picker
}

type session struct {
	id     string
	stdin  *io.PipeWriter
	resize chan source.TerminalSize
	cancel context.CancelFunc

	mu     sync.Mutex
	closed bool
}

// ExecShell is run in the container: bash if there, else sh.
var ExecShell = []string{"sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}

// ExecStart redeems a prepared exec and starts a TTY session in the pod.
// container "" picks the kubectl.kubernetes.io/default-container annotation,
// else the first container.
func (s *Service) ExecStart(token, container string, cols, rows int) (ExecResult, error) {
	a, target, err := s.guard.Redeem(token, safety.Exec)
	if err != nil {
		return ExecResult{}, err
	}
	r := target.(row)
	all := containers(r)
	if container == "" {
		container = defaultContainer(r, all)
	} else if len(all) > 0 && !slices.Contains(all, container) {
		return ExecResult{}, fmt.Errorf("pod %s has no container %q (has %s)", a.Name, container, strings.Join(all, ", "))
	}

	s.mu.Lock()
	s.next++
	id := fmt.Sprintf("s%d", s.next)
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	inR, inW := io.Pipe()
	ss := &session{id: id, stdin: inW, resize: make(chan source.TerminalSize, 4), cancel: cancel}
	if cols > 0 && rows > 0 {
		ss.resize <- source.TerminalSize{Cols: uint16(cols), Rows: uint16(rows)}
	}
	s.mu.Lock()
	s.sessions[id] = ss
	s.mu.Unlock()

	out := newBatcher(func(b []byte) {
		s.emit.Emit(SessionEvent, SessionPayload{ID: id, Data: base64.StdEncoding.EncodeToString(b)})
	})
	go func() {
		err := s.opts.Actor.Exec(ctx, r.cluster, a.Namespace, a.Name, container, ExecShell, source.ExecStreams{Stdin: inR, Stdout: out, Resize: ss.resize})
		out.Close()
		_ = inR.Close()
		s.endSession(ss)
		s.emit.Emit(SessionEvent, SessionPayload{ID: id, Exit: exitText(ctx, err)})
	}()
	return ExecResult{Session: id, Container: container, Pod: a.Name, Context: a.Context, Others: all}, nil
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

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func defaultContainer(r row, all []string) string {
	if d := r.item.Object.GetAnnotations()["kubectl.kubernetes.io/default-container"]; d != "" && (len(all) == 0 || slices.Contains(all, d)) {
		return d
	}
	if len(all) > 0 {
		return all[0]
	}
	return ""
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
	// io.Pipe blocks until the remote reads; keep the bridge call responsive
	go func() { _, _ = ss.stdin.Write(b) }()
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

// Shutdown ends all sessions and port-forwards (app quit).
func (s *Service) Shutdown() {
	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for _, ss := range s.sessions {
		sessions = append(sessions, ss)
	}
	forwards := s.forwards
	s.forwards = map[string]*forward{}
	s.mu.Unlock()
	for _, ss := range sessions {
		ss.cancel()
		s.endSession(ss)
	}
	for _, f := range forwards {
		f.f.Stop()
	}
}
