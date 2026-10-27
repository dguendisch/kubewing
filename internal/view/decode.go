package view

import (
	"errors"
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	sigsyaml "sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/decode"
	"github.com/dguendisch/kubewing/internal/fieldpath"
)

// DecodeLevel is one level of a decode (⏎ in the YAML, ⏎ again in the
// decoded text): a field and the chain applied to its value. The first
// level's field is in the object, a deeper one's in the level above's
// decoded YAML (document Doc of it).
type DecodeLevel struct {
	// Line (0-based) picks the field while Path is empty: a line of the
	// object's YAML (DecodeRequest.Which) or of the level above's decoded
	// text. The answer has it resolved into Path and Doc, which later
	// requests (other versions, the diff) go by.
	Line int            `json:"line"`
	Path fieldpath.Path `json:"path,omitempty"`
	Doc  int            `json:"doc,omitempty"`
	// Steps is the chain to apply; nil detects one (the answer has it filled in).
	Steps []string `json:"steps"`
	// Raw: no rendering (the last level only: the PEM text instead of the certificate).
	Raw bool `json:"raw,omitempty"`
}

// DecodeRequest asks for a row's field decoded.
type DecodeRequest struct {
	Key string `json:"key"`
	// Which object the first level's line is on: "yaml" (the object, as
	// Detail.YAML) or "norm" (the normalized version To, as Detail.CurNorm).
	Which string `json:"which"`
	To    int    `json:"to"`
	// Diff decodes the field in version To and in the one before, with the same chains.
	Diff   bool          `json:"diff,omitempty"`
	Levels []DecodeLevel `json:"levels"`
}

// Decoded is a decoded field: the last level's result.
type Decoded struct {
	Levels []DecodeLevel `json:"levels"`
	// Path names the field through the levels (`data["yaml.br"] → doc 2: spec.replicas`).
	Path     string   `json:"path"`
	Steps    []string `json:"steps"`
	Kind     string   `json:"kind"`
	Text     string   `json:"text"`
	Language string   `json:"language"`
	Size     int      `json:"size"`
	// Absent: the field isn't in this version (a diff stepped to one without it).
	Absent bool `json:"absent,omitempty"`
	// Refused says why the field can't be decoded (a map, plain text, a
	// step that doesn't apply): an answer, not a failure, so it isn't an
	// error (the bindings log those). The rest is unset then.
	Refused string `json:"refused,omitempty"`
	// Prev is the field in the version before (diff only; nil: there's none).
	Prev *DecodedSide `json:"prev,omitempty"`
	Diff *DiffInfo    `json:"diff,omitempty"`
}

// DecodedSide is the field decoded in the diff's other version.
type DecodedSide struct {
	Text   string `json:"text"`
	Absent bool   `json:"absent,omitempty"`
	// Error: the chain didn't apply to that version's value.
	Error string `json:"error,omitempty"`
}

// errAbsent: the field isn't in the object (a version without it).
var errAbsent = errors.New("field not set")

// Decode decodes the field the request's levels lead to. Nothing is kept:
// each request decodes from the object again. A field that can't be
// decoded is an answer (Decoded.Refused); errors are for a request that
// can't be served (no such object).
func (v *View) Decode(req DecodeRequest) (Decoded, error) {
	e, ok := v.entries[req.Key]
	if !ok {
		return Decoded{}, fmt.Errorf("object %s not found", req.Key)
	}
	if len(req.Levels) == 0 {
		return Decoded{}, errors.New("no field to decode")
	}
	cur, prev, info := v.versions(e, req.To)
	obj := e.item.Object
	if req.Diff || req.Which == "norm" {
		obj = cur
	}
	r, levels, err := decodeLevels(content(obj), req.Levels)
	d := Decoded{Levels: levels, Path: levelsPath(levels)}
	switch {
	case errors.Is(err, errAbsent) && req.Diff && len(req.Levels[0].Path) > 0:
		// a version without the field: the diff shows it added or removed
		d.Absent, d.Levels, d.Path = true, req.Levels, levelsPath(req.Levels)
	case err != nil:
		return Decoded{Levels: req.Levels, Refused: err.Error()}, nil
	default:
		d.Steps, d.Kind, d.Text, d.Language, d.Size = r.Steps, r.Kind, r.Text, r.Language, r.Size
	}
	if !req.Diff {
		return d, nil
	}
	d.Diff = info
	if prev != nil {
		pr, _, err := decodeLevels(content(prev), d.Levels)
		switch {
		case errors.Is(err, errAbsent):
			d.Prev = &DecodedSide{Absent: true}
		case err != nil:
			d.Prev = &DecodedSide{Error: err.Error()}
		default:
			d.Prev = &DecodedSide{Text: pr.Text}
			if d.Absent {
				d.Language = pr.Language
			}
		}
	}
	return d, nil
}

func content(o *unstructured.Unstructured) map[string]any {
	if o == nil {
		return nil
	}
	return o.Object
}

// decodeLevels follows the levels from obj down: each level's field is
// resolved (from its line while it has no path) and decoded, the next one
// is looked up in that decoded YAML. It returns the last level's result
// and the levels with paths and chains filled in.
func decodeLevels(obj map[string]any, in []DecodeLevel) (decode.Result, []DecodeLevel, error) {
	levels := make([]DecodeLevel, len(in))
	copy(levels, in)
	var r decode.Result
	for i := range levels {
		l := &levels[i]
		root, text, line := obj, "", l.Line
		if i == 0 {
			if len(l.Path) == 0 {
				text = toYAML(&unstructured.Unstructured{Object: obj})
			}
		} else {
			if r.Language != "yaml" {
				return r, levels, errors.New("the decoded value isn't YAML: no field in it to decode")
			}
			docs := splitDocs(r.Text)
			if len(l.Path) == 0 {
				l.Doc, line = docAt(docs, l.Line)
				if l.Doc < 0 {
					return r, levels, errors.New("no field on this line")
				}
			}
			if l.Doc >= len(docs) {
				return r, levels, errAbsent
			}
			text = docs[l.Doc].text
			root = nil
			if err := sigsyaml.Unmarshal([]byte(text), &root); err != nil || root == nil {
				return r, levels, errors.New("no field on this line")
			}
		}
		if len(l.Path) == 0 {
			p, err := fieldpath.AtLine(text, line, root)
			if err != nil {
				return r, levels, errors.New("no field on this line")
			}
			l.Path = p
		}
		val, ok := fieldpath.Lookup(root, l.Path)
		if !ok {
			return r, levels, errAbsent
		}
		s, ok := val.(string)
		if !ok {
			return r, levels, notString(l.Path, val)
		}
		last := l.Path[len(l.Path)-1]
		res, err := decode.Auto(s, decode.Options{
			Hint:     last.Key,
			Siblings: siblings(root, l.Path),
			Steps:    l.Steps,
			Raw:      l.Raw && i == len(levels)-1,
			Encoded:  i == 0 && encodedField(obj, l.Path),
		})
		if errors.Is(err, decode.ErrNothing) {
			return r, levels, fmt.Errorf("%s is plain text: nothing to decode", l.Path)
		}
		if err != nil {
			return r, levels, fmt.Errorf("%s: %w", l.Path, err)
		}
		l.Steps = res.Steps
		r = res
	}
	return r, levels, nil
}

func notString(p fieldpath.Path, v any) error {
	switch v.(type) {
	case map[string]any:
		return fmt.Errorf("%s is a map: put the cursor on one of its values", p)
	case []any:
		return fmt.Errorf("%s is a list: put the cursor on one of its items", p)
	case nil:
		return fmt.Errorf("%s is null: nothing to decode", p)
	}
	return fmt.Errorf("%s is %v: nothing to decode", p, v)
}

// encodedField: a field whose value is base64 by definition (a secret's
// data, a config map's binaryData).
func encodedField(obj map[string]any, p fieldpath.Path) bool {
	if len(p) != 2 || p[1].Key == "" {
		return false
	}
	kind, _ := obj["kind"].(string)
	return kind == "Secret" && p[0].Key == "data" || kind == "ConfigMap" && p[0].Key == "binaryData"
}

// siblings are the other string values of the map holding the field (a
// secret's other keys: a private key's certificate).
func siblings(root map[string]any, p fieldpath.Path) map[string]string {
	if len(p) == 0 || p[len(p)-1].Key == "" {
		return nil
	}
	parent, ok := fieldpath.Lookup(root, p[:len(p)-1])
	m, _ := parent.(map[string]any)
	if !ok || len(m) < 2 {
		return nil
	}
	out := make(map[string]string, len(m)-1)
	for k, v := range m {
		if s, ok := v.(string); ok && k != p[len(p)-1].Key {
			out[k] = s
		}
	}
	return out
}

func levelsPath(levels []DecodeLevel) string {
	var parts []string
	for _, l := range levels {
		s := l.Path.String()
		if l.Doc > 0 {
			s = fmt.Sprintf("doc %d: %s", l.Doc+1, s)
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " → ")
}

// A document of a multi-document YAML text: its text and first line.
type doc struct {
	start int
	text  string
}

// splitDocs splits YAML text at its `---` lines (a managed resource's
// manifests, a PEM bundle as rendered).
func splitDocs(text string) []doc {
	lines := strings.Split(text, "\n")
	var docs []doc
	start := 0
	for i := 0; i <= len(lines); i++ {
		if i == len(lines) || lines[i] == "---" || strings.HasPrefix(lines[i], "--- ") {
			docs = append(docs, doc{start: start, text: strings.Join(lines[start:i], "\n")})
			start = i + 1
		}
	}
	return docs
}

// docAt finds the document holding line (0-based) and the line within it;
// -1 on a separator.
func docAt(docs []doc, line int) (int, int) {
	for i := len(docs) - 1; i >= 0; i-- {
		if line >= docs[i].start {
			return i, line - docs[i].start
		}
		if line == docs[i].start-1 {
			return -1, 0
		}
	}
	return -1, 0
}
