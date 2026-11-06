package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Installer replaces the running app bundle with a downloaded release:
//
//  1. download the zip and its signature into a staging folder beside the
//     bundle (same volume, so the swap is a rename), hashing as it goes;
//  2. check GitHub's digest and the signature (the built-in key);
//  3. unpack with ditto, check the new bundle's code signature and that its
//     binary runs and reports the expected version;
//  4. swap the two bundles in one step (renamex_np RENAME_SWAP: there's never
//     a moment without an app), remove the old one;
//  5. start a helper that opens the new bundle once this process has exited,
//     and quit (sessions end, which the dialog said).
//
// The download isn't quarantined (only browsers and the like set the flag),
// so the new version doesn't meet Gatekeeper again.
type Installer struct {
	// Bundle is the running kubewing.app ("" = not running from a bundle).
	Bundle    string
	PublicKey string
	Client    *http.Client
	// Run runs a tool (ditto, codesign, the new binary); nil = exec.
	Run func(ctx context.Context, name string, args ...string) ([]byte, error)
	// Swap exchanges two paths atomically; nil = renamex_np (swap_darwin.go).
	Swap func(a, b string) error
	// Relaunch opens bundle once process pid has exited; nil = a detached sh.
	Relaunch func(pid int, bundle string) error
	// Quit ends the app (its shutdown ends the sessions).
	Quit func()
}

// RunningBundle is the .app the executable runs from, "" if none (a bare
// `make build` binary, go run).
func RunningBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	app := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(app, ".app") {
		return ""
	}
	return app
}

// Blocked says why the bundle can't be replaced in place, "" if it can.
func (in *Installer) Blocked() string {
	switch {
	case in.Bundle == "":
		return "kubewing doesn't run from an app bundle"
	case strings.Contains(in.Bundle, "/AppTranslocation/"):
		// macOS runs a quarantined app from a random read-only copy until it's moved
		return "move kubewing.app to Applications first (macOS runs it from a temporary copy)"
	case in.PublicKey == "":
		return "this build has no release key, so it can't verify downloads"
	}
	for _, p := range []string{filepath.Dir(in.Bundle), in.Bundle} {
		if !writable(p) {
			return "no permission to replace " + in.Bundle
		}
	}
	return ""
}

// Install installs r (see Installer); progress reports the phase
// ("download" with 0..1, "verify", "install", "restart").
func (in *Installer) Install(ctx context.Context, r Release, progress func(phase string, p float64)) (err error) {
	version := r.Version()
	name := AssetName(version)
	zip, ok := r.Asset(name)
	if !ok {
		return fmt.Errorf("the release has no %s", name)
	}
	sig, ok := r.Asset(name + SigSuffix)
	if !ok {
		return fmt.Errorf("the release isn't signed (no %s%s): download it from the release page", name, SigSuffix)
	}
	parent := filepath.Dir(in.Bundle)
	staging, err := os.MkdirTemp(parent, ".kubewing-update-")
	if err != nil {
		return fmt.Errorf("preparing the download: %w", err)
	}
	// on success it holds the old bundle (removed too); on failure the partial new one
	defer os.RemoveAll(staging)

	progress("download", 0)
	sigText, err := in.fetch(ctx, sig.URL, 4096)
	if err != nil {
		return fmt.Errorf("downloading the signature: %w", err)
	}
	zipFile := filepath.Join(staging, name)
	sum, err := in.download(ctx, zip, zipFile, func(p float64) { progress("download", p) })
	if err != nil {
		return fmt.Errorf("downloading: %w", err)
	}

	progress("verify", 0)
	if zip.Digest != "" {
		want, err := digest(zip.Digest)
		if err != nil {
			return err
		}
		if want != sum {
			return fmt.Errorf("the download is damaged (sha256 %s, GitHub lists %s)", sum, want)
		}
	}
	if err := Verify(in.PublicKey, string(sigText), name, sum); err != nil {
		return err
	}
	unpacked := filepath.Join(staging, "new")
	if out, err := in.run(ctx, "/usr/bin/ditto", "-x", "-k", zipFile, unpacked); err != nil {
		return fmt.Errorf("unpacking: %v: %s", err, strings.TrimSpace(string(out)))
	}
	_ = os.Remove(zipFile)
	app := filepath.Join(unpacked, "kubewing.app")
	if out, err := in.run(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", app); err != nil {
		return fmt.Errorf("the new app's code signature is invalid: %s", strings.TrimSpace(string(out)))
	}
	out, err := in.run(ctx, filepath.Join(app, "Contents", "MacOS", "kubewing"), "-version")
	if err != nil {
		return fmt.Errorf("the new version doesn't start: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != version {
		return fmt.Errorf("the download is version %q, not %s", got, version)
	}

	progress("install", 0)
	if err := in.swap(app, in.Bundle); err != nil {
		return fmt.Errorf("replacing %s: %w", in.Bundle, err)
	}
	// app now is the old bundle, removed with the staging folder

	progress("restart", 0)
	if err := in.relaunch(os.Getpid(), in.Bundle); err != nil {
		return fmt.Errorf("installed %s, but couldn't restart (start kubewing again): %w", version, err)
	}
	if in.Quit != nil {
		in.Quit()
	}
	return nil
}

func (in *Installer) client() *http.Client {
	if in.Client != nil {
		return in.Client
	}
	return &http.Client{Timeout: 15 * time.Minute}
}

func (in *Installer) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := in.client().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	return resp, nil
}

// fetch reads a small file (at most limit bytes).
func (in *Installer) fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	resp, err := in.get(ctx, url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// download writes a to file, returning its sha256 (hex).
func (in *Installer) download(ctx context.Context, a Asset, file string, progress func(float64)) (string, error) {
	resp, err := in.get(ctx, a.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	total := a.Size
	if total <= 0 {
		total = resp.ContentLength
	}
	f, err := os.Create(file)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	w := &counter{w: io.MultiWriter(f, h), total: total, progress: progress}
	// a release zip is ~40 MB; anything far bigger isn't ours
	_, err = io.Copy(w, io.LimitReader(resp.Body, 1<<30))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if a.Size > 0 && w.n != a.Size {
		return "", fmt.Errorf("got %d bytes of %d", w.n, a.Size)
	}
	progress(1)
	return hex.EncodeToString(h.Sum(nil)), nil
}

type counter struct {
	w        io.Writer
	n, total int64
	progress func(float64)
}

func (c *counter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	if c.total > 0 {
		c.progress(min(float64(c.n)/float64(c.total), 0.999))
	}
	return n, err
}

func (in *Installer) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if in.Run != nil {
		return in.Run(ctx, name, args...)
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (in *Installer) swap(a, b string) error {
	if in.Swap != nil {
		return in.Swap(a, b)
	}
	return swap(a, b)
}

func (in *Installer) relaunch(pid int, bundle string) error {
	if in.Relaunch != nil {
		return in.Relaunch(pid, bundle)
	}
	return relaunch(pid, bundle)
}

// relaunch starts a detached sh that waits for pid to exit (at most a
// minute: a hung shutdown shouldn't leave it around), then opens bundle.
// The values go in as arguments, never into the script's text.
func relaunch(pid int, bundle string) error {
	const script = `i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done; exec /usr/bin/open "$2"`
	cmd := exec.Command("/bin/sh", "-c", script, "kubewing-relaunch", strconv.Itoa(pid), bundle)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

var errNoSwap = errors.New("swapping folders needs macOS")
