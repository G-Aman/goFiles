//go:build !windows

package main

// unix.go — platform helpers: umask, statfs, chmod.

import (
	"os"
	"syscall"
)

type syscallStatfs = syscall.Statfs_t

func statfs(path string, st *syscallStatfs) error {
	return syscall.Statfs(path, (*syscall.Statfs_t)(st))
}

func init() {
	syscall.Umask(0o022)
}

func setMode(abs string, perm os.FileMode) error {
	return syscall.Chmod(abs, uint32(perm.Perm()))
}
