package app

import (
	"context"
	"net/url"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/dguendisch/kubewing/internal/bridge"
)

func init() {
	// Wails puts the calling window in a bound method's context
	base := bridge.WindowNamer
	bridge.WindowNamer = func(ctx context.Context) string {
		if ctx != nil {
			if w, ok := ctx.Value(application.WindowKey).(application.Window); ok && w.Name() != "" {
				return w.Name()
			}
		}
		return base(ctx)
	}
}

// Windows opens kubewing's windows in the Wails app and registers them with
// the bridge's router: events go to the window they're for, a window coming
// to the front is noted (menu clicks and launches go to it), and a closing
// window takes the panes it shows with it.
type Windows struct {
	app    *application.App
	svc    *bridge.Service
	router *bridge.Windows
	// opts are the main window's options; detached windows look the same
	opts application.WebviewWindowOptions

	mu sync.Mutex
}

// NewWindows creates the host and sets it on the service's router.
func NewWindows(a *application.App, svc *bridge.Service, opts application.WebviewWindowOptions) *Windows {
	h := &Windows{app: a, svc: svc, router: svc.Router(), opts: opts}
	h.router.SetHost(h)
	return h
}

// Track registers a window: events for it, its focus, its closing.
func (h *Windows) Track(w *application.WebviewWindow) {
	name := w.Name()
	h.router.Register(name, func(event string, data any) {
		w.DispatchWailsEvent(&application.CustomEvent{Name: event, Data: data})
	})
	w.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) { h.router.Focused(name) })
	// the window is gone (red button, or its last pane moved away): what it showed ends
	w.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
		go h.svc.WindowClosed(name) // closing sessions may wait; not on the main thread
	})
}

// OpenWindow implements bridge.Host: a window like the main one, at bounds.
func (h *Windows) OpenWindow(name string, b bridge.Rect) {
	opts := h.opts
	opts.Name = name
	opts.URL = "/?window=" + url.QueryEscape(name)
	if b.W > 0 && b.H > 0 {
		opts.Width, opts.Height = max(b.W, minWindowWidth), max(b.H, minWindowHeight)
	}
	w := h.app.Window.NewWithOptions(opts)
	if b.W > 0 && b.H > 0 {
		// before Wails shows it (it does in a listener of this event; hooks run first)
		var once sync.Once
		w.RegisterHook(events.Mac.WebViewDidFinishNavigation, func(*application.WindowEvent) {
			once.Do(func() { w.SetPosition(b.X, b.Y) })
		})
	}
	h.Track(w)
}

// CloseWindow implements bridge.Host.
func (h *Windows) CloseWindow(name string) {
	if w, ok := h.app.Window.GetByName(name); ok && w != nil {
		w.Close()
		return
	}
	h.svc.WindowClosed(name)
}

// Bounds implements bridge.Host: the window's frame in screen points, top-left origin.
func (h *Windows) Bounds(name string) (bridge.Rect, bool) {
	w, ok := h.app.Window.GetByName(name)
	if !ok || w == nil {
		return bridge.Rect{}, false
	}
	r := w.Bounds()
	return bridge.Rect{X: r.X, Y: r.Y, W: r.Width, H: r.Height}, true
}

// Front is the window in front (a menu click, a launch from a terminal, are
// for it); nil if none.
func (h *Windows) Front() *application.WebviewWindow {
	if name := h.router.Front(); name != "" {
		if w, ok := h.app.Window.GetByName(name); ok {
			if ww, ok := w.(*application.WebviewWindow); ok {
				return ww
			}
		}
	}
	return nil
}

// EmitFront sends an event to the window in front only (menu commands, a launch).
func (h *Windows) EmitFront(event string, data any) {
	if name := h.router.Front(); name == "" || !h.router.EmitWindow(name, event, data) {
		h.router.Emit(event, data)
	}
}
