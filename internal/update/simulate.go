package update

import (
	"context"
	"errors"
	"time"
)

// Simulated pretends to install (the app's -releases flag, for trying the
// update dialog without publishing releases): it runs through the phases
// with a fake download, then fails without touching anything, so the
// dialog shows an error and stays open.
type Simulated struct {
	// Step is how long each phase takes, the download ten times that (0 = 300ms).
	Step time.Duration
}

// Blocked implements AppInstaller: a simulation always "can" install.
func (Simulated) Blocked() string { return "" }

// Install implements AppInstaller.
func (s Simulated) Install(ctx context.Context, _ Release, progress func(phase string, p float64)) error {
	step := s.Step
	if step <= 0 {
		step = 300 * time.Millisecond
	}
	wait := func(d time.Duration) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
			return nil
		}
	}
	for i := range 40 {
		progress("download", float64(i)/40)
		if err := wait(step / 4); err != nil {
			return err
		}
	}
	progress("download", 1)
	for _, phase := range []string{"verify", "install", "restart"} {
		progress(phase, 0)
		if err := wait(step * 2); err != nil {
			return err
		}
	}
	return errors.New("simulated (-releases), nothing was installed")
}
