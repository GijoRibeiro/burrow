package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetCreature_MarksAssigned(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	s.SetCreature("/some/cwd", 3)

	p := s.Get("/some/cwd")
	if p.CreatureIndex != 3 {
		t.Errorf("CreatureIndex = %d, want 3", p.CreatureIndex)
	}
	if !p.CreatureAssigned {
		t.Errorf("CreatureAssigned = false, want true after SetCreature")
	}
}

func TestNewAgent_NotAssignedByDefault(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// An agent that only ever ticked work (getOrCreate path) has a profile
	// but no creature assigned — the client should treat it as "needs a
	// random creature".
	s.AddXP("/fresh/agent", 0)

	if p := s.Get("/fresh/agent"); p.CreatureAssigned {
		t.Errorf("CreatureAssigned = true, want false for an agent with no creature pick")
	}
}

func TestLoad_MigratesExistingProfilesToAssigned(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".cloovies")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// A pre-existing profile written before creatureAssigned existed.
	legacy := `{"/old/agent":{"name":"Koko","creatureIndex":2,"bonusXP":5}}`
	if err := os.WriteFile(filepath.Join(dir, "agents.json"), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	s, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	p := s.Get("/old/agent")
	// Existing avatar must be preserved as-is (no reshuffle)…
	if p.CreatureIndex != 2 {
		t.Errorf("CreatureIndex = %d, want 2 (preserved)", p.CreatureIndex)
	}
	// …and treated as assigned so the client doesn't randomize it.
	if !p.CreatureAssigned {
		t.Errorf("CreatureAssigned = false, want true for a migrated legacy profile")
	}
}
