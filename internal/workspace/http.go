package workspace

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Local requests only. Mutations require same-origin JSON, preventing websites
// from opening shells through a user's localhost service.
func localRequest(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host {
			return false
		}
	}
	return true
}
func (m *Manager) Handler() http.Handler {
	mux := http.NewServeMux()
	m.linearRoutes(mux)
	m.setupRoutes(mux)
	m.coordinationRoutes(mux)
	m.teamRoutes(mux)
	m.githubRoutes(mux)
	m.complaintRoutes(mux)
	mux.HandleFunc("GET /api/workspace/servers", func(w http.ResponseWriter, r *http.Request) {
		apps, err := m.hostedApps(r.Context())
		respond(w, apps, err)
	})
	// Native readiness must not scan repositories or start external processes.
	mux.HandleFunc("GET /api/workspace/health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]string{"service": "cloovies-workspace"}, nil)
	})
	mux.HandleFunc("GET /api/workspace", func(w http.ResponseWriter, r *http.Request) { respond(w, m.Snapshot(), nil) })
	mux.HandleFunc("POST /api/workspace/projects", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Path, Name string }
		if !decode(w, r, &v) {
			return
		}
		p, e := m.AddProject(v.Path, v.Name)
		respond(w, p, e)
	})
	mux.HandleFunc("DELETE /api/workspace/projects/{id}", func(w http.ResponseWriter, r *http.Request) { respond(w, nil, m.RemoveProject(r.PathValue("id"))) })
	mux.HandleFunc("POST /api/workspace/projects/{id}/git", func(w http.ResponseWriter, r *http.Request) {
		p, err := m.InitializeProjectGit(r.PathValue("id"))
		respond(w, p, err)
	})
	mux.HandleFunc("POST /api/workspace/projects/{id}/worktrees", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Name, Base, IssueID, ParentPath string }
		if !decode(w, r, &v) {
			return
		}
		p, e := m.CreateLinkedWorktree(r.PathValue("id"), v.Name, v.Base, v.IssueID, v.ParentPath)
		respond(w, p, e)
	})
	mux.HandleFunc("DELETE /api/workspace/projects/{id}/worktrees", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Path string }
		if !decode(w, r, &v) {
			return
		}
		respond(w, nil, m.RemoveWorktree(r.PathValue("id"), v.Path))
	})
	mux.HandleFunc("POST /api/workspace/terminals", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			ProjectID           string `json:"projectId"`
			Path, Name, Program string
		}
		if !decode(w, r, &v) {
			return
		}
		t, e := m.CreateProgramTerminal(v.ProjectID, v.Path, v.Name, v.Program)
		respond(w, t, e)
	})
	mux.HandleFunc("PATCH /api/workspace/terminals/{id}", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Action, Name string }
		if !decode(w, r, &v) {
			return
		}
		respond(w, nil, m.UpdateTerminal(r.PathValue("id"), v.Action, v.Name))
	})
	mux.HandleFunc("POST /api/workspace/terminals/{id}/message", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Text   string
			Images []string
		}
		if !decode(w, r, &v) {
			return
		}
		respond(w, nil, m.SendChatMessage(r.PathValue("id"), v.Text, v.Images))
	})
	mux.HandleFunc("GET /api/workspace/terminals/{id}/activity", func(w http.ResponseWriter, r *http.Request) {
		query := conversationQuery{Limit: conversationPageSize, Session: r.URL.Query().Get("session")}
		for name, target := range map[string]**int{"before": &query.Before, "after": &query.After} {
			if raw := r.URL.Query().Get(name); raw != "" {
				value, err := strconv.Atoi(raw)
				if err != nil || value < 0 {
					http.Error(w, "invalid history cursor", http.StatusBadRequest)
					return
				}
				*target = &value
			}
		}
		if query.Before != nil && query.After != nil {
			http.Error(w, "choose one history cursor", http.StatusBadRequest)
			return
		}
		activity, err := m.activity(r.PathValue("id"), query)
		respond(w, activity, err)
	})
	mux.HandleFunc("GET /api/workspace/terminals/{id}/connect", m.connect)
	mux.HandleFunc("GET /api/workspace/terminals/{id}/image", m.terminalImage)
	mux.HandleFunc("POST /api/workspace/terminals/{id}/images", m.uploadImage)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !localRequest(r) {
			http.Error(w, "workspace accepts same-origin local requests only", http.StatusForbidden)
			return
		}
		if r.Method != "GET" && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "JSON content type required", http.StatusUnsupportedMediaType)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		respond(w, nil, errors.New("invalid request body"))
		return false
	}
	return true
}
func respond(w http.ResponseWriter, v any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if v == nil {
		v = map[string]bool{"ok": true}
	}
	json.NewEncoder(w).Encode(v)
}
