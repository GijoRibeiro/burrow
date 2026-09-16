//go:build !windows

package workspace

import (
	"os"
	"os/exec"
	"syscall"
)

// os.Rename rejects existing directories before reaching the kernel. Unix rename
// atomically replaces an empty directory and refuses one containing user files.
func publishClone(checkout, destination string) error {
	return syscall.Rename(checkout, destination)
}

// gh invokes git; cancellation must stop the entire clone process group.
func isolateCloneProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if err == syscall.ESRCH {
			return os.ErrProcessDone
		}
		return err
	}
}
