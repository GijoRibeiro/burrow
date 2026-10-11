package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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
// tmux server options apply to every window created afterwards, so they must
// be set before the first session exists. With no config file tmux keeps only
// 2000 lines of history and captures Ctrl-B as its prefix; agents and editors
// need both back. Idempotent: the server keeps the values once set.
var tmuxServerOptions = [][]string{
	// A server with no sessions exits at once and forgets its options; keep it.
	{"set-option", "-g", "exit-empty", "off"},
	{"set-option", "-g", "history-limit", "20000"},
	{"set-option", "-g", "prefix", "None"},
	{"set-option", "-g", "prefix2", "None"},
	{"set-option", "-gs", "escape-time", "10"},
	{"set-option", "-g", "status", "off"},
	{"set-option", "-g", "mouse", "on"},
	{"set-option", "-g", "focus-events", "on"},
	{"set-option", "-g", "remain-on-exit", "on"},
	{"set-option", "-g", "window-size", "latest"},
}

func (m *Manager) prepareTmuxServer() error {
	args := []string{"start-server"}
	for _, option := range tmuxServerOptions {
		args = append(args, ";")
		args = append(args, option...)
	}
	_, err := m.tmux(args...)
	return err
}

// launchArgs builds the tmux new-session argument list for a terminal. It
// reads workspace state and must be called with m.mu held; the actual process
// launch happens in launch, outside the lock.
func (m *Manager) launchArgs(t Terminal) ([]string, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	if !filepath.IsAbs(shell) {
		return nil, errors.New("SHELL must be an absolute executable path")
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
	resume := t.SessionID != "" && m.sessionResumable(t)
	switch t.Program {
	case "claude":
		binary, err := exec.LookPath("claude")
		if err != nil {
			return nil, errors.New("Claude Code is not installed. Install it, then try Start Claude again")
		}
		// Multiple command arguments make tmux exec Claude directly. Exiting Claude
		// leaves an exited pane, never a shell that could interpret a chat message.
		args = append(args, binary, "--dangerously-skip-permissions", "--name", t.Name)
		if resume {
			args = append(args, "--resume", t.SessionID)
		}
	case "codex":
		binary, err := exec.LookPath("codex")
		if err != nil {
			return nil, errors.New("Codex is not installed. Install the Codex CLI, then try Start Codex again")
		}
		args = append(args, binary)
		if resume {
			args = append(args, "resume", t.SessionID)
		}
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	default:
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
		// A resumed head already has its goal in the conversation.
		if !resume {
			args = append(args, "--", t.Goal)
		}
	} else if !resume && t.TaskID != "" && (t.Program == "claude" || t.Program == "codex") {
		if task, err := m.task(t.TaskID); err == nil {
			args = append(args, m.taskPrompt(task))
		}
	}
	return args, nil
}

// sessionResumable reports whether the recorded conversation still exists on
// disk. Resuming a deleted transcript would make the CLI exit immediately.
func (m *Manager) sessionResumable(t Terminal) bool {
	switch t.Program {
	case "claude":
		if !sessionIDPattern.MatchString(t.SessionID) {
			return false
		}
		config := os.Getenv("CLAUDE_CONFIG_DIR")
		if config == "" {
			home, _ := os.UserHomeDir()
			config = filepath.Join(home, ".claude")
		}
		_, err := os.Stat(transcriptPath(config, t.Path, t.SessionID))
		return err == nil
	case "codex":
		return codexThreadID.MatchString(t.SessionID)
	}
	return false
}

// launch starts the tmux session. It runs without m.mu so a slow program
// start never blocks snapshots or other terminals.
func (m *Manager) launch(id string, args []string) error {
	if err := m.prepareTmuxServer(); err != nil {
		return err
	}
	if _, err := m.tmux(args...); err != nil {
		return err
	}
	name := sessionName(id)
	for _, option := range [][]string{{"set-option", "-t", name, "status", "off"}, {"set-option", "-t", name, "remain-on-exit", "on"}} {
		if _, err := m.tmux(option...); err != nil {
			m.tmux("kill-session", "-t", "="+name)
			return err
		}
	}
	return nil
}

// start is the locked convenience used by team launches: it prepares the
// argument list under m.mu and launches immediately. Prefer launchArgs+launch
// with the lock released for user-facing paths.
func (m *Manager) start(t Terminal) error {
	args, err := m.launchArgs(t)
	if err != nil {
		return err
	}
	return m.launch(t.ID, args)
}
func (m *Manager) lifecycleLock(id string) *sync.Mutex {
	lock, _ := m.lifecycle.LoadOrStore(id, &sync.Mutex{})
	return lock.(*sync.Mutex)
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
	if role == "head" && m.cliPath == "" {
		return Terminal{}, errors.New("head agents require the standalone workspace server")
	}
	// Git discovery can be slow on large or remote checkouts; keep it out of the lock.
	p, err := m.Project(projectID)
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
	m.mu.Lock()
	if _, err = m.project(projectID); err != nil {
		m.mu.Unlock()
		return Terminal{}, err
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
		m.mu.Unlock()
		return Terminal{}, err
	}
	args, err := m.launchArgs(t)
	m.mu.Unlock()
	if err == nil {
		err = m.launch(t.ID, args)
	}
	if err != nil {
		m.mu.Lock()
		m.removeTerminalRecord(t.ID)
		delete(m.state.AgentTokens, t.ID)
		m.save()
		m.mu.Unlock()
		return Terminal{}, err
	}
	return t, nil
}

// Project returns a copy of a stored project without touching Git.
func (m *Manager) Project(id string) (Project, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.project(id)
}
func (m *Manager) removeTerminalRecord(id string) {
	kept := m.state.Terminals[:0]
	for _, item := range m.state.Terminals {
		if item.ID != id {
			kept = append(kept, item)
		}
	}
	m.state.Terminals = kept
}
func (m *Manager) UpdateTerminal(id, action, name string) error {
	if action == "remove" {
		m.planMu.Lock()
		defer m.planMu.Unlock()
	}
	// Process lifecycle runs outside m.mu so one slow launch never freezes the
	// workspace; per-terminal serialization keeps stop/start ordered.
	lock := m.lifecycleLock(id)
	lock.Lock()
	defer lock.Unlock()
	switch action {
	case "stop":
		if _, err := m.Terminal(id); err != nil {
			return err
		}
		if _, err := m.tmux("has-session", "-t", "="+sessionName(id)); err != nil {
			return nil
		}
		_, err := m.tmux("kill-session", "-t", "="+sessionName(id))
		return err
	case "restart":
		m.mu.Lock()
		t, err := m.terminal(id)
		var args []string
		if err == nil {
			args, err = m.launchArgs(t)
		}
		m.mu.Unlock()
		if err != nil {
			return err
		}
		if _, err = m.tmux("has-session", "-t", "="+sessionName(id)); err == nil {
			dead, checkErr := m.tmux("display-message", "-p", "-t", "="+sessionName(id)+":", "#{pane_dead}")
			if checkErr != nil || dead != "1" {
				return errors.New("stop the existing terminal before starting a new shell")
			}
			if _, err = m.tmux("kill-session", "-t", "="+sessionName(id)); err != nil {
				return err
			}
		}
		return m.launch(id, args)
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
	_ = t
	switch action {
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
