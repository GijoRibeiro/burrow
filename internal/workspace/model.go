// Package workspace owns projects and terminals independently of agent discovery.
// tmux owns the processes; the app owns their metadata and attaches disposable PTYs.
package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gijo/cloovies/internal/linear"
)

type Project struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	Worktrees []Worktree `json:"worktrees"`
	Error     string     `json:"error,omitempty"`
}
type Worktree struct {
	ParentPath string                `json:"parentPath,omitempty"`
	BaseCommit string                `json:"baseCommit,omitempty"`
	Issue      *linear.WorktreeIssue `json:"issue,omitempty"`
	Path       string                `json:"path"`
	Name       string                `json:"name"`
	Branch     string                `json:"branch"`
	Main       bool                  `json:"main"`
}
type Terminal struct {
	HeadID    string    `json:"headId,omitempty"`
	Role      string    `json:"role,omitempty"`
	Goal      string    `json:"goal,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
	Program   string    `json:"program,omitempty"`
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	Status    string    `json:"status"`
}
type State struct {
	Plans          []TeamPlan                      `json:"plans,omitempty"`
	WorktreeLinks  map[string]WorktreeLink         `json:"worktreeLinks,omitempty"`
	Tasks          []Task                          `json:"tasks,omitempty"`
	Messages       []AgentMessage                  `json:"messages,omitempty"`
	AgentTokens    map[string]string               `json:"agentTokens,omitempty"`
	WorktreeIssues map[string]linear.WorktreeIssue `json:"worktreeIssues,omitempty"`
	Version        int                             `json:"version"`
	Projects       []Project                       `json:"projects"`
	Terminals      []Terminal                      `json:"terminals"`
	TmuxAvailable  bool                            `json:"tmuxAvailable"`
}
type Manager struct {
	planMu     sync.Mutex
	runtimeURL string
	cliPath    string
	mu         sync.Mutex
	file       string
	socket     string
	state      State
}

func New(file, socket string) (*Manager, error) {
	m := &Manager{file: file, socket: socket, state: State{Version: 1, Projects: []Project{}, Terminals: []Terminal{}}}
	b, err := os.ReadFile(file)
	if err == nil {
		if err = json.Unmarshal(b, &m.state); err != nil {
			return nil, fmt.Errorf("read workspace: %w", err)
		}
		if m.state.Version != 1 {
			return nil, errors.New("unsupported workspace version")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if m.state.Projects == nil {
		m.state.Projects = []Project{}
	}
	if m.state.Terminals == nil {
		m.state.Terminals = []Terminal{}
	}
	return m, nil
}
func NewDefault() (*Manager, error) {
	dir := os.Getenv("CLOOVIES_WORKSPACE_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".cloovies")
	}
	socket := os.Getenv("CLOOVIES_TMUX_SOCKET")
	if socket == "" {
		socket = "cloovies-workspace"
	}
	return New(filepath.Join(dir, "workspace.json"), socket)
}
func id() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func command(dir, bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return commandContext(ctx, dir, bin, args...)
}
func commandContext(ctx context.Context, dir, bin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	// Bound inherited pipes too: a descendant may keep stdout open after Git exits.
	cmd.WaitDelay = time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("%s %s timed out in %q: %w", bin, strings.Join(args, " "), dir, ctx.Err())
		}
		return "", fmt.Errorf("%s: %s (%w)", bin, strings.TrimSpace(string(out)), err)
	}
	return strings.TrimSpace(string(out)), nil
}
func git(dir string, args ...string) (string, error) {
	return command(dir, "git", append([]string{"-c", "core.fsmonitor=false"}, args...)...)
}
func (m *Manager) tmux(args ...string) (string, error) {
	return command("", "tmux", append([]string{"-L", m.socket, "-f", "/dev/null"}, args...)...)
}
func canonical(path string) (string, error) {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, path[2:])
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// save is atomic; callers restore in-memory state on failure.
func (m *Manager) save() error {
	if err := os.MkdirAll(filepath.Dir(m.file), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(m.file), ".workspace-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), m.file)
}
func (m *Manager) project(id string) (Project, error) {
	for _, p := range m.state.Projects {
		if p.ID == id {
			return p, nil
		}
	}
	return Project{}, errors.New("project not found")
}
func (m *Manager) Snapshot() State {
	m.mu.Lock()
	s := m.state
	s.Plans = clonePlans(m.state.Plans)
	s.AgentTokens = nil
	s.Messages = nil
	s.Tasks = append([]Task(nil), m.state.Tasks...)
	s.WorktreeLinks = make(map[string]WorktreeLink, len(m.state.WorktreeLinks))
	for path, link := range m.state.WorktreeLinks {
		s.WorktreeLinks[path] = link
	}
	s.Projects = append([]Project{}, s.Projects...)
	s.Terminals = append([]Terminal{}, s.Terminals...)
	s.WorktreeIssues = make(map[string]linear.WorktreeIssue, len(m.state.WorktreeIssues))
	for path, issue := range m.state.WorktreeIssues {
		s.WorktreeIssues[path] = issue
	}
	m.mu.Unlock()
	_, err := exec.LookPath("tmux")
	s.TmuxAvailable = err == nil
	live := map[string]string{}
	if s.TmuxAvailable {
		out, _ := m.tmux("list-panes", "-a", "-F", "#{session_name} #{pane_dead}")
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) == 2 {
				live[f[0]] = f[1]
			}
		}
	}
	for i := range s.Terminals {
		t := &s.Terminals[i]
		t.Status = "stopped"
		if dead, ok := live[sessionName(t.ID)]; ok {
			t.Status = "running"
			if dead == "1" {
				t.Status = "exited"
			}
		}
	}
	for i := range s.Projects {
		p := &s.Projects[i]
		p.Worktrees, err = listWorktrees(p.Path)
		for j := range p.Worktrees {
			link := s.WorktreeLinks[p.Worktrees[j].Path]
			p.Worktrees[j].ParentPath = link.ParentPath
			p.Worktrees[j].BaseCommit = link.BaseCommit
			if issue, ok := s.WorktreeIssues[p.Worktrees[j].Path]; ok {
				copy := issue
				p.Worktrees[j].Issue = &copy
			}
		}
		if err != nil {
			p.Error = err.Error()
			p.Worktrees = []Worktree{}
		}
	}
	return s
}
func (m *Manager) AddProject(path, name string) (Project, error) {
	if strings.TrimSpace(path) == "" {
		return Project{}, errors.New("enter a project folder")
	}
	p, err := canonical(path)
	if err != nil {
		return Project{}, err
	}
	root, err := git(p, "rev-parse", "--show-toplevel")
	if err != nil {
		return Project{}, fmt.Errorf("could not open project folder %q: %w", p, err)
	}
	// Git lists the primary checkout first. This also handles submodules and
	// repositories whose Git directory lives outside the checkout.
	trees, err := listWorktrees(root)
	if err != nil {
		return Project{}, err
	}
	if len(trees) == 0 {
		return Project{}, errors.New("repository has no working checkout")
	}
	root, err = canonical(trees[0].Path)
	if err != nil {
		return Project{}, err
	}
	for i := range trees {
		trees[i].Main = trees[i].Path == root
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.state.Projects {
		if p.Path == root {
			p.Worktrees = trees
			return p, nil
		}
	}
	if name = strings.TrimSpace(name); name == "" {
		name = filepath.Base(root)
	}
	p2 := Project{ID: id(), Name: name, Path: root, Worktrees: trees}
	m.state.Projects = append(m.state.Projects, p2)
	if err = m.save(); err != nil {
		m.state.Projects = m.state.Projects[:len(m.state.Projects)-1]
		return Project{}, err
	}
	return p2, nil
}
func listWorktrees(root string) ([]Worktree, error) {
	out, err := git(root, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	result := []Worktree{}
	var cur *Worktree
	for _, field := range strings.Split(out, "\x00") {
		if strings.HasPrefix(field, "worktree ") {
			p := strings.TrimPrefix(field, "worktree ")
			result = append(result, Worktree{Path: p, Name: filepath.Base(p), Main: p == root})
			cur = &result[len(result)-1]
		}
		if cur != nil && strings.HasPrefix(field, "branch ") {
			cur.Branch = strings.TrimPrefix(field, "branch refs/heads/")
		}
	}
	return result, nil
}
func (m *Manager) CreateWorktree(projectID, name, base string) (Worktree, error) {
	return m.createWorktree(projectID, name, base, nil)
}
func (m *Manager) createWorktree(projectID, name, base string, issue *linear.WorktreeIssue, parent ...string) (Worktree, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	parentPath := ""
	if len(parent) > 0 {
		parentPath = parent[0]
	}
	return m.createWorktreeLocked(projectID, name, base, issue, parentPath)
}
func (m *Manager) createWorktreeLocked(projectID, name, base string, issue *linear.WorktreeIssue, parentPath string) (Worktree, error) {
	p, err := m.project(projectID)
	if err != nil {
		return Worktree{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "-") || strings.ContainsAny(name, "/\\ \t\r\n") {
		return Worktree{}, errors.New("use a worktree name without spaces, slashes, or a leading dot or dash")
	}
	if _, err = git(p.Path, "check-ref-format", "--branch", name); err != nil {
		return Worktree{}, errors.New("invalid branch name")
	}
	if base = strings.TrimSpace(base); base == "" {
		base = "HEAD"
	}
	// A child starts at its parent's committed HEAD, independently of the root checkout.
	resolvePath := p.Path
	if parentPath != "" {
		parentPath, err = canonical(parentPath)
		if err != nil {
			return Worktree{}, err
		}
		trees, e := listWorktrees(p.Path)
		if e != nil {
			return Worktree{}, e
		}
		found := false
		for _, tree := range trees {
			if tree.Path == parentPath {
				found = true
			}
		}
		if !found {
			return Worktree{}, errors.New("parent must be a checkout of this project")
		}
		resolvePath = parentPath
		base = "HEAD"
	}
	// Resolve to an object ID, so user input can never become a Git option.
	commit, err := git(resolvePath, "rev-parse", "--verify", "--end-of-options", base+"^{commit}")
	if err != nil {
		return Worktree{}, fmt.Errorf("base branch does not resolve to a commit: %w", err)
	}
	// Keep managed checkouts out of the parent's untracked files without
	// changing the project's committed .gitignore.
	excludePath, err := git(p.Path, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return Worktree{}, err
	}
	if !filepath.IsAbs(excludePath) {
		excludePath = filepath.Join(p.Path, excludePath)
	}
	existing, err := os.ReadFile(excludePath)
	if err != nil && !os.IsNotExist(err) {
		return Worktree{}, err
	}
	if !strings.Contains("\n"+string(existing), "\n/.worktrees/\n") {
		if err := os.MkdirAll(filepath.Dir(excludePath), 0755); err != nil {
			return Worktree{}, err
		}
		f, err := os.OpenFile(excludePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			return Worktree{}, err
		}
		_, writeErr := f.WriteString("\n# Cloovies local worktrees\n/.worktrees/\n")
		closeErr := f.Close()
		if writeErr != nil {
			return Worktree{}, writeErr
		}
		if closeErr != nil {
			return Worktree{}, closeErr
		}
	}
	path := filepath.Join(p.Path, ".worktrees", name)
	if _, err = git(p.Path, "worktree", "add", "-b", name, "--", path, commit); err != nil {
		return Worktree{}, err
	}
	previousLink, linked := m.state.WorktreeLinks[path]
	if m.state.WorktreeLinks == nil {
		m.state.WorktreeLinks = map[string]WorktreeLink{}
	}
	if parentPath != "" {
		m.state.WorktreeLinks[path] = WorktreeLink{ParentPath: parentPath, BaseCommit: commit}
	} else {
		delete(m.state.WorktreeLinks, path)
	}
	if parentPath != "" || linked || issue != nil || m.state.WorktreeIssues[path].ID != "" {
		if m.state.WorktreeIssues == nil {
			m.state.WorktreeIssues = map[string]linear.WorktreeIssue{}
		}
		previous, existed := m.state.WorktreeIssues[path]
		if issue != nil {
			m.state.WorktreeIssues[path] = *issue
		} else {
			delete(m.state.WorktreeIssues, path)
		}
		if err := m.save(); err != nil {
			if linked {
				m.state.WorktreeLinks[path] = previousLink
			} else {
				delete(m.state.WorktreeLinks, path)
			}
			if existed {
				m.state.WorktreeIssues[path] = previous
			} else {
				delete(m.state.WorktreeIssues, path)
			}
			// Roll back only the fresh checkout if Git confirms it is still clean.
			if _, cleanup := git(p.Path, "worktree", "remove", "--", path); cleanup == nil {
				git(p.Path, "branch", "-d", "--", name)
			}
			return Worktree{}, fmt.Errorf("could not save worktree metadata: %w", err)
		}
	}
	return Worktree{Path: path, Name: name, Branch: name, Issue: issue, ParentPath: parentPath, BaseCommit: commit}, nil
}
func (m *Manager) RemoveWorktree(projectID, path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := m.project(projectID)
	if err != nil {
		return err
	}
	path, err = canonical(path)
	if err != nil {
		return err
	}
	trees, err := listWorktrees(p.Path)
	if err != nil {
		return err
	}
	found := false
	for _, w := range trees {
		if m.state.WorktreeLinks[w.Path].ParentPath == path {
			return errors.New("remove child worktrees before removing their parent")
		}
		if w.Path == path && !w.Main {
			found = true
		}
	}
	if !found {
		return errors.New("only a linked worktree can be removed")
	}
	for _, t := range m.state.Terminals {
		if t.Path == path {
			if _, err = m.tmux("has-session", "-t", "="+sessionName(t.ID)); err == nil {
				return errors.New("stop this worktree's terminals before removing it")
			}
		}
	}
	_, err = git(p.Path, "worktree", "remove", "--", path)
	if err == nil {
		delete(m.state.WorktreeIssues, path)
		delete(m.state.WorktreeLinks, path)
		err = m.save()
	}
	return err
}
func (m *Manager) RemoveProject(projectID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.project(projectID); err != nil {
		return err
	}
	for _, t := range m.state.Terminals {
		if t.ProjectID == projectID {
			return errors.New("remove the project's terminal sessions first")
		}
	}
	prev := m.state.Projects
	m.state.Projects = []Project{}
	for _, p := range prev {
		if p.ID != projectID {
			m.state.Projects = append(m.state.Projects, p)
		}
	}
	if err := m.save(); err != nil {
		m.state.Projects = prev
		return err
	}
	return nil
}
