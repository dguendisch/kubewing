//go:build !darwin

package app

import "github.com/wailsapp/wails/v3/pkg/application"

func maximiseNow(w *application.WebviewWindow) { w.Maximise() }
