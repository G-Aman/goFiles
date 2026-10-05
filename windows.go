//go:build windows

package main

import "os"

type syscallStatfs struct {
	Blocks uint64
	Bfree  uint64
	Bavail uint64
	Bsize  uint32
}

func statfs(path string, st *syscallStatfs) error {
	return nil
}

func setMode(abs string, perm os.FileMode) error {
	return os.Chmod(abs, perm)
}
