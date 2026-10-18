// Package app is the Wails-bound service: a thin adapter over bridge.Service
// so the generated TS bindings and the WebSocket transport expose the same API.
package app

import (
	"github.com/dguendisch/kubewing/internal/bridge"
	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/view"
)

// App is bound to the frontend.
type App struct {
	svc *bridge.Service
	// Contexts lists available clusters; overridable for tests.
	ContextsFn func() (bridge.ContextList, error)
}

// New wraps a service.
func New(svc *bridge.Service) *App {
	return &App{svc: svc, ContextsFn: KubeContexts}
}

func (a *App) Open(pipelineYAML string) (bridge.OpenResult, error) { return a.svc.Open(pipelineYAML) }
func (a *App) Update(pane, pipelineYAML string) error              { return a.svc.Update(pane, pipelineYAML) }
func (a *App) SetViewport(pane string, offset, limit int) error {
	return a.svc.SetViewport(pane, offset, limit)
}
func (a *App) Resync(pane string) error                     { return a.svc.Resync(pane) }
func (a *App) Object(pane, key string) (view.Detail, error) { return a.svc.Object(pane, key) }
func (a *App) Close(pane string) error                      { return a.svc.Close(pane) }
func (a *App) Contexts() (bridge.ContextList, error)        { return a.ContextsFn() }
func (a *App) Catalog(context string) catalog.Snapshot      { return a.svc.Catalog(context) }
func (a *App) Config() config.Effective                     { return a.svc.Config() }
func (a *App) ReloadConfig() config.Effective               { return a.svc.ReloadConfig() }
func (a *App) ContextRule(cluster string) (safety.Rule, error) {
	return a.svc.ContextRule(cluster)
}
func (a *App) Prepare(kind, pane, key string) (safety.Pending, error) {
	return a.svc.Prepare(kind, pane, key)
}
func (a *App) Delete(token string) error                 { return a.svc.Delete(token) }
func (a *App) Describe(pane, key string) (string, error) { return a.svc.Describe(pane, key) }
func (a *App) ExecStart(token, container string, cols, rows int) (bridge.ExecResult, error) {
	return a.svc.ExecStart(token, container, cols, rows)
}
func (a *App) SessionInput(id, data string) error { return a.svc.SessionInput(id, data) }
func (a *App) SessionResize(id string, cols, rows int) error {
	return a.svc.SessionResize(id, cols, rows)
}
func (a *App) SessionClose(id string) error { return a.svc.SessionClose(id) }
func (a *App) PortForwardStart(pane, key string, ports []string) (bridge.PortForwardInfo, error) {
	return a.svc.PortForwardStart(pane, key, ports)
}
func (a *App) PortForwards() []bridge.PortForwardInfo { return a.svc.PortForwards() }
func (a *App) PortForwardStop(id string) error        { return a.svc.PortForwardStop(id) }

// KubeContexts reads contexts from kubeconfig.
func KubeContexts() (bridge.ContextList, error) {
	names, cur, err := source.Contexts()
	if err != nil {
		return bridge.ContextList{}, err
	}
	return bridge.ContextList{Contexts: names, Current: cur}, nil
}
