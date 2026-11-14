package app

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdlib.h>

// AppKit has no display-only key equivalent: an enabled item fires on its
// keys whenever the page leaves them unhandled, a plain letter typed into a
// text field too. So a menu's display-only items are disabled while it is
// closed (autoenablesItems is off in Wails' menus) and enabled while it is
// open, to look and click like any other item.
@interface KWKeyGuard : NSObject <NSMenuDelegate>
@property (nonatomic, retain) NSArray<NSMenuItem *> *items;
@end

@implementation KWKeyGuard
- (void)dealloc {
	[_items release];
	[super dealloc];
}
- (void)disarm {
	for (NSMenuItem *i in self.items) i.enabled = NO;
}
- (void)menuWillOpen:(NSMenu *)menu {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(disarm) object:nil];
	for (NSMenuItem *i in self.items) i.enabled = YES;
}
- (void)menuDidClose:(NSMenu *)menu {
	// once tracking is over: AppKit sends a clicked item's action after this
	[self performSelector:@selector(disarm) withObject:nil afterDelay:0 inModes:@[NSDefaultRunLoopMode]];
}
@end

static char kwKeyGuardKey;

static void guardMenu(NSMenu *menu, NSString *prefix, NSSet<NSString *> *paths) {
	NSMutableArray<NSMenuItem *> *guarded = [NSMutableArray array];
	for (NSMenuItem *i in menu.itemArray) {
		NSString *path = prefix ? [NSString stringWithFormat:@"%@\t%@", prefix, i.title] : i.title;
		if (i.submenu) {
			guardMenu(i.submenu, path, paths);
		} else if ([paths containsObject:path]) {
			[guarded addObject:i];
		}
	}
	if (guarded.count == 0 || menu.delegate) return; // never replace a delegate of Wails' own
	KWKeyGuard *g = [[KWKeyGuard alloc] init];
	g.items = guarded;
	[g disarm];
	menu.delegate = g; // a weak reference: the menu keeps it as an associated object
	objc_setAssociatedObject(menu, &kwKeyGuardKey, g, OBJC_ASSOCIATION_RETAIN);
	[g release];
}

// paths: "\n"-separated, each one the "\t"-separated titles from a top-level menu down to an item
static void guardMainMenu(char *paths) {
	NSArray<NSString *> *list = [[NSString stringWithUTF8String:paths] componentsSeparatedByString:@"\n"];
	free(paths);
	NSMenu *main = [NSApp mainMenu];
	if (main) guardMenu(main, nil, [NSSet setWithArray:list]);
}
*/
import "C"

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const canGuardKeys = true

// guardMenuKeys disarms the main menu's items at paths (titles joined by
// menuPathSep) while their menu is closed.
func guardMenuKeys(paths []string) {
	application.InvokeSync(func() { C.guardMainMenu(C.CString(strings.Join(paths, "\n"))) })
}
