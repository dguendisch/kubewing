package update

import "golang.org/x/sys/unix"

// swap exchanges a and b in one step (both on the same volume).
func swap(a, b string) error { return unix.RenamexNp(a, b, unix.RENAME_SWAP) }
