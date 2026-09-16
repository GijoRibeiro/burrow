package workspace

import (
	"os"
	"os/exec"
)

func publishClone(checkout, destination string) error { return os.Rename(checkout, destination) }

func isolateCloneProcess(cmd *exec.Cmd) {}
