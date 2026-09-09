package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestQuietConversation(t *testing.T) {
	log := `{"type":"user","uuid":"u1","message":{"content":"Fix the layout"}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"thinking","thinking":"private reasoning"},{"type":"text","text":"I will check the layout."},{"type":"tool_use","name":"Read","input":{"file_path":"secret payload"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"verbose tool output"}]}}
`
	a := parseConversation([]byte(log))
	if a.Status != "working" || a.Tools != 1 || a.Tool != "Read" || len(a.Messages) != 2 {
		t.Fatalf("working: %+v", a)
	}
	data, _ := json.Marshal(a)
	for _, hidden := range []string{"private reasoning", "secret payload", "verbose tool output"} {
		if strings.Contains(string(data), hidden) {
			t.Errorf("leaked %s", hidden)
		}
	}
	log += `{"type":"assistant","uuid":"a2","message":{"content":[{"type":"text","text":"Fixed."}],"stop_reason":"end_turn"}}
{"type":"system","subtype":"turn_duration"}
{"type":"last-prompt","lastPrompt":"Fix the layout"}
{"type":"assistant","isSidechain":true,"message":{"content":"Another agent's response"}}
`
	a = parseConversation([]byte(log))
	if a.Status != "ready" || a.Tool != "" || len(a.Messages) != 3 {
		t.Fatalf("finished: %+v", a)
	}
	// Streaming replacements keep one message rather than duplicate text.
	a = parseConversation([]byte(log + `{"type":"assistant","uuid":"a2","message":{"content":"Fixed completely.","stop_reason":"end_turn"}}`))
	if len(a.Messages) != 3 || a.Messages[2].Text != "Fixed completely." {
		t.Fatalf("dedup: %+v", a)
	}
}
func TestConversationTailWaitsForCompleteRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	os.WriteFile(path, []byte("{\"type\":\"user\",\"message\":{\"content\":\"Hello\"}}\n{\"type\":\"assistant\""), 0600)
	data, truncated, err := conversationTail(path)
	if err != nil || truncated || len(parseConversation(data).Messages) != 1 {
		t.Fatalf("partial record: %s %v", data, err)
	}
}
func TestActivityMatchesTerminalProcessNotDirectory(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	p, err := m.AddProject(repo(t), "Test")
	if err != nil {
		t.Fatal(err)
	}
	first, err := m.CreateTerminal(p.ID, p.Path, "First")
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.CreateTerminal(p.ID, p.Path, "Second")
	if err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	os.MkdirAll(filepath.Join(config, "sessions"), 0700)
	os.MkdirAll(filepath.Join(config, "projects", "different-slug"), 0700)
	for _, terminal := range []Terminal{first, second} {
		pid, err := m.tmux("display-message", "-p", "-t", "="+sessionName(terminal.ID)+":", "#{pane_pid}")
		if err != nil {
			t.Fatal(err)
		}
		number, _ := strconv.Atoi(pid)
		session := claudeSession{PID: number, Cwd: p.Path, SessionID: terminal.ID}
		data, _ := json.Marshal(session)
		os.WriteFile(filepath.Join(config, "sessions", pid+".json"), data, 0600)
		entry := map[string]any{"type": "assistant", "message": map[string]any{"content": terminal.Name, "stop_reason": "end_turn"}}
		data, _ = json.Marshal(entry)
		os.WriteFile(filepath.Join(config, "projects", "different-slug", terminal.ID+".jsonl"), append(data, '\n'), 0600)
	}
	for _, terminal := range []Terminal{first, second} {
		a, err := m.Activity(terminal.ID)
		if err != nil || a.Kind != "claude" || len(a.Messages) != 1 || a.Messages[0].Text != terminal.Name {
			t.Fatalf("wrong session for %s: %+v %v", terminal.Name, a, err)
		}
	}
	m.UpdateTerminal(first.ID, "stop", "")
	a, _ := m.Activity(first.ID)
	if a.Status != "stopped" || len(a.Messages) != 0 {
		t.Fatalf("stale stopped session: %+v", a)
	}
	if _, err := m.Activity("unknown"); err == nil {
		t.Error("accepted unregistered terminal")
	}
}
func TestDescendantDepth(t *testing.T) {
	parents := map[int]int{10: 1, 11: 10, 12: 11, 20: 1, 21: 20, 30: 31, 31: 30}
	for _, tc := range []struct{ child, root, want int }{{12, 10, 2}, {10, 10, 0}, {21, 10, -1}, {99, 10, -1}, {30, 10, -1}} {
		if got := descendantDepth(tc.child, tc.root, parents); got != tc.want {
			t.Errorf("%+v got %d", tc, got)
		}
	}
}

func TestChatRejectsPlainShell(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	p, _ := m.AddProject(repo(t), "Test")
	terminal, err := m.CreateTerminal(p.ID, p.Path, "Shell")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.SendMessage(terminal.ID, "hey u there"); err == nil {
		t.Fatal("chat sent to a shell")
	}
	screen, _ := m.tmux("capture-pane", "-p", "-t", "="+sessionName(terminal.ID)+":")
	if strings.Contains(screen, "hey u there") {
		t.Fatal("rejected chat reached shell")
	}
	if _, err = m.CreateProgramTerminal(p.ID, p.Path, "Bad", "unknown"); err == nil {
		t.Fatal("unsupported program accepted")
	}
}
