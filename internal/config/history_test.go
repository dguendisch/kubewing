package config

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestHistory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "kw") // created on first save
	h := OpenHistory(dir)
	if got := h.Get().DebugImages; len(got) != 0 {
		t.Fatalf("fresh: %v", got)
	}
	for i := range 12 {
		if err := h.AddDebugImage(fmt.Sprintf("img%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	_ = h.AddDebugImage("img5") // again: moves to the front, no duplicate
	want := []string{"img5", "img11", "img10", "img9", "img8", "img7", "img6", "img4", "img3", "img2"}
	if got := h.Get().DebugImages; !slices.Equal(got, want) {
		t.Errorf("in memory: %v", got)
	}
	// a new run reads what the last one wrote
	if got := OpenHistory(dir).Get().DebugImages; !slices.Equal(got, want) {
		t.Errorf("reloaded: %v", got)
	}
	b, _ := os.ReadFile(filepath.Join(dir, HistoryFile))
	if !strings.HasPrefix(string(b), "# Written by kubewing") {
		t.Errorf("file: %q", b)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".history-*")); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
	// removing one: gone from memory and from the file; an unknown image is a no-op
	_ = h.RemoveDebugImage("img3")
	_ = h.RemoveDebugImage("never-used")
	want = slices.DeleteFunc(slices.Clone(want), func(v string) bool { return v == "img3" })
	if got := OpenHistory(dir).Get().DebugImages; !slices.Equal(got, want) {
		t.Errorf("after remove: %v", got)
	}
	// hand-edited files next to it are never touched; Load doesn't complain about history.yaml
	if e := Load(dir); len(e.Errors) != 0 {
		t.Errorf("load: %v", e.Errors)
	}
}

func TestHistoryOpsPod(t *testing.T) {
	dir := t.TempDir()
	h := OpenHistory(dir)
	_ = h.AddDebugImage("busybox")
	if h.Get().OpsPod != nil {
		t.Fatal("no ops pod yet")
	}
	want := OpsPodSettings{Namespace: "kube-system", HostRoot: true}
	if err := h.AddOpsPod("ops-toolbelt", want); err != nil {
		t.Fatal(err)
	}
	got := OpenHistory(dir).Get()
	if got.OpsPod == nil || *got.OpsPod != want || !slices.Equal(got.DebugImages, []string{"ops-toolbelt", "busybox"}) {
		t.Errorf("reloaded: %+v %+v", got, got.OpsPod)
	}
	// Get returns a copy
	got.OpsPod.Namespace = "x"
	if h.Get().OpsPod.Namespace != "kube-system" {
		t.Error("history changed through Get")
	}
}

func TestHistoryBrokenOrNone(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, HistoryFile), []byte("debugImages: {not: a list}\n"), 0o644)
	if got := OpenHistory(dir).Get().DebugImages; len(got) != 0 {
		t.Errorf("broken file: %v", got)
	}
	mem := OpenHistory("")
	_ = mem.AddDebugImage("busybox")
	if got := mem.Get().DebugImages; !slices.Equal(got, []string{"busybox"}) {
		t.Errorf("in memory only: %v", got)
	}
}
