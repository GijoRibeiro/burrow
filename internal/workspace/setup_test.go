package workspace

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSetupWithoutDependenciesAndAfterInstallation(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	state := setupStatus()
	for _, name := range []string{"git", "tmux", "claude", "codex", "ready"} {
		if state[name] != false {
			t.Fatalf("%s unexpectedly available: %v", name, state)
		}
	}
	m, err := New(filepath.Join(t.TempDir(), "workspace.json"), "unused-setup-fixture")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/workspace", "/api/workspace/setup"} {
		response := httptest.NewRecorder()
		m.Handler().ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1"+path, nil))
		if response.Code != 200 {
			t.Fatalf("setup must open without tools: %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	for _, name := range []string{"git", "tmux", "codex"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	state = setupStatus()
	if state["ready"] != true || state["codex"] != true || state["claude"] != false {
		t.Fatalf("new tools not detected: %v", state)
	}
}

func TestSetupReportsVersionsAndPaths(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	for name, version := range map[string]string{"git": "git version 2.45.0", "tmux": "tmux 3.8", "claude": "2.1.0 (Claude Code)", "gh": "gh version 2.60.0 (2026-01-01)\nhttps://github.com/cli/cli/releases"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	state := setupStatus()
	tools, ok := state["tools"].(map[string]toolStatus)
	if !ok {
		t.Fatalf("missing tools: %v", state)
	}
	if tools["git"].Version != "2.45.0" || tools["git"].Path != filepath.Join(bin, "git") || !tools["git"].Installed {
		t.Fatalf("git: %+v", tools["git"])
	}
	if tools["tmux"].Version != "3.8" || tools["claude"].Version != "2.1.0" || tools["gh"].Version != "2.60.0" {
		t.Fatalf("versions: %+v", tools)
	}
	if tools["codex"].Installed || tools["codex"].Version != "" {
		t.Fatalf("codex should be missing: %+v", tools["codex"])
	}
	if state["git"] != true || state["codex"] != false {
		t.Fatalf("legacy flags must remain: %v", state)
	}
}

func TestInstallerStreamsScriptOutputAndRefusesUnknownTools(t *testing.T) {
	m, err := New(filepath.Join(t.TempDir(), "workspace.json"), "unused-installer")
	if err != nil {
		t.Fatal(err)
	}
	m.SetInstaller([]byte("#!/bin/bash\nprintf 'INSTALL-%s rows=%s\\n' \"$1\" \"$(stty size | cut -d' ' -f1)\"\nread -r answer\nprintf 'GOT-%s\\n' \"$answer\"\n"))
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	dial := func(tool string) (*websocket.Conn, *http.Response, error) {
		return websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/workspace/setup/install?tool="+tool+"&cols=80&rows=24", nil)
	}
	if _, _, err := dial("rm-rf"); err == nil {
		t.Fatal("unknown tool accepted")
	}
	c, _, err := dial("required")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readUntil(t, c, "INSTALL-required rows=24")
	sendTest(t, c, "yes\r")
	readUntil(t, c, "GOT-yes")
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		kind, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("expected a completion message: %v", err)
		}
		if kind == websocket.TextMessage && strings.Contains(string(data), `"type":"exit"`) {
			break
		}
	}
}

func TestInstallerAssistRunsClaudeWithSetupPrompt(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nprintf 'ASSIST-%s\\n' \"$1\"\nprintf 'PROMPT-%s\\n' \"$5\" | head -c 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	m, err := New(filepath.Join(t.TempDir(), "workspace.json"), "unused-assist")
	if err != nil {
		t.Fatal(err)
	}
	m.SetInstaller([]byte("#!/bin/bash\n"))
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/workspace/setup/install?tool=assist", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readUntil(t, c, "ASSIST---dangerously-skip-permissions")
	readUntil(t, c, "PROMPT-You are helping set up Burrow")
}
