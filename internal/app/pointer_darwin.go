package app

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// The mouse on screen, in points with the origin at the primary screen's
// top-left (as Wails' window frames), and the number of the frontmost
// window under it (0: none).
static void kwPointer(double *x, double *y, long *number) {
	NSPoint p = [NSEvent mouseLocation];
	NSScreen *primary = [[NSScreen screens] firstObject];
	CGFloat h = primary ? primary.frame.size.height : 0;
	*x = p.x;
	*y = h - p.y;
	*number = (long)[NSWindow windowNumberAtPoint:p belowWindowWithWindowNumber:0];
}

static long kwWindowNumber(void *w) { return (long)[(NSWindow *)w windowNumber]; }

// A screen point (top-left origin) in w's content view: points from its top-left.
static void kwInWindow(void *w, double sx, double sy, double *x, double *y) {
	NSWindow *win = (NSWindow *)w;
	NSScreen *primary = [[NSScreen screens] firstObject];
	CGFloat h = primary ? primary.frame.size.height : 0;
	NSPoint p = [win convertPointFromScreen:NSMakePoint(sx, h - sy)];
	NSRect content = [win contentRectForFrameRect:win.frame];
	*x = p.x;
	*y = content.size.height - p.y;
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/dguendisch/kubewing/internal/bridge"
)

// Pointer implements bridge.Host: where the mouse is, and which of
// kubewing's windows is frontmost under it (AppKit's own window order), with
// the point inside that window's page.
func (h *Windows) Pointer() bridge.PointerInfo {
	var info bridge.PointerInfo
	application.InvokeSync(func() {
		var x, y C.double
		var number C.long
		C.kwPointer(&x, &y, &number)
		info.X, info.Y = float64(x), float64(y)
		if number == 0 {
			return
		}
		for _, w := range h.app.Window.GetAll() {
			ww, ok := w.(*application.WebviewWindow)
			if !ok || ww.Name() == "" {
				continue
			}
			p := ww.NativeWindow()
			if p == nil || C.kwWindowNumber(p) != number {
				continue
			}
			var cx, cy C.double
			C.kwInWindow(p, x, y, &cx, &cy)
			info.Window, info.InX, info.InY = ww.Name(), float64(cx), float64(cy)
			return
		}
		info.Other = true // another app's window, or the desktop
	})
	return info
}
