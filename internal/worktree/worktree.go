// Package worktree wraps the `git worktree` operations cloovies needs to
// spawn (and later remove) sibling agents on parallel worktrees of the
// same repo. Everything here shells out to git via os/exec, with thin
// validation and error-formatting so server handlers can call these
// directly without re-implementing the same checks each time.
package worktree

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Info describes a single worktree under <repoCwd>/.claude/worktrees/.
// Name is the directory basename (also the suffix of the branch name),
// Path is the absolute path on disk, Branch is the branch checked out
// in that worktree (without the refs/heads/ prefix) — empty if detached.
type Info struct {
	Name   string
	Path   string
	Branch string
}

// List enumerates every worktree under <repoCwd>/.claude/worktrees/. It
// invokes `git worktree list --porcelain` and filters the output to
// only the cloovies-managed worktrees, ignoring the main repo worktree
// and any user-created worktrees living elsewhere on disk. Sorted by
// Name ascending for stable rendering.
func List(repoCwd string) ([]Info, error) {
	out, err := runGit(repoCwd, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	// git emits canonical absolute paths (symlinks resolved on macOS),
	// so resolve repoCwd the same way before building the prefix or the
	// match will fail when the caller passes e.g. /var vs /private/var.
	resolved := repoCwd
	if rp, rerr := filepath.EvalSymlinks(repoCwd); rerr == nil {
		resolved = rp
	}
	prefix := filepath.Join(resolved, ".claude", "worktrees") + string(filepath.Separator)

	var result []Info
	// Porcelain groups records by blank lines. Each record starts with a
	// `worktree <path>` line; subsequent lines describe HEAD/branch.
	var cur Info
	var have bool
	flush := func() {
		if !have {
			return
		}
		if strings.HasPrefix(cur.Path, prefix) {
			cur.Name = filepath.Base(cur.Path)
			result = append(result, cur)
		}
		cur = Info{}
		have = false
	}
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimRight(raw, "\r")
		if line == "" {
			flush()
			continue
		}
		switch {
		case strings.HasPrefix(line, "worktree "):
			flush()
			cur = Info{Path: strings.TrimPrefix(line, "worktree ")}
			have = true
		case strings.HasPrefix(line, "branch "):
			b := strings.TrimPrefix(line, "branch ")
			cur.Branch = strings.TrimPrefix(b, "refs/heads/")
		}
	}
	flush()

	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

// ValidateName rejects empty / whitespace / path-separator / hidden /
// parent-dir names. The name becomes both a directory under
// .claude/worktrees and a fragment of a branch name (worktree/<name>),
// so it has to be filesystem-safe AND avoid colliding with git refspec
// syntax — slashes are the main hazard there.
func ValidateName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return errors.New("name can't be empty")
	}
	if trimmed != name {
		return errors.New("name can't have leading or trailing whitespace")
	}
	if strings.ContainsAny(name, "/\\ \t\n\r") {
		return errors.New("name can't contain slashes or whitespace")
	}
	if name == "." || name == ".." {
		return errors.New("name can't be `.` or `..`")
	}
	if strings.HasPrefix(name, ".") {
		return errors.New("name can't start with `.`")
	}
	return nil
}

// DefaultBranch picks the branch a worktree should be cut from. Order:
//  1. `git symbolic-ref refs/remotes/origin/HEAD` — what the remote
//     reports as its default. Works for cloned repos.
//  2. local `main` if present.
//  3. local `master` if present.
//
// Returns an error if none of the three resolve, so handlers can
// surface a clear message instead of silently picking a wrong branch.
func DefaultBranch(repoCwd string) (string, error) {
	// 1. Remote-reported default (the canonical answer for cloned repos).
	out, err := runGit(repoCwd, "symbolic-ref", "refs/remotes/origin/HEAD")
	if err == nil {
		trimmed := strings.TrimSpace(out)
		// e.g. "refs/remotes/origin/main" → "main"
		if i := strings.LastIndex(trimmed, "/"); i >= 0 {
			return trimmed[i+1:], nil
		}
	}
	// 2 + 3. Local fallbacks.
	for _, name := range []string{"main", "master"} {
		if _, err := runGit(repoCwd, "rev-parse", "--verify", name); err == nil {
			return name, nil
		}
	}
	return "", errors.New("couldn't resolve default branch — repo has no `main`, `master`, or `origin/HEAD`")
}

// Create cuts a new worktree under <repoCwd>/.claude/worktrees/<name>,
// on a new branch named `worktree/<name>` based on baseBranch. The
// `worktree/` prefix lets `git branch | grep ^worktree/` list every
// cloovies-spawned branch at once and keeps them out of the way of
// real feature branches in tab-completion. Validation happens up-front
// so callers don't have to parse git's stderr to know it was a bad
// name vs. a real git failure.
func Create(repoCwd, name, baseBranch string) (string, error) {
	if err := ValidateName(name); err != nil {
		return "", err
	}
	path := filepath.Join(repoCwd, ".claude", "worktrees", name)
	branch := "worktree/" + name
	if _, err := runGit(repoCwd, "worktree", "add", "-b", branch, path, baseBranch); err != nil {
		return "", err
	}
	return path, nil
}

// Remove drops a worktree's directory and detaches it from git's
// metadata. If force is false and the worktree has uncommitted
// changes, git refuses and the error includes that message verbatim
// so the UI can offer a force-retry. Force passes --force to git.
func Remove(repoCwd, worktreePath string, force bool) error {
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, worktreePath)
	_, err := runGit(repoCwd, args...)
	return err
}

// runGit shells out to `git -C <dir> <args>` and returns stdout. stderr
// is folded into the returned error so callers can surface the actual
// git complaint, which is usually what the user needs to know.
func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("git %s: %w", args[0], err)
	}
	return string(out), nil
}
