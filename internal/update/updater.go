package update

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Event carries the Status to the frontend on every change.
const Event = "kw:update"

// StateFile remembers the last check and the skipped version (state directory).
const StateFile = "update.json"

// Status is what the frontend shows: the offer (the status line hint, the
// dialog), a check or install in progress, the last error.
type Status struct {
	// Current is the running version.
	Current string `json:"current"`
	// Released: a release build; development builds never get offers.
	Released bool `json:"released"`
	// CheckDays is the automatic check's interval (0 = off).
	CheckDays int    `json:"checkDays"`
	Checking  bool   `json:"checking,omitempty"`
	Offer     *Offer `json:"offer,omitempty"`
	// Skipped is the version the user chose to skip: no hint for it (a newer one is offered again).
	Skipped   string    `json:"skipped,omitempty"`
	LastCheck time.Time `json:"lastCheck,omitzero"`
	// Error is the last check's or install's failure.
	Error string `json:"error,omitempty"`
	// CannotInstall says why "Update" would only open the release page ("" = it installs).
	CannotInstall string `json:"cannotInstall,omitempty"`
	// Installing: "download", "verify", "install", "restart" while it runs.
	Installing string `json:"installing,omitempty"`
	// Progress of the download, 0..1.
	Progress float64 `json:"progress,omitempty"`
}

// Options configure an Updater.
type Options struct {
	Current string
	Feed    Feed
	// StateDir holds StateFile ("" = in memory only).
	StateDir string
	Emit     func(name string, data any)
	Now      func() time.Time
	// Installer swaps the app for a downloaded version; nil = never in place
	// (headless, tests): Update opens the release page instead.
	Installer *Installer
}

// Updater checks the feed on a schedule and on request.
type Updater struct {
	opts Options

	mu          sync.Mutex
	days        int
	prereleases bool
	st          state
	checking    bool
	offer       *Offer
	err         string
	installing  string
	progress    float64
	// lastEmit throttles download progress events
	lastEmit time.Time
}

type state struct {
	LastCheck time.Time `json:"lastCheck,omitzero"`
	Skipped   string    `json:"skipped,omitempty"`
}

// New creates an Updater (checking once a day until Configure says otherwise).
func New(o Options) *Updater {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Emit == nil {
		o.Emit = func(string, any) {}
	}
	u := &Updater{opts: o, days: 1}
	if o.StateDir != "" {
		if b, err := os.ReadFile(filepath.Join(o.StateDir, StateFile)); err == nil {
			_ = json.Unmarshal(b, &u.st)
		}
	}
	return u
}

// Configure applies config.yaml's update settings (at start and on reload).
func (u *Updater) Configure(days int, prereleases bool) {
	u.mu.Lock()
	changed := u.days != days || u.prereleases != prereleases
	u.days, u.prereleases = days, prereleases
	u.mu.Unlock()
	if changed {
		u.emit()
	}
}

// Status is the current state.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.statusLocked()
}

func (u *Updater) statusLocked() Status {
	s := Status{
		Current: u.opts.Current, Released: Released(u.opts.Current), CheckDays: u.days,
		Checking: u.checking, Offer: u.offer, Skipped: u.st.Skipped, LastCheck: u.st.LastCheck,
		Error: u.err, Installing: u.installing, Progress: u.progress,
	}
	switch {
	case u.opts.Installer == nil:
		s.CannotInstall = "this kubewing can't replace itself"
	default:
		s.CannotInstall = u.opts.Installer.Blocked()
	}
	return s
}

func (u *Updater) emit() { u.opts.Emit(Event, u.Status()) }

// Run checks whenever the interval has passed since the last check, until
// ctx ends. It looks every hour against the wall clock, rather than sleeping
// for a day: timers stop while the Mac sleeps.
func (u *Updater) Run(ctx context.Context) {
	t := time.NewTimer(10 * time.Second) // not in the way of the start
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			u.Tick(ctx)
			t.Reset(time.Hour)
		}
	}
}

// Due reports whether the automatic check should run now.
func (u *Updater) Due() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.days <= 0 || !Released(u.opts.Current) || u.checking || u.installing != "" {
		return false
	}
	last := u.st.LastCheck
	now := u.opts.Now()
	// a clock set back: check rather than wait for the old date
	return last.IsZero() || last.After(now) || now.Sub(last) >= time.Duration(u.days)*24*time.Hour
}

// Tick runs the automatic check if it's due.
func (u *Updater) Tick(ctx context.Context) {
	if u.Due() {
		if _, err := u.Check(ctx); err != nil {
			log.Printf("update check: %v", err)
		}
	}
}

// Check fetches the feed now (the menu's "Check for Updates…", or Tick).
// A development build checks too (it shows there is no offer for it).
func (u *Updater) Check(ctx context.Context) (Status, error) {
	u.mu.Lock()
	if u.checking {
		u.mu.Unlock()
		return u.Status(), nil
	}
	u.checking = true
	pre := u.prereleases
	u.mu.Unlock()
	u.emit()

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rs, err := u.opts.Feed.Releases(ctx)

	u.mu.Lock()
	u.checking = false
	if err != nil {
		u.err = "checking for updates: " + err.Error()
	} else {
		u.err = ""
		u.offer = nil
		if o, ok := Pick(rs, u.opts.Current, pre); ok {
			u.offer = &o
		}
		u.st.LastCheck = u.opts.Now()
		u.saveLocked()
	}
	s := u.statusLocked()
	u.mu.Unlock()
	u.emit()
	return s, err
}

// Skip stops the hint for version (until a newer one is out); "" undoes it.
func (u *Updater) Skip(version string) Status {
	u.mu.Lock()
	u.st.Skipped = version
	u.saveLocked()
	u.mu.Unlock()
	u.emit()
	return u.Status()
}

func (u *Updater) saveLocked() {
	if u.opts.StateDir == "" {
		return
	}
	b, _ := json.MarshalIndent(u.st, "", "  ")
	if err := writeAtomic(filepath.Join(u.opts.StateDir, StateFile), b); err != nil {
		log.Printf("update: saving %s: %v", StateFile, err)
	}
}

// Install downloads, verifies and installs the offer, then relaunches (the
// Installer quits this process). It returns once the install failed or the
// app is about to quit; progress arrives as events.
func (u *Updater) Install(ctx context.Context) error {
	u.mu.Lock()
	in, o := u.opts.Installer, u.offer
	switch {
	case o == nil:
		u.mu.Unlock()
		return errors.New("no update to install: check for updates first")
	case u.installing != "":
		u.mu.Unlock()
		return errors.New("the update is already being installed")
	case in == nil:
		u.mu.Unlock()
		return errors.New("this kubewing can't replace itself")
	}
	if b := in.Blocked(); b != "" {
		u.mu.Unlock()
		return errors.New(b)
	}
	u.installing, u.progress, u.err = "download", 0, ""
	u.mu.Unlock()
	u.emit()

	err := in.Install(ctx, o.release, func(phase string, progress float64) {
		u.mu.Lock()
		u.installing, u.progress = phase, progress
		// the download reports every chunk: a few events a second are enough
		now := time.Now()
		throttled := phase == "download" && progress < 1 && now.Sub(u.lastEmit) < 150*time.Millisecond
		if !throttled {
			u.lastEmit = now
		}
		u.mu.Unlock()
		if !throttled {
			u.emit()
		}
	})
	if err != nil {
		u.mu.Lock()
		u.installing, u.progress, u.err = "", 0, "updating to "+o.Version+": "+err.Error()
		u.mu.Unlock()
		u.emit()
	}
	return err
}

// writeAtomic writes file via a temp file and a rename.
func writeAtomic(file string, b []byte) error {
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(file)+"-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), file)
}
