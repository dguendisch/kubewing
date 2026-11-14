//go:build !unix

package gardener

import "io/fs"

// Windows protects its per-user temporary directory with ACLs; Go's
// synthesized permission bits cannot be used to check its privacy.
func checkSessionPermissions(string, fs.FileInfo, bool) error { return nil }
