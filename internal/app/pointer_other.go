//go:build !darwin

package app

import "github.com/dguendisch/kubewing/internal/bridge"

// Pointer implements bridge.Host: unknown off macOS (the page's own screen coordinates are used).
func (h *Windows) Pointer() bridge.PointerInfo { return bridge.PointerInfo{} }
