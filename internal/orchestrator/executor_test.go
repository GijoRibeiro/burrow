package orchestrator_test

import (
	"testing"

	"github.com/gijo/cloovies/internal/orchestrator"
	"github.com/gijo/cloovies/internal/registry"
	"github.com/gijo/cloovies/internal/scanner"
)

func TestExecuteStatus(t *testing.T) {
	reg := registry.New()
	reg.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj", Alive: true, CurrentTask: "Fix bug", TaskStatus: "in_progress"},
	})
	reg.AssignCreature("s1", "creature-01", "Koko")

	exec := orchestrator.NewExecutor(reg)
	result := exec.Execute(orchestrator.Command{Action: "status"})

	if result.Error != "" {
		t.Errorf("unexpected error: %s", result.Error)
	}
	if result.Text == "" {
		t.Error("expected non-empty status text")
	}
}

func TestExecuteStatusEmpty(t *testing.T) {
	reg := registry.New()
	exec := orchestrator.NewExecutor(reg)
	result := exec.Execute(orchestrator.Command{Action: "status"})

	if result.Error != "" {
		t.Errorf("unexpected error: %s", result.Error)
	}
	if result.Text != "No agents running." {
		t.Errorf("expected 'No agents running.', got '%s'", result.Text)
	}
}

func TestExecuteStopUnknown(t *testing.T) {
	reg := registry.New()
	exec := orchestrator.NewExecutor(reg)
	result := exec.Execute(orchestrator.Command{Action: "stop", Target: "nobody"})

	if result.Error == "" {
		t.Error("expected error for unknown agent")
	}
}

func TestExecuteSpawn(t *testing.T) {
	reg := registry.New()
	exec := orchestrator.NewExecutor(reg)
	result := exec.Execute(orchestrator.Command{Action: "spawn", Path: "/proj", Task: "fix bug"})

	if result.Error != "" {
		t.Errorf("unexpected error: %s", result.Error)
	}
	if result.Text == "" {
		t.Error("expected non-empty text")
	}
}

func TestExecuteAssign(t *testing.T) {
	reg := registry.New()
	exec := orchestrator.NewExecutor(reg)
	result := exec.Execute(orchestrator.Command{Action: "assign", Target: "koko", Task: "write tests"})

	if result.Error != "" {
		t.Errorf("unexpected error: %s", result.Error)
	}
	if result.Text == "" {
		t.Error("expected non-empty text")
	}
}
