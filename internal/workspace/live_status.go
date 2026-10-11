package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// One process snapshot for all cards; never parse full transcripts just to paint
// the canvas. Session metadata only applies to a descendant of that exact pane.
func annotateLiveAgents(terminals []Terminal, panePIDs map[string]int) map[string]string {
	hasClaude := false
	for _, t := range terminals {
		if t.Program == "claude" && t.Status == "running" {
			hasClaude = true
			break
		}
	}
	if !hasClaude {
		return nil
	}
	config := os.Getenv("CLAUDE_CONFIG_DIR")
	if config == "" {
		home, _ := os.UserHomeDir()
		config = filepath.Join(home, ".claude")
	}
	entries, err := os.ReadDir(filepath.Join(config, "sessions"))
	if err != nil {
		return nil
	}
	out, err := command("", "ps", "-axo", "pid=,ppid=")
	if err != nil {
		return nil
	}
	parents := map[int]int{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 {
			pid, _ := strconv.Atoi(f[0])
			parent, _ := strconv.Atoi(f[1])
			parents[pid] = parent
		}
	}
	sessions := []claudeSession{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(config, "sessions", entry.Name()))
		if err != nil || len(data) > 65536 {
			continue
		}
		var s claudeSession
		if json.Unmarshal(data, &s) == nil {
			sessions = append(sessions, s)
		}
	}
	return applyLiveAgentStates(terminals, panePIDs, parents, sessions)
}

// applyLiveAgentStates paints LiveStatus and returns each pane's discovered
// Claude session ID, keyed by terminal ID.
func applyLiveAgentStates(terminals []Terminal, panePIDs map[string]int, parents map[int]int, sessions []claudeSession) map[string]string {
	found := map[string]string{}
	for i := range terminals {
		t := &terminals[i]
		t.LiveStatus = ""
		if t.Program != "claude" || t.Status != "running" {
			continue
		}
		best := 1000
		var chosen claudeSession
		for _, s := range sessions {
			depth := descendantDepth(s.PID, panePIDs[sessionName(t.ID)], parents)
			if depth >= 0 && (depth < best || depth == best && s.StartedAt > chosen.StartedAt) {
				best = depth
				chosen = s
			}
		}
		if chosen.PID != 0 && sessionIDPattern.MatchString(chosen.SessionID) {
			found[t.ID] = chosen.SessionID
		}
		switch chosen.Status {
		case "busy", "working":
			t.LiveStatus = "working"
		case "idle":
			t.LiveStatus = "idle"
		case "waiting", "permission":
			t.LiveStatus = "waiting"
		}
	}
	return found
}
