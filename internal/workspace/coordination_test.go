package workspace

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func coordinationManager(t *testing.T) (*Manager, Project, Terminal) {
	t.Helper()
	requireTmux(t)
	bin := t.TempDir()
	for _, name := range []string{"claude", "codex"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexec /bin/sleep 120\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	m := manager(t)
	p, err := m.AddProject(repo(t), "Team")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.ConfigureAgentRuntime("http://127.0.0.1:4337"); err != nil {
		t.Fatal(err)
	}
	parent, err := m.CreateProgramTerminal(p.ID, p.Path, "Parent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	return m, p, parent
}
func commitFile(t *testing.T, path, name, text string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(path, name), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := git(path, "add", "--", name); err != nil {
		t.Fatal(err)
	}
	if _, err := git(path, "commit", "-m", "Test change"); err != nil {
		t.Fatal(err)
	}
	head, err := git(path, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return head
}
func TestChildWorktreesAreOptionalAndFollowParentCommit(t *testing.T) {
	m := manager(t)
	p, err := m.AddProject(repo(t), "Hierarchy")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := m.CreateWorktree(p.ID, "parent", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	commit := commitFile(t, parent.Path, "parent.txt", "parent change")
	if err := os.WriteFile(filepath.Join(parent.Path, "uncommitted.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	child, err := m.createWorktree(p.ID, "child", "ignored", nil, parent.Path)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentPath != parent.Path || child.BaseCommit != commit {
		t.Fatalf("wrong lineage: %+v", child)
	}
	if _, err := os.Stat(filepath.Join(child.Path, "parent.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(child.Path, "uncommitted.txt")); !os.IsNotExist(err) {
		t.Fatal("copied dirty parent files")
	}
	if _, err := m.createWorktree(p.ID, "outside", "HEAD", nil, repo(t)); err == nil {
		t.Fatal("accepted another project as parent")
	}
	if err := m.RemoveWorktree(p.ID, parent.Path); err == nil || !strings.Contains(err.Error(), "child") {
		t.Fatalf("parent removal: %v", err)
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, tree := range loaded.Snapshot().Projects[0].Worktrees {
		if tree.Path == child.Path {
			found = true
			if tree.ParentPath != parent.Path || tree.BaseCommit != commit {
				t.Fatal(tree)
			}
		}
	}
	if !found {
		t.Fatal("child missing after reload")
	}
	flat, err := m.CreateWorktree(p.ID, "independent", "HEAD")
	if err != nil || flat.ParentPath != "" {
		t.Fatalf("ordinary worktree changed: %+v %v", flat, err)
	}
	if err := m.RemoveWorktree(p.ID, child.Path); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.state.WorktreeLinks[child.Path]; ok {
		t.Fatal("stale relationship")
	}
}
func TestDelegationMessagesCompletionAndIntegration(t *testing.T) {
	m, p, parent := coordinationManager(t)
	task, err := m.Delegate(DelegateRequest{ParentID: parent.ID, Name: "api", Program: "codex", Title: "API task", Instructions: "Add an endpoint and test it"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := m.Terminal(task.AgentID)
	if err != nil || worker.TaskID != task.ID || worker.Program != "codex" {
		t.Fatalf("worker: %+v %v", worker, err)
	}
	if !strings.Contains(m.taskPrompt(task), "burrow") || !strings.Contains(m.taskPrompt(task), "Do not merge") {
		t.Fatal("missing coordination instructions")
	}
	msg, err := m.SendCoordinationMessage(task.AgentID, parent.ID, task.ID, "Which endpoint?")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Inbox(parent.ID)) != 1 || len(m.Inbox(parent.ID)) != 1 {
		t.Fatal("reading acknowledged messages")
	}
	if err := m.Acknowledge(task.AgentID, msg.ID); err == nil {
		t.Fatal("another agent acknowledged the message")
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Inbox(parent.ID)) != 1 {
		t.Fatal("lost message on reload")
	}
	if err := m.Acknowledge(parent.ID, msg.ID); err != nil {
		t.Fatal(err)
	}
	if len(m.Inbox(parent.ID)) != 0 {
		t.Fatal("ack failed")
	}
	if _, err := m.UpdateTask(parent.ID, task.ID, "done", "wrong agent"); err == nil {
		t.Fatal("parent reported worker completion")
	}
	if _, err := m.UpdateTask(task.AgentID, task.ID, "waiting", "Need the endpoint name"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Path, "dirty"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.UpdateTask(task.AgentID, task.ID, "done", "tests passed"); err == nil {
		t.Fatal("accepted uncommitted completion")
	}
	if err := os.Remove(filepath.Join(task.Path, "dirty")); err != nil {
		t.Fatal(err)
	}
	result := commitFile(t, task.Path, "api.txt", "done")
	done, err := m.UpdateTask(task.AgentID, task.ID, "done", "Endpoint added; tests passed")
	if err != nil || done.ResultCommit != result {
		t.Fatalf("done: %+v %v", done, err)
	}
	review, err := m.ReviewTask(task.ID)
	if err != nil || !strings.Contains(review["diff"], "api.txt") {
		t.Fatalf("review: %v %v", review, err)
	}
	if _, err := m.IntegrateTask(task.ID, result, "stale-parent"); err == nil {
		t.Fatal("accepted stale review")
	}
	integrated, err := m.IntegrateTask(task.ID, result, review["parentCommit"])
	if err != nil {
		t.Fatal(err)
	}
	if integrated.IntegratedCommit == "" {
		t.Fatal("missing integration result")
	}
	if content, err := os.ReadFile(filepath.Join(p.Path, "api.txt")); err != nil || string(content) != "done" {
		t.Fatalf("missing integrated change: %s %v", content, err)
	}
	if _, err := m.UpdateTask("user", task.ID, "working", ""); err == nil {
		t.Fatal("reopened an integrated task")
	}
	snapshot, _ := json.Marshal(m.Snapshot())
	for _, secret := range m.state.AgentTokens {
		if bytes.Contains(snapshot, []byte(secret)) {
			t.Fatal("credential leaked into snapshot")
		}
	}
	if bytes.Contains(snapshot, []byte("Which endpoint?")) {
		t.Fatal("message bodies leaked into ordinary workspace snapshots")
	}
}
func TestIntegrationConflictRestoresParent(t *testing.T) {
	m, p, parent := coordinationManager(t)
	task, err := m.Delegate(DelegateRequest{ParentID: parent.ID, Name: "conflict", Program: "claude", Title: "Conflict", Instructions: "Test conflict"})
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, task.Path, "same.txt", "child")
	if _, err = m.UpdateTask(task.AgentID, task.ID, "done", "Done"); err != nil {
		t.Fatal(err)
	}
	parentCommit := commitFile(t, p.Path, "same.txt", "parent")
	review, err := m.ReviewTask(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.IntegrateTask(task.ID, review["commit"], review["parentCommit"]); err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("conflict: %v", err)
	}
	head, _ := git(p.Path, "rev-parse", "HEAD")
	status, _ := git(p.Path, "status", "--porcelain")
	if head != parentCommit || status != "" {
		t.Fatalf("parent changed after conflict: %s %s", head, status)
	}
}
func TestAgentAuthenticationAndIdentity(t *testing.T) {
	m, _, parent := coordinationManager(t)
	task, err := m.Delegate(DelegateRequest{ParentID: parent.ID, Name: "worker", Program: "codex", Title: "Worker", Instructions: "Test inbox"})
	if err != nil {
		t.Fatal(err)
	}
	call := func(token string, action AgentAction) *httptest.ResponseRecorder {
		data, _ := json.Marshal(action)
		req := httptest.NewRequest("POST", "http://127.0.0.1/api/workspace/agent", bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Burrow-Agent", task.AgentID)
		req.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		m.Handler().ServeHTTP(response, req)
		return response
	}
	if result := call("wrong", AgentAction{Action: "inbox"}); result.Code != 401 {
		t.Fatal(result.Code)
	}
	if result := call(m.state.AgentTokens[task.AgentID], AgentAction{Action: "send", To: "parent", Text: "Hello"}); result.Code != 200 {
		t.Fatal(result.Body.String())
	}
	messages := m.Inbox(parent.ID)
	if len(messages) != 1 || messages[0].From != task.AgentID || messages[0].TaskID != task.ID {
		t.Fatalf("wrong identity: %+v", messages)
	}
}

func TestFailedDelegationDoesNotLeaveATaskOrCheckout(t *testing.T) {
	m, p, parent := coordinationManager(t)
	t.Setenv("SHELL", "invalid-relative-shell")
	_, err := m.Delegate(DelegateRequest{ParentID: parent.ID, Name: "failed-worker", Program: "codex", Title: "Failure", Instructions: "Must not start"})
	if err == nil {
		t.Fatal("invalid launch accepted")
	}
	if len(m.state.Tasks) != 0 || len(m.state.Terminals) != 1 {
		t.Fatal("failed task left records")
	}
	if _, err := os.Stat(filepath.Join(p.Path, ".worktrees", "failed-worker")); !os.IsNotExist(err) {
		t.Fatal("failed task left checkout")
	}
	if _, err := git(p.Path, "rev-parse", "--verify", "failed-worker"); err == nil {
		t.Fatal("failed task left branch")
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.state.Tasks) != 0 || len(loaded.state.Terminals) != 1 {
		t.Fatal("rollback not persisted")
	}
}
