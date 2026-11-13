package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	jsonpatch "gopkg.in/evanphx/json-patch.v4"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	sigsyaml "sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/view"
)

// editKeep caps open edit sessions (one per editor; abandoned ones linger
// until evicted, oldest first).
const editKeep = 20

// editSession is one object being edited: the row it came from (cluster,
// resource) and the version read when the editor opened. Patches are built
// against it and carry its resourceVersion, so a change made by anyone
// else meanwhile is a conflict instead of being overwritten.
type editSession struct {
	r    row
	orig *unstructured.Unstructured
	used uint64
}

// EditSession is an opened editor: its id and the YAML to edit.
type EditSession struct {
	Session string `json:"session"`
	YAML    string `json:"yaml"`
}

// EditPreview is what an edit would change, as the server reports it in a
// dry run: the normalized object before and after (as the detail diff
// shows objects), and the patch that would be sent.
type EditPreview struct {
	Patch    string `json:"patch"`
	PrevNorm string `json:"prevNorm"`
	CurNorm  string `json:"curNorm"`
	// NoChange: the server would store nothing new (e.g. only status was
	// edited, which the main resource ignores).
	NoChange bool `json:"noChange,omitempty"`
}

// EditOpen reads one row's object fresh from the API server (the watch may
// lag, and Table watches carry no full object for some resources) and opens
// an edit session for it. Read-only contexts are refused here already, not
// only when writing, so nobody edits for nothing.
func (s *Service) EditOpen(paneID, key string) (EditSession, error) {
	if s.opts.Actor == nil {
		return EditSession{}, fmt.Errorf("%s is not available", safety.Edit)
	}
	r, err := s.row(paneID, key)
	if err != nil {
		return EditSession{}, err
	}
	if rule := s.guard.RuleIn(r.context, s.landscape(r.cluster)); rule.ReadOnly {
		return EditSession{}, fmt.Errorf("%s %s/%s: %w %q", safety.Edit, resourceName(r.res, r.typed), r.name(), safety.ErrReadOnly, r.context)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	obj, err := s.opts.Actor.Get(ctx, r.cluster, r.res, r.namespace(), r.name())
	if err != nil {
		return EditSession{}, err
	}
	if uid := r.item.Object.GetUID(); uid != "" && obj.GetUID() != uid {
		return EditSession{}, fmt.Errorf("%s %s was recreated meanwhile; open it again", r.kind(), r.name())
	}
	y, err := sigsyaml.Marshal(obj.Object)
	if err != nil {
		return EditSession{}, err
	}
	id := newSessionID()
	s.mu.Lock()
	s.useq++
	s.edits[id] = &editSession{r: r, orig: obj, used: s.useq}
	if len(s.edits) > editKeep {
		var oldest string
		for k, v := range s.edits {
			if oldest == "" || v.used < s.edits[oldest].used {
				oldest = k
			}
		}
		delete(s.edits, oldest)
	}
	s.mu.Unlock()
	return EditSession{Session: id, YAML: string(y)}, nil
}

// EditClose drops an edit session (editor closed or discarded).
func (s *Service) EditClose(session string) {
	s.mu.Lock()
	delete(s.edits, session)
	s.mu.Unlock()
}

func (s *Service) edit(session string) (*editSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.edits[session]
	if !ok {
		return nil, errors.New("this edit is no longer open (closed, or too many editors since); open it again")
	}
	s.useq++
	e.used = s.useq
	return e, nil
}

// editPatch decodes the edited YAML and returns the merge patch from the
// original to it, with the original's resourceVersion as the precondition.
// What identifies the object stays as it was: a different apiVersion,
// kind, name, namespace or uid would be another object (or a move), not an
// edit. A nil patch means nothing was changed.
func editPatch(orig *unstructured.Unstructured, yaml string) ([]byte, error) {
	var edited map[string]any
	if err := sigsyaml.Unmarshal([]byte(yaml), &edited); err != nil {
		return nil, fmt.Errorf("edited YAML: %w", err)
	}
	if edited == nil {
		return nil, errors.New("edited YAML: empty")
	}
	u := &unstructured.Unstructured{Object: edited}
	switch {
	case u.GetAPIVersion() != orig.GetAPIVersion() || u.GetKind() != orig.GetKind():
		return nil, fmt.Errorf("edited YAML: must stay a %s %s, not %s %s", orig.GetAPIVersion(), orig.GetKind(), u.GetAPIVersion(), u.GetKind())
	case u.GetName() != orig.GetName() || u.GetNamespace() != orig.GetNamespace():
		return nil, fmt.Errorf("edited YAML: name and namespace must stay %s (renaming creates another object)", nsName(orig.GetNamespace(), orig.GetName()))
	case u.GetUID() != orig.GetUID():
		return nil, fmt.Errorf("edited YAML: metadata.uid must stay %s", orig.GetUID())
	}
	before, err := json.Marshal(orig.Object)
	if err != nil {
		return nil, err
	}
	after, err := json.Marshal(edited)
	if err != nil {
		return nil, err
	}
	patch, err := jsonpatch.CreateMergePatch(before, after)
	if err != nil {
		return nil, err
	}
	var p map[string]any
	if err := json.Unmarshal(patch, &p); err != nil {
		return nil, err
	}
	if len(p) == 0 {
		return nil, nil
	}
	md, _ := p["metadata"].(map[string]any)
	if md == nil {
		md = map[string]any{}
		p["metadata"] = md
	}
	// the conflict check: the server refuses the patch (409) if the object changed since it was read
	md["resourceVersion"] = orig.GetResourceVersion()
	return json.Marshal(p)
}

func nsName(ns, name string) string {
	if ns == "" {
		return name
	}
	return ns + "/" + name
}

// EditCheck checks an edit without writing it: the YAML must decode and
// name the same object, and the server dry-runs the patch (validation,
// admission webhooks, the conflict check). The preview is the original
// against what the server would store, both normalized.
func (s *Service) EditCheck(session, yaml string) (EditPreview, error) {
	e, err := s.edit(session)
	if err != nil {
		return EditPreview{}, err
	}
	patch, err := editPatch(e.orig, yaml)
	if err != nil {
		return EditPreview{}, err
	}
	if patch == nil {
		return EditPreview{}, errors.New("no changes")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	got, err := s.opts.Actor.Patch(ctx, e.r.cluster, e.r.res, e.orig.GetNamespace(), e.orig.GetName(), patch, true)
	if err != nil {
		return EditPreview{}, err
	}
	s.mu.Lock()
	norm := s.norm
	s.mu.Unlock()
	prev, cur := norm.Normalize(e.orig), norm.Normalize(got)
	py, err := sigsyaml.Marshal(prev.Object)
	if err != nil {
		return EditPreview{}, err
	}
	cy, err := sigsyaml.Marshal(cur.Object)
	if err != nil {
		return EditPreview{}, err
	}
	return EditPreview{Patch: string(patch), PrevNorm: string(py), CurNorm: string(cy), NoChange: string(py) == string(cy)}, nil
}

// EditApply redeems a prepared edit and writes it: the same patch the
// preview dry-ran, built again from the session's original. The token must
// name the session's object. The open watch shows the new version; the
// session ends on success (on failure it stays, so the editor can retry).
func (s *Service) EditApply(token, session, yaml string) error {
	a, target, err := s.guard.Redeem(token, safety.Edit)
	if err != nil {
		return err
	}
	e, err := s.edit(session)
	if err != nil {
		return err
	}
	t := target.(row)
	if t.context != e.r.context || a.Namespace != e.orig.GetNamespace() || a.Name != e.orig.GetName() || (a.UID != "" && a.UID != string(e.orig.GetUID())) {
		return fmt.Errorf("the prepared edit was for %s, not %s", nsName(a.Namespace, a.Name), nsName(e.orig.GetNamespace(), e.orig.GetName()))
	}
	patch, err := editPatch(e.orig, yaml)
	if err != nil {
		return err
	}
	if patch == nil {
		return errors.New("no changes")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := s.opts.Actor.Patch(ctx, e.r.cluster, e.r.res, e.orig.GetNamespace(), e.orig.GetName(), patch, false); err != nil {
		return err
	}
	s.EditClose(session)
	s.refreshAfter(e.r)
	return nil
}

// EditDecode decodes a field of an editor's text for editing (⌘E in the
// editor); stateless: the encode sends the texts again (see view.EditDecode).
func (s *Service) EditDecode(req view.EditDecodeRequest) view.EditDecoded {
	return view.EditDecode(req)
}

// EditEncode puts an edited decoded level back into the text above it.
func (s *Service) EditEncode(req view.EditEncodeRequest) (string, error) {
	return view.EditEncode(req)
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
