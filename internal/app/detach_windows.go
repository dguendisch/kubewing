package app

import "syscall"

const detachedProcess = 0x00000008 // DETACHED_PROCESS: no console of its own or the parent's

func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP}
}
