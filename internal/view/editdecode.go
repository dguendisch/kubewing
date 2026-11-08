package view

import (
	"errors"
	"fmt"
	"strings"

	sigsyaml "sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/decode"
	"github.com/dguendisch/kubewing/internal/fieldpath"
)

// EditDecodeRequest asks for a field of an editor's text decoded for
// editing (⌘E in the object editor, or deeper in a decoded level). Text is
// what the editor holds, as typed: the object's YAML, or a level's decoded
// YAML or JSON. Nothing is kept: the encode sends the texts again.
type EditDecodeRequest struct {
	Text string `json:"text"`
	// Language of Text: yaml or json.
	Language string `json:"language"`
	// Line (0-based) picks the field while Path is empty; the answer has it resolved.
	Line int            `json:"line"`
	Path fieldpath.Path `json:"path,omitempty"`
	Doc  int            `json:"doc,omitempty"`
	// Steps: the chain to apply (nil detects one).
	Steps []string `json:"steps"`
	// Object: Text is the object's YAML (a Secret's data is base64 by definition).
	Object bool `json:"object,omitempty"`
}

// EditDecoded is a field decoded for editing, or why it can't be.
type EditDecoded struct {
	Path fieldpath.Path `json:"path"`
	Doc  int            `json:"doc"`
	// Label names the field (`data["data.yaml.br"]`, `doc 2: data.kubeconfig`).
	Label   string   `json:"label"`
	Steps   []string `json:"steps"`
	Kind    string   `json:"kind"`
	Text    string   `json:"text"`
	Lang    string   `json:"language"`
	Compact bool     `json:"compact,omitempty"`
	// Refused says why the field can't be edited decoded (a map, binary,
	// a JWT, plain text): an answer, not an error. The rest is unset then.
	Refused string `json:"refused,omitempty"`
}

// EditEncodeRequest asks for an edited level put back into the text above
// it: Value (the decoded text as edited) encoded with Steps, as the field
// at Path in Opened (the text above as it was when the level opened) was
// encoded, then set at Path in Text (the text above as it is now).
type EditEncodeRequest struct {
	Text     string         `json:"text"`
	Opened   string         `json:"opened"`
	Language string         `json:"language"`
	Path     fieldpath.Path `json:"path"`
	Doc      int            `json:"doc,omitempty"`
	Steps    []string       `json:"steps"`
	Object   bool           `json:"object,omitempty"`
	Value    string         `json:"value"`
}

// EditDecode decodes the field the request picks in its text.
func EditDecode(req EditDecodeRequest) EditDecoded {
	docs, root, path, err := editField(req.Text, req.Language, req.Line, req.Path, req.Doc)
	if err != nil {
		return EditDecoded{Refused: err.Error()}
	}
	doc := req.Doc
	if len(req.Path) == 0 {
		doc, _ = docAt(docs, req.Line)
	}
	val, ok := fieldpath.Lookup(root, path)
	if !ok {
		return EditDecoded{Refused: fmt.Sprintf("%s isn't there any more", path)}
	}
	s, ok := val.(string)
	if !ok {
		return EditDecoded{Refused: notString(path, val).Error()}
	}
	e, err := decode.Edit(s, editOptions(req.Object, root, path, req.Steps))
	if errors.Is(err, decode.ErrNothing) {
		return EditDecoded{Refused: fmt.Sprintf("%s is plain text: edit it in place", path)}
	}
	if err != nil {
		return EditDecoded{Refused: fmt.Sprintf("%s: %v", path, err)}
	}
	label := path.String()
	if doc > 0 || len(docs) > 1 {
		label = fmt.Sprintf("doc %d: %s", doc+1, label)
	}
	return EditDecoded{Path: path, Doc: doc, Label: label, Steps: e.Steps, Kind: e.Kind, Text: e.Text, Lang: e.Language, Compact: e.Compact}
}

// EditEncode returns the request's Text with the edited value encoded back
// in. A value still as decoded leaves Text as it is.
func EditEncode(req EditEncodeRequest) (string, error) {
	_, root, _, err := editField(req.Opened, req.Language, 0, req.Path, req.Doc)
	if err != nil {
		return "", err
	}
	val, _ := fieldpath.Lookup(root, req.Path)
	orig, ok := val.(string)
	if !ok {
		return "", fmt.Errorf("%s isn't a string", req.Path)
	}
	enc, err := decode.Encode(orig, editOptions(req.Object, root, req.Path, req.Steps), req.Value)
	if err != nil {
		return "", err
	}
	if enc == orig {
		// unchanged: the text above stays as it is (whatever was typed there since)
		return req.Text, nil
	}
	docs := splitDocs(req.Text)
	if req.Doc >= len(docs) {
		return "", fmt.Errorf("document %d is gone from the text above", req.Doc+1)
	}
	d := docs[req.Doc]
	out, err := fieldpath.Replace(d.text, req.Path, enc, req.Language)
	if err != nil {
		return "", fmt.Errorf("the text above: %w", err)
	}
	lines := strings.Split(req.Text, "\n")
	n := strings.Count(d.text, "\n") + 1
	return strings.Join(append(append(append([]string{}, lines[:d.start]...), out), lines[d.start+n:]...), "\n"), nil
}

// editField parses text's document doc (or the one holding line, with no
// path) and resolves the field: by path, else at the line.
func editField(text, lang string, line int, path fieldpath.Path, docN int) ([]doc, map[string]any, fieldpath.Path, error) {
	docs := []doc{{text: text}}
	if lang != "json" {
		docs = splitDocs(text)
	}
	l := line
	if len(path) == 0 {
		var d int
		d, l = docAt(docs, line)
		if d < 0 {
			return docs, nil, nil, errors.New("no field on this line")
		}
		docN = d
	}
	if docN >= len(docs) {
		return docs, nil, nil, fmt.Errorf("document %d is gone", docN+1)
	}
	var root map[string]any
	if err := sigsyaml.Unmarshal([]byte(docs[docN].text), &root); err != nil {
		return docs, nil, nil, fmt.Errorf("the text doesn't parse: %v", firstLine(err.Error()))
	}
	if root == nil {
		return docs, nil, nil, errors.New("no field on this line")
	}
	if len(path) == 0 {
		p, err := fieldpath.AtLine(docs[docN].text, l, root)
		if err != nil {
			return docs, root, nil, errors.New("no field on this line")
		}
		path = p
	}
	return docs, root, path, nil
}

func editOptions(object bool, root map[string]any, p fieldpath.Path, steps []string) decode.Options {
	return decode.Options{Hint: p[len(p)-1].Key, Steps: steps, Encoded: object && encodedField(root, p)}
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(s, "\n")
	return l
}
