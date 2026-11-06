package update

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func rel(tag string, pre bool, body string, assets ...string) Release {
	r := Release{Tag: tag, Prerelease: pre, Body: body, URL: "https://github.com/x/releases/tag/" + tag, Published: time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)}
	for _, a := range assets {
		r.Assets = append(r.Assets, Asset{Name: a, Size: 10})
	}
	if len(assets) == 0 {
		v := strings.TrimPrefix(tag, "v")
		r.Assets = []Asset{{Name: AssetName(v), Size: 10}}
	}
	return r
}

func versions(ns []Note) []string {
	var vs []string
	for _, n := range ns {
		vs = append(vs, n.Version)
	}
	return vs
}

func TestReleased(t *testing.T) {
	for v, want := range map[string]bool{
		"0.1.0": true, "1.2.3": true, "0.2.0-rc.1": true, "0.2.0-rc.12": true,
		"dev": false, "0.0.0-dev": false, "0.2.0-3-gabc1234": false, "0.2.0-dirty": false,
		"0.2.0-3-gabc1234-dirty": false, "0.2.0-beta.1": false, "0.2.0-rc.": false, "v0.1.0": false, "0.1": false,
	} {
		if got := Released(v); got != want {
			t.Errorf("Released(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestPick(t *testing.T) {
	feed := []Release{
		rel("v0.4.0-rc.2", true, "rc2 notes (all of 0.4.0 so far)"),
		rel("v0.4.0-rc.1", true, "rc1 notes"),
		rel("v0.3.0", false, "### Added\n- three"),
		rel("v0.2.1", false, "### Fixed\n- two-one"),
		rel("v0.2.0", false, "### Added\n- two"),
		rel("v0.2.0-rc.1", true, "two rc"),
		rel("v0.1.0", false, "first"),
		{Tag: "v9.9.9", Draft: true, Assets: []Asset{{Name: AssetName("9.9.9")}}},
		rel("nightly", false, "not ours"),
	}

	t.Run("finals between, newest first", func(t *testing.T) {
		o, ok := Pick(feed, "0.1.0", false)
		if !ok || o.Version != "0.3.0" || o.Prerelease {
			t.Fatalf("got %+v %v", o, ok)
		}
		if got, want := versions(o.Notes), []string{"0.3.0", "0.2.1", "0.2.0"}; !slices.Equal(got, want) {
			t.Fatalf("notes %v, want %v", got, want)
		}
		if o.Notes[0].Body != "### Added\n- three" || o.Notes[0].Date != "2026-11-06" {
			t.Fatalf("note %+v", o.Notes[0])
		}
	})
	t.Run("candidates: only the target's notes among candidates", func(t *testing.T) {
		o, ok := Pick(feed, "0.2.0", true)
		if !ok || o.Version != "0.4.0-rc.2" || !o.Prerelease {
			t.Fatalf("got %+v %v", o, ok)
		}
		if got, want := versions(o.Notes), []string{"0.4.0-rc.2", "0.3.0", "0.2.1"}; !slices.Equal(got, want) {
			t.Fatalf("notes %v, want %v", got, want)
		}
	})
	t.Run("a candidate build gets its final", func(t *testing.T) {
		o, ok := Pick(feed, "0.2.0-rc.1", false)
		if !ok || o.Version != "0.3.0" {
			t.Fatalf("got %+v %v", o, ok)
		}
		if got, want := versions(o.Notes), []string{"0.3.0", "0.2.1", "0.2.0"}; !slices.Equal(got, want) {
			t.Fatalf("notes %v, want %v", got, want)
		}
	})
	t.Run("up to date", func(t *testing.T) {
		if o, ok := Pick(feed, "0.3.0", false); ok {
			t.Fatalf("offered %+v", o)
		}
	})
	t.Run("dev builds never", func(t *testing.T) {
		for _, v := range []string{"dev", "0.0.0-dev", "0.1.0-3-gabc1234", "0.1.0-dirty"} {
			if o, ok := Pick(feed, v, true); ok {
				t.Fatalf("%s offered %+v", v, o)
			}
		}
	})
	t.Run("a release without the zip is skipped", func(t *testing.T) {
		f := []Release{rel("v0.5.0", false, "uploading", "other.txt"), rel("v0.3.0", false, "three")}
		o, ok := Pick(f, "0.2.0", false)
		if !ok || o.Version != "0.3.0" {
			t.Fatalf("got %+v %v", o, ok)
		}
	})
}

func TestSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	sum := strings.Repeat("ab", 32)
	sig := Sign(priv, AssetName("0.3.0"), sum)
	if err := Verify(pubB64, sig, AssetName("0.3.0"), sum); err != nil {
		t.Fatal(err)
	}
	if err := Verify(pubB64, sig+"\n", AssetName("0.3.0"), strings.ToUpper(sum)); err != nil {
		t.Fatalf("whitespace/case: %v", err)
	}
	// an older signed zip renamed as a newer one
	if err := Verify(pubB64, sig, AssetName("0.4.0"), sum); err == nil {
		t.Fatal("verified under another name")
	}
	if err := Verify(pubB64, sig, AssetName("0.3.0"), strings.Repeat("cd", 32)); err == nil {
		t.Fatal("verified another file")
	}
	if err := Verify("", sig, AssetName("0.3.0"), sum); err == nil {
		t.Fatal("verified without a key")
	}
}

type fakeFeed struct {
	rs    []Release
	err   error
	calls int
}

func (f *fakeFeed) Releases(context.Context) ([]Release, error) {
	f.calls++
	return f.rs, f.err
}

func TestSchedule(t *testing.T) {
	now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	feed := &fakeFeed{rs: []Release{rel("v0.2.0", false, "two")}}
	dir := t.TempDir()
	var events int
	u := New(Options{Current: "0.1.0", Feed: feed, StateDir: dir, Now: func() time.Time { return now }, Emit: func(string, any) { events++ }})

	if !u.Due() {
		t.Fatal("never checked: due")
	}
	u.Tick(context.Background())
	if feed.calls != 1 || u.Status().Offer == nil || u.Status().Offer.Version != "0.2.0" || events == 0 {
		t.Fatalf("calls %d, status %+v", feed.calls, u.Status())
	}
	now = now.Add(23 * time.Hour)
	u.Tick(context.Background())
	if feed.calls != 1 {
		t.Fatal("checked again within a day")
	}
	now = now.Add(time.Hour)
	u.Tick(context.Background())
	if feed.calls != 2 {
		t.Fatal("not checked after a day")
	}

	u.Configure(7, false)
	now = now.Add(6 * 24 * time.Hour)
	if u.Due() {
		t.Fatal("due before 7 days")
	}
	now = now.Add(24 * time.Hour)
	if !u.Due() {
		t.Fatal("not due after 7 days")
	}

	u.Configure(0, false)
	now = now.Add(365 * 24 * time.Hour)
	if u.Due() {
		t.Fatal("off, but due")
	}
	// off stops the schedule only: a check on request still works
	if _, err := u.Check(context.Background()); err != nil || feed.calls != 3 {
		t.Fatalf("manual check: %v, calls %d", err, feed.calls)
	}

	// a clock set back
	u.Configure(1, false)
	now = now.Add(-48 * time.Hour)
	if !u.Due() {
		t.Fatal("last check in the future: not due")
	}

	// the last check survives a restart
	u2 := New(Options{Current: "0.1.0", Feed: feed, StateDir: dir, Now: func() time.Time { return now.Add(49 * time.Hour) }})
	if u2.Due() {
		t.Fatal("restart forgot the last check")
	}

	// development builds don't check by themselves
	dev := New(Options{Current: "0.1.0-2-gabc", Feed: feed, Now: func() time.Time { return now }})
	if dev.Due() {
		t.Fatal("dev build due")
	}
}

func TestCheckErrorKeepsLastCheck(t *testing.T) {
	now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	feed := &fakeFeed{err: errors.New("offline")}
	u := New(Options{Current: "0.1.0", Feed: feed, Now: func() time.Time { return now }})
	if _, err := u.Check(context.Background()); err == nil {
		t.Fatal("no error")
	}
	s := u.Status()
	if !strings.Contains(s.Error, "offline") || !s.LastCheck.IsZero() || !u.Due() {
		t.Fatalf("status %+v: a failed check should be retried", s)
	}
	feed.err = nil
	if _, err := u.Check(context.Background()); err != nil || u.Status().Error != "" {
		t.Fatalf("error not cleared: %v %+v", err, u.Status())
	}
}

func TestSkipPersists(t *testing.T) {
	dir := t.TempDir()
	u := New(Options{Current: "0.1.0", Feed: &fakeFeed{}, StateDir: dir})
	u.Skip("0.2.0")
	if got := New(Options{Current: "0.1.0", StateDir: dir}).Status().Skipped; got != "0.2.0" {
		t.Fatalf("skipped %q after restart", got)
	}
	u.Skip("")
	if got := New(Options{Current: "0.1.0", StateDir: dir}).Status().Skipped; got != "" {
		t.Fatalf("unskip: %q", got)
	}
}

// installEnv is a fake release server with a signed zip, and an installed bundle.
type installEnv struct {
	parent, bundle string
	pub            string
	priv           ed25519.PrivateKey
	zip            []byte
	srv            *httptest.Server
	sig            string
}

func newInstallEnv(t *testing.T, version string) *installEnv {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	e := &installEnv{parent: t.TempDir(), pub: base64.StdEncoding.EncodeToString(pub), priv: priv}
	e.bundle = filepath.Join(e.parent, "kubewing.app")
	if err := os.MkdirAll(filepath.Join(e.bundle, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(e.bundle, "Contents", "MacOS", "kubewing"), []byte("old"), 0o755)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("kubewing.app/Contents/MacOS/kubewing")
	w.Write([]byte("new " + version))
	zw.Close()
	e.zip = buf.Bytes()
	sum := sha256.Sum256(e.zip)
	e.sig = Sign(priv, AssetName(version), hex.EncodeToString(sum[:]))
	e.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ".zip"):
			w.Write(e.zip)
		case strings.HasSuffix(r.URL.Path, ".sig"):
			w.Write([]byte(e.sig))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(e.srv.Close)
	return e
}

func (e *installEnv) release(version string) Release {
	sum := sha256.Sum256(e.zip)
	name := AssetName(version)
	return Release{Tag: "v" + version, Assets: []Asset{
		{Name: name, Size: int64(len(e.zip)), URL: e.srv.URL + "/" + name, Digest: "sha256:" + hex.EncodeToString(sum[:])},
		{Name: name + ".sig", URL: e.srv.URL + "/" + name + ".sig"},
	}}
}

// installer with fake tools: ditto unpacks with archive/zip, codesign passes, the binary prints its content's version.
func (e *installEnv) installer(t *testing.T, version string) (*Installer, *[]string) {
	var calls []string
	var relaunched string
	quit := false
	in := &Installer{
		Bundle: e.bundle, PublicKey: e.pub, Client: e.srv.Client(),
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, filepath.Base(name))
			switch filepath.Base(name) {
			case "ditto":
				return nil, unzip(args[2], args[3])
			case "codesign":
				return nil, nil
			case "kubewing":
				b, err := os.ReadFile(name)
				return []byte(strings.TrimPrefix(string(b), "new ") + "\n"), err
			}
			return nil, errors.New("unexpected " + name)
		},
		Swap: func(a, b string) error {
			// not atomic, but the same outcome
			tmp := b + ".swap"
			if err := os.Rename(b, tmp); err != nil {
				return err
			}
			if err := os.Rename(a, b); err != nil {
				return err
			}
			return os.Rename(tmp, a)
		},
		Relaunch: func(_ int, bundle string) error { relaunched = bundle; calls = append(calls, "relaunch"); return nil },
		Quit:     func() { quit = true; calls = append(calls, "quit") },
	}
	t.Cleanup(func() {
		if slices.Contains(calls, "relaunch") && (relaunched != e.bundle || !quit) {
			t.Errorf("relaunched %q, quit %v", relaunched, quit)
		}
	})
	return in, &calls
}

func unzip(file, dir string) error {
	r, err := zip.OpenReader(file)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		p := filepath.Join(dir, f.Name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		var b bytes.Buffer
		b.ReadFrom(rc)
		rc.Close()
		if err := os.WriteFile(p, b.Bytes(), 0o755); err != nil {
			return err
		}
	}
	return nil
}

func leftovers(t *testing.T, dir string) []string {
	ents, _ := os.ReadDir(dir)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

func TestInstall(t *testing.T) {
	e := newInstallEnv(t, "0.3.0")
	in, calls := e.installer(t, "0.3.0")
	var phases []string
	err := in.Install(context.Background(), e.release("0.3.0"), func(p string, _ float64) {
		if len(phases) == 0 || phases[len(phases)-1] != p {
			phases = append(phases, p)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(e.bundle, "Contents", "MacOS", "kubewing"))
	if string(b) != "new 0.3.0" {
		t.Fatalf("bundle has %q", b)
	}
	if got, want := phases, []string{"download", "verify", "install", "restart"}; !slices.Equal(got, want) {
		t.Fatalf("phases %v", got)
	}
	if got, want := *calls, []string{"ditto", "codesign", "kubewing", "relaunch", "quit"}; !slices.Equal(got, want) {
		t.Fatalf("calls %v", got)
	}
	if got := leftovers(t, e.parent); !slices.Equal(got, []string{"kubewing.app"}) {
		t.Fatalf("left behind: %v", got)
	}
}

func TestInstallRefuses(t *testing.T) {
	cases := map[string]struct {
		mutate func(e *installEnv, r *Release, in *Installer)
		want   string
	}{
		"tampered zip": {func(e *installEnv, r *Release, _ *Installer) {
			e.zip = append(bytes.Clone(e.zip), 0) // GitHub's digest then mismatches as well: drop it to reach the signature
			r.Assets[0].Digest, r.Assets[0].Size = "", int64(len(e.zip))
		}, "signature doesn't match"},
		"digest mismatch": {func(_ *installEnv, r *Release, _ *Installer) {
			r.Assets[0].Digest = "sha256:" + strings.Repeat("0", 64)
		}, "damaged"},
		"unsigned release": {func(_ *installEnv, r *Release, _ *Installer) { r.Assets = r.Assets[:1] }, "isn't signed"},
		"another key": {func(_ *installEnv, _ *Release, in *Installer) {
			pub, _, _ := ed25519.GenerateKey(nil)
			in.PublicKey = base64.StdEncoding.EncodeToString(pub)
		}, "signature doesn't match"},
		"wrong version inside": {func(e *installEnv, _ *Release, in *Installer) {
			run := in.Run
			in.Run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
				if filepath.Base(name) == "kubewing" {
					return []byte("0.2.9\n"), nil
				}
				return run(ctx, name, args...)
			}
		}, "not 0.3.0"},
		"bad code signature": {func(_ *installEnv, _ *Release, in *Installer) {
			run := in.Run
			in.Run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
				if filepath.Base(name) == "codesign" {
					return []byte("a sealed resource is missing"), errors.New("exit 1")
				}
				return run(ctx, name, args...)
			}
		}, "code signature is invalid"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e := newInstallEnv(t, "0.3.0")
			in, calls := e.installer(t, "0.3.0")
			r := e.release("0.3.0")
			c.mutate(e, &r, in)
			err := in.Install(context.Background(), r, func(string, float64) {})
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %v, want %q", err, c.want)
			}
			b, _ := os.ReadFile(filepath.Join(e.bundle, "Contents", "MacOS", "kubewing"))
			if string(b) != "old" || slices.Contains(*calls, "quit") {
				t.Fatalf("bundle %q, calls %v", b, *calls)
			}
			if got := leftovers(t, e.parent); !slices.Equal(got, []string{"kubewing.app"}) {
				t.Fatalf("left behind: %v", got)
			}
		})
	}
}

func TestBlocked(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "kubewing.app")
	os.Mkdir(app, 0o755)
	for _, c := range []struct {
		in   Installer
		want string
	}{
		{Installer{Bundle: app, PublicKey: "k"}, ""},
		{Installer{PublicKey: "k"}, "app bundle"},
		{Installer{Bundle: "/private/var/folders/x/AppTranslocation/ABC/d/kubewing.app", PublicKey: "k"}, "Applications"},
		{Installer{Bundle: app}, "no release key"},
	} {
		if got := c.in.Blocked(); (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("Blocked(%+v) = %q, want %q", c.in, got, c.want)
		}
	}
	if os.Getuid() != 0 {
		os.Chmod(dir, 0o555)
		defer os.Chmod(dir, 0o755)
		if got := (&Installer{Bundle: app, PublicKey: "k"}).Blocked(); !strings.Contains(got, "permission") {
			t.Errorf("read-only folder: %q", got)
		}
	}
}

func TestUpdaterInstallFlow(t *testing.T) {
	e := newInstallEnv(t, "0.3.0")
	in, _ := e.installer(t, "0.3.0")
	var last Status
	u := New(Options{Current: "0.2.0", Feed: &fakeFeed{rs: []Release{e.release("0.3.0")}}, Installer: in, Emit: func(_ string, d any) { last = d.(Status) }})
	if err := u.Install(context.Background()); err == nil {
		t.Fatal("installed without an offer")
	}
	if _, err := u.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s := u.Status(); s.Offer == nil || s.CannotInstall != "" {
		t.Fatalf("status %+v", s)
	}
	if err := u.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if last.Installing != "restart" {
		t.Fatalf("last event %+v", last)
	}
}

func TestGitHubFeed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("accept %q", r.Header.Get("Accept"))
		}
		if r.URL.Query().Get("limited") != "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`[{"tag_name":"v0.1.0","body":"### Added\n- x","prerelease":false,"html_url":"u","published_at":"2026-11-06T20:25:06Z",
			"assets":[{"name":"kubewing-0.1.0-macos-arm64.zip","size":41975851,"browser_download_url":"d","digest":"sha256:7bf199651443d0bd5519ae05592a3e1d737b74c3e005fca9bba8054844ff55b7"}]}]`))
	}))
	defer srv.Close()
	rs, err := GitHub{URL: srv.URL}.Releases(context.Background())
	if err != nil || len(rs) != 1 || rs[0].Version() != "0.1.0" || rs[0].Assets[0].Size != 41975851 {
		t.Fatalf("%v %+v", err, rs)
	}
	if d, err := digest(rs[0].Assets[0].Digest); err != nil || len(d) != 64 {
		t.Fatalf("digest %q %v", d, err)
	}
	if _, err := (GitHub{URL: srv.URL + "?limited=1"}).Releases(context.Background()); err == nil || !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("rate limit: %v", err)
	}
}
