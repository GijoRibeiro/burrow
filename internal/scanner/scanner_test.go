package scanner_test

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/gijo/cloovies/internal/scanner"
)

func testdataDir() string {
	_, filename, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(filename), "..", "..", "testdata")
}

func TestScanSessions(t *testing.T) {
	sessionsDir := filepath.Join(testdataDir(), "sessions")
	tasksDir := filepath.Join(testdataDir(), "tasks")

	s := scanner.New(sessionsDir, tasksDir)
	agents, err := s.Scan()
	if err != nil {
		t.Fatalf("Scan() error: %v", err)
	}

	if len(agents) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(agents))
	}

	var agent *scanner.AgentState
	for i := range agents {
		if agents[i].PID == 12345 {
			agent = &agents[i]
			break
		}
	}
	if agent == nil {
		t.Fatal("agent with PID 12345 not found")
	}

	if agent.SessionID != "test-session-aaa" {
		t.Errorf("expected sessionId test-session-aaa, got %s", agent.SessionID)
	}
	if agent.Cwd != "/repo/api" {
		t.Errorf("expected cwd /repo/api, got %s", agent.Cwd)
	}
	if agent.CurrentTask != "Fixing auth middleware" {
		t.Errorf("expected current task 'Fixing auth middleware', got '%s'", agent.CurrentTask)
	}
}

func TestParseWorktreeList(t *testing.T) {
	// Simulates `git worktree list --porcelain` output
	output := `worktree /repo/cloover
HEAD abc123
branch refs/heads/main

worktree /repo/cloover/.claude/worktrees/backoffice
HEAD def456
branch refs/heads/backoffice

worktree /repo/cloover/.claude/worktrees/installer
HEAD 789abc
branch refs/heads/installer

worktree /repo/cloover-installer
HEAD aaa111
branch refs/heads/main
`

	cwd := "/repo/cloover"
	wts := scanner.ParseWorktreeList(output, cwd)

	if len(wts) != 2 {
		t.Fatalf("expected 2 claude-managed worktrees, got %d: %v", len(wts), wts)
	}
	if wts[0].Name != "backoffice" {
		t.Errorf("expected first worktree name 'backoffice', got '%s'", wts[0].Name)
	}
	if wts[0].Path != "/repo/cloover/.claude/worktrees/backoffice" {
		t.Errorf("unexpected path: %s", wts[0].Path)
	}
	if wts[1].Name != "installer" {
		t.Errorf("expected second worktree name 'installer', got '%s'", wts[1].Name)
	}
}

func TestAssignWorktrees(t *testing.T) {
	agents := []scanner.AgentState{
		{SessionID: "aaa", Cwd: "/proj", Alive: true},
		{SessionID: "bbb", Cwd: "/proj", Alive: true},
		{SessionID: "ccc", Cwd: "/other", Alive: true},
	}
	worktrees := map[string][]scanner.WorktreeInfo{
		"/proj": {
			{Name: "backoffice", Path: "/proj/.claude/worktrees/backoffice"},
			{Name: "installer", Path: "/proj/.claude/worktrees/installer"},
		},
	}

	scanner.AssignWorktrees(agents, worktrees)

	// Sorted by SessionID: aaa gets backoffice, bbb gets installer
	if agents[0].Worktree != "backoffice" {
		t.Errorf("expected agent aaa worktree 'backoffice', got '%s'", agents[0].Worktree)
	}
	if agents[0].WorktreePath != "/proj/.claude/worktrees/backoffice" {
		t.Errorf("expected agent aaa worktree path, got '%s'", agents[0].WorktreePath)
	}
	if agents[1].Worktree != "installer" {
		t.Errorf("expected agent bbb worktree 'installer', got '%s'", agents[1].Worktree)
	}
	// ccc is in /other — no worktrees there
	if agents[2].Worktree != "" {
		t.Errorf("expected agent ccc no worktree, got '%s'", agents[2].Worktree)
	}
}

func TestAssignWorktrees_MoreAgentsThanWorktrees(t *testing.T) {
	agents := []scanner.AgentState{
		{SessionID: "aaa", Cwd: "/proj", Alive: true},
		{SessionID: "bbb", Cwd: "/proj", Alive: true},
		{SessionID: "ccc", Cwd: "/proj", Alive: true},
	}
	worktrees := map[string][]scanner.WorktreeInfo{
		"/proj": {
			{Name: "backoffice", Path: "/proj/.claude/worktrees/backoffice"},
		},
	}

	scanner.AssignWorktrees(agents, worktrees)

	// Only 1 worktree: first sorted agent gets it, rest stay on main
	assigned := 0
	for _, a := range agents {
		if a.Worktree != "" {
			assigned++
		}
	}
	if assigned != 1 {
		t.Errorf("expected 1 agent assigned to worktree, got %d", assigned)
	}
}

func TestAssignWorktrees_SingleAgent_NoSplit(t *testing.T) {
	agents := []scanner.AgentState{
		{SessionID: "aaa", Cwd: "/proj", Alive: true},
	}
	worktrees := map[string][]scanner.WorktreeInfo{
		"/proj": {
			{Name: "backoffice", Path: "/proj/.claude/worktrees/backoffice"},
		},
	}

	scanner.AssignWorktrees(agents, worktrees)

	// Single agent — no splitting even if worktrees exist
	if agents[0].Worktree != "" {
		t.Errorf("expected no worktree for single agent, got '%s'", agents[0].Worktree)
	}
}

func TestIsWorkingFromTail(t *testing.T) {
	cases := []struct {
		name string
		tail string
		want bool
	}{
		{
			name: "empty file",
			tail: "",
			want: false,
		},
		{
			name: "turn just ended (turn_duration is last line)",
			tail: `{"type":"assistant","message":{"stop_reason":"end_turn"}}
{"type":"attachment","attachment":{"hookEvent":"Stop"}}
{"type":"system","subtype":"stop_hook_summary"}
{"type":"system","subtype":"turn_duration","durationMs":1234}
`,
			want: false,
		},
		{
			name: "turn ended with stop_hook_summary as last",
			tail: `{"type":"assistant","message":{"stop_reason":"end_turn"}}
{"type":"system","subtype":"stop_hook_summary"}
`,
			want: false,
		},
		{
			name: "user just submitted a message (no assistant reply yet)",
			tail: `{"type":"system","subtype":"turn_duration","durationMs":100}
{"type":"user","message":{"role":"user","content":"next task"}}
`,
			want: true,
		},
		{
			name: "mid tool call (assistant tool_use, no result yet)",
			tail: `{"type":"user","message":{"role":"user","content":"build it"}}
{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use"}]}}
`,
			want: true,
		},
		{
			name: "mid PostToolUse hook",
			tail: `{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}
{"type":"attachment","attachment":{"hookEvent":"PostToolUse","hookName":"PostToolUse:Bash"}}
`,
			want: true,
		},
		{
			name: "assistant end_turn but Stop hook not yet appended (borderline working)",
			tail: `{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}
`,
			want: true,
		},
		{
			name: "trailing blank lines ignored",
			tail: `{"type":"system","subtype":"turn_duration","durationMs":500}

`,
			want: false,
		},
		{
			name: "idle — turn ended but last-prompt and permission-mode appended after",
			tail: `{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text"}]}}
{"type":"attachment","attachment":{"hookEvent":"Stop"}}
{"type":"system","subtype":"stop_hook_summary"}
{"type":"last-prompt"}
{"type":"permission-mode"}
`,
			want: false,
		},
		{
			name: "idle — file-history-snapshot after stop_hook_summary",
			tail: `{"type":"system","subtype":"stop_hook_summary"}
{"type":"file-history-snapshot"}
{"type":"last-prompt"}
`,
			want: false,
		},
		{
			name: "idle — away_summary after turn_duration",
			tail: `{"type":"system","subtype":"stop_hook_summary"}
{"type":"system","subtype":"turn_duration","durationMs":5000}
{"type":"system","subtype":"away_summary"}
`,
			want: false,
		},
		{
			name: "idle — away_summary without turn_duration",
			tail: `{"type":"attachment","attachment":{"hookEvent":"Stop"}}
{"type":"system","subtype":"stop_hook_summary"}
{"type":"system","subtype":"away_summary"}
`,
			want: false,
		},
		{
			name: "idle — pr-link after turn end",
			tail: `{"type":"system","subtype":"stop_hook_summary"}
{"type":"system","subtype":"turn_duration","durationMs":5000}
{"type":"pr-link","url":"https://github.com/foo/bar/pull/1"}
`,
			want: false,
		},
		{
			name: "working — user message after metadata tail",
			tail: `{"type":"system","subtype":"stop_hook_summary"}
{"type":"last-prompt"}
{"type":"permission-mode"}
{"type":"user","message":{"role":"user","content":"do more"}}
`,
			want: true,
		},
		{
			name: "working — assistant mid-turn with trailing attachment",
			tail: `{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use"}]}}
{"type":"attachment","attachment":{"hookEvent":"PostToolUse"}}
`,
			want: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := scanner.IsWorkingFromTail([]byte(tc.tail))
			if got != tc.want {
				t.Errorf("IsWorkingFromTail() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestScanFiltersDead(t *testing.T) {
	sessionsDir := filepath.Join(testdataDir(), "sessions")
	tasksDir := filepath.Join(testdataDir(), "tasks")

	s := scanner.New(sessionsDir, tasksDir)
	agents, err := s.Scan()
	if err != nil {
		t.Fatalf("Scan() error: %v", err)
	}

	for _, a := range agents {
		if a.Alive {
			err := exec.Command("kill", "-0", fmt.Sprintf("%d", a.PID)).Run()
			if err != nil {
				t.Errorf("PID %d marked alive but not running", a.PID)
			}
		}
	}
}
