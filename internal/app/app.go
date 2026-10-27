// Package app is the Wails-bound service: a thin adapter over bridge.Service
// so the generated TS bindings and the WebSocket transport expose the same API.
package app

import (
	"github.com/dguendisch/kubewing/internal/bridge"
	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/relations"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/view"
)

// App is bound to the frontend.
type App struct {
	svc *bridge.Service
	// Contexts lists the contexts of a cluster's kubeconfig ("" = kubewing's own); overridable for tests.
	ContextsFn func(cluster string) (bridge.ContextList, error)
	// MenuFn installs the native menu (see menu.go); nil without one (headless, tests).
	MenuFn func([]Menu)
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
func (a *App) Preview(pane string, d bridge.Draft) (view.Preview, error) {
	return a.svc.Preview(pane, d)
}
func (a *App) FieldKeys(pane string, path []string) (bridge.FieldKeys, error) {
	return a.svc.FieldKeys(pane, path)
}
func (a *App) FieldValues(pane string, path []string) (bridge.FieldValues, error) {
	return a.svc.FieldValues(pane, path)
}
func (a *App) ColumnChoices(pane string) (view.ColumnChoices, error) {
	return a.svc.ColumnChoices(pane)
}
func (a *App) ColumnConfigs() map[string]config.TypeView { return a.svc.ColumnConfigs() }
func (a *App) SetTypeColumns(typ string, cols []pipeline.Column) error {
	return a.svc.SetTypeColumns(typ, cols)
}
func (a *App) SetColumnWidths(typ string, widths map[string]int) error {
	return a.svc.SetColumnWidths(typ, widths)
}
func (a *App) Resync(pane string) error                     { return a.svc.Resync(pane) }
func (a *App) Object(pane, key string) (view.Detail, error) { return a.svc.Object(pane, key) }
func (a *App) ObjectAt(pane, key string, to int) (view.Detail, error) {
	return a.svc.ObjectAt(pane, key, to)
}
func (a *App) SetRecording(pane string, on bool) error        { return a.svc.SetRecording(pane, on) }
func (a *App) SetTime(pane, at string) (view.Timeline, error) { return a.svc.SetTime(pane, at) }
func (a *App) Step(pane string, dir int) (bridge.StepResult, error) {
	return a.svc.Step(pane, dir)
}
func (a *App) Timeline(pane string) (view.Timeline, error) { return a.svc.Timeline(pane) }
func (a *App) FieldHistory(pane, key string, to, line int, which string) (view.FieldHistory, error) {
	return a.svc.FieldHistory(pane, key, to, line, which)
}
func (a *App) Decode(pane string, req view.DecodeRequest) (view.Decoded, error) {
	return a.svc.Decode(pane, req)
}
func (a *App) Close(pane string) error                             { return a.svc.Close(pane) }
func (a *App) Contexts(cluster string) (bridge.ContextList, error) { return a.ContextsFn(cluster) }
func (a *App) Catalog(context string) catalog.Snapshot             { return a.svc.Catalog(context) }
func (a *App) Config() config.Effective                            { return a.svc.Config() }
func (a *App) ReloadConfig() config.Effective                      { return a.svc.ReloadConfig() }
func (a *App) ContextRule(context string) safety.Rule              { return a.svc.ContextRule(context) }
func (a *App) Prepare(kind, pane, key string) (safety.Pending, error) {
	return a.svc.Prepare(kind, pane, key)
}
func (a *App) Delete(token string) error { return a.svc.Delete(token) }
func (a *App) EditOpen(pane, key string) (bridge.EditSession, error) {
	return a.svc.EditOpen(pane, key)
}
func (a *App) EditCheck(session, yaml string) (bridge.EditPreview, error) {
	return a.svc.EditCheck(session, yaml)
}
func (a *App) EditApply(token, session, yaml string) error {
	return a.svc.EditApply(token, session, yaml)
}
func (a *App) EditClose(session string) { a.svc.EditClose(session) }
func (a *App) Describe(pane, key string) (bridge.DescribeResult, error) {
	return a.svc.Describe(pane, key)
}
func (a *App) RowInfo(pane, key string) (bridge.RowInfo, error) { return a.svc.RowInfo(pane, key) }
func (a *App) RowIndex(pane, key string) (int, error)           { return a.svc.RowIndex(pane, key) }
func (a *App) Relations(pane, key string) (bridge.Relations, error) {
	return a.svc.Relations(pane, key)
}
func (a *App) EventsTarget(pane, key string) (relations.Target, error) {
	return a.svc.EventsTarget(pane, key)
}
func (a *App) OwnedScan(pane, key string) (bridge.OwnedScanResult, error) {
	return a.svc.OwnedScan(pane, key)
}
func (a *App) ExecStart(token, container string, cols, rows int) (bridge.ExecResult, error) {
	return a.svc.ExecStart(token, container, cols, rows)
}
func (a *App) DebugStart(token string, o bridge.DebugOptions, cols, rows int) (bridge.DebugResult, error) {
	return a.svc.DebugStart(token, o, cols, rows)
}
func (a *App) DebugImages() []string                 { return a.svc.DebugImages() }
func (a *App) Nodes(cluster string) bridge.NodeList  { return a.svc.Nodes(cluster) }
func (a *App) OpsPodDefaults() bridge.OpsPodDefaults { return a.svc.OpsPodDefaults() }
func (a *App) OpsPodTarget(pane, key string) (bridge.OpsPodTarget, error) {
	return a.svc.OpsPodTargetFor(pane, key)
}
func (a *App) PrepareOpsPod(cluster, node string) (safety.Pending, error) {
	return a.svc.PrepareOpsPod(cluster, node)
}
func (a *App) PersistentVolumes(cluster string) bridge.PVList {
	return a.svc.PersistentVolumes(cluster)
}
func (a *App) OpsPodManifest(cluster, node string, o bridge.OpsPodOptions) (string, error) {
	return a.svc.OpsPodManifest(cluster, node, o)
}
func (a *App) CheckOpsPod(cluster, node string, o bridge.OpsPodOptions) error {
	return a.svc.CheckOpsPod(cluster, node, o)
}
func (a *App) OpsPodStart(token string, o bridge.OpsPodOptions, cols, rows int) (bridge.OpsPodResult, error) {
	return a.svc.OpsPodStart(token, o, cols, rows)
}
func (a *App) RemoveDebugImage(image string) ([]string, error) {
	return a.svc.RemoveDebugImage(image)
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
func (a *App) LogsTargets(pane, key string, whole bool) (bridge.LogsTargets, error) {
	return a.svc.LogsTargets(pane, key, whole)
}
func (a *App) LogsStart(pane, key string, whole bool, o bridge.LogsOptions) (bridge.LogsResult, error) {
	return a.svc.LogsStart(pane, key, whole, o)
}

// SetMenu replaces the native menu's command menus; the frontend builds them
// from its merged keymap (keys/appMenu.ts) and resends them on config changes.
func (a *App) SetMenu(menus []Menu) {
	if a.MenuFn != nil {
		a.MenuFn(menus)
	}
}
