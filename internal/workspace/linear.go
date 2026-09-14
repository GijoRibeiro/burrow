package workspace

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gijo/cloovies/internal/linear"
)

// Credentials stay outside workspace snapshots and are never returned to the UI.
func (m *Manager) linearKey() (string, error) {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(m.file), "linear.json"))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var config struct {
		APIKey string `json:"apiKey"`
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return "", err
	}
	return config.APIKey, nil
}
func (m *Manager) saveLinearKey(key string) error {
	dir := filepath.Dir(m.file)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, _ := json.Marshal(map[string]string{"apiKey": key})
	file, err := os.CreateTemp(dir, ".linear-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(dir, "linear.json"))
}
func (m *Manager) linearRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/linear", func(w http.ResponseWriter, r *http.Request) {
		key, err := m.linearKey()
		respond(w, map[string]bool{"connected": key != ""}, err)
	})
	mux.HandleFunc("POST /api/workspace/linear", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			APIKey string `json:"apiKey"`
		}
		if !decode(w, r, &v) {
			return
		}
		v.APIKey = strings.TrimSpace(v.APIKey)
		if v.APIKey == "" {
			respond(w, nil, errors.New("enter a Linear personal API key"))
			return
		}
		viewer, err := linear.TestKey(v.APIKey)
		if err == nil {
			err = m.saveLinearKey(v.APIKey)
		}
		respond(w, map[string]any{"connected": err == nil, "name": viewer.Name}, err)
	})
	mux.HandleFunc("DELETE /api/workspace/linear", func(w http.ResponseWriter, r *http.Request) { respond(w, nil, m.saveLinearKey("")) })
	mux.HandleFunc("GET /api/workspace/linear/issues", func(w http.ResponseWriter, r *http.Request) {
		key, err := m.linearKey()
		if err == nil && key == "" {
			err = errors.New("connect Linear to find your issues")
		}
		if err != nil {
			respond(w, nil, err)
			return
		}
		rows, err := linear.SearchWorktreeIssues(key, r.URL.Query().Get("q"))
		respond(w, rows, err)
	})
}

func (m *Manager) CreateLinkedWorktree(projectID, name, base, issueID string) (Worktree, error) {
	var issue *linear.WorktreeIssue
	if issueID != "" {
		key, err := m.linearKey()
		if err != nil {
			return Worktree{}, err
		}
		if key == "" {
			return Worktree{}, errors.New("connect Linear before creating a worktree from an issue")
		}
		linked, err := linear.GetWorktreeIssue(key, issueID)
		if err != nil {
			return Worktree{}, err
		}
		issue = &linked
	}
	return m.createWorktree(projectID, name, base, issue)
}
