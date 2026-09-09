package orchestrator

import (
	"fmt"
	"strings"

	"github.com/gijo/cloovies/internal/registry"
)

// Result is the output of executing a command.
type Result struct {
	Text  string `json:"text"`
	Error string `json:"error,omitempty"`
}

// Executor runs parsed commands against the registry.
type Executor struct {
	reg *registry.Registry
}

// NewExecutor creates an executor backed by the given registry.
func NewExecutor(reg *registry.Registry) *Executor {
	return &Executor{reg: reg}
}

// Execute runs a command and returns a result.
func (e *Executor) Execute(cmd Command) Result {
	switch cmd.Action {
	case "status":
		return e.status()
	case "stop":
		return e.stop(cmd.Target)
	case "spawn":
		return Result{Text: fmt.Sprintf("Spawn requested: path=%s task=%s (not yet implemented)", cmd.Path, cmd.Task)}
	case "assign":
		return Result{Text: fmt.Sprintf("Assign requested: target=%s task=%s (not yet implemented)", cmd.Target, cmd.Task)}
	default:
		return Result{Error: "unknown action: " + cmd.Action}
	}
}

func (e *Executor) status() Result {
	agents := e.reg.All()
	if len(agents) == 0 {
		return Result{Text: "No agents running."}
	}

	lines := make([]string, len(agents))
	for i, a := range agents {
		name := a.Name
		if name == "" && len(a.SessionID) >= 8 {
			name = a.SessionID[:8]
		} else if name == "" {
			name = a.SessionID
		}
		task := a.CurrentTask
		if task == "" {
			task = "idle"
		}
		lines[i] = fmt.Sprintf("%s [%s]: %s (%s)", name, a.Status, task, shortenPath(a.Cwd))
	}
	return Result{Text: strings.Join(lines, "\n")}
}

func (e *Executor) stop(target string) Result {
	agents := e.reg.All()
	for _, a := range agents {
		if a.Name == target || (len(a.SessionID) >= 8 && a.SessionID[:8] == target) {
			return Result{Text: fmt.Sprintf("Stopping %s (PID %d)...", target, a.PID)}
		}
	}
	return Result{Error: fmt.Sprintf("Agent '%s' not found", target)}
}

func shortenPath(path string) string {
	parts := strings.Split(path, "/")
	if len(parts) > 2 {
		return "~/" + strings.Join(parts[len(parts)-2:], "/")
	}
	return path
}
