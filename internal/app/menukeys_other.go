//go:build !darwin

package app

// canGuardKeys: elsewhere a menu accelerator always fires (Windows binds it
// window-wide), so display-only ones are left out.
const canGuardKeys = false

func guardMenuKeys([]string) {}
