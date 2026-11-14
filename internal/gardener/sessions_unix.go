//go:build unix

package gardener

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// gardenctl's temporary root must belong to the effective user and be
// private; its ancestors must belong to root or that user and not allow
// replacement by other users (except in sticky directories such as /tmp).
func checkSessionPermissions(dir string, info fs.FileInfo, private bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("cannot determine owner of gardenctl directory %s", dir)
	}
	uid := int(stat.Uid)
	perm := info.Mode().Perm()
	if private {
		if uid != os.Geteuid() || perm != 0o700 {
			return fmt.Errorf("refusing gardenctl directory %s: must be owned by uid %d with mode 0700 (has uid %d, mode %04o); use a private TMPDIR", dir, os.Geteuid(), uid, perm)
		}
	} else if (uid != 0 && uid != os.Geteuid()) || (perm&0o022 != 0 && info.Mode()&fs.ModeSticky == 0) {
		return fmt.Errorf("refusing gardenctl directory below %s: parent can be replaced by another user; use a private TMPDIR", dir)
	}
	return nil
}
