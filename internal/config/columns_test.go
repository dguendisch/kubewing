package config

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/dguendisch/kubewing/internal/pipeline"
)

func TestColumns(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "kw") // created on first save
	s := OpenColumns(dir)
	if got := s.All(); len(got) != 0 {
		t.Fatalf("fresh: %v", got)
	}
	cols := []pipeline.Column{{Name: "NAME"}, {Name: "IP"}, {Name: "IMAGE", Path: "spec.containers[0].image"}}
	if err := s.SetColumns("pods", cols); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWidths("pods", map[string]int{"NAME": 300}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWidths("deployments.apps", map[string]int{"READY": 80}); err != nil {
		t.Fatal(err)
	}
	// a new run reads what the last one wrote
	r := OpenColumns(dir)
	if got := r.Get("pods"); !slices.Equal(got.Columns, cols) || !maps.Equal(got.Widths, map[string]int{"NAME": 300}) {
		t.Errorf("reloaded pods: %+v", got)
	}
	if got := r.Get("deployments.apps"); got.Columns != nil || got.Widths["READY"] != 80 {
		t.Errorf("reloaded deployments: %+v", got)
	}
	b, _ := os.ReadFile(filepath.Join(dir, ColumnsFile))
	if !strings.HasPrefix(string(b), "# Written by kubewing") {
		t.Errorf("file: %q", b)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".columns-*")); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
	// Get returns a copy
	g := s.Get("pods")
	g.Columns[0].Name, g.Widths["NAME"] = "X", 1
	if got := s.Get("pods"); got.Columns[0].Name != "NAME" || got.Widths["NAME"] != 300 {
		t.Errorf("Get shares state: %+v", got)
	}
	// resetting both drops the type
	_ = s.SetColumns("deployments.apps", nil)
	_ = s.SetWidths("deployments.apps", nil)
	if _, ok := OpenColumns(dir).All()["deployments.apps"]; ok {
		t.Error("reset type still in the file")
	}
	// config.Load doesn't trip over the file
	if errs := Load(dir).Errors; len(errs) != 0 {
		t.Errorf("Load errors: %v", errs)
	}
}

func TestColumnsInvalidFile(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ColumnsFile), []byte("types:\n  pods:\n    columns: [{name: A, path: a, expr: b}]\n    widths: {A: 10}\n"), 0o644)
	got := OpenColumns(dir).Get("pods")
	if got.Columns != nil || got.Widths["A"] != 10 {
		t.Fatalf("invalid columns kept or widths lost: %+v", got)
	}
	_ = os.WriteFile(filepath.Join(dir, ColumnsFile), []byte("{{"), 0o644)
	if len(OpenColumns(dir).All()) != 0 {
		t.Fatal("broken file")
	}
	if len(OpenColumns("").All()) != 0 {
		t.Fatal("in memory")
	}
}
