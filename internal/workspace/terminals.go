package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func sessionName(id string) string { return "cw-" + id }
func (m *Manager) Terminal(id string) (Terminal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.terminal(id)
}
func (m *Manager) terminal(id string) (Terminal, error) {
	for _, t := range m.state.Terminals {
		if t.ID == id {
			return t, nil
		}
	}
	return Terminal{}, errors.New("terminal not found")
}
func (m *Manager) start(t Terminal) error {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	if !filepath.IsAbs(shell) {
		return errors.New("SHELL must be an absolute executable path")
	}
	name := sessionName(t.ID)
	args := []string{"new-session", "-d", "-s", name, "-c", t.Path, "-x", "100", "-y", "30"}
	// The app may be launched by a non-interactive tool with NO_COLOR/CI set.
	// Reset those inherited hints inside the persistent tmux server too, before
	// exec'ing the real program. Keep tmux's TERM (its virtual terminal type).
	args = append(args, "/usr/bin/env", "-u", "NO_COLOR", "-u", "FORCE_COLOR", "-u", "CLICOLOR", "-u", "CLICOLOR_FORCE", "-u", "CI", "COLORTERM=truecolor")
	if m.cliPath != "" && (t.Program == "claude" || t.Program == "codex") {
		// Set these on the executed process too: tmux can supply its own PATH.
		args = append(args, "BURROW_AGENT_ID="+t.ID, "BURROW_CLI="+m.cliPath, "PATH="+filepath.Dir(m.cliPath)+":"+os.Getenv("PATH"))
	}
	if t.Program == "claude" {
		binary, err := exec.LookPath("claude")
		if err != nil {
			return errors.New("Claude Code is not installed. Install it, then try Start Claude again")
		}
		// Multiple command arguments make tmux exec Claude directly. Exiting Claude
		// leaves an exited pane, never a shell that could interpret a chat message.
		args = append(args, binary, "--dangerously-skip-permissions", "--name", t.Name)
	} else if t.Program == "codex" {
		binary, err := exec.LookPath("codex")
		if err != nil {
			return errors.New("Codex is not installed. Install the Codex CLI, then try Start Codex again")
		}
		args = append(args, binary, "--dangerously-bypass-approvals-and-sandbox")
	} else {
		args = append(args, shell)
	}
	if t.Role == "head" {
		// Keep coordination mechanics out of the visible opening user message.
		if t.Program == "claude" {
			args = append(args, "--append-system-prompt", m.headPrompt(t))
		} else {
			instructions, _ := json.Marshal(m.headPrompt(t))
			args = append(args, "--config", "developer_instructions="+string(instructions))
		}
		args = append(args, "--", t.Goal)
	} else if t.TaskID != "" && (t.Program == "claude" || t.Program == "codex") {
		if task, err := m.task(t.TaskID); err == nil {
			args = append(args, m.taskPrompt(task))
		}
	}
	if _, err := m.tmux(args...); err != nil {
		return err
	}
	for _, option := range [][]string{{"set-option", "-t", name, "status", "off"}, {"set-option", "-t", name, "remain-on-exit", "on"}, {"set-option", "-t", name, "history-limit", "20000"}, {"set-option", "-t", name, "mouse", "on"}, {"set-option", "-t", name, "window-size", "latest"}} {
		if _, err := m.tmux(option...); err != nil {
			m.tmux("kill-session", "-t", "="+name)
			return err
		}
	}
	return nil
}
func (m *Manager) CreateTerminal(projectID, path, name string) (Terminal, error) {
	return m.CreateProgramTerminal(projectID, path, name, "")
}
func (m *Manager) CreateProgramTerminal(projectID, path, name, program string) (Terminal, error) {
	return m.createProgramTerminal(projectID, path, name, program, "", "")
}
func (m *Manager) createProgramTerminal(projectID, path, name, program, role, goal string) (Terminal, error) {
	if program != "" && program != "shell" && program != "claude" && program != "codex" {
		return Terminal{}, errors.New("choose Claude Code, Codex, or Shell")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if role == "head" && m.cliPath == "" {
		return Terminal{}, errors.New("head agents require the standalone workspace server")
	}
	p, err := m.project(projectID)
	if err != nil {
		return Terminal{}, err
	}
	if role == "head" {
		if err = requireGitCheckout(p.Path); err != nil {
			return Terminal{}, err
		}
	}
	if path == "" {
		path = p.Path
	}
	path, err = canonical(path)
	if err != nil {
		return Terminal{}, err
	}
	if info, e := os.Stat(path); e != nil || !info.IsDir() {
		return Terminal{}, errors.New("choose an existing folder for the agent")
	}
	trees, _, err := projectCheckouts(p.Path)
	if err != nil {
		return Terminal{}, err
	}
	found := false
	for _, w := range trees {
		if w.Path == path || (role != "head" && folderWithin(path, w.Path)) {
			found = true
		}
	}
	if !found {
		return Terminal{}, errors.New("terminal folder must be inside the project or one of its worktrees")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Terminal"
	}
	t := Terminal{Role: role, Goal: goal, Program: program, ID: id(), ProjectID: projectID, Path: path, Name: name, CreatedAt: time.Now().UTC(), Status: "running"}
	if isAgent(t) {
		if m.state.AgentTokens == nil {
			m.state.AgentTokens = map[string]string{}
		}
		m.state.AgentTokens[t.ID] = id() + id()
	}
	// Publish identity before launch: a head's first CLI call can be immediate.
	m.state.Terminals = append(m.state.Terminals, t)
	if err = m.save(); err != nil {
		m.state.Terminals = m.state.Terminals[:len(m.state.Terminals)-1]
		delete(m.state.AgentTokens, t.ID)
		return Terminal{}, err
	}
	if err = m.start(t); err != nil {
		m.state.Terminals = m.state.Terminals[:len(m.state.Terminals)-1]
		delete(m.state.AgentTokens, t.ID)
		m.save()
		return Terminal{}, err
	}
	return t, nil
}
func (m *Manager) UpdateTerminal(id, action, name string) error {
	if action == "remove" {
		m.planMu.Lock()
		defer m.planMu.Unlock()
	}
	return m.updateTerminal(id, action, name)
}
func (m *Manager) updateTerminal(id, action, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, err := m.terminal(id)
	if err != nil {
		return err
	}
	switch action {
	case "stop":
		if _, err = m.tmux("has-session", "-t", "="+sessionName(id)); err != nil {
			return nil
		}
		_, err = m.tmux("kill-session", "-t", "="+sessionName(id))
		return err
	case "restart":
		if _, err = m.tmux("has-session", "-t", "="+sessionName(id)); err == nil {
			dead, checkErr := m.tmux("display-message", "-p", "-t", "="+sessionName(id)+":", "#{pane_dead}")
			if checkErr != nil || dead != "1" {
				return errors.New("stop the existing terminal before starting a new shell")
			}
			if _, err = m.tmux("kill-session", "-t", "="+sessionName(id)); err != nil {
				return err
			}
		}
		return m.start(t)
	case "rename":
		name = strings.TrimSpace(name)
		if name == "" {
			return errors.New("terminal name cannot be empty")
		}
	case "remove":
		if _, err = m.tmux("has-session", "-t", "="+sessionName(id)); err == nil {
			if _, err = m.tmux("kill-session", "-t", "="+sessionName(id)); err != nil {
				return err
			}
		}
	default:
		return errors.New("unknown terminal action")
	}
	prev := m.state.Terminals
	oldPlans, oldTasks := clonePlans(m.state.Plans), append([]Task{}, m.state.Tasks...)
	if action == "remove" {
		for i := range m.state.Tasks {
			task := &m.state.Tasks[i]
			if task.AgentID == id {
				task.LaunchPending = false
				if task.Status != "done" {
					task.Status = "canceled"
				}
				for j := range m.state.Plans {
					for k := range m.state.Plans[j].Items {
						item := &m.state.Plans[j].Items[k]
						if m.state.Plans[j].ID == task.PlanID && item.ID == task.PlanItemID {
							item.Canceled = true
							item.Error = ""
						}
					}
				}
			}
		}
		for i := range m.state.Plans {
			if m.state.Plans[i].HeadID == id {
				m.state.Plans[i].Status = "canceled"
			}
			settleRemovedAssignments(&m.state.Plans[i])
		}
	}
	m.state.Terminals = []Terminal{}
	for _, item := range prev {
		if action == "remove" && item.HeadID == id {
			item.HeadID = ""
		}
		if item.ID == id {
			if action == "remove" {
				continue
			}
			item.Name = name
		}
		m.state.Terminals = append(m.state.Terminals, item)
	}
	if err = m.save(); err != nil {
		m.state.Terminals = prev
		m.state.Plans, m.state.Tasks = oldPlans, oldTasks
		return err
	}
	if action == "remove" {
		m.conversations.Delete(id)
	}
	return nil
}
