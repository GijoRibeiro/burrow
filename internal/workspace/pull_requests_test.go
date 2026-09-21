package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPullRequestDiscoveryUsesCheckoutBranchAndSharesCache(t *testing.T) {
	m := manager(t)
	root := repo(t)
	// This is read-only discovery; no real terminal or GitHub request is needed.
	m.state.Terminals = []Terminal{{ID: "a", Path: root}, {ID: "b", Path: root}}
	bin := t.TempDir()
	fixture := `#!/bin/sh
printf 'call\n' >> "$PR_CALLS"
branch=$(git symbolic-ref --short HEAD)
printf '{"number":42,"url":"https://github.com/test/repo/pull/42","title":"Fix the layout","state":"%s","isDraft":true,"headRefName":"%s"}' "$PR_STATE" "$branch"
`
	os.WriteFile(filepath.Join(bin, "gh"), []byte(fixture), 0700)
	calls := filepath.Join(t.TempDir(), "calls")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PR_CALLS", calls)
	t.Setenv("PR_STATE", "OPEN")
	pr, err := m.pullRequest(context.Background(), "a")
	if err != nil || pr == nil || pr.Number != 42 || !pr.IsDraft {
		t.Fatalf("lookup: %+v %v", pr, err)
	}
	m.pullRequest(context.Background(), "b")
	data, _ := os.ReadFile(calls)
	if strings.Count(string(data), "call") != 1 {
		t.Fatalf("duplicate lookup: %s", data)
	}
	if _, err := git(root, "checkout", "-b", "feature"); err != nil {
		t.Fatal(err)
	}
	pr, err = m.pullRequest(context.Background(), "b")
	if err != nil || pr == nil || pr.HeadRefName != "feature" {
		t.Fatalf("branch changed: %+v %v", pr, err)
	}
	data, _ = os.ReadFile(calls)
	if strings.Count(string(data), "call") != 2 {
		t.Fatal("branch change must invalidate cache")
	}
	t.Setenv("PR_STATE", "MERGED")
	m.pullRequests.entries[root].checked = time.Time{}
	pr, err = m.pullRequest(context.Background(), "a")
	if err != nil || pr != nil {
		t.Fatalf("merged PR still advertised: %+v %v", pr, err)
	}
	t.Setenv("PR_STATE", "OPEN")
	git(root, "checkout", "--detach")
	pr, err = m.pullRequest(context.Background(), "a")
	if err != nil || pr != nil {
		t.Fatalf("detached HEAD: %+v %v", pr, err)
	}
	m.state.Terminals = append(m.state.Terminals, Terminal{ID: "folder", Path: t.TempDir()})
	pr, err = m.pullRequest(context.Background(), "folder")
	if err != nil || pr != nil {
		t.Fatalf("ordinary folder: %+v %v", pr, err)
	}
}
func TestPullRequestLinksRejectWrongBranchClosedAndUnsafeURLs(t *testing.T) {
	good := PullRequest{Number: 7, URL: "https://github.com/team/repo/pull/7", State: "OPEN", HeadRefName: "feature"}
	if !validPullRequest(good, "feature") {
		t.Fatal("valid PR rejected")
	}
	for _, u := range []string{"javascript:alert(1)", "https://evil.test/team/repo/pull/7", "https://github.com/team/repo/pull/8"} {
		p := good
		p.URL = u
		if validPullRequest(p, "feature") {
			t.Fatalf("accepted %s", u)
		}
	}
	if validPullRequest(good, "other") {
		t.Fatal("wrong branch")
	}
	good.State = "CLOSED"
	if validPullRequest(good, "feature") {
		t.Fatal("closed PR")
	}
}
