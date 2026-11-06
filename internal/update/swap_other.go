//go:build !darwin

package update

func swap(a, b string) error { return errNoSwap }
