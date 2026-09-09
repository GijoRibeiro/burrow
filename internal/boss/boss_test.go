package boss

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewBoss(t *testing.T) {
	b, err := New()
	if err != nil {
		t.Fatalf("New() returned error: %v", err)
	}
	if b == nil {
		t.Fatal("New() returned nil boss")
	}
	if b.dir == "" {
		t.Fatal("boss dir is empty")
	}
	if !b.ready {
		t.Fatal("new boss should be ready")
	}
}

func TestEnsureBossDir(t *testing.T) {
	// Use a temp directory to avoid touching the real ~/.cloovies.
	tmp := t.TempDir()
	b := &Boss{dir: filepath.Join(tmp, "boss")}

	if err := b.ensureDir(); err != nil {
		t.Fatalf("ensureDir() error: %v", err)
	}

	// Directory should exist.
	info, err := os.Stat(b.dir)
	if err != nil {
		t.Fatalf("boss dir not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("boss dir is not a directory")
	}

	// CLAUDE.md should exist with content.
	mdPath := filepath.Join(b.dir, "CLAUDE.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("CLAUDE.md not created: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("CLAUDE.md is empty")
	}
	if got := string(data); got != claudeMD {
		t.Errorf("CLAUDE.md content mismatch:\ngot length %d, want length %d", len(got), len(claudeMD))
	}
}

func TestEnsureBossDirIdempotent(t *testing.T) {
	tmp := t.TempDir()
	b := &Boss{dir: filepath.Join(tmp, "boss")}

	// Call twice — should not error or overwrite.
	if err := b.ensureDir(); err != nil {
		t.Fatalf("first ensureDir() error: %v", err)
	}

	// Write custom content to CLAUDE.md.
	mdPath := filepath.Join(b.dir, "CLAUDE.md")
	custom := []byte("custom content")
	if err := os.WriteFile(mdPath, custom, 0o644); err != nil {
		t.Fatalf("write custom CLAUDE.md: %v", err)
	}

	// Second call should not overwrite.
	if err := b.ensureDir(); err != nil {
		t.Fatalf("second ensureDir() error: %v", err)
	}
	data, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("read CLAUDE.md: %v", err)
	}
	if string(data) != "custom content" {
		t.Error("ensureDir() overwrote existing CLAUDE.md")
	}
}

func TestParseActionsBlock(t *testing.T) {
	input := "Here is what I'll do:\n```actions\n[{\"tool\": \"status\"}]\n```\nDone."

	actions, remainder, ok := parseActionsBlock(input)
	if !ok {
		t.Fatal("parseActionsBlock returned false")
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 action, got %d", len(actions))
	}
	if actions[0].Tool != "status" {
		t.Errorf("expected tool=status, got %s", actions[0].Tool)
	}
	if got := remainder; got != "\nDone." {
		t.Errorf("unexpected remainder: %q", got)
	}
}

func TestParseActionsBlockNoBlock(t *testing.T) {
	input := "Just some text with no actions."
	_, _, ok := parseActionsBlock(input)
	if ok {
		t.Error("parseActionsBlock should return false when no block present")
	}
}

func TestParseActionsBlockUnclosed(t *testing.T) {
	input := "```actions\n[{\"tool\": \"status\"}"
	_, _, ok := parseActionsBlock(input)
	if ok {
		t.Error("parseActionsBlock should return false for unclosed block")
	}
}

func TestIsRunningDefault(t *testing.T) {
	b := &Boss{}
	if b.IsRunning() {
		t.Error("bare boss should not be ready")
	}
}

func TestBuildPrompt(t *testing.T) {
	b := &Boss{dir: t.TempDir()}
	prompt := b.buildPrompt("hello", "- agent-1 [active] ~/api", false)
	if !strings.Contains(prompt, "hello") {
		t.Error("prompt missing user message")
	}
	if !strings.Contains(prompt, "agent-1") {
		t.Error("prompt missing registry snapshot")
	}
}

func TestBuildPromptWithHistory(t *testing.T) {
	b := &Boss{
		dir:     t.TempDir(),
		history: []historyEntry{{Role: "user", Text: "first msg"}, {Role: "assistant", Text: "first reply"}},
	}
	prompt := b.buildPrompt("second msg", "", false)
	if !strings.Contains(prompt, "first msg") {
		t.Error("prompt missing history")
	}
	if !strings.Contains(prompt, "second msg") {
		t.Error("prompt missing current message")
	}
}
