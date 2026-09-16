package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func githubFixture(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	script := `#!/bin/sh
if [ "$1" = api ]; then
 if [ "$GH_TEST_MODE" = auth ]; then echo 'gh auth login' >&2; exit 1; fi
 case "$*" in
 *user/repos*)
  case "$*" in *--paginate*) ;; *) exit 1;; esac
  printf '%s\n' '{"fullName":"user/first","name":"first","private":true}' '{"fullName":"org/second","name":"second","description":"page two","archived":true}' '{"fullName":"user/first","name":"first"}'
  ;;
 *) printf '%s\n' '{"login":"fixture-user"}';;
 esac
 exit 0
fi
if [ "$GH_TEST_MODE" = fail ]; then echo 'auth token MUST_NOT_LEAK' >&2; exit 1; fi
if [ "$GH_TEST_MODE" = slow ]; then
 sleep 90 &
 echo $! > "$GH_TEST_PID"
 wait
 exit 1
fi
exec git clone --progress "$GH_TEST_REPO" "$4"
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_TEST_REPO", repo(t))
	t.Setenv("GH_TEST_MODE", "")
	t.Setenv("GH_TEST_PID", filepath.Join(t.TempDir(), "child"))
}
func awaitClone(t *testing.T, m *Manager, id string) CloneJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		job, err := m.cloneJob(id, false)
		if err != nil {
			t.Fatal(err)
		}
		if job.Status == "done" || job.Status == "error" || job.Status == "canceled" {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("clone never completed")
	return CloneJob{}
}
func TestGitHubConnectionAndRepositoryPages(t *testing.T) {
	githubFixture(t)
	status := githubStatus(context.Background())
	if !status.Installed || !status.Connected || status.Login != "fixture-user" {
		t.Fatalf("status: %+v", status)
	}
	repos, err := githubRepositories(context.Background())
	if err != nil || len(repos) != 2 || !repos[0].Private || repos[1].FullName != "org/second" || !repos[1].Archived {
		t.Fatalf("repos: %+v %v", repos, err)
	}
	t.Setenv("GH_TEST_MODE", "auth")
	status = githubStatus(context.Background())
	if status.Connected || !strings.Contains(status.Error, "connect GitHub") {
		t.Fatalf("auth: %+v", status)
	}
	t.Setenv("PATH", t.TempDir())
	if githubStatus(context.Background()).Installed {
		t.Fatal("missing CLI reported installed")
	}
}
func TestGitHubCloneOpensProjectWithoutOverwritingFolders(t *testing.T) {
	githubFixture(t)
	m := manager(t)
	defer m.CloseClones()
	parent := t.TempDir()
	job, err := m.startGitHubClone("org/project", parent, "My project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.startGitHubClone("org/project", parent, "My project"); err == nil {
		t.Fatal("accepted duplicate destination")
	}
	job = awaitClone(t, m, job.ID)
	if job.Status != "done" || job.Project == nil || !job.Project.Git || job.Project.Path != job.Path {
		t.Fatalf("clone: %+v", job)
	}
	if _, err = git(job.Path, "rev-parse", "HEAD"); err != nil {
		t.Fatal(err)
	}
	loaded, err := New(m.file, m.socket)
	if err != nil || len(loaded.Snapshot().Projects) != 1 {
		t.Fatalf("persistence: %v", err)
	}
	for _, name := range []string{"../outside", ".", "..", "a/b", "a\\b", " name", ""} {
		if _, err = m.startGitHubClone("org/project", parent, name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, repository := range []string{"--flag", "https://evil.test/repo", "org/../repo", "org/..", "org/repo;touch"} {
		if _, err = m.startGitHubClone(repository, parent, "unused"); err == nil {
			t.Fatalf("accepted %q", repository)
		}
	}
	empty := filepath.Join(parent, "existing")
	os.Mkdir(empty, 0755)
	if _, err = m.startGitHubClone("org/project", parent, "existing"); err == nil {
		t.Fatal("reused existing empty folder")
	}
	os.WriteFile(filepath.Join(empty, "keep"), []byte("unchanged"), 0600)
	if _, err = m.startGitHubClone("org/project", parent, "existing"); err == nil {
		t.Fatal("reused existing populated folder")
	}
	data, _ := os.ReadFile(filepath.Join(empty, "keep"))
	if string(data) != "unchanged" {
		t.Fatal("modified existing file")
	}
}
func TestGitHubCloneFailureCancellationAndShutdown(t *testing.T) {
	githubFixture(t)
	for _, mode := range []string{"fail", "cancel", "shutdown", "preserve"} {
		t.Run(mode, func(t *testing.T) {
			m := manager(t)
			defer m.CloseClones()
			parent := t.TempDir()
			t.Setenv("GH_TEST_PID", filepath.Join(parent, "child.pid"))
			if mode == "fail" {
				t.Setenv("GH_TEST_MODE", "fail")
			} else {
				t.Setenv("GH_TEST_MODE", "slow")
			}
			job, err := m.startGitHubClone("org/project", parent, "target")
			if err != nil {
				t.Fatal(err)
			}
			if mode == "preserve" {
				if err = os.WriteFile(filepath.Join(job.Path, "keep"), []byte("mine"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "shutdown" {
				waitForCloneChild(t)
				m.CloseClones()
			} else if mode != "fail" {
				waitForCloneChild(t)
				m.cloneJob(job.ID, true)
			}
			job = awaitClone(t, m, job.ID)
			m.CloseClones() // Also wait for private staging cleanup.
			if mode != "fail" {
				pid, _ := os.ReadFile(os.Getenv("GH_TEST_PID"))
				state, _ := exec.Command("ps", "-p", strings.TrimSpace(string(pid)), "-o", "stat=").Output()
				if value := strings.TrimSpace(string(state)); value != "" && !strings.HasPrefix(value, "Z") {
					t.Fatalf("clone child survived cancellation: %s", value)
				}
				os.Remove(os.Getenv("GH_TEST_PID"))
			}
			expected := "canceled"
			if mode == "fail" {
				expected = "error"
			}
			if job.Status != expected || strings.Contains(job.Error, "MUST_NOT_LEAK") {
				t.Fatalf("job: %+v", job)
			}
			if len(m.Snapshot().Projects) != 0 {
				t.Fatal("failed clone created a project")
			}
			files, _ := os.ReadDir(parent)
			if mode == "preserve" {
				data, _ := os.ReadFile(filepath.Join(job.Path, "keep"))
				if string(data) != "mine" {
					t.Fatal("deleted user-added file")
				}
			} else if len(files) != 0 {
				t.Fatalf("left temporary files: %v", files)
			}
		})
	}
}

func waitForCloneChild(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if b, _ := os.ReadFile(os.Getenv("GH_TEST_PID")); len(b) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("clone fixture did not start")
}
