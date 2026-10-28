// Package decode turns a field's value into something readable: a chain of
// steps (base64, brotli, gzip) detected one after the other, each feeding the
// next, and a rendering of the result (JWT, PEM/x509, JSON or YAML in a
// string as it is, text, else a hex dump). Pure; the detail view's ⏎ builds on it.
package decode

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/andybalholm/brotli"
)

// Limit caps what a decompression step may produce (a decompression bomb
// stops there, as an error).
const Limit = 16 << 20

// The steps of a chain.
const (
	Base64 = "base64"
	Brotli = "brotli"
	Gzip   = "gzip"
)

// The renderings.
const (
	JWT    = "jwt"
	PEM    = "pem"
	JSON   = "json"
	YAML   = "yaml"
	Text   = "text"
	Binary = "binary"
)

// Result is a decoded value.
type Result struct {
	// Steps applied, in order (base64, brotli, gzip).
	Steps []string `json:"steps"`
	// Kind is the rendering: jwt, pem, json, yaml, text or binary.
	Kind string `json:"kind"`
	// Text is the rendering's text (JWT, PEM and binary as annotated YAML or a hex dump).
	Text string `json:"text"`
	// Language is the viewer's: yaml, json or plaintext.
	Language string `json:"language"`
	// Size is the decoded bytes' size (before rendering).
	Size int `json:"size"`
}

// Options steer a decode. Hint is the field's key (`data.yaml.br`: a .br
// suffix asks for brotli); Siblings are the other string values of the same
// map (a secret's other keys), so a private key can say which certificate it
// belongs to. Steps, if set, is the chain to apply instead of detecting one
// (each step must succeed); Raw skips the rendering (the bytes as text).
type Options struct {
	Hint     string
	Siblings map[string]string
	Steps    []string
	Raw      bool
	// Encoded: the value is known to be base64 (a secret's data, binaryData),
	// so the first base64 step holds whatever it decodes to.
	Encoded bool
	Now     time.Time
}

// ErrNothing: the value is plain text, there's nothing to decode.
var ErrNothing = errors.New("nothing to decode: plain text")

// Auto decodes value as Options say. With no steps detected and a plain
// text rendering it returns ErrNothing (the value is as it reads); asked for
// no steps, it renders the value itself.
func Auto(value string, o Options) (Result, error) {
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	b := []byte(value)
	var steps []string
	if o.Steps != nil {
		for _, s := range o.Steps {
			out, err := apply(s, b)
			if err != nil {
				return Result{}, fmt.Errorf("%s: %w", s, err)
			}
			b, steps = out, append(steps, s)
		}
	} else {
		b, steps = detect(b, o.Hint, o.Encoded)
	}
	r := Result{Steps: steps, Size: len(b)}
	if steps == nil {
		r.Steps = []string{}
	}
	if o.Raw {
		r.Kind, r.Text, r.Language = Text, string(b), "plaintext"
		if !printable(b) {
			r.Kind, r.Text = Binary, hexDump(b)
		}
		return r, nil
	}
	r.Kind, r.Text, r.Language = render(b, o)
	if o.Steps == nil && len(steps) == 0 && r.Kind == Text {
		return Result{}, ErrNothing
	}
	return r, nil
}

// detect applies steps while one fits: gzip (its magic bytes), brotli
// (bytes that aren't text, or asked for by a .br suffix: brotli has no magic
// bytes, so without the suffix it's kept only if the result is text), and
// base64 when the whole value is base64 and decodes to text, gzip or brotli
// text. Text that only happens to be base64 ("true", "admin123") decodes to
// bytes that are neither, so it stays as it reads.
func detect(b []byte, hint string, encoded bool) ([]byte, []string) {
	var steps []string
	br := strings.HasSuffix(hint, ".br")
	for len(steps) < 8 {
		switch {
		case isGzip(b):
			out, err := gunzip(b)
			if err != nil {
				return b, steps
			}
			b, steps = out, append(steps, Gzip)
		case !printable(b):
			out, ok := brotliText(b, br)
			if !ok {
				return b, steps
			}
			b, steps, br = out, append(steps, Brotli), false
		default:
			out, ok := unbase64(b)
			if !ok {
				return b, steps
			}
			if !(encoded && len(steps) == 0) && !printable(out) && !isGzip(out) {
				if _, ok := brotliText(out, br); !ok {
					return b, steps
				}
			}
			b, steps = out, append(steps, Base64)
		}
	}
	return b, steps
}

// brotliText decompresses b if it's brotli: with asked (a .br key) whatever
// it holds, else only text (random bytes sometimes decode as brotli).
func brotliText(b []byte, asked bool) ([]byte, bool) {
	out, err := unbrotli(b)
	if err != nil || len(out) == 0 || (!asked && !printable(out)) {
		return nil, false
	}
	return out, true
}

// printable: valid UTF-8 without control characters other than tab and line breaks.
func printable(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, r := range string(b) {
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' || r == 0x7f {
			return false
		}
	}
	return true
}

func apply(step string, b []byte) ([]byte, error) {
	switch step {
	case Base64:
		out, ok := unbase64(b)
		if !ok {
			return nil, errors.New("not base64")
		}
		return out, nil
	case Brotli:
		return unbrotli(b)
	case Gzip:
		return gunzip(b)
	}
	return nil, fmt.Errorf("unknown step")
}

// unbase64 decodes standard or URL-safe base64, padded or not, ignoring
// line breaks (wrapped values); at least 4 characters.
func unbase64(b []byte) ([]byte, bool) {
	s := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, strings.TrimSpace(string(b)))
	if len(s) < 4 {
		return nil, false
	}
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '+' || r == '/' || r == '-' || r == '_' || r == '=') {
			return nil, false
		}
	}
	enc := base64.StdEncoding
	if strings.ContainsAny(s, "-_") {
		enc = base64.URLEncoding
	}
	if !strings.HasSuffix(s, "=") {
		enc = enc.WithPadding(base64.NoPadding)
	}
	out, err := enc.DecodeString(s)
	if err != nil || len(out) == 0 {
		return nil, false
	}
	return out, true
}

func isGzip(b []byte) bool { return len(b) > 2 && b[0] == 0x1f && b[1] == 0x8b }

func gunzip(b []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	return capped(r)
}

func unbrotli(b []byte) ([]byte, error) { return capped(brotli.NewReader(bytes.NewReader(b))) }

// capped reads r up to Limit; more is an error, not a truncation.
func capped(r io.Reader) ([]byte, error) {
	out, err := io.ReadAll(io.LimitReader(r, Limit+1))
	if err != nil {
		return nil, err
	}
	if len(out) > Limit {
		return nil, fmt.Errorf("larger than %d MiB", Limit>>20)
	}
	return out, nil
}

// render picks the rendering of decoded bytes.
func render(b []byte, o Options) (kind, text, lang string) {
	if !printable(b) {
		return Binary, hexDump(b), "plaintext"
	}
	s := string(b)
	if t, ok := renderJWT(s, o.Now); ok {
		return JWT, t, "yaml"
	}
	if t, ok := renderPEM(b, o); ok {
		return PEM, t, "yaml"
	}
	if t, ok := prettyJSON(b); ok {
		return JSON, t, "json"
	}
	if t, ok := prettyYAML(b); ok {
		return YAML, t, "yaml"
	}
	return Text, s, "plaintext"
}

// hexDump renders the first KiB as `hexdump -C` does.
func hexDump(b []byte) string {
	const show = 1024
	var w strings.Builder
	fmt.Fprintf(&w, "# binary, %d bytes", len(b))
	if len(b) > show {
		fmt.Fprintf(&w, " (the first %d shown)", show)
	}
	w.WriteByte('\n')
	n := min(len(b), show)
	for off := 0; off < n; off += 16 {
		line := b[off:min(off+16, n)]
		fmt.Fprintf(&w, "%08x  ", off)
		for i := range 16 {
			if i < len(line) {
				fmt.Fprintf(&w, "%02x ", line[i])
			} else {
				w.WriteString("   ")
			}
			if i == 7 {
				w.WriteByte(' ')
			}
		}
		w.WriteString(" |")
		for _, c := range line {
			if c >= 0x20 && c < 0x7f {
				w.WriteByte(c)
			} else {
				w.WriteByte('.')
			}
		}
		w.WriteString("|\n")
	}
	return w.String()
}

// ago renders t relative to now: "in 3h", "2d ago".
func ago(t, now time.Time) string {
	d := t.Sub(now)
	past := d < 0
	if past {
		d = -d
	}
	var s string
	switch {
	case d < time.Minute:
		s = fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		s = fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		s = fmt.Sprintf("%dh", int(d.Hours()))
	case d > 2*365*24*time.Hour:
		s = fmt.Sprintf("%dy", int(d.Hours()/24/365))
	default:
		s = fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	if past {
		return s + " ago"
	}
	return "in " + s
}
