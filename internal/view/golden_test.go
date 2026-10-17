package view

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dguendisch/kubewing/internal/tape"
)

// Goldens are the spec. Regenerate deliberately with:
//
//	go test ./internal/view -run TestGolden -update
//
// and review the golden diff as its own change.
var update = flag.Bool("update", false, "rewrite golden files")

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

// replay runs a tape and returns the transcript of recorded frames.
func replay(t testing.TB, tp *tape.Tape) []Frame {
	t.Helper()
	v, err := New(tp.Pipeline, Options{
		HighlightFor: 5 * time.Second,
		TombstoneFor: 5 * time.Second,
		Namespaced:   tp.Pipeline.Source.AllNamespaces(),
	})
	if err != nil {
		t.Fatal(err)
	}
	var frames []Frame
	record := func(now time.Time) {
		if f, ok := v.Frame(now); ok {
			frames = append(frames, f)
		} else {
			frames = append(frames, Frame{}) // explicit "no update" marker
		}
	}
	v.Apply(tp.InitialEvent(), t0)
	record(t0)
	for i, s := range tp.Steps {
		off, err := s.Offset()
		if err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		now := t0.Add(off)
		if ev, ok := tp.Event(s); ok {
			v.Apply(ev, now)
		}
		if s.Viewport != nil {
			v.SetViewport(s.Viewport.Offset, s.Viewport.Limit)
		}
		if s.Frame {
			record(now)
		}
	}
	return frames
}

func TestGolden(t *testing.T) {
	tapes, err := filepath.Glob("../../testdata/tapes/*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if len(tapes) == 0 {
		t.Fatal("no tapes found")
	}
	for _, path := range tapes {
		name := strings.TrimSuffix(filepath.Base(path), ".yaml")
		t.Run(name, func(t *testing.T) {
			tp, err := tape.Load(path)
			if err != nil {
				t.Fatal(err)
			}
			got := renderTranscript(replay(t, tp))
			golden := filepath.Join("testdata", name+".golden")
			if *update {
				if err := os.WriteFile(golden, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("missing golden (run with -update to create): %v", err)
			}
			if !bytes.Equal(got, want) {
				t.Errorf("transcript differs from %s (re-run with -update only if the change is intended):\n%s",
					golden, lineDiff(string(want), string(got)))
			}
		})
	}
}

func renderTranscript(frames []Frame) []byte {
	var b bytes.Buffer
	for i, f := range frames {
		fmt.Fprintf(&b, "--- frame %d\n", i)
		if f.Seq == 0 {
			b.WriteString("(no update)\n")
			continue
		}
		j, _ := json.MarshalIndent(f, "", "  ")
		b.Write(j)
		b.WriteByte('\n')
	}
	return b.Bytes()
}

func lineDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	var b strings.Builder
	n := max(len(w), len(g))
	shown := 0
	for i := 0; i < n && shown < 40; i++ {
		var wl, gl string
		if i < len(w) {
			wl = w[i]
		}
		if i < len(g) {
			gl = g[i]
		}
		if wl != gl {
			fmt.Fprintf(&b, "line %d:\n  - %s\n  + %s\n", i+1, wl, gl)
			shown++
		}
	}
	return b.String()
}
