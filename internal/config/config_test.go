package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gijo/cloovies/internal/config"
)

func TestDefaultConfig(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if cfg.TerminalApp != "terminal" {
		t.Errorf("expected default terminal app 'terminal', got '%s'", cfg.TerminalApp)
	}
}

func TestSaveAndReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	cfg, _ := config.Load(path)
	if err := cfg.SetTerminalApp("iterm2"); err != nil {
		t.Fatalf("SetTerminalApp error: %v", err)
	}
	cfg2, err := config.Load(path)
	if err != nil {
		t.Fatalf("Reload error: %v", err)
	}
	if cfg2.TerminalApp != "iterm2" {
		t.Errorf("expected 'iterm2', got '%s'", cfg2.TerminalApp)
	}
}

func TestInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	os.WriteFile(path, []byte("{invalid}"), 0644)
	_, err := config.Load(path)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}
