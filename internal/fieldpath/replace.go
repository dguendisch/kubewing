package fieldpath

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	yaml "go.yaml.in/yaml/v3"
)

// Replace returns text (one YAML document, or JSON) with the string at p
// set to value, everything else as it was: only the value's own characters
// change (formatting, comments, key order and the other values stay). The
// value keeps its style where it can: a quoted one stays quoted, a value
// with line breaks becomes a literal block (`|`, its indentation kept if it
// was one), JSON gets a JSON string. In a flow collection (`{a: b}`) it's
// quoted.
func Replace(text string, p Path, value string, lang string) (string, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return "", fmt.Errorf("doesn't parse: %w", err)
	}
	if len(doc.Content) == 0 {
		return "", errors.New("empty document")
	}
	n, parent, err := nodeAt(doc.Content[0], p)
	if err != nil {
		return "", err
	}
	if n.Kind != yaml.ScalarNode || n.Tag != "!!str" && n.Tag != "!!binary" {
		return "", fmt.Errorf("%s isn't a string", p)
	}
	start := offset(text, n.Line, n.Column)
	if start < 0 {
		return "", fmt.Errorf("%s: position out of range", p)
	}
	end, blockIndent, err := scalarEnd(text, start, n, parent)
	if err != nil {
		return "", fmt.Errorf("%s: %w", p, err)
	}
	var repr string
	if lang == "json" {
		repr = jsonString(value)
	} else {
		repr = yamlScalar(value, n.Style, parent, blockIndent)
	}
	return text[:start] + repr + text[end:], nil
}

// nodeAt walks p down from n; parent is the collection holding the result.
func nodeAt(n *yaml.Node, p Path) (node, parent *yaml.Node, err error) {
	for i, s := range p {
		for n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
			n = n.Content[0]
		}
		if n.Kind == yaml.AliasNode {
			return nil, nil, fmt.Errorf("%s is an alias", p[:i])
		}
		parent = n
		var next *yaml.Node
		switch {
		case s.By != "":
			if n.Kind == yaml.SequenceNode {
				for _, it := range n.Content {
					if v := mapValue(it, s.By); v != nil && v.Kind == yaml.ScalarNode && v.Value == s.Val {
						next = it
						break
					}
				}
			}
		case s.List:
			if n.Kind == yaml.SequenceNode && s.Index >= 0 && s.Index < len(n.Content) {
				next = n.Content[s.Index]
			}
		default:
			next = mapValue(n, s.Key)
		}
		if next == nil {
			return nil, nil, fmt.Errorf("%s not found", p[:i+1])
		}
		n = next
	}
	return n, parent, nil
}

func mapValue(n *yaml.Node, key string) *yaml.Node {
	if n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

// offset is the byte offset of a 1-based line and (rune) column; -1 if out of range.
func offset(text string, line, col int) int {
	off := 0
	for l := 1; l < line; l++ {
		i := strings.IndexByte(text[off:], '\n')
		if i < 0 {
			return -1
		}
		off += i + 1
	}
	for c := 1; c < col; c++ {
		if off >= len(text) || text[off] == '\n' {
			return -1
		}
		_, size := utf8.DecodeRuneInString(text[off:])
		off += size
	}
	return off
}

// scalarEnd finds where the scalar starting at start ends, by its style:
// past the closing quote, after a block's last content line, or (plain)
// before a comment, the line's end, or (in a flow collection) a , ] or }.
// blockIndent is a block scalar's content indentation (0 otherwise).
func scalarEnd(text string, start int, n, parent *yaml.Node) (end, blockIndent int, err error) {
	switch {
	case n.Style&yaml.DoubleQuotedStyle != 0:
		for i := start + 1; i < len(text); i++ {
			switch text[i] {
			case '\\':
				i++
			case '"':
				return i + 1, 0, nil
			}
		}
		return 0, 0, errors.New("unterminated double-quoted string")
	case n.Style&yaml.SingleQuotedStyle != 0:
		for i := start + 1; i < len(text); i++ {
			if text[i] == '\'' {
				if i+1 < len(text) && text[i+1] == '\'' {
					i++
					continue
				}
				return i + 1, 0, nil
			}
		}
		return 0, 0, errors.New("unterminated single-quoted string")
	case n.Style&(yaml.LiteralStyle|yaml.FoldedStyle) != 0:
		return blockEnd(text, start, parent)
	}
	flow := parent != nil && parent.Style&yaml.FlowStyle != 0
	i := start
	for ; i < len(text) && text[i] != '\n'; i++ {
		if text[i] == '#' && i > start && (text[i-1] == ' ' || text[i-1] == '\t') {
			break
		}
		if flow && (text[i] == ',' || text[i] == ']' || text[i] == '}') {
			break
		}
	}
	end = max(len(strings.TrimRight(text[:i], " \t")), start)
	if flow {
		return end, 0, nil
	}
	// a plain value continued on more indented lines (folded)
	coll := parentIndent(parent)
	for i < len(text) {
		next := i + 1
		le := strings.IndexByte(text[next:], '\n')
		line := text[next:]
		if le >= 0 {
			line = text[next : next+le]
		}
		t := strings.TrimLeft(line, " ")
		ind := len(line) - len(t)
		if t == "" || strings.HasPrefix(t, "#") || ind <= coll {
			break
		}
		if c := strings.Index(t, " #"); c >= 0 {
			t = t[:c]
		}
		end = next + ind + len(strings.TrimRight(t, " \t"))
		if le < 0 {
			break
		}
		i = next + le
	}
	return end, 0, nil
}

// parentIndent is the indentation of the collection holding a value: its
// keys' (or dashes') column, 0-based; -1 at the top.
func parentIndent(parent *yaml.Node) int {
	if parent == nil {
		return -1
	}
	return parent.Column - 1
}

// blockEnd: a literal or folded block from its header (`|`, `>-`, `|2+`)
// to its last content line; trailing blank lines stay out unless it keeps
// them (`+`).
func blockEnd(text string, start int, parent *yaml.Node) (int, int, error) {
	hl := strings.IndexByte(text[start:], '\n')
	if hl < 0 {
		return len(text), 0, nil
	}
	header := text[start : start+hl]
	if c := strings.Index(header, " #"); c >= 0 {
		header = header[:c]
	}
	header = strings.TrimSpace(header)
	keep := strings.Contains(header, "+")
	explicit := 0
	for _, r := range header[1:] {
		if r >= '1' && r <= '9' {
			explicit = int(r - '0')
		}
	}
	base := parentIndent(parent)
	indent := 0
	if explicit > 0 {
		indent = max(base, 0) + explicit
	}
	end := start + hl // the header's end: an empty block
	i := start + hl + 1
	for i <= len(text) {
		le := strings.IndexByte(text[i:], '\n')
		line := text[i:]
		if le >= 0 {
			line = text[i : i+le]
		}
		t := strings.TrimLeft(line, " ")
		ind := len(line) - len(t)
		switch {
		case t == "":
			if keep && (indent == 0 || ind >= indent || ind == len(line)) {
				end = i + len(line)
			}
		case indent == 0 && ind > base:
			indent = ind
			end = i + len(line)
		case indent > 0 && ind >= indent:
			end = i + len(line)
		default:
			return end, indent, nil
		}
		if le < 0 {
			break
		}
		i += le + 1
	}
	return end, indent, nil
}

// yamlScalar writes value as a YAML scalar in the place of one in style.
func yamlScalar(value string, style yaml.Style, parent *yaml.Node, blockIndent int) string {
	flow := parent != nil && parent.Style&yaml.FlowStyle != 0
	if strings.Contains(value, "\n") && !flow && blockable(value) {
		base := max(parentIndent(parent), 0)
		indent := blockIndent
		if indent <= base {
			indent = base + 2
		}
		return literal(value, indent, base)
	}
	switch {
	case style&yaml.DoubleQuotedStyle != 0, flow, strings.ContainsAny(value, "\n\r\t"):
		return jsonString(value)
	case style&yaml.SingleQuotedStyle != 0:
		return "'" + strings.ReplaceAll(value, "'", "''") + "'"
	}
	b, err := yaml.Marshal(value)
	if out := strings.TrimSuffix(string(b), "\n"); err == nil && !strings.Contains(out, "\n") {
		return out
	}
	return jsonString(value)
}

// blockable: a literal block can hold value (printable, no carriage returns,
// no lines of only spaces before content: they'd change its indentation).
func blockable(value string) bool {
	for _, r := range value {
		if r == '\r' || r < 0x20 && r != '\n' && r != '\t' || r == 0x7f || r == 0xfeff {
			return false
		}
	}
	return true
}

// literal writes value as a literal block at indent (its collection's at
// base): `|` keeps one final line break, `|-` none, `|+` more; an
// indentation indicator when the first line starts with a space (it would
// set the indentation otherwise).
func literal(value string, indent, base int) string {
	var b strings.Builder
	b.WriteByte('|')
	body := strings.TrimRight(value, "\n")
	if first := strings.TrimLeft(body, "\n"); strings.HasPrefix(first, " ") || strings.HasPrefix(first, "\t") {
		b.WriteString(fmt.Sprint(min(max(indent-base, 1), 9)))
	}
	switch trail := len(value) - len(body); {
	case trail == 0:
		b.WriteByte('-')
	case trail > 1:
		b.WriteByte('+')
		body = value[:len(value)-1]
	}
	pad := strings.Repeat(" ", indent)
	for _, l := range strings.Split(body, "\n") {
		b.WriteByte('\n')
		if l != "" {
			b.WriteString(pad)
			b.WriteString(l)
		}
	}
	return b.String()
}

// jsonString is value as a JSON string (valid YAML double-quoted too), without HTML escapes.
func jsonString(value string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
	return strings.TrimSuffix(b.String(), "\n")
}
