package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitializeProjectGitPreservesFilesSessionsAndHistory(t *testing.T) {
	m, _, _ := coordinationManager(t)
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "notes.txt"), []byte("my work"), 0600)
	os.WriteFile(filepath.Join(root, ".env"), []byte("fixture-only"), 0600)
	p, err := m.AddProject(root, "Plain")
	if err != nil {
		t.Fatal(err)
	}
	agent, err := m.CreateProgramTerminal(p.ID, p.Path, "Existing agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := m.tmux("display-message", "-p", "-t", "="+sessionName(agent.ID)+":", "#{pane_pid}")
	initialized, err := m.InitializeProjectGit(p.ID)
	if err != nil || !initialized.Git || initialized.ID != p.ID || initialized.Path != p.Path {
		t.Fatalf("initialize: %+v %v", initialized, err)
	}
	files, err := git(p.Path, "ls-files")
	if err != nil || files != "" {
		t.Fatalf("files were staged: %s %v", files, err)
	}
	if _, err = git(p.Path, "rev-parse", "--verify", "HEAD"); err == nil {
		t.Fatal("initialization committed files")
	}
	data, _ := os.ReadFile(filepath.Join(p.Path, "notes.txt"))
	if string(data) != "my work" {
		t.Fatal("file changed")
	}
	after, _ := m.tmux("display-message", "-p", "-t", "="+sessionName(agent.ID)+":", "#{pane_pid}")
	if pid != after {
		t.Fatal("restarted existing agent")
	}
	head, err := m.CreateHead(p.ID, p.Path, "Head", "claude", "Help prepare this new repository")
	if err != nil || head.Role != "head" {
		t.Fatalf("head: %+v %v", head, err)
	}
	if !strings.Contains(m.headPrompt(head), "Before creating workers, check that HEAD exists") {
		t.Fatal("head missing bootstrap guidance")
	}
	if _, err = git(p.Path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "Fixture commit"); err != nil {
		t.Fatal(err)
	}
	before, _ := git(p.Path, "rev-parse", "HEAD")
	if _, err = m.InitializeProjectGit(p.ID); err != nil {
		t.Fatal(err)
	}
	afterCommit, _ := git(p.Path, "rev-parse", "HEAD")
	if before != afterCommit {
		t.Fatal("existing history changed")
	}
	loaded, err := New(m.file, m.socket)
	if err != nil || !loaded.Snapshot().Projects[1].Git {
		t.Fatalf("not persisted: %v", err)
	}
	if _, err = m.InitializeProjectGit("missing"); err == nil {
		t.Fatal("unknown project accepted")
	}
}

func TestInitializeProjectGitDoesNotRepairBrokenRepositories(t *testing.T) {
	m := manager(t)
	p, err := m.AddProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(p.Path, ".git")
	os.WriteFile(marker, []byte("invalid fixture"), 0600)
	if _, err = m.InitializeProjectGit(p.ID); err == nil {
		t.Fatal("corrupt repository silently replaced")
	}
	b, _ := os.ReadFile(marker)
	if string(b) != "invalid fixture" {
		t.Fatal("Git marker overwritten")
	}
}
