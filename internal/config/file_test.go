package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"sigs.k8s.io/yaml"
)

func TestReferenceIsValid(t *testing.T) {
	dir := write(t, map[string]string{File: Reference})
	if e := Load(dir); len(e.Errors) != 0 {
		t.Errorf("the reference must load without problems: %v", e.Errors)
	}
}

// Every setting of config.yaml is in the reference, so a new one can't be
// forgotten there.
func TestReferenceIsComplete(t *testing.T) {
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(Reference), &doc); err != nil {
		t.Fatal(err)
	}
	var missing []string
	var walk func(t reflect.Type, v any, at string)
	walk = func(typ reflect.Type, v any, at string) {
		for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice {
			typ = typ.Elem()
			if l, ok := v.([]any); ok && len(l) > 0 {
				v = l[0]
			}
		}
		if typ.Kind() != reflect.Struct {
			return
		}
		m, _ := v.(map[string]any)
		for i := range typ.NumField() {
			f := typ.Field(i)
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "" || name == "-" {
				continue
			}
			sub, ok := m[name]
			if !ok {
				missing = append(missing, at+name)
				continue
			}
			walk(f.Type, sub, at+name+".")
		}
	}
	walk(reflect.TypeFor[Config](), doc, "")
	if len(missing) > 0 {
		t.Errorf("not in reference.yaml: %v", missing)
	}
}

func TestStarterChangesNothing(t *testing.T) {
	dir := write(t, map[string]string{File: Starter()})
	if diff := cmp.Diff(Defaults(dir), Load(dir)); diff != "" {
		t.Error(diff)
	}
	// uncommenting a line gives back the reference's
	ref := strings.Split(Reference, "\n")
	for _, l := range strings.Split(Starter(), "\n") {
		if rest, ok := strings.CutPrefix(l, "# "); ok && strings.HasPrefix(rest, "theme:") {
			if rest != ref[2] {
				t.Errorf("uncommented %q, reference %q", rest, ref[2])
			}
			return
		}
	}
	t.Error("no commented theme line")
}

func TestCheck(t *testing.T) {
	dir := write(t, map[string]string{"keybindings.yaml": "- {key: x}\n"})
	if errs, _ := Check(dir, File, "terminal:\n  scrollback: 20000\n"); errs != nil {
		t.Errorf("valid: %v", errs)
	}
	// only config.yaml's problems, without its name; the file on disk is not read
	errs, _ := Check(dir, File, "terminal:\n  scrollback: 5\nbogus: 1\n")
	want := []string{`error unmarshaling JSON: while decoding JSON: json: unknown field "bogus"`, "terminal.scrollback: 5 is not between 100 and 1000000 lines"}
	if diff := cmp.Diff(want, errs); diff != "" {
		t.Error(diff)
	}
	if errs, _ := Check(dir, File, "theme: [\n"); len(errs) != 1 {
		t.Errorf("broken YAML: %v", errs)
	}
	// the theme file is looked up next to it
	if errs, _ := Check(dir, File, "theme: nope\n"); len(errs) != 1 || !strings.Contains(errs[0], "themes/nope.yaml not found") {
		t.Errorf("missing theme: %v", errs)
	}
}

func TestCheckKeys(t *testing.T) {
	dir := write(t, map[string]string{File: "bogus: 1\n", KeysFile: "- {key: x}\n"})
	// only keybindings.yaml's problems (config.yaml's bogus is not one), with the bindings it gives
	errs, e := Check(dir, KeysFile, "- {key: cmd+k, command: row.down, when: [table]}\n- {key: q}\n")
	if diff := cmp.Diff([]string{"[1]: key and command are required"}, errs); diff != "" {
		t.Error(diff)
	}
	if diff := cmp.Diff([]Binding{{Key: "cmd+k", Command: "row.down", When: []string{"table"}}, {Key: "q"}}, e.Keybindings); diff != "" {
		t.Error(diff)
	}
	if errs, _ := Check(dir, KeysFile, "{key: x}\n"); len(errs) != 1 {
		t.Errorf("not a list: %v", errs)
	}
}

func TestReadWriteFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new")
	if _, exists, err := ReadFile(dir, File); exists || err != nil {
		t.Fatalf("missing: exists %v, err %v", exists, err)
	}
	if err := WriteFile(dir, File, "theme: a\n"); err != nil {
		t.Fatal(err)
	}
	if text, exists, err := ReadFile(dir, File); text != "theme: a\n" || !exists || err != nil {
		t.Fatalf("%q %v %v", text, exists, err)
	}
	if err := WriteFile(dir, KeysFile, "[]\n"); err != nil {
		t.Fatal(err)
	}
	if text, exists, err := ReadFile(dir, KeysFile); text != "[]\n" || !exists || err != nil {
		t.Fatalf("%q %v %v", text, exists, err)
	}
	// only the editable files, nothing else in (or outside) the directory
	for _, f := range []string{"refs.yaml", "history.yaml", "../config.yaml", "themes/x.yaml", ""} {
		if _, _, err := ReadFile(dir, f); err == nil {
			t.Errorf("read %q: no error", f)
		}
		if err := WriteFile(dir, f, "x"); err == nil {
			t.Errorf("write %q: no error", f)
		}
	}
	// permissions stay, a symlink is written through
	real := filepath.Join(t.TempDir(), "dotfiles.yaml")
	if err := os.WriteFile(real, []byte("theme: b\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := t.TempDir()
	if err := os.Symlink(real, filepath.Join(link, File)); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(link, File, "theme: c\n"); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(filepath.Join(link, File)); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link was replaced: %v", err)
	}
	if b, _ := os.ReadFile(real); string(b) != "theme: c\n" {
		t.Errorf("target: %q", b)
	}
	if fi, _ := os.Stat(real); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	if entries, _ := os.ReadDir(filepath.Dir(real)); len(entries) != 1 {
		t.Errorf("leftover temporary files: %v", entries)
	}
	if err := WriteFile("", File, "x"); err == nil {
		t.Error("no directory: an error")
	}
}
