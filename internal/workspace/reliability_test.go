package workspace

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Scrollback and key handling are tmux server options. They must be in force
// for the first window, not only for windows created after the session.
func TestTmuxSessionsGetScrollbackAndNoPrefix(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	p, err := m.AddProject(repo(t), "")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateTerminal(p.ID, p.Path, "Shell")
	if err != nil {
		t.Fatal(err)
	}
	limit, err := m.tmux("display-message", "-p", "-t", "="+sessionName(term.ID)+":", "#{history_limit}")
	if err != nil || limit != "20000" {
		t.Fatalf("first window history limit %q %v", limit, err)
	}
	prefix, _ := m.tmux("show-options", "-gv", "prefix")
	if prefix != "None" {
		t.Fatalf("tmux prefix must not capture Ctrl-B: %q", prefix)
	}
	escape, _ := m.tmux("show-options", "-gsv", "escape-time")
	if escape != "10" {
		t.Fatalf("escape-time %q", escape)
	}
}

func writeAgentFixture(t *testing.T, bin, program, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(bin, program), []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
}
func waitArgs(t *testing.T, path string) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, _ := os.ReadFile(path); len(data) > 0 {
			return strings.Split(strings.TrimSpace(string(data)), "\n")
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("agent never launched: %s", path)
	return nil
}

// Restarting Claude after a stop or reboot must continue its conversation,
// never replay the opening prompt as a fresh session.
func TestClaudeRestartResumesDiscoveredSession(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	bin := t.TempDir()
	config := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	// Record argv, publish session metadata like Claude, then keep running.
	writeAgentFixture(t, bin, "claude", `#!/bin/sh
printf '%s\n' "$@" > "$0.args"
mkdir -p "$CLAUDE_CONFIG_DIR/sessions" "$CLAUDE_CONFIG_DIR/projects/fixture"
printf '{"pid":%s,"sessionId":"fixture-session-1","cwd":"%s","status":"idle"}' "$$" "$PWD" > "$CLAUDE_CONFIG_DIR/sessions/$$.json"
: > "$CLAUDE_CONFIG_DIR/projects/fixture/fixture-session-1.jsonl"
exec /bin/cat
`)
	p, err := m.AddProject(repo(t), "")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateProgramTerminal(p.ID, p.Path, "Agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	first := waitArgs(t, filepath.Join(bin, "claude.args"))
	if strings.Contains(strings.Join(first, " "), "--resume") {
		t.Fatalf("fresh launch must not resume: %q", first)
	}
	deadline := time.Now().Add(5 * time.Second)
	var seen Terminal
	for time.Now().Before(deadline) {
		for _, candidate := range m.Snapshot().Terminals {
			if candidate.ID == term.ID {
				seen = candidate
			}
		}
		if seen.SessionID != "" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if seen.SessionID != "fixture-session-1" {
		t.Fatalf("session was not discovered from the live pane: %+v", seen)
	}
	if err := m.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(bin, "claude.args"))
	reloaded, err := New(m.file, m.socket)
	if err != nil {
		t.Fatal(err)
	}
	if err := reloaded.UpdateTerminal(term.ID, "restart", ""); err != nil {
		t.Fatal(err)
	}
	second := waitArgs(t, filepath.Join(bin, "claude.args"))
	joined := strings.Join(second, " ")
	if !strings.Contains(joined, "--resume fixture-session-1") || !strings.Contains(joined, "--dangerously-skip-permissions") {
		t.Fatalf("restart must resume the recorded session in YOLO mode: %q", second)
	}
	// Without a transcript the session cannot be resumed; start fresh instead.
	if err := reloaded.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(bin, "claude.args"))
	os.Remove(filepath.Join(config, "projects/fixture/fixture-session-1.jsonl"))
	if err := reloaded.UpdateTerminal(term.ID, "restart", ""); err != nil {
		t.Fatal(err)
	}
	third := waitArgs(t, filepath.Join(bin, "claude.args"))
	if strings.Contains(strings.Join(third, " "), "--resume") {
		t.Fatalf("missing transcript must not be resumed: %q", third)
	}
}

func TestCodexRestartResumesDiscoveredThread(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	bin := t.TempDir()
	home := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	thread := "0f3c2d1e-1111-4222-8333-444455556666"
	locks := filepath.Join(home, "thread-writer-locks")
	os.MkdirAll(locks, 0700)
	// Hold the writer lock from a process named codex, like the real CLI.
	writeAgentFixture(t, bin, "codex", "#!/bin/bash\nprintf '%s\\n' \"$@\" > \"$0.args\"\nexec 7>'"+filepath.Join(locks, thread+".lock")+"'\nexec -a codex /bin/cat\n")
	p, err := m.AddProject(repo(t), "")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateProgramTerminal(p.ID, p.Path, "Codex", "codex")
	if err != nil {
		t.Fatal(err)
	}
	waitArgs(t, filepath.Join(bin, "codex.args"))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		m.Activity(term.ID)
		if current, _ := m.Terminal(term.ID); current.SessionID == thread {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if current, _ := m.Terminal(term.ID); current.SessionID != thread {
		t.Fatalf("thread was not recorded: %+v", current)
	}
	if err := m.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(bin, "codex.args"))
	if err := m.UpdateTerminal(term.ID, "restart", ""); err != nil {
		t.Fatal(err)
	}
	args := waitArgs(t, filepath.Join(bin, "codex.args"))
	if len(args) < 3 || args[0] != "resume" || args[1] != thread || !strings.Contains(strings.Join(args, " "), "--dangerously-bypass-approvals-and-sandbox") {
		t.Fatalf("codex restart must resume its thread: %q", args)
	}
}

// A browser cannot read the HTTP status of a failed upgrade, so a missing tmux
// session must close the socket with a distinct code instead of a 410 page.
func TestConnectToStoppedTerminalClosesWithCode(t *testing.T) {
	requireTmux(t)
	m := manager(t)
	p, err := m.AddProject(repo(t), "")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateTerminal(p.ID, p.Path, "Shell")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateTerminal(term.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	c := connectTest(t, server, term.ID)
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = c.ReadMessage()
	closeErr, ok := err.(*websocket.CloseError)
	if !ok || closeErr.Code != closeTerminalStopped {
		t.Fatalf("expected close code %d, got %v", closeTerminalStopped, err)
	}
}

// Idle terminals produce no output, so liveness needs explicit pings in both
// directions: a client that stops answering is dropped and its attach client freed.
func TestTerminalSocketKeepalive(t *testing.T) {
	requireTmux(t)
	oldPing, oldWait := pingInterval, pongWait
	pingInterval, pongWait = 100*time.Millisecond, 400*time.Millisecond
	t.Cleanup(func() { pingInterval, pongWait = oldPing, oldWait })
	m := manager(t)
	p, err := m.AddProject(repo(t), "")
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.CreateTerminal(p.ID, p.Path, "Shell")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	readPing := func(c *websocket.Conn) bool {
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		for {
			kind, data, err := c.ReadMessage()
			if err != nil {
				return false
			}
			var msg struct{ Type string }
			if kind == websocket.TextMessage && json.Unmarshal(data, &msg) == nil && msg.Type == "ping" {
				return true
			}
		}
	}
	silent := connectTest(t, server, term.ID)
	defer silent.Close()
	if !readPing(silent) {
		t.Fatal("server never pinged an idle client")
	}
	silent.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := silent.ReadMessage(); err != nil {
			if _, timeout := err.(interface{ Timeout() bool }); timeout && err.(interface{ Timeout() bool }).Timeout() {
				t.Fatal("unresponsive client was never dropped")
			}
			break
		}
	}
	healthy := connectTest(t, server, term.ID)
	defer healthy.Close()
	for i := 0; i < 8; i++ {
		if !readPing(healthy) {
			t.Fatalf("responsive client dropped after %d pings", i)
		}
		if err := healthy.WriteJSON(map[string]string{"type": "pong"}); err != nil {
			t.Fatal(err)
		}
	}
	sendTest(t, healthy, "printf 'ALIVE-%s\\n' 'yes'\r")
	readUntil(t, healthy, "ALIVE-yes")
}

func TestHealthReportsVersionAndShutdownStopsServer(t *testing.T) {
	m, err := New(filepath.Join(t.TempDir(), "workspace.json"), "unused")
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{}, 1)
	m.OnShutdown(func() { stopped <- struct{}{} })
	h := m.Handler()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1/api/workspace/health", nil))
	var health struct {
		Service, Version string
		PID              int
	}
	if json.Unmarshal(w.Body.Bytes(), &health) != nil || health.Version == "" || health.PID != os.Getpid() {
		t.Fatalf("health: %s", w.Body.String())
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1/api/workspace/shutdown", strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("shutdown: %d %s", w.Code, w.Body.String())
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not stop the server")
	}
}
