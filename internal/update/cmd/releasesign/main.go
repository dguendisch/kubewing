// Command releasesign makes and uses the release signing key (see
// Development.md, "Release signing"):
//
//	go run ./internal/update/cmd/releasesign -keygen        # prints a new key pair
//	KUBEWING_SIGNING_KEY=… go run ./internal/update/cmd/releasesign bin/kubewing-0.2.0-macos-arm64.zip
//
// Signing writes <zip>.sig next to the zip: the base64 ed25519 signature of
// the zip's name and sha256 (update.Message), which the updater checks with
// the public key built into the app (build/release-key.pub).
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/dguendisch/kubewing/internal/update"
)

func main() {
	keygen := flag.Bool("keygen", false, "print a new key pair: the private key for the KUBEWING_SIGNING_KEY secret, the public one for build/release-key.pub")
	flag.Parse()
	log.SetFlags(0)
	if *keygen {
		pub, priv, err := ed25519.GenerateKey(nil)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("private (secret KUBEWING_SIGNING_KEY): %s\n", base64.StdEncoding.EncodeToString(priv.Seed()))
		fmt.Printf("public  (build/release-key.pub):       %s\n", base64.StdEncoding.EncodeToString(pub))
		return
	}
	if flag.NArg() != 1 {
		log.Fatal("usage: releasesign -keygen | releasesign <zip>  (key in $KUBEWING_SIGNING_KEY)")
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("KUBEWING_SIGNING_KEY")))
	if err != nil || len(seed) != ed25519.SeedSize {
		log.Fatal("KUBEWING_SIGNING_KEY: not a base64 ed25519 seed (see -keygen)")
	}
	priv := ed25519.NewKeyFromSeed(seed)
	zip := flag.Arg(0)
	f, err := os.Open(zip)
	if err != nil {
		log.Fatal(err)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		log.Fatal(err)
	}
	f.Close()
	sum := hex.EncodeToString(h.Sum(nil))
	sig := update.Sign(priv, filepath.Base(zip), sum)
	// the public key alongside, if present: a mismatched secret fails here, not on users' machines
	if b, err := os.ReadFile("build/release-key.pub"); err == nil {
		if err := update.Verify(strings.TrimSpace(string(b)), sig, filepath.Base(zip), sum); err != nil {
			log.Fatalf("KUBEWING_SIGNING_KEY doesn't match build/release-key.pub: %v", err)
		}
	}
	if err := os.WriteFile(zip+update.SigSuffix, []byte(sig+"\n"), 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("signed %s\n", zip+update.SigSuffix)
}
