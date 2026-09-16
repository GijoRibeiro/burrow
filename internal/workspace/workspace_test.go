package workspace

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func repo(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	for _, args := range [][]string{{"init", "-b", "main"}, {"config", "user.email", "test@localhost"}, {"config", "user.name", "Workspace Test"}, {"commit", "--allow-empty", "-m", "Initial"}} {
		if _, err := git(p, args...); err != nil {
			t.Fatal(err)
		}
	}
	p, _ = canonical(p)
	return p
}
func manager(t *testing.T) *Manager {
	t.Helper()
	m, err := New(filepath.Join(t.TempDir(), "workspace.json"), "cw-test-"+id())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", "/bin/sh")
	t.Cleanup(func() { m.tmux("kill-server") })
	return m
}
func requireTmux(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
}
func TestProjectsAndWorktrees(t *testing.T) {
	m := manager(t)
	root := repo(t)
	p, err := m.AddProject(root, "Checkout")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := m.CreateWorktree(p.ID, "redesign", "main")
	if err != nil {
		t.Fatal(err)
	}
	if status, err := git(root, "status", "--porcelain"); err != nil || status != "" {
		t.Fatalf("managed worktree dirtied project: %q %v", status, err)
	}
	again, err := m.AddProject(wt.Path, "")
	if err != nil || again.ID != p.ID {
		t.Fatalf("linked worktree should resolve to project: %+v %v", again, err)
	}
	external := filepath.Join(t.TempDir(), "insurance")
	if _, err := git(root, "worktree", "add", "-b", "insurance", external); err != nil {
		t.Fatal(err)
	}
	snapshot := m.Snapshot()
	if len(snapshot.Projects) != 1 || len(snapshot.Projects[0].Worktrees) != 3 {
		t.Fatalf("must discover external worktrees: %+v", snapshot)
	}
	loaded, err := New(m.file, m.socket)
	if err != nil || len(loaded.Snapshot().Projects) != 1 {
		t.Fatalf("persistence: %v", err)
	}
	for _, name := range []string{"../escape", "-flag", "bad name", "thing:other", ".hidden"} {
		if _, err := m.CreateWorktree(p.ID, name, "HEAD"); err == nil {
			t.Errorf("accepted invalid name %q", name)
		}
	}
	if _, err := m.CreateWorktree(p.ID, "bad-base", "--help"); err == nil {
		t.Error("accepted invalid base")
	}
	if err := os.WriteFile(filepath.Join(wt.Path, "dirty.txt"), []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.RemoveWorktree(p.ID, wt.Path); err == nil {
		t.Fatal("removed dirty worktree")
	}
	if err := m.RemoveWorktree(p.ID, root); err == nil {
		t.Fatal("removed main checkout")
	}
	if err := m.RemoveWorktree(p.ID, external); err != nil {
		t.Fatal(err)
	}
	if _, err := git(root, "rev-parse", "--verify", "insurance"); err != nil {
		t.Fatal("removing worktree deleted its branch")
	}
}
func TestTerminalLifecycleAndReload(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	root := repo(t)
	p, err := m.AddProject(root, "")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateTerminal(p.ID, root, "Shell")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.CreateTerminal(p.ID, t.TempDir(), "outside"); err == nil {
		t.Fatal("accepted unrelated folder")
	}
	if err = m.RemoveProject(p.ID); err == nil {
		t.Fatal("removed project with terminal")
	}
	if err = m.UpdateTerminal(term.ID, "restart", ""); err == nil {
		t.Fatal("restarted live terminal")
	}
	if err = m.UpdateTerminal(term.ID, "rename", "Builder"); err != nil {
		t.Fatal(err)
	}
	reloaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	got := reloaded.Snapshot().Terminals[0]
	if got.Status != "running" || got.Name != "Builder" {
		t.Fatalf("reload lost running terminal: %+v", got)
	}
	if err = m.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	if status := m.Snapshot().Terminals[0].Status; status != "stopped" {
		t.Fatal(status)
	}
	if err = m.UpdateTerminal(term.ID, "restart", ""); err != nil {
		t.Fatal(err)
	}
	if err = m.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	if err = m.UpdateTerminal(term.ID, "remove", ""); err != nil {
		t.Fatal(err)
	}
	if err = m.RemoveProject(p.ID); err != nil {
		t.Fatal(err)
	}
}
func connectTest(t *testing.T, server *httptest.Server, id string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/workspace/terminals/"+id+"/connect?cols=100&rows=30", nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}
func sendTest(t *testing.T, c *websocket.Conn, text string) {
	t.Helper()
	if err := c.WriteJSON(map[string]any{"type": "input", "data": text}); err != nil {
		t.Fatal(err)
	}
}
func readUntil(t *testing.T, c *websocket.Conn, want string) string {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(8 * time.Second))
	var all strings.Builder
	for {
		_, b, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %q: %v; output: %q", want, err, all.String())
		}
		all.Write(b)
		if strings.Contains(all.String(), want) {
			return all.String()
		}
	}
}
func TestLiveTerminalResizeDisconnectAndDaemonRestart(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	root := repo(t)
	p, err := m.AddProject(root, "checkout")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateTerminal(p.ID, root, "live")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	c := connectTest(t, server, term.ID)
	sendTest(t, c, "printf 'CW-%s\\n' 'ready'\r")
	readUntil(t, c, "CW-ready")
	sendTest(t, c, "pwd\r")
	readUntil(t, c, root)
	if err := c.WriteJSON(map[string]any{"type": "resize", "cols": 72, "rows": 18}); err != nil {
		t.Fatal(err)
	}
	// tmux applies a SIGWINCH asynchronously; wait until the shell sees its size.
	sendTest(t, c, "while [ \"$(stty size)\" != '18 72' ]; do sleep .05; done; printf 'RESIZE-%s\\n' 'ok'\r")
	readUntil(t, c, "RESIZE-ok")
	sendTest(t, c, "export CLOOVIES_TEST_VALUE=survived; printf 'SET-%s\\n' 'ok'\r")
	readUntil(t, c, "SET-ok")
	c.Close()
	server.Close()
	reloaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	second := httptest.NewServer(reloaded.Handler())
	defer second.Close()
	c2 := connectTest(t, second, term.ID)
	defer c2.Close()
	sendTest(t, c2, "printf 'PERSIST-%s\\n' \"$CLOOVIES_TEST_VALUE\"\r")
	readUntil(t, c2, "PERSIST-survived")
	if err := m.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
}
func TestOriginAndInvalidRequests(t *testing.T) {
	m := manager(t)
	h := m.Handler()
	for _, tt := range []struct {
		method, path, host, origin, content string
		code                                int
	}{
		{"GET", "/api/workspace", "evil.example", "", "", 403},
		{"GET", "/api/workspace", "localhost:3333", "https://evil.example", "", 403},
		{"POST", "/api/workspace/projects", "localhost:3333", "", "text/plain", 415},
		{"GET", "/api/workspace", "localhost:3333", "http://localhost:3333", "", 200},
		{"POST", "/api/workspace/projects", "localhost:3333", "", "application/json", 400},
	} {
		r := httptest.NewRequest(tt.method, "http://"+tt.host+tt.path, strings.NewReader("{}"))
		r.Host = tt.host
		r.Header.Set("Origin", tt.origin)
		r.Header.Set("Content-Type", tt.content)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tt.code {
			t.Errorf("%+v: %d %s", tt, w.Code, w.Body.String())
		}
	}
}
func TestCorruptStateIsNotOverwritten(t *testing.T) {
	file := filepath.Join(t.TempDir(), "workspace.json")
	os.WriteFile(file, []byte("not json"), 0600)
	if _, err := New(file, "test"); err == nil {
		t.Fatal("accepted corrupt state")
	}
	b, _ := os.ReadFile(file)
	if string(b) != "not json" {
		t.Fatal("overwrote corrupt state")
	}
}
func TestSaveFailureRollsBack(t *testing.T) {
	m := manager(t)
	m.file = filepath.Join(m.file, "nested", "workspace.json")
	os.WriteFile(filepath.Dir(filepath.Dir(m.file)), []byte("block"), 0600)
	_, err := m.AddProject(repo(t), "")
	if err == nil {
		t.Fatal("expected save failure")
	}
	if len(m.state.Projects) != 0 {
		t.Fatal("failed save left ghost project")
	}
}
func TestSnapshotJSONHasArrays(t *testing.T) {
	m := manager(t)
	b, _ := json.Marshal(m.Snapshot())
	if strings.Contains(string(b), "null") {
		t.Fatal(string(b))
	}
}

func TestAgentLaunchAndRestartUseYOLO(t *testing.T) {
	requireTmux(t)
	for _, program := range []string{"claude", "codex"} {
		t.Run(program, func(t *testing.T) {
			m := manager(t)
			bin := t.TempDir()
			// Record argv from the actual process started inside tmux.
			script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nexec /bin/cat\n"
			if err := os.WriteFile(filepath.Join(bin, program), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			p, err := m.AddProject(repo(t), "Agent test")
			if err != nil {
				t.Fatal(err)
			}
			terminal, err := m.CreateProgramTerminal(p.ID, p.Path, "Agent with spaces", program)
			if err != nil {
				t.Fatal(err)
			}
			flag := "--dangerously-skip-permissions"
			if program == "codex" {
				flag = "--dangerously-bypass-approvals-and-sandbox"
			}
			for pass := 0; pass < 2; pass++ {
				var data []byte
				deadline := time.Now().Add(3 * time.Second)
				for time.Now().Before(deadline) {
					data, _ = os.ReadFile(filepath.Join(bin, program) + ".args")
					if len(data) > 0 {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				args := strings.Split(strings.TrimSpace(string(data)), "\n")
				if len(args) == 0 || args[0] != flag {
					t.Fatalf("%s launch %d: %q", program, pass, args)
				}
				if program == "claude" && (len(args) != 3 || args[1] != "--name" || args[2] != terminal.Name) {
					t.Fatalf("name was not preserved: %q", args)
				}
				if program == "codex" {
					activity, err := m.Activity(terminal.ID)
					if err != nil || activity.Kind != "codex" || activity.CanMessage {
						t.Fatalf("Codex misidentified: %+v %v", activity, err)
					}
				}
				if pass == 0 {
					if err := m.UpdateTerminal(terminal.ID, "stop", ""); err != nil {
						t.Fatal(err)
					}
					os.Remove(filepath.Join(bin, program) + ".args")
					loaded, err := New(m.file, m.socket)
					if err != nil {
						t.Fatal(err)
					}
					if err := loaded.UpdateTerminal(terminal.ID, "restart", ""); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
}
