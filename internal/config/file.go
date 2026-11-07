package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// ReadFile returns config.yaml's content in dir; exists is false when there
// is none yet (an error only when it exists but can't be read).
func ReadFile(dir string) (text string, exists bool, err error) {
	if dir == "" {
		return "", false, errors.New("no config directory")
	}
	b, err := os.ReadFile(filepath.Join(dir, File))
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(b), true, nil
}

// WriteFile replaces config.yaml in dir with text, creating dir if needed.
// The write is atomic (a temporary file renamed over it), so a crash never
// leaves half a file; a symlinked config.yaml (dotfiles) is written where
// it points, and the file keeps its permissions.
func WriteFile(dir, text string) error {
	if dir == "" {
		return errors.New("no config directory")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	target := filepath.Join(dir, File)
	if real, err := filepath.EvalSymlinks(target); err == nil {
		target = real
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	mode := fs.FileMode(0o644)
	if fi, err := os.Stat(target); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+File+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	if _, err := tmp.WriteString(text); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}
