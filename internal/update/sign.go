package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// PublicKey verifies the releases' signatures (base64 ed25519); the release
// workflow signs with its private half (an Actions secret, see
// scripts/sign-release.go). Set at build time (-ldflags -X, see the
// Makefile); a build without it can check for updates but not install them,
// as anything it downloaded would be unverified.
var PublicKey = ""

// SigSuffix names a zip's signature asset (kubewing-<v>-macos-arm64.zip.sig).
const SigSuffix = ".sig"

// Message is what a release signature covers: the asset's name (which holds
// the version) and its sha256. Signing the name too means a validly signed
// older zip can't be passed off as a newer one.
func Message(asset, sha256hex string) []byte {
	return []byte("kubewing-release-v1\n" + asset + "\n" + strings.ToLower(sha256hex) + "\n")
}

// Sign signs an asset's name and sha256 (the release workflow).
func Sign(priv ed25519.PrivateKey, asset, sha256hex string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, Message(asset, sha256hex)))
}

// Verify checks a base64 signature of asset with the base64 public key.
func Verify(pub, sig, asset, sha256hex string) error {
	if pub == "" {
		return errors.New("this build has no release key, so it can't verify downloads")
	}
	k, err := base64.StdEncoding.DecodeString(pub)
	if err != nil || len(k) != ed25519.PublicKeySize {
		return fmt.Errorf("the built-in release key is invalid")
	}
	s, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sig))
	if err != nil || len(s) != ed25519.SignatureSize {
		return fmt.Errorf("the release's signature is malformed")
	}
	if !ed25519.Verify(ed25519.PublicKey(k), Message(asset, sha256hex), s) {
		return fmt.Errorf("the release's signature doesn't match: not installing it")
	}
	return nil
}
