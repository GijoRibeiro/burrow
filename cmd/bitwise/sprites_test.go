package main

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func mapFS(paths ...string) fstest.MapFS {
	m := fstest.MapFS{}
	for _, p := range paths {
		m[p] = &fstest.MapFile{Data: []byte("png-" + p)}
	}
	return m
}

func exists(t *testing.T, p string) bool {
	t.Helper()
	_, err := os.Stat(p)
	return err == nil
}

func TestExtractSprites_FirstInstall_CopiesAll(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sprites")
	fsys := mapFS("Koko-1.png", "Koko-2.png", "Grook-1.png")

	if err := extractSpritesFrom(fsys, dir); err != nil {
		t.Fatalf("extractSpritesFrom: %v", err)
	}
	for _, f := range []string{"Koko-1.png", "Koko-2.png", "Grook-1.png"} {
		if !exists(t, filepath.Join(dir, f)) {
			t.Errorf("first install should copy %s", f)
		}
	}
}

func TestExtractSprites_ExistingInstall_AdoptsBaseline(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "sprites")
	// Pre-existing install: user has Koko but deleted Grook, no manifest yet.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "Koko-1.png"), []byte("user"), 0o644)

	fsys := mapFS("Koko-1.png", "Grook-1.png") // bundle still ships Grook

	if err := extractSpritesFrom(fsys, dir); err != nil {
		t.Fatalf("extractSpritesFrom: %v", err)
	}
	// Grook must NOT be re-added — the existing dir is the baseline.
	if exists(t, filepath.Join(dir, "Grook-1.png")) {
		t.Errorf("baseline adoption should not re-add Grook the user deleted")
	}
	// Koko untouched.
	if data, _ := os.ReadFile(filepath.Join(dir, "Koko-1.png")); string(data) != "user" {
		t.Errorf("existing Koko was clobbered")
	}
}

func TestExtractSprites_DeliversNewAvatar(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "sprites")

	// First install with one creature.
	if err := extractSpritesFrom(mapFS("Koko-1.png"), dir); err != nil {
		t.Fatal(err)
	}
	// Next version ships a NEW creature.
	if err := extractSpritesFrom(mapFS("Koko-1.png", "Newbie-1.png"), dir); err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "Newbie-1.png")) {
		t.Errorf("a newly-shipped avatar should be delivered to existing users")
	}
}

func TestExtractSprites_DoesNotReAddUserDeleted(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "sprites")

	// First install ships Koko + Grook.
	if err := extractSpritesFrom(mapFS("Koko-1.png", "Grook-1.png"), dir); err != nil {
		t.Fatal(err)
	}
	// User deletes Grook.
	os.Remove(filepath.Join(dir, "Grook-1.png"))
	// Re-run with the same bundle (no new avatars).
	if err := extractSpritesFrom(mapFS("Koko-1.png", "Grook-1.png"), dir); err != nil {
		t.Fatal(err)
	}
	if exists(t, filepath.Join(dir, "Grook-1.png")) {
		t.Errorf("a sprite the user deleted must stay deleted, not get re-added")
	}
}
