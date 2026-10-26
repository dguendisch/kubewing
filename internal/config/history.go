package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"sigs.k8s.io/yaml"
)

// HistoryFile is one of the two files kubewing writes in its directory (the
// other is ColumnsFile): what it remembers between runs (recent debug
// images, the window's size). Hand-edited files stay read-only; this one is
// the app's and is rewritten as a whole.
const HistoryFile = "history.yaml"

// MaxDebugImages is how many recent debug images are kept.
const MaxDebugImages = 10

// History mirrors history.yaml.
type History struct {
	// DebugImages are the images of debug containers and ops pods that started, newest first.
	DebugImages []string `json:"debugImages"`
	// OpsPod: the namespace and checkboxes of the last ops pod that started; nil = none yet.
	OpsPod *OpsPodSettings `json:"opsPod,omitempty"`
	// Window: the main window's size when kubewing last closed; nil = never closed yet.
	Window *Window `json:"window,omitempty"`
}

// Window states (Window.State).
const (
	WindowNormal     = ""
	WindowMaximised  = "maximised"
	WindowFullscreen = "fullscreen"
)

// Window is the main window's state and size.
type Window struct {
	// State is WindowNormal, WindowMaximised or WindowFullscreen.
	State string `json:"state,omitempty"`
	// Width and Height are the normal (not maximised) size in points.
	Width  int `json:"width"`
	Height int `json:"height"`
}

// HistoryStore reads and writes dir/history.yaml. dir "" keeps history in
// memory only (headless runs, tests).
type HistoryStore struct {
	dir string

	mu sync.Mutex
	h  History
}

// OpenHistory loads dir/history.yaml; a missing or unreadable file is an empty history.
func OpenHistory(dir string) *HistoryStore {
	s := &HistoryStore{dir: dir, h: History{DebugImages: []string{}}}
	if dir == "" {
		return s
	}
	b, err := os.ReadFile(filepath.Join(dir, HistoryFile))
	if err != nil {
		return s
	}
	var h History
	if yaml.Unmarshal(b, &h) == nil {
		s.h.DebugImages = dedupe(h.DebugImages, MaxDebugImages)
		s.h.OpsPod = h.OpsPod
		s.h.Window = h.Window
	}
	return s
}

// Get returns a copy of the history.
func (s *HistoryStore) Get() History {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := History{DebugImages: slices.Clone(s.h.DebugImages)}
	if s.h.OpsPod != nil {
		o := *s.h.OpsPod
		h.OpsPod = &o
	}
	if s.h.Window != nil {
		w := *s.h.Window
		h.Window = &w
	}
	return h
}

// SetWindow remembers the main window's size and state and saves.
func (s *HistoryStore) SetWindow(w Window) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.h.Window = &w
	return s.save()
}

// AddOpsPod remembers a started ops pod: its image (with the debug images) and its settings.
func (s *HistoryStore) AddOpsPod(image string, o OpsPodSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.h.DebugImages = dedupe(append([]string{image}, s.h.DebugImages...), MaxDebugImages)
	s.h.OpsPod = &o
	return s.save()
}

// AddDebugImage moves image to the front (at most MaxDebugImages) and saves.
func (s *HistoryStore) AddDebugImage(image string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.h.DebugImages = dedupe(append([]string{image}, s.h.DebugImages...), MaxDebugImages)
	return s.save()
}

// RemoveDebugImage drops image from the history and saves; unknown images are a no-op.
func (s *HistoryStore) RemoveDebugImage(image string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.Index(s.h.DebugImages, image)
	if i < 0 {
		return nil
	}
	s.h.DebugImages = slices.Delete(s.h.DebugImages, i, i+1)
	return s.save()
}

func (s *HistoryStore) save() error {
	return writeAtomic(s.dir, HistoryFile, "# Written by kubewing (recent debug/ops pod images, last ops pod settings, window size); safe to delete.\n", s.h)
}

// writeAtomic writes v as YAML to dir/file (temp file + rename), so a crash
// never leaves half a file; dir "" writes nothing.
func writeAtomic(dir, file, header string, v any) error {
	if dir == "" {
		return nil
	}
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+strings.TrimSuffix(file, ".yaml")+"-*.yaml")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append([]byte(header), b...)); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, file))
}

func dedupe(in []string, max int) []string {
	out := []string{}
	for _, v := range in {
		if v != "" && !slices.Contains(out, v) && len(out) < max {
			out = append(out, v)
		}
	}
	return out
}
