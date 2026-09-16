package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFolderProjectsRunAgentsAndBecomeGitProjects(t *testing.T) {
	m, _, _ := coordinationManager(t) // Local Claude/Codex fixtures, never real providers.
	root, err := canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "notes.txt")
	if err = os.WriteFile(file, []byte("Keep this file"), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := m.AddProject(root, "Plain folder")
	if err != nil || p.Git || len(p.Worktrees) != 1 || p.Worktrees[0].Path != root || !p.Worktrees[0].Main {
		t.Fatalf("folder: %+v %v", p, err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err = os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	again, err := m.AddProject(alias, "")
	if err != nil || again.ID != p.ID {
		t.Fatal("duplicate folder", again, err)
	}
	pids := map[string]string{}
	for _, program := range []string{"shell", "claude", "codex"} {
		term, e := m.CreateProgramTerminal(p.ID, root, program, program)
		if e != nil {
			t.Fatal(program, e)
		}
		pid, e := m.tmux("display-message", "-p", "-t", "="+sessionName(term.ID)+":", "#{pane_pid}")
		if e != nil {
			t.Fatal(e)
		}
		pids[term.ID] = pid
		cwd, e := m.tmux("display-message", "-p", "-t", "="+sessionName(term.ID)+":", "#{pane_current_path}")
		if e != nil || cwd != root {
			t.Fatal("wrong working folder", cwd, e)
		}
	}
	if _, err = m.CreateTerminal(p.ID, t.TempDir(), "Outside"); err == nil {
		t.Fatal("unrelated folder allowed")
	}
	if _, err = m.CreateWorktree(p.ID, "child", "HEAD"); err == nil || !strings.Contains(err.Error(), "require Git") {
		t.Fatal("unclear worktree error", err)
	}
	if _, err = m.CreateHead(p.ID, root, "Head", "claude", "Create a team"); err == nil || !strings.Contains(err.Error(), "require Git") {
		t.Fatal("unclear head error", err)
	}
	if _, err = os.Stat(filepath.Join(root, ".git")); !os.IsNotExist(err) {
		t.Fatal("opening folder initialized Git", err)
	}
	if data, _ := os.ReadFile(file); string(data) != "Keep this file" {
		t.Fatal("changed user file")
	}
	loaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := loaded.Snapshot()
	for _, project := range snapshot.Projects {
		if project.ID == p.ID && (project.Git || project.Error != "" || len(project.Worktrees) != 1) {
			t.Fatal(project)
		}
	}
	// User initializes Git later; the next snapshot discovers it with the same ID.
	for _, args := range [][]string{{"init", "-b", "main"}, {"-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "Initial"}} {
		if _, err = git(root, args...); err != nil {
			t.Fatal(err)
		}
	}
	snapshot = loaded.Snapshot()
	for _, project := range snapshot.Projects {
		if project.ID == p.ID && (!project.Git || project.Error != "") {
			t.Fatal("Git not discovered", project)
		}
	}
	if _, err = loaded.CreateWorktree(p.ID, "later", "HEAD"); err != nil {
		t.Fatal(err)
	}
	for id, pid := range pids {
		current, e := loaded.tmux("display-message", "-p", "-t", "="+sessionName(id)+":", "#{pane_pid}")
		if e != nil || current != pid {
			t.Fatal("conversion replaced a session", e)
		}
	}
}

func TestPlainFolderDoesNotRequireGitAndInvalidRepositoriesStayErrors(t *testing.T) {
	m := manager(t)
	root := t.TempDir()
	t.Setenv("PATH", t.TempDir())
	p, err := m.AddProject(root, "")
	if err != nil || p.Git {
		t.Fatal("plain folder requires Git", p, err)
	}
	if s := m.Snapshot(); len(s.Projects) != 1 || s.Projects[0].Error != "" {
		t.Fatal(s)
	}
	file := filepath.Join(root, "file.txt")
	os.WriteFile(file, []byte("text"), 0600)
	if _, err = m.AddProject(file, ""); err == nil {
		t.Fatal("accepted file as project")
	}
	if _, err = m.AddProject(filepath.Join(root, "missing"), ""); err == nil {
		t.Fatal("accepted missing folder")
	}
	os.Mkdir(filepath.Join(root, ".git"), 0700)
	if _, err = m.AddProject(root, ""); err == nil {
		t.Fatal("Git error silently became plain folder")
	}
}

func TestNestedGitFolderStillResolvesToExistingProject(t *testing.T) {
	m := manager(t)
	root := repo(t)
	nested := filepath.Join(root, "src", "components")
	os.MkdirAll(nested, 0700)
	p, err := m.AddProject(nested, "")
	if err != nil || !p.Git || p.Path != root {
		t.Fatal(p, err)
	}
	same, err := m.AddProject(root, "")
	if err != nil || same.ID != p.ID {
		t.Fatal(same, err)
	}
}
