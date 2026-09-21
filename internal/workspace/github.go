package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type GitHubRepository struct {
	FullName    string `json:"fullName"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Private     bool   `json:"private"`
	Archived    bool   `json:"archived"`
}
type GitHubStatus struct {
	Installed bool   `json:"installed"`
	Connected bool   `json:"connected"`
	Login     string `json:"login,omitempty"`
	Folder    string `json:"folder"`
	Error     string `json:"error,omitempty"`
}
type CloneJob struct {
	ID         string   `json:"id"`
	Repository string   `json:"repository"`
	Path       string   `json:"path"`
	Status     string   `json:"status"`
	Progress   string   `json:"progress"`
	Error      string   `json:"error,omitempty"`
	Project    *Project `json:"project,omitempty"`
	cancel     context.CancelFunc
	created    time.Time
}
type githubState struct {
	mu      sync.Mutex
	jobs    map[string]*CloneJob
	closing bool
	wg      sync.WaitGroup
}
type boundedOutput struct {
	data  []byte
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(b.data)+n > b.limit {
		return 0, errors.New("GitHub response exceeded its size limit")
	}
	b.data = append(b.data, p...)
	return n, nil
}
func githubCommand(ctx context.Context, output io.Writer, args ...string) error {
	return githubCommandInDir(ctx, "", output, args...)
}
func githubCommandInDir(ctx context.Context, dir string, output io.Writer, args ...string) error {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_PAGER=cat", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never")
	cmd.WaitDelay = time.Second
	isolateCloneProcess(cmd)
	var stderr boundedOutput
	stderr.limit = 64 << 10
	cmd.Stdout = output
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		detail := strings.ToLower(string(stderr.data))
		switch {
		case strings.Contains(detail, "auth login"), strings.Contains(detail, "401"), strings.Contains(detail, "bad credentials"):
			return errors.New("connect GitHub to continue")
		case strings.Contains(detail, "rate limit"):
			return errors.New("GitHub's rate limit was reached; try again shortly")
		case strings.Contains(detail, "404"), strings.Contains(detail, "not found"):
			return errors.New("repository not found or your GitHub account does not have access")
		default:
			return errors.New("GitHub could not complete the request; check your connection and GitHub sign-in")
		}
	}
	return nil
}
func defaultCloneFolder() string {
	home, _ := os.UserHomeDir()
	for _, path := range []string{filepath.Join(home, "Documents", "Code"), filepath.Join(home, "Documents"), home} {
		if info, e := os.Stat(path); e == nil && info.IsDir() {
			return path
		}
	}
	return home
}
func githubStatus(ctx context.Context) GitHubStatus {
	s := GitHubStatus{Folder: defaultCloneFolder()}
	if _, err := exec.LookPath("gh"); err != nil {
		return s
	}
	s.Installed = true
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out := boundedOutput{limit: 4096}
	if err := githubCommand(ctx, &out, "api", "--hostname", "github.com", "user", "--jq", "{login}"); err != nil {
		s.Error = err.Error()
		return s
	}
	var user struct {
		Login string `json:"login"`
	}
	if json.Unmarshal(out.data, &user) != nil || user.Login == "" {
		s.Error = "GitHub returned an unreadable account"
		return s
	}
	s.Connected = true
	s.Login = user.Login
	return s
}
func githubRepositories(ctx context.Context) ([]GitHubRepository, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	out := boundedOutput{limit: 8 << 20}
	err := githubCommand(ctx, &out, "api", "--hostname", "github.com", "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", "--paginate", "--jq", ".[] | {fullName: .full_name, name, description: (.description // \"\"), private, archived}")
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(out.data))
	repos := []GitHubRepository{}
	seen := map[string]bool{}
	for {
		var repo GitHubRepository
		if err = decoder.Decode(&repo); err == io.EOF {
			break
		} else if err != nil {
			return nil, errors.New("GitHub returned an unreadable repository list")
		}
		if validGitHubRepo(repo.FullName) && !seen[repo.FullName] {
			repos = append(repos, repo)
			seen[repo.FullName] = true
		}
	}
	return repos, nil
}

var githubRepoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`)

func validGitHubRepo(name string) bool {
	if len(name) > 200 || !githubRepoPattern.MatchString(name) {
		return false
	}
	leaf := strings.Split(name, "/")[1]
	return leaf != "." && leaf != ".."
}
func (m *Manager) startGitHubClone(repository, parent, name string) (CloneJob, error) {
	if !validGitHubRepo(repository) {
		return CloneJob{}, errors.New("choose a GitHub repository")
	}
	if name == "" || name == "." || name == ".." || len(name) > 200 || strings.ContainsAny(name, "/\\\x00\r\n") || strings.TrimSpace(name) != name {
		return CloneJob{}, errors.New("choose a folder name without slashes or leading/trailing spaces")
	}
	parent, err := canonical(parent)
	if err != nil {
		return CloneJob{}, errors.New("choose an existing parent folder")
	}
	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		return CloneJob{}, errors.New("choose an existing parent folder")
	}
	path := filepath.Join(parent, name)
	m.github.mu.Lock()
	defer m.github.mu.Unlock()
	if m.github.closing {
		return CloneJob{}, errors.New("workspace is closing; reopen it before cloning")
	}
	if m.github.jobs == nil {
		m.github.jobs = map[string]*CloneJob{}
	}
	for id, job := range m.github.jobs {
		if job.cancel == nil && time.Since(job.created) > time.Hour {
			delete(m.github.jobs, id)
		}
	}
	// Reserve only a new directory. Never reuse or overwrite the user's folder.
	if err = os.Mkdir(path, 0755); err != nil {
		if os.IsExist(err) {
			return CloneJob{}, errors.New("that folder already exists; choose another name, or open it as a local project")
		}
		return CloneJob{}, fmt.Errorf("could not create the destination folder: %w", err)
	}
	stage, err := os.MkdirTemp(parent, ".burrow-clone-")
	if err != nil {
		os.Remove(path)
		return CloneJob{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	job := &CloneJob{ID: id(), Repository: repository, Path: path, Status: "cloning", Progress: "Connecting to GitHub…", cancel: cancel, created: time.Now()}
	m.github.jobs[job.ID] = job
	m.github.wg.Add(1)
	go m.runGitHubClone(ctx, job.ID, stage)
	return *job, nil
}

type cloneProgress struct {
	m    *Manager
	id   string
	mu   sync.Mutex
	tail string
}

func (w *cloneProgress) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.tail += string(p)
	if len(w.tail) > 4096 {
		w.tail = w.tail[len(w.tail)-4096:]
	}
	lines := strings.FieldsFunc(w.tail, func(r rune) bool { return r == '\n' || r == '\r' })
	if len(lines) > 0 {
		line := strings.TrimSpace(lines[len(lines)-1])
		if len(line) > 240 {
			line = line[:240]
		}
		// Only Git's progress counters are exposed, not arbitrary credential output.
		if strings.Contains(line, "Receiving objects:") || strings.Contains(line, "Resolving deltas:") || strings.Contains(line, "Updating files:") || strings.Contains(line, "remote: Counting objects:") {
			w.m.github.mu.Lock()
			if job := w.m.github.jobs[w.id]; job != nil && job.Status == "cloning" {
				job.Progress = line
			}
			w.m.github.mu.Unlock()
		}
	}
	return len(p), nil
}
func (m *Manager) runGitHubClone(ctx context.Context, jobID, stage string) {
	defer m.github.wg.Done()
	defer os.RemoveAll(stage) // Private staging directory created exclusively by this clone.
	m.github.mu.Lock()
	job := *m.github.jobs[jobID]
	m.github.mu.Unlock()
	checkout := filepath.Join(stage, "checkout")
	cmd := exec.CommandContext(ctx, "gh", "repo", "clone", "https://github.com/"+job.Repository, checkout, "--no-upstream", "--", "--progress")
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_PAGER=cat", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never")
	cmd.WaitDelay = time.Second
	isolateCloneProcess(cmd)
	progress := &cloneProgress{m: m, id: jobID}
	cmd.Stdout = progress
	cmd.Stderr = progress
	err := cmd.Run()
	m.github.mu.Lock()
	defer m.github.mu.Unlock()
	current := m.github.jobs[jobID]
	contextErr := ctx.Err()
	current.cancel()
	current.cancel = nil
	if err != nil || contextErr != nil {
		current.Status = "error"
		current.Error = "Clone failed. Check your connection and repository access, then try again."
		if errors.Is(contextErr, context.Canceled) {
			current.Status = "canceled"
			current.Error = ""
			current.Progress = "Clone canceled"
		}
		if errors.Is(contextErr, context.DeadlineExceeded) {
			current.Error = "Clone timed out after 15 minutes. Try again when your connection is ready."
		}
		os.Remove(job.Path) // Only removes our empty reservation; never deletes user-added files.
		return
	}
	current.Status = "opening"
	current.Progress = "Opening project…"
	// Rename can replace only our still-empty reservation; added files block it.
	if err = publishClone(checkout, job.Path); err != nil {
		current.Status = "error"
		current.Error = "The destination changed during cloning. Choose another folder and try again."
		os.Remove(job.Path)
		return
	}
	project, err := m.AddProject(job.Path, "")
	if err != nil {
		current.Status = "error"
		current.Error = "Repository cloned, but could not be added. Open it as a local folder: " + job.Path
		return
	}
	current.Project = &project
	current.Status = "done"
	current.Progress = "Project ready"
}
func (m *Manager) cloneJob(id string, cancel bool) (CloneJob, error) {
	m.github.mu.Lock()
	defer m.github.mu.Unlock()
	job := m.github.jobs[id]
	if job == nil {
		return CloneJob{}, errors.New("clone is no longer active; check your destination folder or start again")
	}
	if cancel && job.cancel != nil {
		job.Status = "canceling"
		job.Progress = "Canceling clone…"
		job.cancel()
	}
	return *job, nil
}

// Closing the app cancels clone processes; it never touches tmux agents.
func (m *Manager) CloseClones() {
	m.github.mu.Lock()
	m.github.closing = true
	for _, job := range m.github.jobs {
		if job.cancel != nil {
			job.cancel()
		}
	}
	m.github.mu.Unlock()
	m.github.wg.Wait()
}
func (m *Manager) githubRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/github", func(w http.ResponseWriter, r *http.Request) { respond(w, githubStatus(r.Context()), nil) })
	mux.HandleFunc("GET /api/workspace/github/repos", func(w http.ResponseWriter, r *http.Request) {
		repos, err := githubRepositories(r.Context())
		respond(w, repos, err)
	})
	mux.HandleFunc("POST /api/workspace/github/clones", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Repository string `json:"repository"`
			Parent     string `json:"parent"`
			Name       string `json:"name"`
		}
		if !decode(w, r, &v) {
			return
		}
		job, err := m.startGitHubClone(v.Repository, v.Parent, v.Name)
		respond(w, job, err)
	})
	mux.HandleFunc("GET /api/workspace/github/clones/{id}", func(w http.ResponseWriter, r *http.Request) {
		job, err := m.cloneJob(r.PathValue("id"), false)
		respond(w, job, err)
	})
	mux.HandleFunc("DELETE /api/workspace/github/clones/{id}", func(w http.ResponseWriter, r *http.Request) {
		job, err := m.cloneJob(r.PathValue("id"), true)
		respond(w, job, err)
	})
}
