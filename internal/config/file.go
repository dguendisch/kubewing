package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Editable reports whether file is one the settings editor may read and
// write: config.yaml (File) and keybindings.yaml (KeysFile).
func Editable(file string) bool { return file == File || file == KeysFile }

func editable(dir, file string) error {
	if dir == "" {
		return errors.New("no config directory")
	}
	if !Editable(file) {
		return fmt.Errorf("%q is not an editable config file", file)
	}
	return nil
}

// ReadFile returns the content of file (see Editable) in dir; exists is
// false when there is none yet (an error only when it exists but can't be read).
func ReadFile(dir, file string) (text string, exists bool, err error) {
	if err := editable(dir, file); err != nil {
		return "", false, err
	}
	b, err := os.ReadFile(filepath.Join(dir, file))
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(b), true, nil
}

// WriteFile replaces file (see Editable) in dir with text, creating dir if
// needed. The write is atomic (a temporary file renamed over it), so a crash
// never leaves half a file; a symlinked file (dotfiles) is written where
// it points, and the file keeps its permissions.
func WriteFile(dir, file, text string) error {
	if err := editable(dir, file); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	target := filepath.Join(dir, file)
	if real, err := filepath.EvalSymlinks(target); err == nil {
		target = real
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	mode := fs.FileMode(0o644)
	if fi, err := os.Stat(target); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+file+".*")
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
