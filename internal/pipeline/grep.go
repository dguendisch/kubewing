package pipeline

import "strings"

// GrepTerm is one term of a grep stage: a case-insensitive substring of the
// rendered row that must occur, or with Not must not occur.
type GrepTerm struct {
	Text string
	Not  bool
}

// ParseGrep splits a grep stage into terms (fzf-like): space-separated, all
// must match; "!x" excludes rows containing x; "a b" in double quotes is one
// term with a space; a backslash escapes the next character (\! is a literal
// "!", \" a quote). Terms are lower-cased; empty ones ("!" alone) are dropped.
func ParseGrep(s string) []GrepTerm {
	var terms []GrepTerm
	var cur strings.Builder
	not, quoted, started := false, false, false
	flush := func() {
		if cur.Len() > 0 {
			terms = append(terms, GrepTerm{Text: strings.ToLower(cur.String()), Not: not})
		}
		cur.Reset()
		not, started = false, false
	}
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == '\\' && i+1 < len(rs):
			i++
			cur.WriteRune(rs[i])
			started = true
		case r == '"':
			quoted = !quoted
			started = true
		case r == ' ' && !quoted:
			flush()
		case r == '!' && !started:
			not, started = true, true
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	flush()
	return terms
}
