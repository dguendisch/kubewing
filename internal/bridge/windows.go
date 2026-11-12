package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"sync"
	"time"
)

// MainWindow is the window kubewing opens with: calls that name no window
// (tests, the WebSocket transport without ?window=) come from it.
const MainWindow = "main"

// WindowEvent carries a message from one window's frontend to another's (a
// pane handed over, a drag passing over it), sent to the addressed window only.
const WindowEvent = "kw:window"

// WindowMessage is one WindowEvent.
type WindowMessage struct {
	From string          `json:"from"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Rect is a window's frame on screen: points, top-left origin.
type Rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// WindowInfo describes an open window, for a drag crossing windows.
type WindowInfo struct {
	Name   string `json:"name"`
	Bounds Rect   `json:"bounds"`
}

// PointerInfo is where the mouse is during a pane's drag: on screen
// (points, top-left origin) and, over one of kubewing's windows (the
// frontmost there), that window and the point in its page.
type PointerInfo struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	// Window is the kubewing window under the mouse ("" if none).
	Window string  `json:"window,omitempty"`
	InX    float64 `json:"inX,omitempty"`
	InY    float64 `json:"inY,omitempty"`
	// Other: another app's window is in front there (it counts as outside kubewing's).
	Other bool `json:"other,omitempty"`
}

// Host opens and closes native windows (the Wails app); nil headless, where
// the page opens them (window.open) and they register as they connect.
type Host interface {
	OpenWindow(name string, bounds Rect)
	CloseWindow(name string)
	Bounds(name string) (Rect, bool)
	// Pointer is the mouse and the window under it (the page's own screen
	// coordinates aren't to be trusted in WKWebView, nor its idea of z-order).
	Pointer() PointerInfo
}

type windowKey struct{}

// WithWindow marks ctx as a call from the named window (WebSocket transport).
func WithWindow(ctx context.Context, name string) context.Context {
	return context.WithValue(ctx, windowKey{}, name)
}

// WindowNamer finds the calling window's name in a call's context. The app
// extends it for Wails' own window key; the default reads WithWindow.
var WindowNamer = func(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	n, _ := ctx.Value(windowKey{}).(string)
	return n
}

// windowOf names the window a call came from: the main window if none.
func windowOf(ctx context.Context) string {
	if n := WindowNamer(ctx); n != "" {
		return n
	}
	return MainWindow
}

// pendingMax bounds what queues for a window whose frontend doesn't listen
// yet: one that never loads must not hold a shell's output forever.
const pendingMax = 8192

// windowReadyWait: how long opening a window waits for its frontend.
const windowReadyWait = 15 * time.Second

// Window is one registration of a window: its delivery queue. A page that
// reloads (headless) registers again under the same name and gets a new
// one; the streams the old page opened stay with the old registration.
type Window struct {
	name string
	emit func(event string, data any)

	mu      sync.Mutex
	queue   []queued
	ready   bool
	closed  bool
	wake    chan struct{}
	readyCh chan struct{}
}

type queued struct {
	event string
	data  any
}

func newWindow(name string) *Window {
	return &Window{name: name, wake: make(chan struct{}, 1), readyCh: make(chan struct{})}
}

// push queues an event. Never blocks: the router calls it under its lock, and
// delivery (Wails: on the main thread) must not wait on that lock.
func (w *Window) push(event string, data any) {
	w.mu.Lock()
	if w.closed || (!w.ready && len(w.queue) >= pendingMax) {
		w.mu.Unlock()
		return
	}
	w.queue = append(w.queue, queued{event, data})
	ready := w.ready
	w.mu.Unlock()
	if ready {
		w.signal()
	}
}

func (w *Window) signal() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *Window) setReady() {
	w.mu.Lock()
	if w.ready {
		w.mu.Unlock()
		return
	}
	w.ready = true
	close(w.readyCh)
	w.mu.Unlock()
	w.signal()
}

func (w *Window) close() {
	w.mu.Lock()
	w.closed, w.queue = true, nil
	w.mu.Unlock()
	w.signal()
}

// run delivers the queue in order, one window's events after another.
func (w *Window) run() {
	for range w.wake {
		for {
			w.mu.Lock()
			if w.closed {
				w.mu.Unlock()
				return
			}
			q := w.queue
			w.queue = nil
			w.mu.Unlock()
			if len(q) == 0 {
				break
			}
			if w.emit != nil {
				for _, e := range q {
					w.emit(e.event, e.data)
				}
			}
		}
	}
}

// Windows routes stream events to the window owning the stream: a table
// pane's frames, a shell's output and a log tail's lines go to the window
// showing it, and follow the pane when it moves to another window. Events
// of no stream (config, port-forwards …) go to every window.
//
// Until a window registers at all (tests, the app before its first window),
// everything goes to the fallback emitter.
type Windows struct {
	mu sync.Mutex
	// byName: the current registration per window name
	byName map[string]*Window
	// owner: stream id (server pane, session) → the registration it belongs to
	owner map[string]*Window
	// seq: per session, the sequence number of its last chunk
	seq map[string]int64
	// focus: window names, most recently focused first
	focus    []string
	next     int
	host     Host
	fallback Emitter
}

// NewWindows creates a router; fallback gets the events while no window is registered.
func NewWindows(fallback Emitter) *Windows {
	return &Windows{byName: map[string]*Window{}, owner: map[string]*Window{}, seq: map[string]int64{}, fallback: fallback}
}

// SetHost sets the native window host (Wails app).
func (r *Windows) SetHost(h Host) {
	r.mu.Lock()
	r.host = h
	r.mu.Unlock()
}

func (r *Windows) hostOf() Host {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.host
}

// Register adds a window and how to deliver to it. It is ready (delivered
// to) right away unless it was reserved by NewName: a window opened to take
// a pane gets what's sent to it once its frontend listens (Ready).
// Registering a name again (a reloaded page) starts a new registration.
func (r *Windows) Register(name string, emit func(event string, data any)) *Window {
	r.mu.Lock()
	w, ok := r.byName[name]
	reserved := ok && w.emit == nil
	if !reserved {
		w = newWindow(name)
		r.byName[name] = w
	}
	w.emit = emit
	if !slices.Contains(r.focus, name) {
		r.focus = append(r.focus, name)
	}
	r.mu.Unlock()
	go w.run()
	if !reserved {
		w.setReady()
	}
	r.announce()
	return w
}

// announce tells every window which windows are open (WindowMessage kind
// "windows"): a pane's grip can be dragged to another window once there is one.
func (r *Windows) announce() {
	r.mu.Lock()
	names := slices.Sorted(maps.Keys(r.byName))
	r.mu.Unlock()
	data, _ := json.Marshal(names)
	r.Emit(WindowEvent, WindowMessage{Kind: "windows", Data: data})
}

// Unregister removes a registration and returns the streams it owned, for
// the caller to close: the window is gone, and so are its panes.
func (r *Windows) Unregister(w *Window) []string {
	r.mu.Lock()
	if r.byName[w.name] == w {
		delete(r.byName, w.name)
		r.focus = slices.DeleteFunc(r.focus, func(n string) bool { return n == w.name })
	}
	var owned []string
	for id, o := range r.owner {
		if o == w {
			owned = append(owned, id)
			delete(r.owner, id)
			delete(r.seq, id)
		}
	}
	r.mu.Unlock()
	w.close()
	r.announce()
	slices.Sort(owned)
	return owned
}

// UnregisterName removes the window's current registration (Wails: its window closed).
func (r *Windows) UnregisterName(name string) []string {
	r.mu.Lock()
	w := r.byName[name]
	r.mu.Unlock()
	if w == nil {
		return nil
	}
	return r.Unregister(w)
}

// Ready marks a window's frontend as listening; what queued meanwhile goes out.
func (r *Windows) Ready(name string) {
	r.mu.Lock()
	w := r.byName[name]
	r.mu.Unlock()
	if w != nil {
		w.setReady()
	}
}

// Focused notes a window coming to the front (the key window).
func (r *Windows) Focused(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byName[name]; !ok {
		return
	}
	r.focus = slices.DeleteFunc(r.focus, func(n string) bool { return n == name })
	r.focus = append([]string{name}, r.focus...)
}

// Front is the window most recently in front ("" if none).
func (r *Windows) Front() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.focus) == 0 {
		return ""
	}
	return r.focus[0]
}

// List returns the open windows, most recently focused first, with their
// frames as the host knows them (zero headless).
func (r *Windows) List() []WindowInfo {
	r.mu.Lock()
	names := slices.Clone(r.focus)
	host := r.host
	r.mu.Unlock()
	out := make([]WindowInfo, 0, len(names))
	for _, n := range names {
		info := WindowInfo{Name: n}
		if host != nil {
			info.Bounds, _ = host.Bounds(n)
		}
		out = append(out, info)
	}
	return out
}

// Own assigns a new stream to the named window's current registration.
func (r *Windows) Own(id, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if w := r.byName[name]; w != nil {
		r.owner[id] = w
	}
}

// Disown forgets a stream (closed).
func (r *Windows) Disown(id string) {
	r.mu.Lock()
	delete(r.owner, id)
	delete(r.seq, id)
	r.mu.Unlock()
}

// Owner names the window a stream belongs to ("" if none).
func (r *Windows) Owner(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if w := r.owner[id]; w != nil {
		return w.name
	}
	return ""
}

// Reassign moves streams to another window. It returns, per stream, the
// sequence number of the last chunk sent before the move: the old window
// hands over what it has up to it, the new one gets everything after.
// Streams that ended meanwhile are left out.
func (r *Windows) Reassign(ids []string, to string) (map[string]int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	w := r.byName[to]
	if w == nil {
		return nil, fmt.Errorf("no window %q", to)
	}
	seqs := map[string]int64{}
	for _, id := range ids {
		if _, ok := r.owner[id]; !ok {
			continue
		}
		r.owner[id] = w
		seqs[id] = r.seq[id]
	}
	return seqs, nil
}

// emitStream sends a stream's event to the window owning it; data gets the
// event's sequence number in that stream, assigned under the same lock as
// the routing, so a Reassign splits the stream exactly.
func (r *Windows) emitStream(id, event string, data func(seq int64) any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq[id]++
	d := data(r.seq[id])
	if w := r.owner[id]; w != nil {
		w.push(event, d)
		return
	}
	if len(r.byName) == 0 && r.fallback != nil {
		r.fallback.Emit(event, d)
	}
	// owned by no window: it was closed (or is closing with its window)
}

// EmitWindow sends an event to one window.
func (r *Windows) EmitWindow(name, event string, data any) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	w := r.byName[name]
	if w == nil {
		return false
	}
	w.push(event, data)
	return true
}

// Emit sends an event to every window (Emitter).
func (r *Windows) Emit(event string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.byName) == 0 {
		if r.fallback != nil {
			r.fallback.Emit(event, data)
		}
		return
	}
	for _, w := range r.byName {
		w.push(event, data)
	}
}

// NewName reserves a name for a window about to open (w1, w2 …); it
// registers when it connects (Register), and gets events once Ready.
func (r *Windows) NewName() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	name := fmt.Sprintf("w%d", r.next)
	r.byName[name] = newWindow(name)
	return name
}

// AwaitReady waits until the named window's frontend listens, or ctx ends.
func (r *Windows) AwaitReady(ctx context.Context, name string) error {
	r.mu.Lock()
	w := r.byName[name]
	r.mu.Unlock()
	if w == nil {
		return fmt.Errorf("no window %q", name)
	}
	select {
	case <-w.readyCh:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("window %s didn't load: %w", name, ctx.Err())
	}
}

// --- Service API (bound for the frontend through app.App) ---

// OpenWindow opens a new window at bounds (points, top-left origin) and
// returns its name once its frontend listens. Headless there is no host:
// the page opens the window itself (window.open with the name, then
// AwaitWindow).
func (s *Service) OpenWindow(bounds Rect) (string, error) {
	name := s.win.NewName()
	h := s.win.hostOf()
	if h == nil {
		return name, nil
	}
	h.OpenWindow(name, bounds)
	if err := s.AwaitWindow(name); err != nil {
		h.CloseWindow(name)
		return "", err
	}
	return name, nil
}

// AwaitWindow waits for a new window's frontend to listen.
func (s *Service) AwaitWindow(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), windowReadyWait)
	defer cancel()
	return s.win.AwaitReady(ctx, name)
}

// WindowReady: the calling window's frontend listens now.
func (s *Service) WindowReady(ctx context.Context) { s.win.Ready(windowOf(ctx)) }

// CloseWindow closes a window other than the main one (its last pane moved
// away); what it still shows closes with it.
func (s *Service) CloseWindow(name string) {
	if name == MainWindow {
		return
	}
	if h := s.win.hostOf(); h != nil {
		h.CloseWindow(name) // the host calls WindowClosed as it goes
		return
	}
	s.WindowClosed(name)
}

// WindowClosed: a window is gone; the streams it still owned close.
func (s *Service) WindowClosed(name string) { s.closeStreams(s.win.UnregisterName(name)) }

// ConnectionClosed: a page's connection is gone (headless); so are its streams.
func (s *Service) ConnectionClosed(w *Window) { s.closeStreams(s.win.Unregister(w)) }

func (s *Service) closeStreams(ids []string) {
	for _, id := range ids {
		s.mu.Lock()
		_, isPane := s.panes[id]
		s.mu.Unlock()
		if isPane {
			_ = s.Close(id)
		} else {
			_ = s.SessionClose(id)
		}
	}
}

// Windows lists the open windows, most recently focused first.
func (s *Service) Windows() []WindowInfo { return s.win.List() }

// Pointer is the mouse during a pane's drag, and the window under it; ok
// false headless (no host: the page works it out itself).
func (s *Service) Pointer() (PointerInfo, bool) {
	h := s.win.hostOf()
	if h == nil {
		return PointerInfo{}, false
	}
	return h.Pointer(), true
}

// Reassign hands streams (server panes, sessions) to another window; it
// returns per stream the sequence number of the last event sent before.
func (s *Service) Reassign(ids []string, to string) (map[string]int64, error) {
	return s.win.Reassign(ids, to)
}

// SendWindow delivers a message from the calling window to another one.
func (s *Service) SendWindow(ctx context.Context, to, kind string, data json.RawMessage) error {
	if !s.win.EmitWindow(to, WindowEvent, WindowMessage{From: windowOf(ctx), Kind: kind, Data: data}) {
		return fmt.Errorf("no window %q", to)
	}
	return nil
}

// Router is the service's window router: the app registers windows with it.
func (s *Service) Router() *Windows { return s.win }
