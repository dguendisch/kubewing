package config

/*
#cgo LDFLAGS: -framework CoreText -framework CoreFoundation
#include <CoreText/CoreText.h>
#include <stdlib.h>

static int sameName(CFStringRef a, CFStringRef b) {
	return a && b && CFStringCompare(a, b, kCFCompareCaseInsensitive) == kCFCompareEqualTo;
}

// Whether a font family (as Font Book lists it) or a font's full or
// PostScript name is installed: what WebKit's font-family matches, user
// fonts (~/Library/Fonts) included.
static int fontInstalled(const char *cname) {
	CFStringRef name = CFStringCreateWithCString(NULL, cname, kCFStringEncodingUTF8);
	if (!name) return 0;
	int found = 0;
	CFArrayRef families = CTFontManagerCopyAvailableFontFamilyNames();
	if (families) {
		for (CFIndex i = 0, n = CFArrayGetCount(families); i < n && !found; i++)
			found = sameName(name, (CFStringRef)CFArrayGetValueAtIndex(families, i));
		CFRelease(families);
	}
	if (!found) {
		// CoreText falls back to another font for an unknown name: it's this one only if a name matches
		CTFontRef f = CTFontCreateWithName(name, 12, NULL);
		if (f) {
			CFStringRef full = CTFontCopyFullName(f), ps = CTFontCopyPostScriptName(f);
			found = sameName(name, full) || sameName(name, ps);
			if (full) CFRelease(full);
			if (ps) CFRelease(ps);
			CFRelease(f);
		}
	}
	CFRelease(name);
	return found;
}
*/
import "C"

import "unsafe"

// systemFontInstalled asks CoreText (see fontInstalled above).
func systemFontInstalled(name string) bool {
	c := C.CString(name)
	defer C.free(unsafe.Pointer(c))
	return C.fontInstalled(c) != 0
}
