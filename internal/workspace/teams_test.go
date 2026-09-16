package workspace

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestTeamPreparationValidatesIdentityAndLinearContext(t *testing.T) {
	m, p, ordinary := coordinationManager(t)
	head, err := m.CreateHead(p.ID, p.Path, "Morning lead", "claude", "Help me choose three Linear tickets")
	if err != nil {
		t.Fatal(err)
	}
	command, err := m.tmux("display-message", "-p", "-t", "="+sessionName(head.ID)+":", "#{pane_start_command}")
	if err != nil || !strings.Contains(command, "You are the head agent") || !strings.Contains(command, "--dangerously-skip-permissions") || !strings.Contains(command, "--append-system-prompt") || !strings.Contains(command, head.Goal) {
		t.Fatalf("head launch: %s %v", command, err)
	}
	if _, err = m.Delegate(DelegateRequest{ParentID: head.ID, Name: "bypass", Program: "codex", Title: "Bypass", Instructions: "Bypass the plan"}); err == nil {
		t.Fatal("head bypassed proposal")
	}
	old := http.DefaultClient
	defer func() { http.DefaultClient = old }()
	http.DefaultClient = &http.Client{Transport: linearTransport(func(r *http.Request) (*http.Response, error) {
		var body struct {
			Query     string
			Variables map[string]string
		}
		json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Authorization") != "team-test-key" {
			t.Error("missing Linear key")
		}
		data := `{"data":{"viewer":{"assignedIssues":{"nodes":[{"id":"uuid-1","identifier":"ENG-1","title":"First task","url":"https://linear.app/test/issue/ENG-1/task","state":{"name":"Todo"}}]}}}}`
		if strings.Contains(body.Query, "query WorktreeIssue(") {
			ref := body.Variables["id"]
			data = fmt.Sprintf(`{"data":{"issue":{"id":%q,"identifier":%q,"title":"Ticket title","url":"https://linear.app/test/issue/%s/task","description":"Acceptance criteria from Linear","state":{"name":"Todo"}}}}`, ref, ref, ref)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(data)), Header: http.Header{}}, nil
	})}
	if err = m.saveLinearKey("team-test-key"); err != nil {
		t.Fatal(err)
	}
	request := func(actor Terminal, action AgentAction) *httptest.ResponseRecorder {
		b, _ := json.Marshal(action)
		r := httptest.NewRequest("POST", "http://localhost/api/workspace/agent", bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Burrow-Agent", actor.ID)
		r.Header.Set("Authorization", "Bearer "+m.state.AgentTokens[actor.ID])
		w := httptest.NewRecorder()
		m.Handler().ServeHTTP(w, r)
		return w
	}
	if w := request(head, AgentAction{Action: "linear"}); w.Code != 200 || !strings.Contains(w.Body.String(), "ENG-1") || strings.Contains(w.Body.String(), "team-test-key") {
		t.Fatal(w.Body.String())
	}
	v := PlanRequest{Title: "Three tickets", Summary: "Three independent fixes, one worker each"}
	for i := 1; i <= 3; i++ {
		v.Items = append(v.Items, PlanItemRequest{Name: fmt.Sprintf("ticket-%d", i), Title: fmt.Sprintf("Ticket %d", i), IssueID: fmt.Sprintf("ENG-%d", i), Program: "codex", Instructions: "Implement, test and commit."})
	}
	if w := request(ordinary, AgentAction{Action: "propose", Plan: &v}); w.Code != 400 {
		t.Fatal("ordinary agent created a team plan")
	}
	plan, err := m.preparePlan(head.ID, v)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Snapshot().Terminals) != 2 || len(m.Snapshot().Projects[0].Worktrees) != 1 {
		t.Fatal("proposal spawned workers")
	}
	if _, err = m.preparePlan(head.ID, v); err == nil {
		t.Fatal("duplicate pending plan accepted")
	}
	if w := request(head, AgentAction{Action: "approve"}); w.Code != 400 {
		t.Fatal("agent approved own plan")
	}
	result, err := m.StartPlan(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "active" || len(m.state.Tasks) != 3 {
		t.Fatalf("launch: %+v", result)
	}
	for _, task := range m.state.Tasks {
		if task.ParentID != head.ID || task.Issue == nil || !strings.Contains(task.Instructions, "Acceptance criteria from Linear") {
			t.Fatal("lost ticket/parent context")
		}
	}
	if len(m.Inbox(head.ID)) == 0 {
		t.Fatal("head did not receive approval update")
	}
	if _, err = m.SendCoordinationMessage(head.ID, "user", "", "Team is underway"); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(m.Snapshot())
	if bytes.Contains(raw, []byte("team-test-key")) || bytes.Contains(raw, []byte("agentTokens")) {
		t.Fatal("credentials leaked")
	}
}
func TestTeamPartialLaunchRetryAcrossRestartIsIdempotent(t *testing.T) {
	m, p, _ := coordinationManager(t)
	head, err := m.CreateHead(p.ID, p.Path, "Head", "codex", "Coordinate two tasks")
	if err != nil {
		t.Fatal(err)
	}
	command, err := m.tmux("display-message", "-p", "-t", "="+sessionName(head.ID)+":", "#{pane_start_command}")
	if err != nil || !strings.Contains(command, "developer_instructions=") || !strings.Contains(command, "--dangerously-bypass-approvals-and-sandbox") || !strings.Contains(command, head.Goal) {
		t.Fatalf("Codex head launch: %s %v", command, err)
	}
	plan, err := m.preparePlan(head.ID, PlanRequest{Title: "Team", Summary: "Independent tasks", Items: []PlanItemRequest{
		{Name: "one", Title: "One", Program: "claude", Instructions: "First task"},
		{Name: "two", Title: "Two", Program: "codex", Instructions: "Second task"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	// Do not fall through to a real provider installed elsewhere on this Mac.
	fixtureBin := filepath.Dir(binary)
	for _, name := range []string{"git", "tmux"} {
		real, e := exec.LookPath(name)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.Symlink(real, filepath.Join(fixtureBin, name)); e != nil {
			t.Fatal(e)
		}
	}
	t.Setenv("PATH", fixtureBin)
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(binary); err != nil {
		t.Fatal(err)
	}
	partial, err := m.StartPlan(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if partial.Status != "partial" || partial.Items[0].TaskID == "" || partial.Items[1].Error == "" {
		t.Fatalf("expected partial launch: %+v", partial)
	}
	if err = os.WriteFile(binary, data, 0700); err != nil {
		t.Fatal(err)
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	if err = loaded.ConfigureAgentRuntime("http://127.0.0.1:4337"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, e := loaded.StartPlan(plan.ID)
			if e != nil || result.Status != "active" {
				t.Errorf("retry: %v %+v", e, result)
			}
		}()
	}
	wg.Wait()
	if len(loaded.state.Tasks) != 2 || loaded.state.Plans[0].Items[0].TaskID != partial.Items[0].TaskID {
		t.Fatal("retry duplicated existing worker")
	}
	if len(loaded.Snapshot().Projects[0].Worktrees) != 3 {
		t.Fatal("incorrect worktree count")
	}
}
func TestDismissedPlanNeverLaunches(t *testing.T) {
	m, p, _ := coordinationManager(t)
	head, e := m.CreateHead(p.ID, p.Path, "Head", "claude", "Discuss scope")
	if e != nil {
		t.Fatal(e)
	}
	v := PlanRequest{Title: "Plan", Summary: "Needs discussion", Items: []PlanItemRequest{{Name: "draft", Title: "Draft", Program: "codex", Instructions: "Do task"}}}
	plan, e := m.preparePlan(head.ID, v)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.DismissPlan(plan.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = m.StartPlan(plan.ID); e == nil {
		t.Fatal("dismissed plan launched")
	}
	if _, e = m.preparePlan(head.ID, v); e != nil {
		t.Fatal("could not revise dismissed plan", e)
	}
	if len(m.state.Tasks) != 0 {
		t.Fatal("dismissal started work")
	}
}

func TestApprovedTeamRecoversInterruptedWorkerLaunch(t *testing.T) {
	m, p, _ := coordinationManager(t)
	head, err := m.CreateHead(p.ID, p.Path, "Head", "claude", "Coordinate")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := m.preparePlan(head.ID, PlanRequest{Title: "Recovery", Summary: "One worker", Items: []PlanItemRequest{{Name: "recover", Title: "Recover", Program: "codex", Instructions: "Finish task"}}})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = m.StartPlan(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	task := m.state.Tasks[0]
	if err = m.UpdateTerminal(task.AgentID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after the task identity was saved but before tmux started.
	m.state.Tasks[0].LaunchPending = true
	m.state.Plans[0].Status = "launching"
	m.state.Plans[0].Items[0].TaskID = ""
	if err = m.save(); err != nil {
		t.Fatal(err)
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	if err = loaded.ConfigureAgentRuntime("http://127.0.0.1:4337"); err != nil {
		t.Fatal(err)
	}
	result, err := loaded.StartPlan(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "active" || len(loaded.state.Tasks) != 1 || loaded.state.Tasks[0].LaunchPending {
		t.Fatal("pending worker was not recovered", result)
	}
	if _, err = loaded.tmux("has-session", "-t", "="+sessionName(task.AgentID)); err != nil {
		t.Fatal("worker process missing", err)
	}
}

func TestHeadRequestStartsWorkersAndRemovalSurvivesRetry(t *testing.T) {
	m, p, _ := coordinationManager(t)
	head, err := m.CreateHead(p.ID, p.Path, "Head", "claude", "Start two agents")
	if err != nil {
		t.Fatal(err)
	}
	v := PlanRequest{Title: "Direct team", Summary: "Start requested work", Items: []PlanItemRequest{
		{Name: "direct-one", Title: "One", Program: "codex", Instructions: "First task"},
		{Name: "direct-two", Title: "Two", Program: "codex", Instructions: "Second task"},
	}}
	b, _ := json.Marshal(AgentAction{Action: "propose", Plan: &v})
	r := httptest.NewRequest("POST", "http://localhost/api/workspace/agent", bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Burrow-Agent", head.ID)
	r.Header.Set("Authorization", "Bearer "+m.state.AgentTokens[head.ID])
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var plan TeamPlan
	if err = json.Unmarshal(w.Body.Bytes(), &plan); err != nil || plan.Status != "active" {
		t.Fatal(plan, err)
	}
	tasks := m.Coordination().Tasks
	if len(tasks) != 2 {
		t.Fatal(tasks)
	}
	removed, kept := tasks[0], tasks[1]
	if err = m.UpdateTerminal(removed.AgentID, "remove", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = m.tmux("has-session", "-t", "="+sessionName(removed.AgentID)); err == nil {
		t.Fatal("removed process still running")
	}
	if _, err = os.Stat(removed.Path); err != nil {
		t.Fatal("removed checkout", err)
	}
	// A partial launch retry cannot recreate a removed worker.
	m.state.Plans[0].Status = "partial"
	if err = m.save(); err != nil {
		t.Fatal(err)
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	if err = loaded.ConfigureAgentRuntime("http://127.0.0.1:4337"); err != nil {
		t.Fatal(err)
	}
	if _, err = loaded.StartPlan(plan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = loaded.Terminal(removed.AgentID); err == nil {
		t.Fatal("worker returned")
	}
	// Removing a head leaves existing workers and their worktrees intact.
	if err = loaded.UpdateTerminal(head.ID, "remove", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = loaded.tmux("has-session", "-t", "="+sessionName(kept.AgentID)); err != nil {
		t.Fatal("worker stopped with head", err)
	}
	if _, err = loaded.StartPlan(plan.ID); err == nil {
		t.Fatal("removed head's plan restarted")
	}
}

func TestRemovePendingWorkerAndRaceWithFinishedLaunch(t *testing.T) {
	m, p, _ := coordinationManager(t)
	head, err := m.CreateHead(p.ID, p.Path, "Head", "claude", "Discuss")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := m.preparePlan(head.ID, PlanRequest{Title: "Pending", Summary: "Pending", Items: []PlanItemRequest{
		{Name: "skip", Title: "Skip", Program: "codex", Instructions: "Skip"},
		{Name: "keep", Title: "Keep", Program: "codex", Instructions: "Keep"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err = m.RemovePlannedWorker(plan.ID, plan.Items[0].ID); err != nil {
		t.Fatal(err)
	}
	plan, err = m.StartPlan(plan.ID)
	if err != nil || len(m.state.Tasks) != 1 {
		t.Fatal(plan, err)
	}
	task := m.state.Tasks[0]
	// Stale placeholder removal after launch must remove the actual terminal too.
	if err = m.RemovePlannedWorker(plan.ID, plan.Items[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Terminal(task.AgentID); err == nil {
		t.Fatal("late removal left terminal")
	}
	if _, err = os.Stat(task.Path); err != nil {
		t.Fatal(err)
	}
}
