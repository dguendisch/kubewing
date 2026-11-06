package update

import "os/exec"

func detach(*exec.Cmd)     {}
func writable(string) bool { return false }
