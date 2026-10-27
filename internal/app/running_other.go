//go:build !darwin

package app

// Running: unknown off macOS (Wails locks differently there), so a launch
// detaches and the detached one hands over, silently.
func Running(configDir string) bool { return false }
