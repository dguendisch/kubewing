package decode

import (
	"bytes"
	"compress/gzip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
)

var now = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func br(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := brotli.NewWriter(&buf)
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func gz(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func jwt(header, payload string) string {
	e := base64.RawURLEncoding.EncodeToString
	return e([]byte(header)) + "." + e([]byte(payload)) + "." + e([]byte("not-a-real-signature"))
}

const manifests = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: svc\n"

func TestAuto(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		opts    Options
		steps   []string
		kind    string
		has     []string
		nothing bool
	}{
		{name: "plain text is left alone", value: "kube-system", nothing: true},
		{name: "a word that happens to be base64 is text", value: "admin123", nothing: true},
		{name: "true is text", value: "true", nothing: true},
		{name: "base64 text", value: b64([]byte("hello world")), steps: []string{Base64}, kind: Text, has: []string{"hello world"}},
		{name: "secret data: base64 of a short password", value: b64([]byte("s3cr3t!")), opts: Options{Encoded: true}, steps: []string{Base64}, kind: Text, has: []string{"s3cr3t!"}},
		{name: "unpadded url-safe base64", value: base64.RawURLEncoding.EncodeToString([]byte("a?b>c~~~d")), steps: []string{Base64}, kind: Text, has: []string{"a?b>c~~~d"}},
		{name: "wrapped base64", value: wrap(b64([]byte(strings.Repeat("line of text ", 20))), 76), steps: []string{Base64}, kind: Text},
		{name: "base64 of yaml", value: b64([]byte(manifests)), steps: []string{Base64}, kind: YAML, has: []string{"kind: Service"}},
		{name: "base64 brotli yaml, by the .br key", value: "", opts: Options{Hint: "data.yaml.br", Encoded: true}, steps: []string{Base64, Brotli}, kind: YAML, has: []string{"kind: ConfigMap", "name: svc"}},
		{name: "base64 brotli yaml, detected without the key", value: "", opts: Options{Hint: "data.yaml"}, steps: []string{Base64, Brotli}, kind: YAML, has: []string{"kind: ConfigMap"}},
		{name: "base64 gzip json", value: b64(gz(t, []byte(`{"b":[1,2],"a":"x"}`))), steps: []string{Base64, Gzip}, kind: JSON, has: []string{"a: x", "b:\n    - 1"}},
		{name: "json in a string", value: `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p"}}`, steps: []string{}, kind: JSON, has: []string{"kind: Pod", "metadata:\n    name: p"}},
		{name: "json scalar is text", value: `"just a string"`, nothing: true},
		{name: "a yaml scalar is text", value: "just: text: here", nothing: true},
		{name: "binary as a hex dump", value: b64([]byte{0, 1, 2, 3, 0xff, 0xfe, 'A', 'B'}), opts: Options{Encoded: true}, steps: []string{Base64}, kind: Binary, has: []string{"# binary, 8 bytes", "00000000  00 01 02 03 ff fe 41 42", "|......AB|"}},
		{
			name: "jwt", value: jwt(`{"alg":"RS256","kid":"k1"}`, `{"iss":"https://kubernetes.default.svc","sub":"system:serviceaccount:kube-system:default","exp":1793116800,"iat":1761566400}`),
			steps: []string{}, kind: JWT,
			has: []string{"# JWT, signature not verified", "alg: RS256", "sub: system:serviceaccount:kube-system:default", "exp: 1793116800  # 2026-10-27T16:00:00Z, in 4h", "iat: 1761566400  # 2025-10-27T12:00:00Z, 365d ago"},
		},
		{name: "expired jwt", value: jwt(`{"alg":"none"}`, `{"exp":1761566400}`), steps: []string{}, kind: JWT, has: []string{"# EXPIRED 2025-10-27T12:00:00Z, 365d ago"}},
		{name: "jwt in a secret (base64 of it)", value: b64([]byte(jwt(`{"alg":"RS256"}`, `{"exp":1793188800}`))), opts: Options{Encoded: true}, steps: []string{Base64}, kind: JWT, has: []string{"in 24h"}},
		{name: "explicit steps: base64 only, raw", value: "", opts: Options{Hint: "data.yaml.br", Steps: []string{Base64}, Raw: true}, steps: []string{Base64}, kind: Binary},
		{name: "explicit steps: none, rendered", value: manifests, opts: Options{Steps: []string{}}, steps: []string{}, kind: YAML},
		{name: "explicit steps: none, plain text shown", value: b64([]byte(manifests)), opts: Options{Steps: []string{}}, steps: []string{}, kind: Text},
	}
	brValue := b64(br(t, manifests))
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v := tc.value
			if v == "" {
				v = brValue
			}
			tc.opts.Now = now
			r, err := Auto(v, tc.opts)
			if tc.nothing {
				if !errors.Is(err, ErrNothing) {
					t.Fatalf("want ErrNothing, got %v (%+v)", err, r)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(r.Steps, ",") != strings.Join(tc.steps, ",") {
				t.Errorf("steps %v, want %v", r.Steps, tc.steps)
			}
			if r.Kind != tc.kind {
				t.Errorf("kind %s, want %s\n%s", r.Kind, tc.kind, r.Text)
			}
			for _, h := range tc.has {
				if !strings.Contains(r.Text, h) {
					t.Errorf("text lacks %q:\n%s", h, r.Text)
				}
			}
		})
	}
}

func wrap(s string, n int) string {
	var b strings.Builder
	for i := 0; i < len(s); i += n {
		b.WriteString(s[i:min(i+n, len(s))])
		b.WriteByte('\n')
	}
	return b.String()
}

func TestExplicitStepFails(t *testing.T) {
	_, err := Auto("plain words here", Options{Steps: []string{Base64}})
	if err == nil || !strings.Contains(err.Error(), "base64") {
		t.Fatalf("want a base64 error, got %v", err)
	}
	_, err = Auto(b64([]byte("not brotli at all")), Options{Steps: []string{Base64, Brotli}})
	if err == nil || !strings.HasPrefix(err.Error(), "brotli") {
		t.Fatalf("want a brotli error, got %v", err)
	}
}

func TestDecompressionCap(t *testing.T) {
	bomb := gz(t, make([]byte, Limit+1))
	_, err := Auto(b64(bomb), Options{Steps: []string{Base64, Gzip}})
	if err == nil || !strings.Contains(err.Error(), "larger than 16 MiB") {
		t.Fatalf("want the cap, got %v", err)
	}
	// detected: the chain stops before the step that's too big
	r, err := Auto(b64(bomb), Options{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.Steps, ",") != Base64 || r.Kind != Binary {
		t.Fatalf("got %v %s", r.Steps, r.Kind)
	}
}

func TestHexDumpFirstKiB(t *testing.T) {
	r, err := Auto(b64(make([]byte, 3000)), Options{Encoded: true, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.Text, "# binary, 3000 bytes (the first 1024 shown)") || strings.Count(r.Text, "\n") != 65 {
		t.Fatalf("dump:\n%s", r.Text)
	}
	if r.Size != 3000 {
		t.Fatalf("size %d", r.Size)
	}
}

type pair struct{ cert, key string }

func tlsPair(t *testing.T, cn string, ec bool) pair {
	t.Helper()
	var (
		signer any
		pub    any
		keyPEM []byte
	)
	if ec {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		der, _ := x509.MarshalECPrivateKey(k)
		signer, pub, keyPEM = k, &k.PublicKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	} else {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		signer, pub, keyPEM = k, &k.PublicKey, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(0xabc),
		Subject:      pkix.Name{CommonName: cn, Organization: []string{"gardener"}},
		NotBefore:    now.Add(-24 * time.Hour),
		NotAfter:     now.Add(90 * 24 * time.Hour),
		DNSNames:     []string{cn, "*." + cn},
		IPAddresses:  []net.IP{net.ParseIP("10.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, signer)
	if err != nil {
		t.Fatal(err)
	}
	return pair{cert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), key: string(keyPEM)}
}

func TestPEM(t *testing.T) {
	a := tlsPair(t, "api.example.com", false)
	b := tlsPair(t, "other.example.com", true)

	r, err := Auto(b64([]byte(a.cert)), Options{Encoded: true, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != PEM {
		t.Fatalf("kind %s", r.Kind)
	}
	for _, h := range []string{
		"type: certificate", `subject: "CN=api.example.com,O=gardener"`, "selfSigned: true",
		"dnsNames:\n  - \"api.example.com\"\n  - \"*.api.example.com\"", "ipAddresses:\n  - \"10.0.0.1\"",
		"notAfter: 2027-01-25T12:00:00Z  # in 90d", "keyUsage:\n  - \"digitalSignature\"\n  - \"keyEncipherment\"",
		"extKeyUsage:\n  - \"serverAuth\"", "publicKey: RSA 2048 bits", "serial: abc", "sha256: ",
	} {
		if !strings.Contains(r.Text, h) {
			t.Errorf("certificate lacks %q:\n%s", h, r.Text)
		}
	}

	// a bundle: each block, separated
	r, _ = Auto(a.cert+b.cert, Options{Now: now})
	if strings.Count(r.Text, "type: certificate") != 2 || !strings.Contains(r.Text, "---\n") || !strings.Contains(r.Text, "ECDSA P-256") {
		t.Errorf("bundle:\n%s", r.Text)
	}

	// a private key: which certificate of the secret it belongs to
	sib := map[string]string{"tls.crt": b64([]byte(a.cert)), "ca.crt": b64([]byte(b.cert))}
	r, _ = Auto(b64([]byte(a.key)), Options{Hint: "tls.key", Encoded: true, Siblings: sib, Now: now})
	for _, h := range []string{"type: private key", "encoding: PKCS#1", "key: RSA 2048 bits", "publicKeySHA256: ", "matchesCertificate:\n  - \"tls.crt (api.example.com)\""} {
		if !strings.Contains(r.Text, h) {
			t.Errorf("key lacks %q:\n%s", h, r.Text)
		}
	}
	// the same fingerprint as the certificate's public key
	cr, _ := Auto(a.cert, Options{Now: now})
	if fp := line(r.Text, "publicKeySHA256: "); fp == "" || fp != line(cr.Text, "publicKeySHA256: ") {
		t.Errorf("fingerprints differ: %q vs %q", fp, line(cr.Text, "publicKeySHA256: "))
	}

	// a mismatched pair says so
	r, _ = Auto(b.key, Options{Hint: "tls.key", Siblings: map[string]string{"tls.crt": b64([]byte(a.cert))}, Now: now})
	for _, h := range []string{"encoding: SEC1", "key: ECDSA P-256", "MISMATCH", "otherCertificates:\n  - \"tls.crt (api.example.com)\""} {
		if !strings.Contains(r.Text, h) {
			t.Errorf("mismatched key lacks %q:\n%s", h, r.Text)
		}
	}

	// encrypted: no material to look into
	enc := string(pem.EncodeToMemory(&pem.Block{Type: "ENCRYPTED PRIVATE KEY", Bytes: []byte{1, 2, 3}}))
	r, _ = Auto(enc, Options{Now: now})
	if !strings.Contains(r.Text, "encrypted: true") {
		t.Errorf("encrypted:\n%s", r.Text)
	}
}

func TestExpiredCertificate(t *testing.T) {
	a := tlsPair(t, "old.example.com", true)
	r, _ := Auto(a.cert, Options{Now: now.Add(100 * 24 * time.Hour)})
	if !strings.Contains(r.Text, "# EXPIRED 10d ago") {
		t.Errorf("expired:\n%s", r.Text)
	}
}

func line(text, prefix string) string {
	for _, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(l, prefix) {
			return strings.TrimPrefix(l, prefix)
		}
	}
	return ""
}
