package normalize

import (
	"fmt"
	"regexp"
	"strings"
)

// Describe noise: kubectl describe output contains relative times that
// change on every run (event ages, node heartbeats, lease renewals). For the
// describe diff they are blanked, and tables are re-aligned with widths
// shared by both runs, so one longer cell (a new event reason, "2m" vs
// "15m") doesn't shift every column and make every row look changed.

// describeColumns transform table cells by column header.
var describeColumns = map[string]func(string) string{
	// "2m (x3 over 10m)" → "(x3)": the count is a real change, the times aren't
	"Age":                 keepCount,
	"Last Seen":           blank,
	"First Seen":          blank,
	"LastHeartbeatTime":   blank,
	"Last Heartbeat Time": blank,
}

// describeLines blank the value of plain "Key: value" lines.
var describeLines = []*regexp.Regexp{
	regexp.MustCompile(`^(\s*RenewTime:).*$`), // lease heartbeat (describe node)
}

var (
	dashRow  = regexp.MustCompile(`^\s*-+(\s+-+)*\s*$`)
	dashRun  = regexp.MustCompile(`-+`)
	countRun = regexp.MustCompile(`\(x(\d+) over [^)]*\)`)
)

func keepCount(s string) string {
	if m := countRun.FindStringSubmatch(s); m != nil {
		return "(x" + m[1] + ")"
	}
	return ""
}

func blank(string) string { return "" }

// DescribePair normalizes two describe outputs of the same object for
// diffing: relative times blanked, tables aligned with shared widths.
func DescribePair(prev, cur string) (string, string) {
	bp, bc := parseDescribe(prev), parseDescribe(cur)
	widths := map[string][]int{}
	for _, blocks := range [][]block{bp, bc} {
		for _, b := range blocks {
			if b.table != nil {
				b.table.measure(widths)
			}
		}
	}
	return render(bp, widths), render(bc, widths)
}

type block struct {
	line  string
	table *table
}

type table struct {
	key    string // pairs the same table across both runs
	indent int
	cols   []string
	rows   [][]string
}

func parseDescribe(text string) []block {
	lines := strings.Split(text, "\n")
	var out []block
	seen := map[string]int{}
	for i := 0; i < len(lines); i++ {
		if i+1 < len(lines) && strings.TrimSpace(lines[i]) != "" && dashRow.MatchString(lines[i+1]) {
			var starts []int
			for _, loc := range dashRun.FindAllStringIndex(lines[i+1], -1) {
				starts = append(starts, loc[0])
			}
			t := &table{indent: starts[0], cols: cut(lines[i], starts)}
			j := i + 2
			for ; j < len(lines); j++ {
				l := lines[j]
				if strings.TrimSpace(l) == "" || len(l)-len(strings.TrimLeft(l, " ")) < t.indent {
					break // a table ends at a blank line or a less indented one
				}
				row := cut(l, starts)
				for c, name := range t.cols {
					if f := describeColumns[name]; f != nil && c < len(row) {
						row[c] = f(row[c])
					}
				}
				t.rows = append(t.rows, row)
			}
			id := fmt.Sprintf("%d|%s", t.indent, strings.Join(t.cols, "|"))
			t.key = fmt.Sprintf("%s#%d", id, seen[id])
			seen[id]++
			out = append(out, block{table: t})
			i = j - 1
			continue
		}
		line := lines[i]
		for _, re := range describeLines {
			line = re.ReplaceAllString(line, "$1")
		}
		out = append(out, block{line: line})
	}
	return out
}

// cut splits a tabwriter line at the column start positions; the last
// column runs to the end of the line (messages contain spaces).
func cut(line string, starts []int) []string {
	cells := make([]string, len(starts))
	for k, st := range starts {
		if st >= len(line) {
			continue
		}
		end := len(line)
		if k+1 < len(starts) && starts[k+1] < end {
			end = starts[k+1]
		}
		cells[k] = strings.TrimSpace(line[st:end])
	}
	return cells
}

func (t *table) measure(widths map[string][]int) {
	w := widths[t.key]
	if w == nil {
		w = make([]int, len(t.cols))
	}
	for _, row := range append([][]string{t.cols}, t.rows...) {
		for c, cell := range row {
			if c < len(w) && len(cell) > w[c] {
				w[c] = len(cell)
			}
		}
	}
	widths[t.key] = w
}

func render(blocks []block, widths map[string][]int) string {
	var b strings.Builder
	for i, bl := range blocks {
		if i > 0 {
			b.WriteByte('\n')
		}
		if bl.table == nil {
			b.WriteString(bl.line)
			continue
		}
		t, w := bl.table, widths[bl.table.key]
		dashes := make([]string, len(t.cols))
		for c, name := range t.cols {
			dashes[c] = strings.Repeat("-", len(name))
		}
		for r, row := range append([][]string{t.cols, dashes}, t.rows...) {
			if r > 0 {
				b.WriteByte('\n')
			}
			var line strings.Builder
			line.WriteString(strings.Repeat(" ", t.indent))
			for c, cell := range row {
				line.WriteString(cell)
				if c < len(row)-1 {
					line.WriteString(strings.Repeat(" ", w[c]-len(cell)+2)) // kubectl's padding
				}
			}
			b.WriteString(strings.TrimRight(line.String(), " "))
		}
	}
	return b.String()
}
