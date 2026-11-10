//go:build !darwin

package config

// systemFontInstalled can't tell off macOS: every font counts as installed (none reported).
func systemFontInstalled(string) bool { return true }
