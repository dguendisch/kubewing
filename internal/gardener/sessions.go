package gardener

import (
	"os"
	"path/filepath"
	"slices"
	"time"

	"sigs.k8s.io/yaml"
)

// SessionTarget is the target of a gardenctl session (a terminal), as of
// when it was last set.
type SessionTarget struct {
	Target
	Set time.Time
}

// Sessions reads the targets of gardenctl's sessions (dir/<session>/target.yaml),
// the latest first, without repeats. Targets kubewing can't open (no
// garden) are left out.
func Sessions(dir string) []SessionTarget {
	if dir == "" {
		return nil
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*", "target.yaml"))
	var out []SessionTarget
	for _, f := range files {
		fi, err := os.Stat(f)
		if err != nil {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var t Target
		if yaml.Unmarshal(b, &t) != nil || t.Garden == "" {
			continue
		}
		// gardenctl notes a shoot's seed too; kubewing finds it again
		if t.Shoot != "" {
			t.Seed = ""
		}
		out = append(out, SessionTarget{Target: t, Set: fi.ModTime()})
	}
	slices.SortStableFunc(out, func(a, b SessionTarget) int { return b.Set.Compare(a.Set) })
	seen := map[Target]bool{}
	return slices.DeleteFunc(out, func(s SessionTarget) bool {
		if seen[s.Target] {
			return true
		}
		seen[s.Target] = true
		return false
	})
}
