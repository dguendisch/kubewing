package source

import (
	"context"
	"errors"
)

// RunShell: local terminals need a PTY, which kubewing has on Unix only.
func RunShell(context.Context, string, ExecStreams) error {
	return errors.New("local terminals are not supported on Windows")
}
