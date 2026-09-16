package workspace

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAttachExistingAgentPreservesProcessAndCheckout(t *testing.T) {
	m, p, agent := coordinationManager(t)
	head, err := m.CreateHead(p.ID, p.Path, "Head", "claude", "Coordinate")
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := m.tmux("display-message", "-p", "-t", "="+sessionName(agent.ID)+":", "#{pane_pid}")
	before := m.Snapshot()
	attached, err := m.AttachAgent(agent.ID, head.ID)
	if err != nil || attached.HeadID != head.ID || attached.Path != agent.Path || attached.TaskID != "" {
		t.Fatalf("attach: %+v %v", attached, err)
	}
	after := m.Snapshot()
	next, _ := m.tmux("display-message", "-p", "-t", "="+sessionName(agent.ID)+":", "#{pane_pid}")
	if next != pid || len(before.Terminals) != len(after.Terminals) || len(before.Projects[0].Worktrees) != len(after.Projects[0].Worktrees) {
		t.Fatal("attachment changed processes or worktrees")
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := loaded.Terminal(agent.ID)
	if saved.HeadID != head.ID {
		t.Fatal("attachment lost after restart")
	}
	call := func(actor Terminal, action AgentAction) *httptest.ResponseRecorder {
		data, _ := json.Marshal(action)
		r := httptest.NewRequest("POST", "http://localhost/api/workspace/agent", bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Burrow-Agent", actor.ID)
		r.Header.Set("Authorization", "Bearer "+m.state.AgentTokens[actor.ID])
		w := httptest.NewRecorder()
		m.Handler().ServeHTTP(w, r)
		return w
	}
	if w := call(agent, AgentAction{Action: "send", To: "parent", Text: "Where should I start?"}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, actor := range []Terminal{head, agent} {
		w := call(actor, AgentAction{Action: "team"})
		if w.Code != 200 || !strings.Contains(w.Body.String(), agent.ID) || !strings.Contains(w.Body.String(), head.ID) {
			t.Fatal(w.Body.String())
		}
	}
	if _, err = m.AttachAgent(head.ID, agent.ID); err == nil {
		t.Fatal("attached a head beneath a worker")
	}
	task, err := m.Delegate(DelegateRequest{ParentID: agent.ID, Name: "child", Program: "codex", Title: "Child", Instructions: "Keep scope"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.AttachAgent(task.AgentID, head.ID); err == nil {
		t.Fatal("changed a delegated integration parent")
	}
	other, err := m.AddProject(repo(t), "Other")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := m.CreateHead(other.ID, other.Path, "Other head", "claude", "Coordinate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.AttachAgent(agent.ID, foreign.ID); err == nil {
		t.Fatal("accepted unrelated project")
	}
	if _, err = m.AttachAgent(agent.ID, ""); err != nil {
		t.Fatal(err)
	}
	if w := call(agent, AgentAction{Action: "send", To: "parent", Text: "Detached"}); w.Code == 200 {
		t.Fatal("sent to detached parent")
	}
	if _, err = m.AttachAgent(agent.ID, head.ID); err != nil {
		t.Fatal(err)
	}
	if err = m.UpdateTerminal(head.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	if err = m.UpdateTerminal(head.ID, "remove", ""); err != nil {
		t.Fatal(err)
	}
	detached, _ := m.Terminal(agent.ID)
	if detached.HeadID != "" {
		t.Fatal("removed head left a stale attachment")
	}

}

func TestIdleClaudeDoesNotKeepOldThinkingState(t *testing.T) {
	a := parseConversation([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}`))
	if a.Status != "working" {
		t.Fatal(a)
	}
	applySessionStatus(&a, "idle")
	if a.Status != "ready" || a.Tool != "" {
		t.Fatal("stale thinking state", a)
	}
}
