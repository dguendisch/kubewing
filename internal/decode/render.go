package decode

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	yaml "go.yaml.in/yaml/v3"
	sigsyaml "sigs.k8s.io/yaml"
)

// renderJWT shows a JWT's header and payload as YAML, its times annotated;
// the signature isn't verified (there's no key to verify it with).
func renderJWT(s string, now time.Time) (string, bool) {
	s = strings.TrimSpace(s)
	parts := strings.Split(s, ".")
	if len(parts) != 3 || !strings.HasPrefix(s, "eyJ") {
		return "", false
	}
	var head, claims map[string]any
	if !jwtPart(parts[0], &head) || !jwtPart(parts[1], &claims) {
		return "", false
	}
	var w strings.Builder
	w.WriteString("# JWT, signature not verified\n")
	w.WriteString("header:\n")
	writeYAML(&w, head, "  ", nil)
	w.WriteString("payload:\n")
	writeYAML(&w, claims, "  ", func(k string, v any) string {
		if k != "exp" && k != "iat" && k != "nbf" && k != "auth_time" {
			return ""
		}
		n, ok := v.(json.Number)
		if !ok {
			return ""
		}
		f, err := n.Float64()
		if err != nil {
			return ""
		}
		t := time.Unix(int64(f), 0).UTC()
		note := t.Format(time.RFC3339) + ", " + ago(t, now)
		if k == "exp" && t.Before(now) {
			note = "EXPIRED " + note
		}
		return note
	})
	if len(parts[2]) > 0 {
		fmt.Fprintf(&w, "signature: %d bytes\n", base64.RawURLEncoding.DecodedLen(len(parts[2])))
	}
	return w.String(), true
}

func jwtPart(p string, into *map[string]any) bool {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(p, "="))
	if err != nil {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber() // exp: 1793102400, not 1.7931024e+09
	return d.Decode(into) == nil && *into != nil
}

// writeYAML writes a map as YAML at an indent; note adds a comment to a
// top-level key's line.
func writeYAML(w *strings.Builder, m map[string]any, indent string, note func(k string, v any) string) {
	// via JSON (sigs.k8s.io/yaml): json.Number stays a number
	b, err := sigsyaml.Marshal(m)
	if err != nil {
		fmt.Fprintf(w, "%s# %v\n", indent, err)
		return
	}
	for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		w.WriteString(indent)
		w.WriteString(line)
		if note != nil && !strings.HasPrefix(line, " ") {
			if k, _, ok := strings.Cut(line, ":"); ok {
				if n := note(k, m[k]); n != "" {
					w.WriteString("  # ")
					w.WriteString(n)
				}
			}
		}
		w.WriteByte('\n')
	}
}

// prettyJSON keeps a JSON object or array as JSON (last-applied-configuration,
// a docker config, a kubeconfig in JSON): as written if it spans lines,
// indented if it's on one (so a line picks a field, for ⏎ deeper).
func prettyJSON(b []byte) (string, bool) {
	t := bytes.TrimSpace(b)
	if len(t) < 2 || (t[0] != '{' && t[0] != '[') || !json.Valid(t) {
		return "", false
	}
	if bytes.ContainsRune(t, '\n') {
		return string(b), true
	}
	var out bytes.Buffer
	if json.Indent(&out, t, "", "  ") != nil {
		return "", false
	}
	out.WriteByte('\n')
	return out.String(), true
}

// prettyYAML keeps YAML that holds a map or a list of them (a kubeconfig, a
// managed resource's manifests) as it is: it's already readable, but the
// viewer should color and fold it as YAML. A scalar is just text.
func prettyYAML(b []byte) (string, bool) {
	dec := yaml.NewDecoder(bytes.NewReader(b))
	docs := 0
	for {
		var n yaml.Node
		err := dec.Decode(&n)
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return "", false
		}
		if len(n.Content) == 0 {
			continue
		}
		if k := n.Content[0].Kind; k != yaml.MappingNode && k != yaml.SequenceNode {
			return "", false
		}
		docs++
	}
	if docs == 0 {
		return "", false
	}
	return string(b), true
}
