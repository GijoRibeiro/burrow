package workspace

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/gijo/cloovies/internal/linear"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type AgentRuntime struct {
	URL       string `json:"url"`
	StateFile string `json:"stateFile"`
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func (m *Manager) ConfigureAgentRuntime(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		return errors.New("agent runtime must use a loopback HTTP endpoint")
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Join(filepath.Dir(m.file), "bin")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	runtimeFile := filepath.Join(filepath.Dir(m.file), "agent-runtime.json")
	data, _ := json.Marshal(AgentRuntime{URL: endpoint, StateFile: m.file})
	if err = writePrivate(runtimeFile, data, 0600); err != nil {
		return err
	}
	cli := filepath.Join(dir, "burrow")
	if err = writePrivate(cli, []byte("#!/bin/sh\nexec "+shellQuote(binary)+" agent --runtime "+shellQuote(runtimeFile)+" \"$@\"\n"), 0700); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runtimeURL = endpoint
	m.cliPath = cli
	if m.state.AgentTokens == nil {
		m.state.AgentTokens = map[string]string{}
	}
	for _, t := range m.state.Terminals {
		if isAgent(t) && m.state.AgentTokens[t.ID] == "" {
			m.state.AgentTokens[t.ID] = id() + id()
		}
	}
	return m.save()
}
func writePrivate(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".agent-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
func (m *Manager) authenticatedAgent(r *http.Request) (Terminal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := r.Header.Get("X-Burrow-Agent")
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	expected := m.state.AgentTokens[id]
	if expected == "" || subtle.ConstantTimeCompare([]byte(expected), []byte(token)) != 1 {
		return Terminal{}, errors.New("invalid agent credentials")
	}
	t, err := m.terminal(id)
	if err != nil || !isAgent(t) {
		return Terminal{}, errors.New("agent is unavailable")
	}
	return t, nil
}
func (m *Manager) coordinationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/coordination", func(w http.ResponseWriter, r *http.Request) { respond(w, m.Coordination(), nil) })
	mux.HandleFunc("POST /api/workspace/tasks", func(w http.ResponseWriter, r *http.Request) {
		var v DelegateRequest
		if !decode(w, r, &v) {
			return
		}
		t, e := m.Delegate(v)
		respond(w, t, e)
	})
	mux.HandleFunc("PATCH /api/workspace/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Status, Summary string }
		if !decode(w, r, &v) {
			return
		}
		t, e := m.UpdateTask("user", r.PathValue("id"), v.Status, v.Summary)
		respond(w, t, e)
	})
	mux.HandleFunc("GET /api/workspace/tasks/{id}/review", func(w http.ResponseWriter, r *http.Request) {
		v, e := m.ReviewTask(r.PathValue("id"))
		respond(w, v, e)
	})
	mux.HandleFunc("POST /api/workspace/tasks/{id}/integrate", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Commit, ParentCommit string }
		if !decode(w, r, &v) {
			return
		}
		t, e := m.IntegrateTask(r.PathValue("id"), v.Commit, v.ParentCommit)
		respond(w, t, e)
	})
	mux.HandleFunc("POST /api/workspace/messages", func(w http.ResponseWriter, r *http.Request) {
		var v struct{ To, TaskID, Text string }
		if !decode(w, r, &v) {
			return
		}
		msg, e := m.SendCoordinationMessage("user", v.To, v.TaskID, v.Text)
		respond(w, msg, e)
	})
	mux.HandleFunc("POST /api/workspace/agent", m.agentAction)
}

type AgentAction struct {
	Query     string           `json:"query,omitempty"`
	Plan      *PlanRequest     `json:"plan,omitempty"`
	Action    string           `json:"action"`
	To        string           `json:"to,omitempty"`
	Text      string           `json:"text,omitempty"`
	MessageID string           `json:"messageId,omitempty"`
	TaskID    string           `json:"taskId,omitempty"`
	Status    string           `json:"status,omitempty"`
	Delegate  *DelegateRequest `json:"delegate,omitempty"`
}

func (m *Manager) agentAction(w http.ResponseWriter, r *http.Request) {
	actor, err := m.authenticatedAgent(r)
	if err != nil {
		http.Error(w, "invalid agent credentials", http.StatusUnauthorized)
		return
	}
	var v AgentAction
	if !decode(w, r, &v) {
		return
	}
	if v.TaskID == "" {
		v.TaskID = actor.TaskID
	}
	switch v.Action {
	case "linear":
		key, e := m.linearKey()
		if e != nil {
			respond(w, nil, e)
			return
		}
		rows, e := linear.SearchWorktreeIssues(key, v.Query)
		respond(w, rows, e)
	case "issue":
		key, e := m.linearKey()
		if e != nil {
			respond(w, nil, e)
			return
		}
		row, e := linear.GetWorktreeIssue(key, v.Query)
		respond(w, row, e)
	case "plans":
		m.mu.Lock()
		rows := []TeamPlan{}
		for _, p := range clonePlans(m.state.Plans) {
			if p.HeadID == actor.ID {
				rows = append(rows, p)
			}
		}
		m.mu.Unlock()
		respond(w, rows, nil)
	case "start":
		m.mu.Lock()
		plan, e := m.teamPlan(v.Query)
		m.mu.Unlock()
		if e != nil || actor.Role != "head" || plan.HeadID != actor.ID {
			respond(w, nil, errors.New("choose a team belonging to this head"))
			return
		}
		plan, e = m.StartPlan(plan.ID)
		respond(w, plan, e)
	case "propose":
		if v.Plan == nil {
			respond(w, nil, errors.New("provide a plan"))
			return
		}
		plan, e := m.ProposePlan(actor.ID, *v.Plan)
		respond(w, plan, e)

	case "inbox":
		respond(w, m.Inbox(actor.ID), nil)
	case "ack":
		respond(w, nil, m.Acknowledge(actor.ID, v.MessageID))
	case "team":
		rows := []Terminal{}
		snapshot := m.Snapshot()
		headID := actor.HeadID
		if actor.Role == "head" {
			headID = actor.ID
		}
		if headID == "" && actor.TaskID != "" {
			for _, task := range snapshot.Tasks {
				if task.ID == actor.TaskID {
					headID = task.ParentID
				}
			}
		}
		for _, t := range snapshot.Terminals {
			belongs := t.ID == actor.ID || (headID != "" && (t.ID == headID || t.HeadID == headID))
			for _, task := range snapshot.Tasks {
				if headID != "" && task.ParentID == headID && task.AgentID == t.ID {
					belongs = true
				}
			}
			if isAgent(t) && belongs {
				rows = append(rows, t)
			}
		}
		respond(w, rows, nil)
	case "agents":
		rows := []Terminal{}
		for _, t := range m.Snapshot().Terminals {
			if isAgent(t) {
				rows = append(rows, t)
			}
		}
		respond(w, rows, nil)
	case "tasks":
		rows := []Task{}
		for _, t := range m.Coordination().Tasks {
			if t.AgentID == actor.ID || t.ParentID == actor.ID {
				rows = append(rows, t)
			}
		}
		respond(w, rows, nil)
	case "task":
		m.mu.Lock()
		t, e := m.task(v.TaskID)
		m.mu.Unlock()
		respond(w, t, e)
	case "send":
		if v.To == "parent" && actor.HeadID != "" {
			v.To = actor.HeadID
		}
		if v.To == "parent" {
			m.mu.Lock()
			t, e := m.task(actor.TaskID)
			m.mu.Unlock()
			if e != nil {
				respond(w, nil, e)
				return
			}
			v.To = t.ParentID
		}
		msg, e := m.SendCoordinationMessage(actor.ID, v.To, v.TaskID, v.Text)
		respond(w, msg, e)
	case "status":
		t, e := m.UpdateTask(actor.ID, v.TaskID, v.Status, v.Text)
		respond(w, t, e)
	case "delegate":
		if v.Delegate == nil {
			respond(w, nil, errors.New("provide a task"))
			return
		}
		v.Delegate.ParentID = actor.ID
		t, e := m.Delegate(*v.Delegate)
		respond(w, t, e)
	default:
		respond(w, nil, errors.New("unknown agent action"))
	}
}
