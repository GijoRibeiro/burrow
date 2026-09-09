package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TrustFolder marks folder as trusted in ~/.claude.json so launching `claude`
// there doesn't block on the first-run "Do you trust the files in this
// folder?" prompt. It sets projects[folder].hasTrustDialogAccepted=true,
// preserving every other key in the file, and writes back atomically.
//
// Spawned agents run in a detached tmux session with no visible terminal, so
// a blocking trust prompt leaves the agent invisible: claude never writes a
// session file, so the scanner never sees it and nothing appears in the app.
// The user already expressed intent by picking the folder, so pre-trusting it
// closes that gap.
func TrustFolder(home, folder string) error {
	folder = strings.TrimRight(folder, "/")
	path := filepath.Join(home, ".claude.json")

	root := map[string]any{}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &root); err != nil {
			return fmt.Errorf("parsing %s: %w", path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("reading %s: %w", path, err)
	}

	projects, ok := root["projects"].(map[string]any)
	if !ok {
		projects = map[string]any{}
		root["projects"] = projects
	}
	entry, ok := projects[folder].(map[string]any)
	if !ok {
		entry = map[string]any{}
		projects[folder] = entry
	}
	entry["hasTrustDialogAccepted"] = true

	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling %s: %w", path, err)
	}

	// Atomic write: temp file in the same dir + rename, so a concurrent
	// reader (a running claude process also owns this file) never sees a
	// half-written document.
	tmp, err := os.CreateTemp(home, ".claude.json.tmp-*")
	if err != nil {
		return fmt.Errorf("creating temp for %s: %w", path, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing temp for %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp for %s: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("renaming temp into %s: %w", path, err)
	}
	return nil
}
