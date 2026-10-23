package app

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework QuartzCore
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

// Wails' WebviewWindow animates zoom: (maximise) itself, frame by frame on a timer.
@protocol kwZoomAnimation
- (BOOL)zoomAnimationIsRunning;
- (void)stepZoomAnimationAtTime:(CFTimeInterval)time;
@end

static void finishZoomAnimation(void *w) {
	id win = (id)w;
	if (![win respondsToSelector:@selector(zoomAnimationIsRunning)] ||
		![win respondsToSelector:@selector(stepZoomAnimationAtTime:)] ||
		![(id<kwZoomAnimation>)win zoomAnimationIsRunning]) {
		return;
	}
	// a step past its end applies the target frame and stops the animation
	[(id<kwZoomAnimation>)win stepZoomAnimationAtTime:CACurrentMediaTime() + 3600];
}
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// maximiseNow maximises w without Wails' zoom animation: on a window that
// isn't shown yet, the animation would play once it appears.
func maximiseNow(w *application.WebviewWindow) {
	w.Maximise()
	if p := w.NativeWindow(); p != nil {
		application.InvokeSync(func() { C.finishZoomAnimation(p) })
	}
}
