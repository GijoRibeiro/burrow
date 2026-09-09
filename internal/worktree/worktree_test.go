package worktree_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gijo/cloovies/internal/worktree"
)

func TestValidateName(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"empty", "", true},
		{"whitespace only", "   ", true},
		{"contains slash", "foo/bar", true},
		{"contains backslash", `foo\bar`, true},
		{"contains space", "foo bar", true},
		{"contains tab", "foo\tbar", true},
		{"dotdot", "..", true},
		{"leading dot", ".hidden", true},
		{"valid simple", "login-redesign", false},
		{"valid with underscore", "feature_x", false},
		{"valid with numbers", "fix-42", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := worktree.ValidateName(c.input)
			if (err != nil) != c.wantErr {
				t.Errorf("ValidateName(%q) err=%v, wantErr=%v", c.input, err, c.wantErr)
			}
		})
	}
}

// initRepo creates an empty git repo with one commit on the given
// initial branch. Returns the repo path. t.TempDir is used so the dir
// is cleaned up automatically when the test ends.
func initRepo(t *testing.T, initialBranch string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		// Quiet the "hint: using" banner so failed tests stay readable.
		cmd.Env = append(os.Environ(), "GIT_DEFAULT_BRANCH="+initialBranch)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", initialBranch)
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return dir
}

func TestDefaultBranch_Main(t *testing.T) {
	dir := initRepo(t, "main")
	got, err := worktree.DefaultBranch(dir)
	if err != nil {
		t.Fatalf("DefaultBranch: %v", err)
	}
	if got != "main" {
		t.Errorf("expected main, got %q", got)
	}
}

func TestDefaultBranch_Master(t *testing.T) {
	dir := initRepo(t, "master")
	got, err := worktree.DefaultBranch(dir)
	if err != nil {
		t.Fatalf("DefaultBranch: %v", err)
	}
	if got != "master" {
		t.Errorf("expected master, got %q", got)
	}
}

func TestDefaultBranch_NeitherExists(t *testing.T) {
	dir := initRepo(t, "trunk")
	_, err := worktree.DefaultBranch(dir)
	if err == nil {
		t.Fatal("expected error when repo has no main/master/origin HEAD")
	}
}

func TestCreateAndRemove(t *testing.T) {
	repo := initRepo(t, "main")

	// Create
	path, err := worktree.Create(repo, "login-redesign", "main")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	wantPath := filepath.Join(repo, ".claude", "worktrees", "login-redesign")
	if path != wantPath {
		t.Errorf("Create path: got %q, want %q", path, wantPath)
	}
	// Directory exists and contains a working tree.
	if _, err := os.Stat(filepath.Join(path, "README.md")); err != nil {
		t.Errorf("worktree README.md missing: %v", err)
	}
	// Branch `worktree/login-redesign` exists.
	out, err := exec.Command("git", "-C", repo, "branch", "--list", "worktree/login-redesign").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		t.Errorf("branch worktree/login-redesign not created: out=%q err=%v", out, err)
	}

	// Remove
	if err := worktree.Remove(repo, path, false); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("worktree dir should be gone, got err=%v", err)
	}
}

func TestCreate_InvalidName(t *testing.T) {
	repo := initRepo(t, "main")
	if _, err := worktree.Create(repo, "bad/name", "main"); err == nil {
		t.Fatal("expected validation error for `bad/name`")
	}
}

func TestCreate_DuplicateName(t *testing.T) {
	repo := initRepo(t, "main")
	if _, err := worktree.Create(repo, "dup", "main"); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	if _, err := worktree.Create(repo, "dup", "main"); err == nil {
		t.Fatal("expected error on duplicate Create")
	}
}

func TestList_Empty(t *testing.T) {
	repo := initRepo(t, "main")
	got, err := worktree.List(repo)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty, got %v", got)
	}
}

func TestList_AfterCreate(t *testing.T) {
	repo := initRepo(t, "main")
	if _, err := worktree.Create(repo, "alpha", "main"); err != nil {
		t.Fatalf("Create alpha: %v", err)
	}
	if _, err := worktree.Create(repo, "beta", "main"); err != nil {
		t.Fatalf("Create beta: %v", err)
	}
	got, err := worktree.List(repo)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2, got %d: %+v", len(got), got)
	}
	if got[0].Name != "alpha" || got[1].Name != "beta" {
		t.Errorf("expected [alpha, beta], got [%s, %s]", got[0].Name, got[1].Name)
	}
	if got[0].Branch != "worktree/alpha" {
		t.Errorf("expected branch worktree/alpha, got %q", got[0].Branch)
	}
	if !strings.HasSuffix(got[0].Path, "/.claude/worktrees/alpha") {
		t.Errorf("expected path under .claude/worktrees/alpha, got %q", got[0].Path)
	}
}
