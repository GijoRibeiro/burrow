package registry_test

import (
	"testing"

	"github.com/gijo/cloovies/internal/registry"
	"github.com/gijo/cloovies/internal/scanner"
)

func TestUpdateFromScan(t *testing.T) {
	r := registry.New()

	scan := []scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj/a", Alive: true, CurrentTask: "Fix bug"},
		{PID: 200, SessionID: "s2", Cwd: "/proj/b", Alive: true},
	}

	r.UpdateFromScan(scan)

	agents := r.All()
	if len(agents) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(agents))
	}
}

// Detection of "agent is awaiting a choice" must not hinge on the rich
// picker parser fully succeeding. The scan loop passes the loose match
// signal (a chevron+number or the "Enter to select" footer); even when
// ParsePicker can't build a structured Picker — scrolled cursor, an
// unparseable rich layout — a true match still lights the awaiting
// indicator so the user gets the signal and can jump to the terminal.
func TestSetPicker_AwaitingDecoupledFromParse(t *testing.T) {
	r := registry.New()
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj/a", Alive: true},
	})

	// Loose signal saw a picker, but the parser produced nothing.
	r.SetPicker("s1", nil, true)
	a, ok := r.Get("s1")
	if !ok {
		t.Fatal("agent not found")
	}
	if !a.AwaitingChoice {
		t.Error("AwaitingChoice should be true from the loose match even when Picker is nil")
	}
	if a.Picker != nil {
		t.Errorf("Picker should be nil, got %+v", a.Picker)
	}

	// Nothing matched → not awaiting.
	r.SetPicker("s1", nil, false)
	a, _ = r.Get("s1")
	if a.AwaitingChoice {
		t.Error("AwaitingChoice should be false when nothing matched")
	}
}

func TestAssignCreature(t *testing.T) {
	r := registry.New()
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj/a", Alive: true},
	})

	err := r.AssignCreature("s1", "creature-01", "Koko")
	if err != nil {
		t.Fatalf("AssignCreature error: %v", err)
	}

	agent, ok := r.Get("s1")
	if !ok {
		t.Fatal("agent not found after assignment")
	}
	if agent.CreatureID != "creature-01" {
		t.Errorf("expected creature-01, got %s", agent.CreatureID)
	}
	if agent.Name != "Koko" {
		t.Errorf("expected Koko, got %s", agent.Name)
	}
}

func TestDeadAgentsRemoved(t *testing.T) {
	r := registry.New()
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj/a", Alive: true},
	})

	// Second scan: agent is gone
	r.UpdateFromScan([]scanner.AgentState{})

	agents := r.All()
	if len(agents) != 0 {
		t.Fatalf("expected 0 agents after removal, got %d", len(agents))
	}
}

func TestDeadAgentsBecomesDone(t *testing.T) {
	r := registry.New()
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj/a", Alive: true, TaskStatus: "in_progress", CurrentTask: "Fix bug"},
	})

	// Agent process dies but session file still exists
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj/a", Alive: false},
	})

	agents := r.All()
	if len(agents) != 1 {
		t.Fatalf("expected 1 agent (done), got %d", len(agents))
	}
	if agents[0].Status != "done" {
		t.Errorf("expected status 'done', got '%s'", agents[0].Status)
	}
	if agents[0].CurrentTask != "" {
		t.Errorf("expected empty task, got '%s'", agents[0].CurrentTask)
	}
}

func TestWorktreePassthrough(t *testing.T) {
	r := registry.New()
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj", Alive: true, Worktree: "backoffice", WorktreePath: "/proj/.claude/worktrees/backoffice"},
		{PID: 200, SessionID: "s2", Cwd: "/proj", Alive: true, Worktree: "installer", WorktreePath: "/proj/.claude/worktrees/installer"},
	})

	a1, ok := r.Get("s1")
	if !ok {
		t.Fatal("agent s1 not found")
	}
	if a1.Worktree != "backoffice" {
		t.Errorf("expected worktree 'backoffice', got '%s'", a1.Worktree)
	}

	a2, ok := r.Get("s2")
	if !ok {
		t.Fatal("agent s2 not found")
	}
	if a2.Worktree != "installer" {
		t.Errorf("expected worktree 'installer', got '%s'", a2.Worktree)
	}
}

func TestStatusDerived(t *testing.T) {
	r := registry.New()
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Alive: true, CurrentTask: "Writing code", TaskStatus: "in_progress"},
	})

	agent, _ := r.Get("s1")
	if agent.Status != "active" {
		t.Errorf("expected status 'active', got '%s'", agent.Status)
	}

	// No task = idle
	r.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Alive: true},
	})
	agent, _ = r.Get("s1")
	if agent.Status != "idle" {
		t.Errorf("expected status 'idle', got '%s'", agent.Status)
	}
}
