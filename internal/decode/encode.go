package decode

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

// Editable is a value decoded for editing: the bytes the chain leads to as
// text, not a rendering of them (a certificate is its PEM text, a JWT and
// binary bytes are refused). Encode takes the edited text back.
type Editable struct {
	// Steps applied, in order; empty for a YAML or JSON string kept as it is
	// (a config map's `config.yaml: |`).
	Steps []string `json:"steps"`
	// Kind is what the text is: yaml, json, pem or text.
	Kind string `json:"kind"`
	Text string `json:"text"`
	// Language is the editor's: yaml, json or plaintext.
	Language string `json:"language"`
	// Compact: JSON on one line, shown indented; Encode compacts it again.
	Compact bool `json:"compact,omitempty"`
}

// Edit decodes value for editing as Options say (Hint, Encoded, Steps;
// Raw and Siblings don't matter). A value with nothing to decode and no
// YAML or JSON in it is ErrNothing: it's edited in place, as it reads.
func Edit(value string, o Options) (Editable, error) {
	b, steps, err := chain(value, o)
	if err != nil {
		return Editable{}, err
	}
	e := Editable{Steps: steps}
	if steps == nil {
		e.Steps = []string{}
	}
	if !printable(b) {
		return Editable{}, fmt.Errorf("binary (%d bytes): no text to edit", len(b))
	}
	s := string(b)
	switch {
	case isJWT(s):
		return Editable{}, errors.New("a JWT: an edit would break its signature")
	case bytes.Contains(b, []byte("-----BEGIN ")):
		e.Kind, e.Text, e.Language = PEM, s, "plaintext"
	default:
		if t, ok := prettyJSON(b); ok {
			e.Kind, e.Text, e.Language, e.Compact = JSON, t, "json", !bytes.ContainsRune(bytes.TrimSpace(b), '\n')
			if !e.Compact {
				e.Text = s
			}
		} else if _, ok := prettyYAML(b); ok {
			e.Kind, e.Text, e.Language = YAML, s, "yaml"
		} else {
			e.Kind, e.Text, e.Language = Text, s, "plaintext"
		}
	}
	if len(steps) == 0 && (e.Kind == Text || e.Kind == PEM) {
		return Editable{}, ErrNothing
	}
	return e, nil
}

// isJWT: three base64url parts whose first two are JSON objects.
func isJWT(s string) bool {
	_, ok := renderJWT(s, time.Time{})
	return ok
}

// chain applies Options' steps to value, or detects them.
func chain(value string, o Options) ([]byte, []string, error) {
	b := []byte(value)
	if o.Steps == nil {
		b, steps := detect(b, o.Hint, o.Encoded)
		return b, steps, nil
	}
	var steps []string
	for _, s := range o.Steps {
		out, err := apply(s, b)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", s, err)
		}
		b, steps = out, append(steps, s)
	}
	return b, steps, nil
}

// Encode is Edit backwards: text, as edited, encoded with the chain value
// was decoded with (o.Steps, else detected again), each step in the
// variant value has (base64's alphabet, padding, line wrapping and trailing
// newline; compressed again at the best level). Text that's still what
// Edit gave returns value itself: an unchanged level is never re-encoded
// (gzip and brotli wouldn't give the same bytes back). The result is
// decoded again and must give the edited bytes.
func Encode(value string, o Options, text string) (string, error) {
	e, err := Edit(value, o)
	if err != nil {
		return "", err
	}
	if text == e.Text {
		return value, nil
	}
	// the intermediate values: ins[i] is what step i decoded (ins[0] the value)
	ins := [][]byte{[]byte(value)}
	for _, s := range e.Steps {
		out, err := apply(s, ins[len(ins)-1])
		if err != nil {
			return "", fmt.Errorf("%s: %w", s, err)
		}
		ins = append(ins, out)
	}
	b := []byte(text)
	if e.Compact {
		var w bytes.Buffer
		if err := json.Compact(&w, b); err != nil {
			return "", fmt.Errorf("the JSON doesn't parse: %w", err)
		}
		if bytes.HasSuffix(ins[len(ins)-1], []byte("\n")) {
			w.WriteByte('\n')
		}
		b = w.Bytes()
	}
	want := b
	for i := len(e.Steps) - 1; i >= 0; i-- {
		if b, err = encodeStep(e.Steps[i], b, ins[i]); err != nil {
			return "", fmt.Errorf("%s: %w", e.Steps[i], err)
		}
	}
	got := b
	for _, s := range e.Steps {
		if got, err = apply(s, got); err != nil {
			return "", fmt.Errorf("encoded value doesn't decode again (%s: %w)", s, err)
		}
	}
	if !bytes.Equal(got, want) {
		return "", errors.New("encoded value doesn't decode to the edited text again")
	}
	return string(b), nil
}

// encodeStep undoes step on b, as like is encoded.
func encodeStep(step string, b, like []byte) ([]byte, error) {
	switch step {
	case Base64:
		return encodeBase64(b, like), nil
	case Gzip:
		var w bytes.Buffer
		z, err := gzip.NewWriterLevel(&w, gzip.BestCompression)
		if err != nil {
			return nil, err
		}
		if _, err := z.Write(b); err != nil {
			return nil, err
		}
		if err := z.Close(); err != nil {
			return nil, err
		}
		return w.Bytes(), nil
	case Brotli:
		var w bytes.Buffer
		z := brotli.NewWriterLevel(&w, brotli.BestCompression)
		if _, err := z.Write(b); err != nil {
			return nil, err
		}
		if err := z.Close(); err != nil {
			return nil, err
		}
		return w.Bytes(), nil
	}
	return nil, errors.New("unknown step")
}

// encodeBase64 encodes b in like's variant: the URL alphabet if like uses
// it, unpadded if like has no padding where it would need some, wrapped at
// like's first line's width if like spans lines, with like's trailing line break.
func encodeBase64(b, like []byte) []byte {
	s := strings.TrimRight(string(like), " \t\r\n")
	trail := string(like[len(strings.TrimRight(string(like), "\r\n")):])
	flat := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	enc := base64.StdEncoding
	url := strings.ContainsAny(flat, "-_")
	if url {
		enc = base64.URLEncoding
	}
	// a length that needs no padding doesn't say: the standard alphabet pads
	// (as Kubernetes does), the URL one doesn't (as JWTs don't)
	if !strings.HasSuffix(flat, "=") && (len(flat)%4 != 0 || url) {
		enc = enc.WithPadding(base64.NoPadding)
	}
	out := enc.EncodeToString(b)
	if first, _, wrapped := strings.Cut(strings.TrimSpace(s), "\n"); wrapped {
		width := len(strings.TrimRight(first, "\r"))
		nl := "\n"
		if strings.HasSuffix(first, "\r") {
			nl = "\r\n"
		}
		var w strings.Builder
		for len(out) > width {
			w.WriteString(out[:width])
			w.WriteString(nl)
			out = out[width:]
		}
		w.WriteString(out)
		out = w.String()
	}
	return []byte(out + trail)
}
