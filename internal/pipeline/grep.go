package pipeline

import (
	"slices"
	"strings"
)

// GrepTerm is one term of a grep stage: a case-insensitive substring of the
// rendered row that must occur, or with Not must not occur. Prefix and Suffix
// anchor it to the start or end of a cell. Or joins it to the previous term:
// consecutive terms joined by Or form a group, one of which has to hold.
type GrepTerm struct {
	Text   string
	Not    bool
	Prefix bool
	Suffix bool
	Or     bool
}

// ParseGrep splits a grep stage into terms (fzf-like): space-separated, all
// must match; "!x" excludes rows containing x; "^x" means a cell starts with
// x, "x$" a cell ends with x; a lone "|" between terms means either one
// ("a b | c" is a and (b or c)); "a b" in double quotes is one term with a
// space; a backslash escapes the next character (\! \^ \$ \| are literal, \"
// a quote). Terms are lower-cased; empty ones ("!" or "^" alone) are dropped,
// as is a "|" with no term on one side.
func ParseGrep(s string) []GrepTerm {
	var terms []GrepTerm
	var cur strings.Builder
	not, prefix, dollar, quoted, started, or := false, false, false, false, false, false
	flush := func() {
		text := cur.String()
		if dollar {
			text = text[:len(text)-1]
		}
		if text != "" {
			terms = append(terms, GrepTerm{Text: strings.ToLower(text), Not: not, Prefix: prefix, Suffix: dollar, Or: or && len(terms) > 0})
			or = false
		}
		cur.Reset()
		not, prefix, dollar, started = false, false, false, false
	}
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == '\\' && i+1 < len(rs):
			i++
			cur.WriteRune(rs[i])
			dollar, started = false, true
		case r == '"':
			quoted = !quoted
			started = true
		case r == ' ' && !quoted:
			flush()
		case r == '|' && !quoted && !started && (i+1 == len(rs) || rs[i+1] == ' '):
			or = true
		case r == '!' && !started:
			not, started = true, true
		case r == '^' && !prefix && cur.Len() == 0:
			prefix, started = true, true
		default:
			cur.WriteRune(r)
			dollar, started = r == '$', true
		}
	}
	flush()
	return terms
}

// MatchGrep reports whether a row's cells (or a log line's parts) satisfy
// the terms. They are searched in the lower-cased cells joined by a space, so
// a phrase can span two cells; an anchored term has to start or end where a
// cell does.
func MatchGrep(terms []GrepTerm, cells []string) bool {
	if len(terms) == 0 {
		return true
	}
	anchored := slices.ContainsFunc(terms, func(t GrepTerm) bool { return t.Prefix || t.Suffix })
	row, starts, ends := joinCells(cells, anchored)
	group := true // the current Or group holds
	for i, t := range terms {
		ok := occurs(row, starts, ends, t) != t.Not
		if t.Or {
			group = group || ok
		} else {
			group = ok
		}
		// a group is decided once the next term starts a new one
		if (i+1 == len(terms) || !terms[i+1].Or) && !group {
			return false
		}
	}
	return true
}

// joinCells lower-cases and joins the cells, with where each one starts and
// ends in the result (only when an anchored term needs them).
func joinCells(cells []string, bounds bool) (row string, starts, ends []int) {
	var b strings.Builder
	for i, c := range cells {
		if i > 0 {
			b.WriteByte(' ')
		}
		if bounds {
			starts = append(starts, b.Len())
		}
		b.WriteString(strings.ToLower(c))
		if bounds {
			ends = append(ends, b.Len())
		}
	}
	return b.String(), starts, ends
}

func occurs(row string, starts, ends []int, t GrepTerm) bool {
	for at := 0; ; {
		i := strings.Index(row[at:], t.Text)
		if i < 0 {
			return false
		}
		i += at
		if (!t.Prefix || has(starts, i)) && (!t.Suffix || has(ends, i+len(t.Text))) {
			return true
		}
		at = i + 1
	}
}

func has(sorted []int, x int) bool {
	_, ok := slices.BinarySearch(sorted, x)
	return ok
}
