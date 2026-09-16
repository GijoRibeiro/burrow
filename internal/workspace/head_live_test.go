package workspace

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Explicit opt-in: exercises a real Claude conversation against fake Linear
// tickets and local worker fixtures. Never uses a user's real tickets or files.
func TestLiveHeadTicketConversation(t *testing.T) {
	binary, checkout := os.Getenv("BURROW_SMOKE_BINARY"), os.Getenv("BURROW_SMOKE_REPO")
	if binary == "" || checkout == "" {
		t.Skip("set BURROW_SMOKE_BINARY and BURROW_SMOKE_REPO to run the live provider smoke")
	}
	requireTmux(t)
	bin := t.TempDir()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := filepath.Abs("../../web/e2e/fixtures/codex.cjs")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(bin, "codex"), []byte("#!/bin/sh\nexec "+shellQuote(node)+" "+shellQuote(fixture)+" \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	m := manager(t)
	p, err := m.AddProject(checkout, "Live conversation smoke")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	if err = m.ConfigureAgentRuntime(server.URL); err != nil {
		t.Fatal(err)
	}
	runtime := filepath.Join(filepath.Dir(m.file), "agent-runtime.json")
	if err = writePrivate(m.cliPath, []byte("#!/bin/sh\nexec "+shellQuote(binary)+" agent --runtime "+shellQuote(runtime)+" \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = m.saveLinearKey("isolated-fake-linear"); err != nil {
		t.Fatal(err)
	}
	old := http.DefaultClient
	defer func() { http.DefaultClient = old }()
	http.DefaultClient = &http.Client{Transport: linearTransport(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		data := `{"data":{"viewer":{"assignedIssues":{"nodes":[{"id":"SMOKE-1","identifier":"SMOKE-1","title":"Overview documentation","url":"https://linear.app/smoke/issue/SMOKE-1","state":{"name":"Todo"}},{"id":"SMOKE-2","identifier":"SMOKE-2","title":"Setup documentation","url":"https://linear.app/smoke/issue/SMOKE-2","state":{"name":"Todo"}}]}}}}`
		if strings.Contains(string(body), "query WorktreeIssue(") {
			id := "SMOKE-1"
			if strings.Contains(string(body), "SMOKE-2") {
				id = "SMOKE-2"
			}
			data = fmt.Sprintf(`{"data":{"issue":{"id":%q,"identifier":%q,"title":"Documentation task","url":"https://linear.app/smoke/issue/%s","description":"Independent documentation task in this isolated fixture repository. TEAM_FIXTURE. Use Codex. Commit and report when done.","state":{"name":"Todo"}}}}`, id, id, id)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(data))}, nil
	})}
	head, err := m.CreateHead(p.ID, p.Path, "Live smoke head", "claude", "This is an isolated test. Say HEAD_READY and return to your prompt. Wait for my next message before reading tickets or proposing work.")
	if err != nil {
		t.Fatal(err)
	}
	wait := func(stage string, limit time.Duration, ready func() bool) {
		t.Helper()
		deadline := time.Now().Add(limit)
		for time.Now().Before(deadline) {
			if ready() {
				t.Log(stage)
				return
			}
			time.Sleep(time.Second)
		}
		screen, _ := m.tmux("capture-pane", "-p", "-S", "-45", "-t", "="+sessionName(head.ID)+":")
		t.Fatalf("%s timed out\n%s", stage, screen)
	}
	wait("Head ready", 90*time.Second, func() bool {
		a, _ := m.Activity(head.ID)
		for _, msg := range a.Messages {
			if msg.Role == "assistant" && strings.Contains(msg.Text, "HEAD_READY") && a.Status == "ready" {
				return true
			}
		}
		return false
	})
	branchPrefix := "live-smoke-" + id()
	if err = m.SendMessage(head.ID, fmt.Sprintf("Create agents for my Linear tickets for me. Use both assigned SMOKE tickets, with one Codex worker for each. These are independent documentation tasks. Use branches %s-one and %s-two. Read the ticket context with the Burrow CLI, then start the agents immediately. Do not wait or poll after launching.", branchPrefix, branchPrefix)); err != nil {
		t.Fatal(err)
	}
	wait("Conversational request started a Linear team", 120*time.Second, func() bool { plans := m.Snapshot().Plans; return len(plans) == 1 && plans[0].Status == "active" })
	plan := m.Snapshot().Plans[0]
	if len(plan.Items) != 2 || len(m.Snapshot().Terminals) != 3 {
		t.Fatalf("unexpected proposal: %+v", plan)
	}
	for _, item := range plan.Items {
		if item.Issue == nil {
			t.Fatal("missing Linear issue", item)
		}
	}
	tasks := m.Coordination().Tasks
	if len(tasks) != 2 {
		t.Fatal(tasks)
	}
	for _, task := range tasks {
		if task.ParentID != head.ID || task.Issue == nil {
			t.Fatal(task)
		}
		defer func(path string) {
			if m.RemoveWorktree(p.ID, path) == nil {
				_, _ = git(p.Path, "branch", "-d", filepath.Base(path))
			}
		}(task.Path)
	}
	wait("Workers connected to head inbox", 30*time.Second, func() bool {
		count := 0
		for _, msg := range m.Inbox(head.ID) {
			if msg.From != "user" {
				count++
			}
		}
		return count >= 2
	})
	// Stop only these disposable fixture sessions before removing their worktrees.
	for _, task := range tasks {
		_ = m.UpdateTerminal(task.AgentID, "stop", "")
		_ = m.UpdateTerminal(task.AgentID, "remove", "")
	}
	t.Log("Real head + conversational ticket request + automatic launch + two attached worker terminals passed")
}
