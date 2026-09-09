package orchestrator

import (
	"fmt"
	"strings"
)

// Command represents a parsed user command.
type Command struct {
	Action string // "spawn", "stop", "status", "assign"
	Target string // agent name (for stop, assign)
	Path   string // project path (for spawn)
	Task   string // task description (for spawn, assign)
}

var validActions = map[string]bool{
	"spawn":  true,
	"stop":   true,
	"kill":   true,
	"status": true,
	"assign": true,
}

// Parse parses a structured command string.
func Parse(input string) (Command, error) {
	input = strings.TrimSpace(input)
	parts := strings.Fields(input)
	if len(parts) == 0 {
		return Command{}, fmt.Errorf("empty command")
	}

	action := strings.ToLower(parts[0])
	if action == "kill" {
		action = "stop"
	}

	if !validActions[action] {
		return Command{}, fmt.Errorf("unknown command: %s", parts[0])
	}

	cmd := Command{Action: action}

	switch action {
	case "status":
		// No args needed
	case "stop":
		if len(parts) < 2 {
			return Command{}, fmt.Errorf("stop requires an agent name")
		}
		cmd.Target = parts[1]
	case "spawn":
		if len(parts) < 2 {
			return Command{}, fmt.Errorf("spawn requires a project path")
		}
		cmd.Path = parts[1]
		if len(parts) > 2 {
			cmd.Task = strings.Join(parts[2:], " ")
		}
	case "assign":
		if len(parts) < 3 {
			return Command{}, fmt.Errorf("assign requires agent name and task")
		}
		cmd.Target = parts[1]
		cmd.Task = strings.Join(parts[2:], " ")
	}

	return cmd, nil
}
