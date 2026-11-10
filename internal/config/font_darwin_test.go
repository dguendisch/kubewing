package config

import "testing"

// CoreText finds system fonts by family and by full name, and not a made-up one.
func TestSystemFontInstalled(t *testing.T) {
	for name, want := range map[string]bool{
		"Menlo":                 true,
		"menlo":                 true,
		"Menlo Regular":         true,
		"Helvetica":             true,
		"No Such Font Anywhere": false,
		"":                      false,
	} {
		if got := systemFontInstalled(name); got != want {
			t.Errorf("%q: installed %v, want %v", name, got, want)
		}
	}
}
