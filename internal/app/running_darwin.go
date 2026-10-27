package app

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#include <stdlib.h>
#import <Foundation/Foundation.h>

static char* kwTempDir() { return strdup([NSTemporaryDirectory() UTF8String]); }
*/
import "C"

import "unsafe"

// Running reports whether a kubewing holds the single-instance lock of
// configDir, i.e. a launch on it hands over and exits. Wails' lock file
// (single_instance_darwin.go): NSTemporaryDirectory(), not $TMPDIR.
func Running(configDir string) bool {
	dir := C.kwTempDir()
	path := C.GoString(dir) + InstanceID(configDir) + ".lock"
	C.free(unsafe.Pointer(dir))
	return locked(path)
}
