package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"sigs.k8s.io/yaml"
)

// HistoryFile is the one file kubewing writes in its directory: what it
// remembers between runs (recent debug images). Hand-edited files stay
// read-only; this one is the app's and is rewritten as a whole.
const HistoryFile = "history.yaml"

// MaxDebugImages is how many recent debug images are kept.
const MaxDebugImages = 10

// History mirrors history.yaml.
type History struct {
	// DebugImages are the images of debug containers that started, newest first.
	DebugImages []string `json:"debugImages"`
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
	}
	return s
}

// Get returns a copy of the history.
func (s *HistoryStore) Get() History {
	s.mu.Lock()
	defer s.mu.Unlock()
	return History{DebugImages: slices.Clone(s.h.DebugImages)}
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

// save writes atomically (temp file + rename), so a crash never leaves half a file.
func (s *HistoryStore) save() error {
	if s.dir == "" {
		return nil
	}
	b, err := yaml.Marshal(s.h)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".history-*.yaml")
	if err != nil {
		return err
	}
	header := "# Written by kubewing (recent debug images); safe to delete.\n"
	if _, err := tmp.Write(append([]byte(header), b...)); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(s.dir, HistoryFile))
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
