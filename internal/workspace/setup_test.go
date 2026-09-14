package workspace

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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
