package registry

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gijo/cloovies/internal/scanner"
	"github.com/gijo/cloovies/internal/terminal"
)

// Agent is the enriched agent state tracked by the registry.
type Agent struct {
	PID            int       `json:"pid"`
	SessionID      string    `json:"sessionId"`
	Cwd            string    `json:"cwd"`
	Name           string    `json:"name"`
	CreatureID     string    `json:"creatureId"`
	Status         string    `json:"status"`
	CurrentTask    string    `json:"currentTask"`
	Tasks          []scanner.Task `json:"tasks"`
	ContextTokens  int            `json:"contextTokens"`
	TaskElapsedMs  int64          `json:"taskElapsedMs"`
	ActiveSinceMs  int64          `json:"activeSinceMs"` // unix ms when agent last became active, 0 if not active
	StartedAt      time.Time `json:"startedAt"`
	ActiveSubs     int              `json:"activeSubs"`
	TotalSubs      int              `json:"totalSubs"`
	Subagents      []scanner.SubAgent `json:"subagents"`
	CommitsToday   int       `json:"commitsToday"`
	PushesToday    int       `json:"pushesToday"`
	MergesToday    int       `json:"mergesToday"`
	TotalCommits   int       `json:"totalCommits"`
	Branch         string    `json:"branch"`
	Worktree       string    `json:"worktree"`
	// DevURLs are the local server URLs seen in the agent's session output
	// (dev servers it started). Surfaced as pinned, clickable chips below
	// the lane's tab so you don't have to hunt for the port. Cleared when
	// the agent goes dead — its servers are gone with it.
	DevURLs        []string  `json:"devUrls,omitempty"`
	// AwaitingChoice is set by the terminal-picker scanner when the
	// agent's tmux pane is showing a numbered choice / permission
	// prompt. Drives the gold sprite tint on the agent frame so the
	// user can spot which agent is blocked on them.
	AwaitingChoice bool `json:"awaitingChoice"`
	// Picker carries the parsed question + options when the agent's
	// tmux pane is showing a Claude Code picker. The frontend
	// renders this inline in the agent's lane so the user can
	// answer the picker from Cloovies — clicking an option sends
	// the corresponding number + Enter to the agent's pane via
	// chat.SendMessage. Nil when no picker is up.
	Picker *terminal.Picker `json:"picker,omitempty"`
}

// Registry holds the live state of all known agents.
type Registry struct {
	mu     sync.RWMutex
	agents map[string]*Agent // keyed by sessionID
	// Debug overrides for awaitingChoice — keyed by sessionID, value
	// is the time at which the override expires. While time.Now() is
	// before the expiry, SetAwaitingChoice keeps the flag forced on
	// (the regular picker scanner can't clear it). Used by the
	// /api/debug/picker test endpoint so the user can see how the
	// indicator looks without having to actually trigger a real
	// Claude Code picker. Stored separately from Agent so it isn't
	// serialized to clients.
	awaitingOverrides map[string]time.Time
}

// New creates an empty registry.
func New() *Registry {
	return &Registry{
		agents:            make(map[string]*Agent),
		awaitingOverrides: make(map[string]time.Time),
	}
}

// FinishedAgent describes an agent that just transitioned from active to idle/done.
type FinishedAgent struct {
	SessionID string
	Cwd       string
	Name      string
}

// UpdateFromScan merges scanner results into the registry.
// Returns agents that transitioned from active to idle/done this cycle.
func (r *Registry) UpdateFromScan(states []scanner.AgentState) []FinishedAgent {
	r.mu.Lock()
	defer r.mu.Unlock()

	seen := make(map[string]bool)
	var finished []FinishedAgent

	// Filter out the boss agent (runs in ~/.cloovies/boss/)
	bossDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		bossDir = filepath.Join(home, ".cloovies", "boss")
	}

	for _, s := range states {
		if bossDir != "" && strings.HasPrefix(s.Cwd, bossDir) {
			continue
		}
		seen[s.SessionID] = true

		existing, ok := r.agents[s.SessionID]
		if !ok {
			existing = &Agent{
				PID:       s.PID,
				SessionID: s.SessionID,
				Cwd:       s.Cwd,
				StartedAt: time.UnixMilli(s.StartedAt),
				Worktree:  s.Worktree,
			}
			r.agents[s.SessionID] = existing
		}

		prevStatus := existing.Status

		if s.Alive {
			existing.CurrentTask = s.CurrentTask
			existing.Tasks = s.Tasks
			existing.ContextTokens = s.ContextTokens
			existing.TaskElapsedMs = s.TaskElapsedMs
			existing.Status = deriveStatus(s)
			existing.ActiveSubs = s.ActiveSubs
			existing.TotalSubs = s.TotalSubs
			existing.Subagents = s.Subagents
			existing.DevURLs = s.DevURLs
			// Track when this agent became active (transition idle/done → active)
			if existing.Status == "active" {
				if prevStatus != "active" {
					existing.ActiveSinceMs = time.Now().UnixMilli()
				}
			} else {
				existing.ActiveSinceMs = 0
			}
		} else {
			existing.Status = "done"
			existing.CurrentTask = ""
			existing.Tasks = nil
			existing.ContextTokens = 0
			existing.TaskElapsedMs = 0
			existing.ActiveSinceMs = 0
			existing.ActiveSubs = 0
			existing.Subagents = nil
			existing.DevURLs = nil
		}

		// Detect active → idle/done transitions
		if prevStatus == "active" && (existing.Status == "idle" || existing.Status == "done") {
			finished = append(finished, FinishedAgent{
				SessionID: existing.SessionID,
				Cwd:       existing.Cwd,
				Name:      existing.Name,
			})
		}

		existing.Worktree = s.Worktree
		existing.CommitsToday = s.CommitsToday
		existing.PushesToday = s.PushesToday
		existing.MergesToday = s.MergesToday
		existing.TotalCommits = s.TotalCommits
		existing.Branch = s.Branch
	}

	// Remove agents whose session files no longer exist
	for id := range r.agents {
		if !seen[id] {
			delete(r.agents, id)
		}
	}

	return finished
}

// SetAwaitingChoice flips the agent's awaiting-choice flag (the
// terminal-picker badge). Best-effort: silently no-ops on unknown
// session IDs since the picker scanner runs against a snapshot and
// agents may have already disappeared by the time we call back in.
//
// Honors any active debug override: while ForceAwaitingChoice is in
// effect for this session, the flag stays true regardless of what
// the scanner reports. The override expires automatically.
func (r *Registry) SetAwaitingChoice(sessionID string, awaiting bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if a, ok := r.agents[sessionID]; ok {
		if until, has := r.awaitingOverrides[sessionID]; has {
			if time.Now().Before(until) {
				a.AwaitingChoice = true
				return
			}
			// Expired — clean up.
			delete(r.awaitingOverrides, sessionID)
		}
		a.AwaitingChoice = awaiting
	}
}

// SetPicker stores the parsed picker (or clears it with nil) for the
// given session, and sets AwaitingChoice from the loose match signal —
// NOT from whether the parse succeeded. The two are deliberately
// decoupled: the rich parser (ParsePicker) returns nil for pickers it
// can't fully structure (cursor scrolled offscreen, an unfamiliar rich
// layout), but the agent is still waiting on the user. Driving the
// awaiting indicator off `matched` (a chevron+number or "Enter to
// select", same loose signal CapturePane reports) keeps the "needs you"
// signal lit in those cases — the panel just stays empty until the next
// tick parses cleanly. Previously AwaitingChoice = (p != nil), so any
// parse miss silently dropped detection entirely.
func (r *Registry) SetPicker(sessionID string, p *terminal.Picker, matched bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.agents[sessionID]
	if !ok {
		return
	}
	if until, has := r.awaitingOverrides[sessionID]; has {
		if time.Now().Before(until) {
			a.AwaitingChoice = true
			return
		}
		delete(r.awaitingOverrides, sessionID)
	}
	a.Picker = p
	a.AwaitingChoice = matched
}

// ForceAwaitingChoice pins the awaiting-choice flag to true on the
// given session for the given duration. Used by the debug endpoint
// so the user can preview how the indicator looks without having to
// trigger a real Claude Code picker. After the duration elapses,
// the regular scanner takes over again.
func (r *Registry) ForceAwaitingChoice(sessionID string, d time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.agents[sessionID]
	if !ok {
		return false
	}
	r.awaitingOverrides[sessionID] = time.Now().Add(d)
	a.AwaitingChoice = true
	return true
}

// AssignCreature sets the creature ID and name for an agent.
func (r *Registry) AssignCreature(sessionID, creatureID, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	agent, ok := r.agents[sessionID]
	if !ok {
		return fmt.Errorf("agent %s not found", sessionID)
	}

	agent.CreatureID = creatureID
	agent.Name = name
	return nil
}

// Get returns an agent by session ID.
func (r *Registry) Get(sessionID string) (Agent, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	agent, ok := r.agents[sessionID]
	if !ok {
		return Agent{}, false
	}
	return *agent, true
}

// All returns a snapshot of all agents.
func (r *Registry) All() []Agent {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make([]Agent, 0, len(r.agents))
	for _, a := range r.agents {
		result = append(result, *a)
	}
	return result
}

func deriveStatus(s scanner.AgentState) string {
	if s.TaskStatus == "in_progress" {
		return "active"
	}
	return "idle"
}
