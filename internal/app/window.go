package app

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/dguendisch/kubewing/internal/config"
)

// Smallest remembered size that is reapplied; anything smaller is a broken history.
const minWindowWidth, minWindowHeight = 400, 300

// NewMainWindow opens the main window with the size it had when kubewing last
// closed (history.yaml), maximised or fullscreen again. It opens centred on
// the display macOS picks.
func NewMainWindow(a *application.App, h *config.HistoryStore, opts application.WebviewWindowOptions) *application.WebviewWindow {
	saved := h.Get().Window
	if saved != nil && (saved.Width < minWindowWidth || saved.Height < minWindowHeight) {
		saved = nil
	}
	// until the window is resized: the default size
	k := &windowKeeper{store: h, normal: config.Window{Width: opts.Width, Height: opts.Height}}
	if saved != nil {
		opts.Width, opts.Height = saved.Width, saved.Height
		k.normal = config.Window{Width: saved.Width, Height: saved.Height}
	}
	k.w = a.Window.NewWithOptions(opts)
	if saved != nil {
		// Wails shows the window in a listener of this event; hooks run before it,
		// so it appears in its size right away.
		var once sync.Once
		k.w.RegisterHook(events.Mac.WebViewDidFinishNavigation, func(*application.WindowEvent) {
			once.Do(func() { k.restore(*saved) })
		})
	}
	if saved != nil && saved.State == config.WindowFullscreen {
		// a window that isn't on screen yet can't enter fullscreen
		var once sync.Once
		k.w.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) { once.Do(func() { k.w.Fullscreen() }) })
	}
	k.w.OnWindowEvent(events.Common.WindowDidResize, func(*application.WindowEvent) { k.changed() })
	// Closing the last window (it quits the app) and ⌘Q: whichever comes first, while the window still exists.
	k.w.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { k.save() })
	a.OnShutdown(k.save)
	return k.w
}

type windowKeeper struct {
	w     *application.WebviewWindow
	store *config.HistoryStore
	saved atomic.Bool

	mu sync.Mutex
	// normal is the last size the window had while neither maximised nor fullscreen.
	normal config.Window
	timer  *time.Timer
}

func (k *windowKeeper) restore(p config.Window) {
	width, height := p.Width, p.Height
	if s, err := k.w.GetScreen(); err == nil && s != nil && s.WorkArea.Width > 0 && s.WorkArea.Height > 0 {
		// the display may be smaller than the one it was closed on
		width, height = min(width, s.WorkArea.Width), min(height, s.WorkArea.Height)
	}
	k.w.SetSize(width, height) // also when unchanged: Wails creates it a point smaller
	k.w.Center()
	if p.State == config.WindowMaximised {
		maximiseNow(k.w)
	}
}

// changed notes a resize; the size is read once it settles.
func (k *windowKeeper) changed() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.timer == nil {
		k.timer = time.AfterFunc(300*time.Millisecond, k.track)
	} else {
		k.timer.Reset(300 * time.Millisecond)
	}
}

func (k *windowKeeper) track() {
	if p, ok := k.current(); ok && p.State == config.WindowNormal {
		k.mu.Lock()
		k.normal = p
		k.mu.Unlock()
	}
}

func (k *windowKeeper) save() {
	p, ok := k.current()
	if !ok || !k.saved.CompareAndSwap(false, true) {
		return
	}
	if p.State != config.WindowNormal {
		// a maximised or fullscreen window keeps the size it un-maximises to
		state := p.State
		p = k.normalCopy()
		p.State = state
	}
	_ = k.store.SetWindow(p)
}

// current reads the window's size and state; false once the window is gone.
// A minimised window counts as normal.
func (k *windowKeeper) current() (config.Window, bool) {
	var p config.Window
	switch {
	case k.w.IsFullscreen():
		p.State = config.WindowFullscreen
	case k.w.IsMaximised():
		p.State = config.WindowMaximised
	case k.w.IsMinimised():
		return k.normalCopy(), true
	}
	p.Width, p.Height = k.w.Size()
	return p, p.Width > 0 && p.Height > 0
}

func (k *windowKeeper) normalCopy() config.Window {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.normal
}
