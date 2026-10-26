// Package normalize strips noise from Kubernetes objects so that diffs and
// change detection only reflect meaningful changes.
package normalize

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Rule removes the field at Path. Path segments are separated by "."; the
// segment "*" matches every element of a list or every key of a map.
type Rule struct {
	Path string `json:"path"`
	// Kinds optionally restricts the rule to the given object kinds.
	Kinds []string `json:"kinds,omitempty"`
}

// DefaultRules are always applied; users can add more via config.
var DefaultRules = []Rule{
	{Path: "metadata.resourceVersion"},
	{Path: "metadata.managedFields"},
	{Path: "metadata.generation"},
	{Path: "metadata.annotations.kubectl\\.kubernetes\\.io/last-applied-configuration"},
	{Path: "status.conditions.*.lastHeartbeatTime"},
	{Path: "status.conditions.*.lastProbeTime"},
	{Path: "spec.renewTime", Kinds: []string{"Lease"}},
}

// Normalizer applies a fixed set of rules.
type Normalizer struct {
	rules [][]string
	kinds [][]string
}

// New returns a normalizer applying DefaultRules plus extra.
func New(extra ...Rule) *Normalizer {
	n := &Normalizer{}
	for _, r := range append(append([]Rule{}, DefaultRules...), extra...) {
		n.rules = append(n.rules, splitPath(r.Path))
		n.kinds = append(n.kinds, r.Kinds)
	}
	return n
}

// splitPath splits on unescaped dots ("\." keeps a literal dot).
func splitPath(p string) []string {
	var segs []string
	var cur strings.Builder
	for i := 0; i < len(p); i++ {
		switch {
		case p[i] == '\\' && i+1 < len(p) && p[i+1] == '.':
			cur.WriteByte('.')
			i++
		case p[i] == '.':
			segs = append(segs, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(p[i])
		}
	}
	return append(segs, cur.String())
}

// Normalize returns a deep copy of obj with all noise fields removed.
func (n *Normalizer) Normalize(obj *unstructured.Unstructured) *unstructured.Unstructured {
	out := obj.DeepCopy()
	kind := out.GetKind()
	for i, segs := range n.rules {
		if len(n.kinds[i]) > 0 && !contains(n.kinds[i], kind) {
			continue
		}
		remove(out.Object, segs)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func remove(node any, segs []string) {
	if len(segs) == 0 {
		return
	}
	switch v := node.(type) {
	case map[string]any:
		if segs[0] == "*" {
			for _, child := range v {
				remove(child, segs[1:])
			}
			return
		}
		if len(segs) == 1 {
			delete(v, segs[0])
			return
		}
		remove(v[segs[0]], segs[1:])
	case []any:
		if segs[0] != "*" {
			return
		}
		for _, child := range v {
			remove(child, segs[1:])
		}
	}
}

// Hash returns a stable content hash of a (normalized) object.
func Hash(obj *unstructured.Unstructured) string {
	h, _ := HashSize(obj)
	return h
}

// HashSize is Hash plus the size of the object's JSON encoding (a cheap
// estimate of the memory it holds; it's encoded for the hash anyway).
func HashSize(obj *unstructured.Unstructured) (string, int) {
	// encoding/json sorts map keys, so the encoding is canonical.
	b, err := json.Marshal(obj.Object)
	if err != nil {
		return "", 0
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:12]), len(b)
}
