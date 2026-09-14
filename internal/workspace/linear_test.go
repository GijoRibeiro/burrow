package workspace

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type linearTransport func(*http.Request) (*http.Response, error)

func (f linearTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLinearWorktreeLifecycle(t *testing.T) {
	old := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: linearTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.linear.app" {
			t.Fatalf("unexpected destination: %s", r.URL.Host)
		}
		code := 200
		body := `{"data":{"viewer":{"id":"viewer","name":"Fixture User"}}}`
		if r.Header.Get("Authorization") != "fixture-linear-key" {
			code = 401
			body = `{"error":"invalid key"}`
		} else {
			var input struct {
				Query     string
				Variables map[string]string
			}
			json.NewDecoder(r.Body).Decode(&input)
			if strings.Contains(input.Query, "WorktreeIssue(") {
				if input.Variables["id"] != "ENG-42" {
					t.Fatalf("wrong lookup: %v", input.Variables)
				}
				body = `{"data":{"issue":{"id":"issue-42","identifier":"ENG-42","title":"Fix menu","url":"https://linear.app/test/issue/ENG-42/fix-menu","description":"Fix the keyboard menu.","state":{"name":"Todo"}}}}`
			} else if strings.Contains(input.Query, "WorktreeAssigned") {
				body = `{"data":{"viewer":{"assignedIssues":{"nodes":[]}}}}`
			}
		}
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = old })
	m := manager(t)
	p, err := m.AddProject(repo(t), "Linear project")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "http://localhost/api/workspace"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		m.Handler().ServeHTTP(w, r)
		return w
	}
	if w := request("POST", "/projects/"+p.ID+"/worktrees", `{"name":"no-key","base":"HEAD","issueID":"ENG-42"}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request("POST", "/linear", `{"apiKey":"fixture-linear-key"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(m.file), "linear.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("credential permissions: %v %v", info, err)
	}
	for _, path := range []string{"/linear", "/linear/issues"} {
		w := request("GET", path, "")
		if w.Code != 200 || strings.Contains(w.Body.String(), "fixture-linear-key") {
			t.Fatalf("bad status or leaked key: %d", w.Code)
		}
	}
	if w := request("POST", "/linear", `{"apiKey":"wrong-key"}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if key, _ := m.linearKey(); key != "fixture-linear-key" {
		t.Fatal("failed authentication overwrote working key")
	}
	w := request("POST", "/projects/"+p.ID+"/worktrees", `{"name":"eng-42-fix-menu","base":"HEAD","issueID":"https://linear.app/test/issue/ENG-42/fix-menu"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var tree Worktree
	json.Unmarshal(w.Body.Bytes(), &tree)
	if tree.Issue == nil || tree.Issue.Identifier != "ENG-42" {
		t.Fatal("missing issue")
	}
	reloaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	state := reloaded.Snapshot()
	found := false
	for _, w := range state.Projects[0].Worktrees {
		if w.Path == tree.Path {
			found = w.Issue != nil && w.Issue.Description == "Fix the keyboard menu."
		}
	}
	if !found {
		t.Fatal("issue link did not survive reload")
	}
	saved, _ := os.ReadFile(m.file)
	if bytes.Contains(saved, []byte("fixture-linear-key")) {
		t.Fatal("key leaked into workspace state")
	}
	if err = reloaded.RemoveWorktree(p.ID, tree.Path); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.state.WorktreeIssues) != 0 {
		t.Fatal("removed worktree retained issue")
	}
	if w := request("DELETE", "/linear", ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if key, _ := m.linearKey(); key != "" {
		t.Fatal("disconnect retained key")
	}
}
