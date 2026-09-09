package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/gijo/cloovies/internal/server"
)

// readClaudeJSON loads ~/.claude.json from a fake home into a generic map.
func readClaudeJSON(t *testing.T, home string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatalf("reading .claude.json: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshaling .claude.json: %v", err)
	}
	return m
}

// trustFlag digs out projects[folder].hasTrustDialogAccepted, or nil if absent.
func trustFlag(m map[string]any, folder string) any {
	projects, ok := m["projects"].(map[string]any)
	if !ok {
		return nil
	}
	entry, ok := projects[folder].(map[string]any)
	if !ok {
		return nil
	}
	return entry["hasTrustDialogAccepted"]
}

func TestTrustFolder_CreatesFileWhenMissing(t *testing.T) {
	home := t.TempDir()
	folder := "/Users/test/projects/foo"

	if err := server.TrustFolder(home, folder); err != nil {
		t.Fatalf("TrustFolder: %v", err)
	}

	m := readClaudeJSON(t, home)
	if got := trustFlag(m, folder); got != true {
		t.Fatalf("hasTrustDialogAccepted = %v, want true", got)
	}
}

func TestTrustFolder_PreservesExistingKeys(t *testing.T) {
	home := t.TempDir()
	// A pre-existing config with unrelated top-level keys and another project.
	existing := map[string]any{
		"numStartups": float64(42),
		"userID":      "abc123",
		"projects": map[string]any{
			"/Users/test/other": map[string]any{
				"hasTrustDialogAccepted": true,
				"allowedTools":           []any{"Bash"},
			},
		},
	}
	data, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	folder := "/Users/test/projects/foo"
	if err := server.TrustFolder(home, folder); err != nil {
		t.Fatalf("TrustFolder: %v", err)
	}

	m := readClaudeJSON(t, home)
	// New folder trusted.
	if got := trustFlag(m, folder); got != true {
		t.Fatalf("new folder hasTrustDialogAccepted = %v, want true", got)
	}
	// Unrelated top-level keys preserved.
	if m["numStartups"] != float64(42) {
		t.Errorf("numStartups = %v, want 42", m["numStartups"])
	}
	if m["userID"] != "abc123" {
		t.Errorf("userID = %v, want abc123", m["userID"])
	}
	// Other project entry and its sub-keys preserved.
	projects := m["projects"].(map[string]any)
	other, ok := projects["/Users/test/other"].(map[string]any)
	if !ok {
		t.Fatal("other project entry was dropped")
	}
	if other["hasTrustDialogAccepted"] != true {
		t.Errorf("other project trust flag clobbered")
	}
	if _, ok := other["allowedTools"]; !ok {
		t.Errorf("other project allowedTools dropped")
	}
}

func TestTrustFolder_PreservesExistingProjectSubKeys(t *testing.T) {
	home := t.TempDir()
	folder := "/Users/test/projects/foo"
	existing := map[string]any{
		"projects": map[string]any{
			folder: map[string]any{
				"hasTrustDialogAccepted":     false,
				"projectOnboardingSeenCount": float64(3),
			},
		},
	}
	data, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := server.TrustFolder(home, folder); err != nil {
		t.Fatalf("TrustFolder: %v", err)
	}

	m := readClaudeJSON(t, home)
	if got := trustFlag(m, folder); got != true {
		t.Fatalf("hasTrustDialogAccepted = %v, want true", got)
	}
	entry := m["projects"].(map[string]any)[folder].(map[string]any)
	if entry["projectOnboardingSeenCount"] != float64(3) {
		t.Errorf("projectOnboardingSeenCount = %v, want 3", entry["projectOnboardingSeenCount"])
	}
}

func TestTrustFolder_NormalizesTrailingSlash(t *testing.T) {
	home := t.TempDir()
	if err := server.TrustFolder(home, "/Users/test/projects/foo/"); err != nil {
		t.Fatalf("TrustFolder: %v", err)
	}

	m := readClaudeJSON(t, home)
	// Keyed without the trailing slash, matching Claude Code's convention.
	if got := trustFlag(m, "/Users/test/projects/foo"); got != true {
		t.Fatalf("trailing-slash folder not normalized; got flag %v for clean key", got)
	}
}
