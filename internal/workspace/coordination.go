package workspace

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gijo/cloovies/internal/linear"
)

type WorktreeLink struct {
	ParentPath string `json:"parentPath"`
	BaseCommit string `json:"baseCommit"`
}
type Task struct {
	LaunchPending    bool                  `json:"launchPending,omitempty"`
	PlanID           string                `json:"planId,omitempty"`
	PlanItemID       string                `json:"planItemId,omitempty"`
	Issue            *linear.WorktreeIssue `json:"issue,omitempty"`
	ParentBranch     string                `json:"parentBranch"`
	ID               string                `json:"id"`
	ProjectID        string                `json:"projectId"`
	ParentID         string                `json:"parentId"`
	AgentID          string                `json:"agentId"`
	ParentPath       string                `json:"parentPath"`
	Path             string                `json:"path"`
	Title            string                `json:"title"`
	Instructions     string                `json:"instructions"`
	Status           string                `json:"status"`
	Summary          string                `json:"summary,omitempty"`
	ResultCommit     string                `json:"resultCommit,omitempty"`
	IntegratedCommit string                `json:"integratedCommit,omitempty"`
	CreatedAt        time.Time             `json:"createdAt"`
	UpdatedAt        time.Time             `json:"updatedAt"`
}
type AgentMessage struct {
	ID        string     `json:"id"`
	TaskID    string     `json:"taskId,omitempty"`
	From      string     `json:"from"`
	To        string     `json:"to"`
	Text      string     `json:"text"`
	CreatedAt time.Time  `json:"createdAt"`
	ReadAt    *time.Time `json:"readAt,omitempty"`
}
type Coordination struct {
	Tasks    []Task         `json:"tasks"`
	Messages []AgentMessage `json:"messages"`
	CLI      string         `json:"cli"`
}
type DelegateRequest struct {
	ParentID     string `json:"parentId"`
	Name         string `json:"name"`
	Program      string `json:"program"`
	Title        string `json:"title"`
	Instructions string `json:"instructions"`
}

func (m *Manager) task(id string) (Task, error) {
	for _, task := range m.state.Tasks {
		if task.ID == id {
			return task, nil
		}
	}
	return Task{}, errors.New("task not found")
}
func (m *Manager) Coordination() Coordination {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Coordination{Tasks: append([]Task{}, m.state.Tasks...), Messages: append([]AgentMessage{}, m.state.Messages...), CLI: m.cliPath}
}
func isAgent(t Terminal) bool { return t.Program == "claude" || t.Program == "codex" }
func (m *Manager) Delegate(v DelegateRequest) (Task, error) {
	return m.delegate(v, "", "", nil)
}
func (m *Manager) delegate(v DelegateRequest, planID, itemID string, issue *linear.WorktreeIssue) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cliPath == "" {
		return Task{}, errors.New("coordination requires the standalone workspace server")
	}
	parent, err := m.terminal(v.ParentID)
	if err != nil {
		return Task{}, err
	}
	if parent.Role == "head" && planID == "" {
		return Task{}, errors.New("head agents propose a plan first; the propose command starts the workers immediately")
	}
	if planID != "" {
		for _, existing := range m.state.Tasks {
			if existing.PlanID == planID && existing.PlanItemID == itemID {
				if existing.LaunchPending {
					terminal, e := m.terminal(existing.AgentID)
					if e != nil {
						return Task{}, e
					}
					if _, e = m.tmux("has-session", "-t", "="+sessionName(terminal.ID)); e != nil {
						if e = m.start(terminal); e != nil {
							return Task{}, e
						}
					}
					existing.LaunchPending = false
					for i := range m.state.Tasks {
						if m.state.Tasks[i].ID == existing.ID {
							m.state.Tasks[i] = existing
						}
					}
					if e = m.save(); e != nil {
						return Task{}, e
					}
				}
				return existing, nil
			}
		}
	}
	if !isAgent(parent) {
		return Task{}, errors.New("choose a Claude or Codex parent agent")
	}
	if v.Program != "claude" && v.Program != "codex" {
		return Task{}, errors.New("choose Claude or Codex for this task")
	}
	if _, err := exec.LookPath(v.Program); err != nil {
		return Task{}, fmt.Errorf("%s is not installed", v.Program)
	}
	v.Title = strings.TrimSpace(v.Title)
	v.Instructions = strings.TrimSpace(v.Instructions)
	if v.Title == "" || len(v.Title) > 160 || v.Instructions == "" || len(v.Instructions) > 12000 {
		return Task{}, errors.New("provide a title (up to 160 characters) and task instructions (up to 12000 characters)")
	}
	parentBranch, err := git(parent.Path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return Task{}, errors.New("check out a branch in the parent before delegating")
	}
	tree, err := m.createWorktreeLocked(parent.ProjectID, v.Name, "HEAD", issue, parent.Path)
	if err != nil {
		return Task{}, err
	}
	now := time.Now().UTC()
	task := Task{LaunchPending: true, PlanID: planID, PlanItemID: itemID, Issue: issue, ParentBranch: parentBranch, ID: id(), ProjectID: parent.ProjectID, ParentID: parent.ID, ParentPath: parent.Path, Path: tree.Path, Title: v.Title, Instructions: v.Instructions, Status: "working", CreatedAt: now, UpdatedAt: now}
	terminal := Terminal{ID: id(), Program: v.Program, ProjectID: parent.ProjectID, Path: tree.Path, Name: v.Title, TaskID: task.ID, CreatedAt: now, Status: "running"}
	task.AgentID = terminal.ID
	oldTasks, oldTerminals := m.state.Tasks, m.state.Terminals
	m.state.Tasks = append(m.state.Tasks, task)
	m.state.Terminals = append(m.state.Terminals, terminal)
	if m.state.AgentTokens == nil {
		m.state.AgentTokens = map[string]string{}
	}
	m.state.AgentTokens[terminal.ID] = id() + id()
	if m.state.AgentTokens[parent.ID] == "" {
		m.state.AgentTokens[parent.ID] = id() + id()
	}
	rollback := func() {
		m.state.Tasks = oldTasks
		m.state.Terminals = oldTerminals
		delete(m.state.AgentTokens, terminal.ID)
		if _, clean := git(parent.Path, "worktree", "remove", "--", tree.Path); clean == nil {
			delete(m.state.WorktreeLinks, tree.Path)
			delete(m.state.WorktreeIssues, tree.Path)
			git(parent.Path, "branch", "-d", "--", v.Name)
		}
		m.save()
	}
	// Publish identity before launching so the first CLI call can authenticate.
	if err := m.save(); err != nil {
		rollback()
		return Task{}, err
	}
	if err := m.start(terminal); err != nil {
		rollback()
		return Task{}, err
	}
	task.LaunchPending = false
	for i := range m.state.Tasks {
		if m.state.Tasks[i].ID == task.ID {
			m.state.Tasks[i] = task
		}
	}
	if err := m.save(); err != nil {
		return Task{}, err
	}
	return task, nil
}
func (m *Manager) taskPrompt(t Task) string {
	return fmt.Sprintf("You are working in an isolated child worktree on task %s: %s\n\n%s\n\nParent agent: %s. Current task status: %s.\nCoordination CLI: %s\nRun the CLI with help to see its commands. Use inbox regularly, send parent <message> to ask questions or report progress, and wait 60 when waiting for a reply. Messages are persistent; acknowledge handled messages with ack <message-id>. Other agents will only receive messages when they check their inbox.\nWork only in this checkout. Commit your changes and run checks before reporting status done <summary including tests>. Do not merge into the parent. If blocked, report status waiting <question> and check for replies. After receiving an answer, acknowledge it and report status working before resuming. If this task is already done or canceled, read task and inbox before acting; do not repeat completed work. You can delegate a smaller task with delegate <branch-name> <claude|codex> <title> <instructions>.\n", t.ID, t.Title, t.Instructions, t.ParentID, t.Status, shellQuote(m.cliPath))
}
func (m *Manager) SendCoordinationMessage(from, to, taskID, text string) (AgentMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 12000 {
		return AgentMessage{}, errors.New("message must contain 1–12000 characters")
	}
	if from != "user" {
		if t, e := m.terminal(from); e != nil || !isAgent(t) {
			return AgentMessage{}, errors.New("sender agent not found")
		}
	}
	if t, e := m.terminal(to); to != "user" && (e != nil || !isAgent(t)) {
		return AgentMessage{}, errors.New("recipient agent not found")
	}
	if taskID != "" {
		if _, err := m.task(taskID); err != nil {
			return AgentMessage{}, err
		}
	}
	msg := AgentMessage{ID: id(), TaskID: taskID, From: from, To: to, Text: text, CreatedAt: time.Now().UTC()}
	old := m.state.Messages
	m.state.Messages = append(m.state.Messages, msg)
	if err := m.save(); err != nil {
		m.state.Messages = old
		return AgentMessage{}, err
	}
	return msg, nil
}
func (m *Manager) Inbox(agent string) []AgentMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := []AgentMessage{}
	for _, msg := range m.state.Messages {
		if msg.To == agent && msg.ReadAt == nil {
			rows = append(rows, msg)
		}
	}
	return rows
}
func (m *Manager) Acknowledge(agent, message string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, msg := range m.state.Messages {
		if msg.ID == message && msg.To == agent {
			now := time.Now().UTC()
			m.state.Messages[i].ReadAt = &now
			if err := m.save(); err != nil {
				m.state.Messages[i] = msg
				return err
			}
			return nil
		}
	}
	return errors.New("message not found in this agent's inbox")
}
func (m *Manager) UpdateTask(actor, taskID, status, summary string) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, err := m.task(taskID)
	if err != nil {
		return Task{}, err
	}
	if actor != "user" && actor != task.AgentID {
		return Task{}, errors.New("only the assigned agent can report task status")
	}
	if task.IntegratedCommit != "" {
		return Task{}, errors.New("integrated tasks cannot change status")
	}
	if status != "working" && status != "waiting" && status != "done" && status != "canceled" {
		return Task{}, errors.New("choose working, waiting, done, or canceled")
	}
	summary = strings.TrimSpace(summary)
	if len(summary) > 12000 || ((status == "waiting" || status == "done") && summary == "") {
		return Task{}, errors.New("include a question or completion summary")
	}
	task.Status = status
	task.Summary = summary
	task.ResultCommit = ""
	task.UpdatedAt = time.Now().UTC()
	if status == "done" {
		clean, err := git(task.Path, "status", "--porcelain")
		if err != nil {
			return Task{}, err
		}
		if clean != "" {
			return Task{}, errors.New("commit or remove outstanding changes before marking this task done")
		}
		task.ResultCommit, err = git(task.Path, "rev-parse", "HEAD")
		if err != nil {
			return Task{}, err
		}
	}
	previousMessages := m.state.Messages
	for i, old := range m.state.Tasks {
		if old.ID == taskID {
			m.state.Tasks[i] = task
			m.state.Messages = append(m.state.Messages, AgentMessage{ID: id(), TaskID: taskID, From: actor, To: task.ParentID, Text: fmt.Sprintf("%s: %s\n%s", task.Title, status, summary), CreatedAt: task.UpdatedAt})
			if err := m.save(); err != nil {
				m.state.Tasks[i] = old
				m.state.Messages = previousMessages
				return Task{}, err
			}
			break
		}
	}
	return task, nil
}
func (m *Manager) ReviewTask(taskID string) (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, err := m.task(taskID)
	if err != nil {
		return nil, err
	}
	if task.Status != "done" || task.ResultCommit == "" {
		return nil, errors.New("mark the task done before reviewing its committed changes")
	}
	parentCommit, err := git(task.ParentPath, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	diff, err := git(task.ParentPath, "diff", "--no-ext-diff", "--no-textconv", parentCommit+"..."+task.ResultCommit, "--")
	if err != nil {
		return nil, err
	}
	if len(diff) > 200000 {
		diff = diff[:200000] + "\n[Preview truncated. Review the full diff in your terminal.]"
	}
	return map[string]string{"diff": diff, "commit": task.ResultCommit, "summary": task.Summary, "parentCommit": parentCommit}, nil
}
func (m *Manager) IntegrateTask(taskID, expectedCommit, expectedParent string) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, err := m.task(taskID)
	if err != nil {
		return Task{}, err
	}
	if task.Status != "done" || task.ResultCommit == "" || expectedCommit != task.ResultCommit {
		return Task{}, errors.New("review the task's current result before integrating")
	}
	if task.IntegratedCommit != "" {
		return task, nil
	}
	branch, err := git(task.ParentPath, "symbolic-ref", "--short", "HEAD")
	if err != nil || branch != task.ParentBranch {
		return Task{}, errors.New("restore the original parent branch before integrating")
	}
	head, err := git(task.ParentPath, "rev-parse", "HEAD")
	if err != nil {
		return Task{}, err
	}
	if head != expectedParent {
		return Task{}, errors.New("the parent changed; review the task again before integrating")
	}
	clean, err := git(task.ParentPath, "status", "--porcelain")
	if err != nil {
		return Task{}, err
	}
	if clean != "" {
		return Task{}, errors.New("commit or stash changes in the parent checkout before integrating")
	}
	// Do not disturb an existing merge/rebase, even if its index happens to be clean.
	for _, name := range []string{"MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"} {
		path, e := git(task.ParentPath, "rev-parse", "--git-path", name)
		if e != nil {
			return Task{}, e
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(task.ParentPath, path)
		}
		if _, e = os.Stat(path); e == nil {
			return Task{}, errors.New("finish the parent's existing Git operation first")
		}
	}
	if _, err = git(task.ParentPath, "merge", "--no-edit", "--no-ff", task.ResultCommit); err != nil {
		if _, abort := git(task.ParentPath, "merge", "--abort"); abort != nil {
			return Task{}, fmt.Errorf("integration failed: %v; check the parent checkout before continuing", err)
		}
		return Task{}, fmt.Errorf("integration conflicted and was rolled back: %w", err)
	}
	commit, err := git(task.ParentPath, "rev-parse", "HEAD")
	if err != nil {
		return Task{}, err
	}
	task.IntegratedCommit = commit
	task.UpdatedAt = time.Now().UTC()
	for i, old := range m.state.Tasks {
		if old.ID == taskID {
			m.state.Tasks[i] = task
			if err := m.save(); err != nil {
				m.state.Tasks[i] = old
				return Task{}, fmt.Errorf("Git integrated commit %s, but saving task status failed: %w", commit, err)
			}
			break
		}
	}
	return task, nil
}
