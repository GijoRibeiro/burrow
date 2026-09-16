package workspace

import (
	"context"
	"os"
	"testing"
	"time"
)

// Opt-in smoke test uses the operator's existing gh sign-in, clones only the
// explicitly supplied repository into t.TempDir, and never changes that account.
func TestGitHubLiveClone(t *testing.T) {
	repository := os.Getenv("BURROW_LIVE_GITHUB_REPO")
	if repository == "" {
		t.Skip("set BURROW_LIVE_GITHUB_REPO to run the real GitHub smoke test")
	}
	status := githubStatus(context.Background())
	if !status.Connected {
		t.Fatalf("connection: %+v", status)
	}
	repos, err := githubRepositories(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range repos {
		if r.FullName == repository {
			found = true
		}
	}
	if !found {
		t.Fatal("requested repository missing from account repository list")
	}
	m := manager(t)
	defer m.CloseClones()
	job, err := m.startGitHubClone(repository, t.TempDir(), "checkout")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		job, err = m.cloneJob(job.ID, false)
		if err != nil {
			t.Fatal(err)
		}
		if job.Status == "done" {
			if job.Project == nil || !job.Project.Git {
				t.Fatal("clone did not open a Git project")
			}
			if _, err = git(job.Path, "rev-parse", "HEAD"); err != nil {
				t.Fatal(err)
			}
			t.Logf("Listed %d repositories across pages and cloned/opened the requested repository", len(repos))
			return
		}
		if job.Status == "error" || job.Status == "canceled" {
			t.Fatalf("clone: %+v", job)
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("clone did not finish within the smoke-test timeout")
}
