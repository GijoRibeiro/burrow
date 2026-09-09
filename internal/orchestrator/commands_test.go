package orchestrator_test

import (
	"testing"

	"github.com/gijo/cloovies/internal/orchestrator"
)

func TestParseSpawn(t *testing.T) {
	cmd, err := orchestrator.Parse("spawn ~/projects/api fix the auth bug")
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if cmd.Action != "spawn" {
		t.Errorf("expected action 'spawn', got '%s'", cmd.Action)
	}
	if cmd.Path != "~/projects/api" {
		t.Errorf("expected path '~/projects/api', got '%s'", cmd.Path)
	}
	if cmd.Task != "fix the auth bug" {
		t.Errorf("expected task 'fix the auth bug', got '%s'", cmd.Task)
	}
}

func TestParseStop(t *testing.T) {
	cmd, err := orchestrator.Parse("stop koko")
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if cmd.Action != "stop" {
		t.Errorf("expected action 'stop', got '%s'", cmd.Action)
	}
	if cmd.Target != "koko" {
		t.Errorf("expected target 'koko', got '%s'", cmd.Target)
	}
}

func TestParseStatus(t *testing.T) {
	cmd, err := orchestrator.Parse("status")
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if cmd.Action != "status" {
		t.Errorf("expected action 'status', got '%s'", cmd.Action)
	}
}

func TestParseAssign(t *testing.T) {
	cmd, err := orchestrator.Parse("assign koko write unit tests for auth")
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if cmd.Action != "assign" {
		t.Errorf("expected action 'assign', got '%s'", cmd.Action)
	}
	if cmd.Target != "koko" {
		t.Errorf("expected target 'koko', got '%s'", cmd.Target)
	}
	if cmd.Task != "write unit tests for auth" {
		t.Errorf("expected task 'write unit tests for auth', got '%s'", cmd.Task)
	}
}

func TestParseUnknown(t *testing.T) {
	_, err := orchestrator.Parse("fly to the moon")
	if err == nil {
		t.Error("expected error for unknown command")
	}
}

func TestParseKillAliasesStop(t *testing.T) {
	cmd, err := orchestrator.Parse("kill koko")
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if cmd.Action != "stop" {
		t.Errorf("expected action 'stop', got '%s'", cmd.Action)
	}
	if cmd.Target != "koko" {
		t.Errorf("expected target 'koko', got '%s'", cmd.Target)
	}
}

func TestParseEmpty(t *testing.T) {
	_, err := orchestrator.Parse("")
	if err == nil {
		t.Error("expected error for empty command")
	}
}
