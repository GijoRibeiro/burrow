package workspace

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type PullRequest struct {
	Number      int    `json:"number"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	IsDraft     bool   `json:"isDraft"`
	State       string `json:"state"`
	HeadRefName string `json:"headRefName"`
}
type pullRequestEntry struct {
	mu      sync.Mutex
	branch  string
	checked time.Time
	pr      *PullRequest
}
type pullRequestCache struct {
	mu      sync.Mutex
	entries map[string]*pullRequestEntry
}

// PR lookup is independent of snapshots, activity and PTY traffic. Terminals in
// the same checkout share a short cache; branch changes invalidate it at once.
func (m *Manager) pullRequest(ctx context.Context, id string) (*PullRequest, error) {
	terminal, err := m.Terminal(id)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	root, err := scanCommand(ctx, terminal.Path, "git", "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, nil
	}
	branch, err := scanCommand(ctx, root, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || branch == "" {
		return nil, nil
	}
	cache := &m.pullRequests
	cache.mu.Lock()
	if cache.entries == nil {
		cache.entries = map[string]*pullRequestEntry{}
	}
	entry := cache.entries[root]
	if entry == nil {
		// Bound old checkout entries without holding the cache lock over I/O.
		if len(cache.entries) >= 256 {
			for key := range cache.entries {
				delete(cache.entries, key)
				break
			}
		}
		entry = &pullRequestEntry{}
		cache.entries[root] = entry
	}
	cache.mu.Unlock()
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if ctx.Err() != nil {
		return nil, nil
	}
	if entry.branch == branch && time.Since(entry.checked) < 30*time.Second {
		return entry.pr, nil
	}
	out := boundedOutput{limit: 64 << 10}
	var found *PullRequest
	if githubCommandInDir(ctx, root, &out, "pr", "view", "--json", "number,url,title,isDraft,state,headRefName") == nil {
		var value PullRequest
		if json.Unmarshal(out.data, &value) == nil && validPullRequest(value, branch) {
			found = &value
		}
	}
	// Never advertise another branch's PR if the agent checked out while gh ran.
	current, err := scanCommand(ctx, root, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || current != branch {
		return nil, nil
	}
	entry.branch, entry.checked, entry.pr = branch, time.Now(), found
	// No gh, no sign-in, no open PR, or offline: leave the header quiet and retry.
	return found, nil
}
func validPullRequest(pr PullRequest, branch string) bool {
	u, err := url.Parse(pr.URL)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || pr.Number <= 0 || pr.State != "OPEN" || pr.HeadRefName != branch {
		return false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	return len(parts) == 4 && parts[0] != "" && parts[1] != "" && parts[2] == "pull" && parts[3] == strconv.Itoa(pr.Number)
}
func (m *Manager) pullRequestRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/terminals/{id}/pull-request", func(w http.ResponseWriter, r *http.Request) {
		pr, err := m.pullRequest(r.Context(), r.PathValue("id"))
		respond(w, pr, err)
	})
}
