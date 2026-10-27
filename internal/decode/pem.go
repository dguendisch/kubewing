package decode

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"sort"
	"strings"
	"time"
)

// renderPEM describes each block of a PEM bundle: certificates (subject,
// issuer, SANs, validity, usage, serial, fingerprint), private and public
// keys (type, size, encoding, public-key fingerprint, and which certificate
// of the secret they match). Anything else in the bundle is named only.
func renderPEM(b []byte, o Options) (string, bool) {
	if !bytes.Contains(b, []byte("-----BEGIN ")) {
		return "", false
	}
	var w strings.Builder
	n := 0
	for rest := b; ; {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if n > 0 {
			w.WriteString("---\n")
		}
		n++
		switch blk.Type {
		case "CERTIFICATE":
			writeCert(&w, blk.Bytes, o.Now)
		case "PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY":
			writeKey(&w, blk, o)
		case "PUBLIC KEY", "RSA PUBLIC KEY":
			writePublic(&w, blk, o)
		case "CERTIFICATE REQUEST":
			writeCSR(&w, blk.Bytes)
		default:
			fmt.Fprintf(&w, "type: %s\nsize: %d bytes\n", blk.Type, len(blk.Bytes))
		}
	}
	if n == 0 {
		return "", false
	}
	return w.String(), true
}

func writeCert(w *strings.Builder, der []byte, now time.Time) {
	c, err := x509.ParseCertificate(der)
	if err != nil {
		fmt.Fprintf(w, "type: certificate\nerror: %q\n", err.Error())
		return
	}
	w.WriteString("type: certificate\n")
	fmt.Fprintf(w, "subject: %q\n", c.Subject.String())
	fmt.Fprintf(w, "issuer: %q\n", c.Issuer.String())
	if c.Subject.String() == c.Issuer.String() {
		w.WriteString("selfSigned: true\n")
	}
	if c.IsCA {
		w.WriteString("ca: true\n")
	}
	list(w, "dnsNames", c.DNSNames)
	var ips []string
	for _, ip := range c.IPAddresses {
		ips = append(ips, ip.String())
	}
	list(w, "ipAddresses", ips)
	list(w, "emailAddresses", c.EmailAddresses)
	var uris []string
	for _, u := range c.URIs {
		uris = append(uris, u.String())
	}
	list(w, "uris", uris)
	fmt.Fprintf(w, "notBefore: %s  # %s\n", c.NotBefore.UTC().Format(time.RFC3339), ago(c.NotBefore, now))
	note := ago(c.NotAfter, now)
	switch {
	case c.NotAfter.Before(now):
		note = "EXPIRED " + note
	case c.NotBefore.After(now):
		note = "NOT YET VALID, expires " + note
	}
	fmt.Fprintf(w, "notAfter: %s  # %s\n", c.NotAfter.UTC().Format(time.RFC3339), note)
	list(w, "keyUsage", keyUsages(c.KeyUsage))
	list(w, "extKeyUsage", extKeyUsages(c.ExtKeyUsage))
	fmt.Fprintf(w, "publicKey: %s\n", keyDesc(c.PublicKey))
	fmt.Fprintf(w, "publicKeySHA256: %s\n", fingerprint(c.PublicKey))
	fmt.Fprintf(w, "serial: %s\n", c.SerialNumber.Text(16))
	sum := sha256.Sum256(der)
	fmt.Fprintf(w, "sha256: %s\n", colons(sum[:]))
}

func writeCSR(w *strings.Builder, der []byte) {
	r, err := x509.ParseCertificateRequest(der)
	if err != nil {
		fmt.Fprintf(w, "type: certificate request\nerror: %q\n", err.Error())
		return
	}
	w.WriteString("type: certificate request\n")
	fmt.Fprintf(w, "subject: %q\n", r.Subject.String())
	list(w, "dnsNames", r.DNSNames)
	var ips []string
	for _, ip := range r.IPAddresses {
		ips = append(ips, ip.String())
	}
	list(w, "ipAddresses", ips)
	fmt.Fprintf(w, "publicKey: %s\n", keyDesc(r.PublicKey))
}

func writeKey(w *strings.Builder, blk *pem.Block, o Options) {
	w.WriteString("type: private key\n")
	if blk.Type == "ENCRYPTED PRIVATE KEY" || blk.Headers["Proc-Type"] != "" {
		w.WriteString("encoding: PKCS#8\nencrypted: true\n")
		return
	}
	var (
		key any
		enc string
		err error
	)
	switch blk.Type {
	case "RSA PRIVATE KEY":
		enc = "PKCS#1"
		key, err = x509.ParsePKCS1PrivateKey(blk.Bytes)
	case "EC PRIVATE KEY":
		enc = "SEC1"
		key, err = x509.ParseECPrivateKey(blk.Bytes)
	default:
		enc = "PKCS#8"
		key, err = x509.ParsePKCS8PrivateKey(blk.Bytes)
	}
	fmt.Fprintf(w, "encoding: %s\n", enc)
	if err != nil {
		fmt.Fprintf(w, "error: %q\n", err.Error())
		return
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		fmt.Fprintf(w, "key: %T\n", key)
		return
	}
	pub := signer.Public()
	fmt.Fprintf(w, "key: %s\n", keyDesc(pub))
	fmt.Fprintf(w, "publicKeySHA256: %s\n", fingerprint(pub))
	writeMatches(w, pub, o)
}

func writePublic(w *strings.Builder, blk *pem.Block, o Options) {
	w.WriteString("type: public key\n")
	var (
		pub any
		err error
	)
	if blk.Type == "RSA PUBLIC KEY" {
		pub, err = x509.ParsePKCS1PublicKey(blk.Bytes)
	} else {
		pub, err = x509.ParsePKIXPublicKey(blk.Bytes)
	}
	if err != nil {
		fmt.Fprintf(w, "error: %q\n", err.Error())
		return
	}
	fmt.Fprintf(w, "key: %s\n", keyDesc(pub))
	fmt.Fprintf(w, "publicKeySHA256: %s\n", fingerprint(pub))
	writeMatches(w, pub, o)
}

// writeMatches names the certificates among the siblings (a secret's other
// keys, decoded) whose public key is pub: `tls.key` ↔ `tls.crt`.
func writeMatches(w *strings.Builder, pub any, o Options) {
	if len(o.Siblings) == 0 {
		return
	}
	type pk interface{ Equal(crypto.PublicKey) bool }
	p, ok := pub.(pk)
	if !ok {
		return
	}
	var match, other []string
	for k, v := range o.Siblings {
		b, _ := detect([]byte(v), k, false)
		for rest := b; ; {
			var blk *pem.Block
			blk, rest = pem.Decode(rest)
			if blk == nil {
				break
			}
			if blk.Type != "CERTIFICATE" {
				continue
			}
			c, err := x509.ParseCertificate(blk.Bytes)
			if err != nil {
				continue
			}
			name := k
			if cn := c.Subject.CommonName; cn != "" {
				name = fmt.Sprintf("%s (%s)", k, cn)
			}
			if p.Equal(c.PublicKey) {
				match = append(match, name)
			} else {
				other = append(other, name)
			}
		}
	}
	sort.Strings(match)
	sort.Strings(other)
	switch {
	case len(match) > 0:
		list(w, "matchesCertificate", match)
	case len(other) > 0:
		w.WriteString("matchesCertificate: []  # MISMATCH: none of the certificates in this object has this key\n")
		list(w, "otherCertificates", other)
	}
}

func keyDesc(pub any) string {
	switch k := pub.(type) {
	case *rsa.PublicKey:
		return fmt.Sprintf("RSA %d bits", k.N.BitLen())
	case *ecdsa.PublicKey:
		return "ECDSA " + k.Curve.Params().Name
	case ed25519.PublicKey:
		return "Ed25519"
	}
	return fmt.Sprintf("%T", pub)
}

// fingerprint is the SHA-256 of the key's SubjectPublicKeyInfo (as
// `openssl pkey -pubout -outform der | sha256sum`), the same for a
// certificate and its private key.
func fingerprint(pub any) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "?"
	}
	sum := sha256.Sum256(der)
	return colons(sum[:])
}

func colons(b []byte) string {
	h := strings.ToUpper(hex.EncodeToString(b))
	var out strings.Builder
	for i := 0; i < len(h); i += 2 {
		if i > 0 {
			out.WriteByte(':')
		}
		out.WriteString(h[i : i+2])
	}
	return out.String()
}

func list(w *strings.Builder, key string, vals []string) {
	if len(vals) == 0 {
		return
	}
	fmt.Fprintf(w, "%s:\n", key)
	for _, v := range vals {
		fmt.Fprintf(w, "  - %q\n", v)
	}
}

func keyUsages(u x509.KeyUsage) []string {
	names := []string{"digitalSignature", "contentCommitment", "keyEncipherment", "dataEncipherment", "keyAgreement", "certSign", "crlSign", "encipherOnly", "decipherOnly"}
	var out []string
	for i, n := range names {
		if u&(1<<i) != 0 {
			out = append(out, n)
		}
	}
	return out
}

func extKeyUsages(us []x509.ExtKeyUsage) []string {
	names := map[x509.ExtKeyUsage]string{
		x509.ExtKeyUsageAny: "any", x509.ExtKeyUsageServerAuth: "serverAuth", x509.ExtKeyUsageClientAuth: "clientAuth",
		x509.ExtKeyUsageCodeSigning: "codeSigning", x509.ExtKeyUsageEmailProtection: "emailProtection",
		x509.ExtKeyUsageTimeStamping: "timeStamping", x509.ExtKeyUsageOCSPSigning: "ocspSigning",
	}
	var out []string
	for _, u := range us {
		if n, ok := names[u]; ok {
			out = append(out, n)
		} else {
			out = append(out, fmt.Sprintf("%d", u))
		}
	}
	return out
}
