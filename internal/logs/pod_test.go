package logs

import (
	"strings"
	"testing"
)

func TestSplitTimestamp(t *testing.T) {
	cases := []struct {
		in, ts, text string
	}{
		{"2026-01-01T00:00:00Z hello world", "2026-01-01T00:00:00Z", "hello world"},
		{"2026-01-01T00:00:00.123456789Z json={\"a\":1}", "2026-01-01T00:00:00.123456789Z", "json={\"a\":1}"},
		{"2026-01-01T00:00:00+02:00 tz line", "2026-01-01T00:00:00+02:00", "tz line"},
		{"no timestamp here", "", "no timestamp here"},
		{"", "", ""},
		{"2026-01-01 not really a ts", "", "2026-01-01 not really a ts"},
	}
	for _, c := range cases {
		ts, text := splitTimestamp(c.in)
		if ts != c.ts || text != c.text {
			t.Errorf("splitTimestamp(%q) = (%q, %q), want (%q, %q)", c.in, ts, text, c.ts, c.text)
		}
	}
}

// lineWriter splits a byte stream into lines, forwards each with its
// timestamp, truncates an over-long line and flushes a trailing partial one.
func TestLineWriter(t *testing.T) {
	var got []Line
	tl := &Tailer{sink: sinkFunc(func(l Line) { got = append(got, l) })}
	f := &follower{stream: Stream{ID: "s"}}
	w := &lineWriter{tailer: tl, f: f, cap: 1 << 20}

	// two lines arriving in three writes, split across a boundary
	w.Write([]byte("2026-01-01T00:00:00Z he"))
	w.Write([]byte("llo\n2026-01-01T00:00:01Z wo"))
	w.Write([]byte("rld\n"))
	if len(got) != 2 || got[0].Text != "hello" || got[1].Text != "world" {
		t.Fatalf("lines = %+v", got)
	}
	if got[0].TS != "2026-01-01T00:00:00Z" {
		t.Errorf("ts = %q", got[0].TS)
	}

	// an over-long line with no newline is truncated at cap
	got = nil
	w = &lineWriter{tailer: tl, f: f, cap: 5}
	w.Write([]byte("abcdefghij"))
	if len(got) != 1 || !strings.Contains(got[0].Text, "truncated") || !strings.HasPrefix(got[0].Text, "abcde") {
		t.Errorf("truncation: %+v", got)
	}

	// a trailing partial line is flushed on flush()
	got = nil
	w = &lineWriter{tailer: tl, f: f, cap: 100}
	w.Write([]byte("partial"))
	if len(got) != 0 {
		t.Fatalf("partial line must not emit before flush: %+v", got)
	}
	w.flush()
	if len(got) != 1 || got[0].Text != "partial" {
		t.Errorf("flush: %+v", got)
	}
}

type sinkFunc func(Line)

func (f sinkFunc) Line(l Line)    { f(l) }
func (sinkFunc) Streams([]Stream) {}
