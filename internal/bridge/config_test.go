package bridge

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/source"
)

type eventLog struct {
	mu     sync.Mutex
	events map[string][]any
}

func (l *eventLog) Emit(event string, data any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events[event] = append(l.events[event], data)
}

func (l *eventLog) get(event string) []any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]any{}, l.events[event]...)
}

// hiddenOpener relists one pod, then changes only spec.gen (not shown).
type hiddenOpener struct{ stormOpener }

func (hiddenOpener) Watch(ctx context.Context, _ string, _ source.Resolved, _ source.Key, out chan<- source.Event) {
	out <- source.Event{Type: source.Relist, Items: []source.Item{obj(0, 0)}}
	select {
	case <-ctx.Done():
	case out <- source.Event{Type: source.Modified, Item: obj(0, 1)}:
	}
	<-ctx.Done()
}

// hidden reports whether a pane opened now marks the gen-only change as
// "changed, not visible".
func hidden(t *testing.T, svc *Service, log *eventLog) bool {
	t.Helper()
	res, err := svc.Open("source: {resource: pods, namespace: ns}\nrender: {columns: [{name: NAME, path: metadata.name}]}")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(res.Pane)
	svc.SetViewport(res.Pane, 0, 10)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range log.get(FrameEvent) {
			f := e.(FramePayload)
			if f.Pane != res.Pane {
				continue
			}
			for _, r := range f.Frame.Rows {
				if r.Hidden {
					return true
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestReloadConfigAppliesDiffRulesToNewPanes(t *testing.T) {
	dir := t.TempDir()
	log := &eventLog{events: map[string][]any{}}
	svc := New(source.NewRegistry(hiddenOpener{}), log, Options{ConfigDir: dir})
	if !hidden(t, svc, log) {
		t.Fatal("without rules, a spec.gen change must be a hidden change")
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("diff: {ignore: [{path: spec.gen}]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := svc.ReloadConfig()
	if len(cfg.Config.Diff.Ignore) != 1 || len(cfg.Errors) != 0 {
		t.Fatalf("reload: %+v", cfg)
	}
	if ev := log.get(ConfigEvent); len(ev) != 1 || len(ev[0].(config.Effective).Config.Diff.Ignore) != 1 {
		t.Fatalf("config events: %v", ev)
	}
	if hidden(t, svc, log) {
		t.Error("an ignored path must not count as a change")
	}
	if got := svc.Config(); len(got.Config.Diff.Ignore) != 1 {
		t.Errorf("Config(): %+v", got)
	}
}

// The settings editor's files: config.yaml with its starter and reference,
// keybindings.yaml as it is; nothing else in the directory.
func TestConfigFiles(t *testing.T) {
	dir := t.TempDir()
	log := &eventLog{events: map[string][]any{}}
	svc := New(source.NewRegistry(hiddenOpener{}), log, Options{ConfigDir: dir})

	f, err := svc.ConfigFile(config.File)
	if err != nil || f.Exists || f.Text != config.Starter() || f.Reference != config.Reference || f.File != config.File {
		t.Fatalf("new config.yaml: %+v %v", f, err)
	}
	k, err := svc.ConfigFile(config.KeysFile)
	if err != nil || k.Exists || k.Text != "" || k.Reference != "" || k.Path != filepath.Join(dir, config.KeysFile) {
		t.Fatalf("new keybindings.yaml: %+v %v", k, err)
	}
	if _, err := svc.ConfigFile("refs.yaml"); err == nil {
		t.Error("refs.yaml: not editable")
	}

	c, err := svc.CheckConfig(config.KeysFile, "- {key: cmd+k, command: row.down}\n- {key: x}\n")
	if err != nil || len(c.Problems) != 1 || len(c.Keybindings) != 2 || c.Keybindings[0].Command != "row.down" {
		t.Fatalf("check keybindings.yaml: %+v %v", c, err)
	}
	if c, _ := svc.CheckConfig(config.File, "theme: blue\n"); c.Problems == nil || len(c.Problems) != 0 || c.Keybindings == nil {
		t.Errorf("check config.yaml: %+v (empty lists, never null)", c)
	}
	if _, err := svc.CheckConfig("../x", ""); err == nil {
		t.Error("check ../x: not editable")
	}

	cfg, err := svc.SaveConfig(config.KeysFile, "- {key: cmd+k, command: row.down}\n")
	if err != nil || len(cfg.Keybindings) != 1 {
		t.Fatalf("save: %+v %v", cfg, err)
	}
	if ev := log.get(ConfigEvent); len(ev) != 1 {
		t.Errorf("config events: %v", ev)
	}
	if k, _ := svc.ConfigFile(config.KeysFile); !k.Exists || k.Text != "- {key: cmd+k, command: row.down}\n" {
		t.Errorf("saved keybindings.yaml: %+v", k)
	}
}
