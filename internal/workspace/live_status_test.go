package workspace

import "testing"

func TestLiveStatesMatchExactPaneAndNearestProcess(t *testing.T) {
	agents := []Terminal{{ID: "head", Program: "claude", Status: "running"}, {ID: "worker", Program: "claude", Status: "running"}, {ID: "stopped", Program: "claude", Status: "stopped"}, {ID: "codex", Program: "codex", Status: "running"}, {ID: "missing", Program: "claude", Status: "running"}}
	panes := map[string]int{sessionName("head"): 100, sessionName("worker"): 200, sessionName("stopped"): 300}
	parents := map[int]int{100: 10, 101: 100, 102: 101, 200: 10, 201: 200, 300: 10, 301: 300, 500: 10}
	sessions := []claudeSession{{PID: 101, Status: "idle", StartedAt: 2}, {PID: 102, Status: "busy", StartedAt: 3}, {PID: 201, Status: "busy"}, {PID: 301, Status: "busy"}, {PID: 500, Status: "busy"}}
	applyLiveAgentStates(agents, panes, parents, sessions)
	for i, want := range []string{"idle", "working", "", "", ""} {
		if agents[i].LiveStatus != want {
			t.Fatalf("%s: got %q want %q", agents[i].ID, agents[i].LiveStatus, want)
		}
	}
	// A process disappearing cannot leave the old busy state painted forever.
	applyLiveAgentStates(agents, panes, map[int]int{}, sessions)
	for _, a := range agents {
		if a.LiveStatus != "" {
			t.Fatalf("stale state: %+v", a)
		}
	}
}
