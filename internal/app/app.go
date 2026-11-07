// Package app is the Wails-bound service: a thin adapter over bridge.Service
// so the generated TS bindings and the WebSocket transport expose the same API.
package app

import (
	"context"
	"errors"
	"net/url"

	"github.com/dguendisch/kubewing/internal/bridge"
	"github.com/dguendisch/kubewing/internal/catalog"
	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/relations"
	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/update"
	"github.com/dguendisch/kubewing/internal/view"
)

// App is bound to the frontend.
type App struct {
	svc *bridge.Service
	// Contexts lists the contexts of a cluster's kubeconfig ("" = kubewing's own); overridable for tests.
	ContextsFn func(cluster string) (bridge.ContextList, error)
	// MenuFn installs the native menu (see menu.go); nil without one (headless, tests).
	MenuFn func([]Menu)
	// Updater checks for and installs new versions; nil = none (tests).
	Updater *update.Updater
	// OpenURLFn opens a link in the browser; nil = links aren't opened (headless: the page opens them).
	OpenURLFn func(string) error
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
func (a *App) Labels(pane, key, others string) (bridge.LabelCounts, error) {
	return a.svc.Labels(pane, key, others)
}
func (a *App) ColumnChoices(pane string) (view.ColumnChoices, error) {
	return a.svc.ColumnChoices(pane)
}
func (a *App) ColumnConfigs() map[string]config.TypeView { return a.svc.ColumnConfigs() }
func (a *App) SetTypeColumns(typ string, cols []pipeline.Column) error {
	return a.svc.SetTypeColumns(typ, cols)
}
func (a *App) SetTypeMetrics(typ, group string, cols []pipeline.Column, place *config.MetricsPlace) error {
	return a.svc.SetTypeMetrics(typ, group, cols, place)
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
func (a *App) ReloadConfig() config.Effective {
	cfg := a.svc.ReloadConfig()
	a.configureUpdater(cfg)
	return cfg
}
func (a *App) ConfigFile() (bridge.ConfigFile, error) { return a.svc.ConfigFile() }
func (a *App) CheckConfig(text string) []string       { return a.svc.CheckConfig(text) }
func (a *App) SaveConfig(text string) (config.Effective, error) {
	cfg, err := a.svc.SaveConfig(text)
	if err == nil {
		a.configureUpdater(cfg)
	}
	return cfg, err
}
func (a *App) Reconnect(cluster string) int                      { return a.svc.Reconnect(cluster) }
func (a *App) Refresh(pane string) error                         { return a.svc.Refresh(pane) }
func (a *App) Skipped(pane string) ([]source.SkippedType, error) { return a.svc.Skipped(pane) }
func (a *App) ContextRule(context string) safety.Rule            { return a.svc.ContextRule(context) }
func (a *App) Clusters() bridge.ClusterList                      { return a.svc.Clusters() }
func (a *App) MatchTarget(text string) ([]bridge.ClusterEntry, error) {
	return a.svc.MatchTarget(text)
}
func (a *App) OpenCluster(e bridge.ClusterEntry) (bridge.ClusterOpen, error) {
	return a.svc.OpenCluster(e)
}
func (a *App) ForgetCluster(e bridge.ClusterEntry) error { return a.svc.ForgetCluster(e) }
func (a *App) OtherPlane(cluster, namespace string) (bridge.ClusterOpen, error) {
	return a.svc.OtherPlane(cluster, namespace)
}
func (a *App) Prepare(kind, pane, key string) (safety.Pending, error) {
	return a.svc.Prepare(kind, pane, key)
}
func (a *App) Delete(token string) error                     { return a.svc.Delete(token) }
func (a *App) Mark(pane string, op view.MarkOp) (int, error) { return a.svc.Mark(pane, op) }
func (a *App) Marked(pane string) ([]bridge.MarkedRow, error) {
	return a.svc.Marked(pane)
}
func (a *App) PrepareMarked(kind, pane string) (bridge.MarkedBatch, error) {
	return a.svc.PrepareMarked(kind, pane)
}
func (a *App) RowMeta(pane, key string) (bridge.RowMeta, error) {
	return a.svc.RowMeta(pane, key)
}
func (a *App) Label(token string, c bridge.MetaChanges) error    { return a.svc.Label(token, c) }
func (a *App) Annotate(token string, c bridge.MetaChanges) error { return a.svc.Annotate(token, c) }
func (a *App) Scale(token string, replicas int64) error          { return a.svc.Scale(token, replicas) }
func (a *App) Restart(token string) error                        { return a.svc.Restart(token) }
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
func (a *App) FieldRefs(pane, text string) ([]bridge.FieldMark, error) {
	return a.svc.FieldRefs(pane, text)
}
func (a *App) FieldRelations(pane, text string, line int) ([]relations.Relation, error) {
	return a.svc.FieldRelations(pane, text, line)
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
func (a *App) PrepareTerminal(cluster, namespace string) (safety.Pending, error) {
	return a.svc.PrepareTerminal(cluster, namespace)
}
func (a *App) TerminalStart(token string, cols, rows int) (bridge.TerminalResult, error) {
	return a.svc.TerminalStart(token, cols, rows)
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

// StartUpdater applies the config to the updater and runs its schedule until ctx ends.
func (a *App) StartUpdater(ctx context.Context) {
	if a.Updater == nil {
		return
	}
	a.configureUpdater(a.svc.Config())
	go a.Updater.Run(ctx)
}

func (a *App) configureUpdater(cfg config.Effective) {
	if a.Updater != nil {
		a.Updater.Configure(cfg.Config.Update.Days(), cfg.Config.Update.Prereleases)
	}
}

// UpdateStatus is the update state (also pushed as update.Event on every change).
func (a *App) UpdateStatus() update.Status {
	if a.Updater == nil {
		return update.Status{Current: Version, Released: update.Released(Version), CannotInstall: "updates are off in this build"}
	}
	return a.Updater.Status()
}

// CheckUpdate checks the releases now.
func (a *App) CheckUpdate() (update.Status, error) {
	if a.Updater == nil {
		return a.UpdateStatus(), errors.New("updates are off in this build")
	}
	return a.Updater.Check(context.Background())
}

// SkipUpdate hides the hint for version until a newer one is out ("" = undo).
func (a *App) SkipUpdate(version string) update.Status {
	if a.Updater == nil {
		return a.UpdateStatus()
	}
	return a.Updater.Skip(version)
}

// InstallUpdate downloads and installs the offered version, then restarts
// kubewing (ending its sessions). Progress and failures arrive as update.Event.
func (a *App) InstallUpdate() error {
	if a.Updater == nil {
		return errors.New("updates are off in this build")
	}
	return a.Updater.Install(context.Background())
}

// OpenURL opens an http(s) link in the default browser (release notes' links:
// the webview itself must never navigate away from the app).
func (a *App) OpenURL(link string) error {
	u, err := url.Parse(link)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return errors.New("not a web link: " + link)
	}
	if a.OpenURLFn == nil {
		return errors.New("no browser to open " + link)
	}
	return a.OpenURLFn(u.String())
}

// SetMenu replaces the native menu's command menus; the frontend builds them
// from its merged keymap (keys/appMenu.ts) and resends them on config changes.
func (a *App) SetMenu(menus []Menu) {
	if a.MenuFn != nil {
		a.MenuFn(menus)
	}
}
