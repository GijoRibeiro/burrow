// Package store persists agent profiles (names, creatures, XP) to a JSON file.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AgentProfile holds persistent data for an agent, keyed by cwd.
type AgentProfile struct {
	Name          string `json:"name"`
	CreatureIndex int    `json:"creatureIndex"`
	// CreatureAssigned distinguishes an explicitly-chosen creature from the
	// zero-value default, so the frontend knows whether to assign a random
	// avatar on first creation (and both the chat badge and agent frame read
	// the same persisted value instead of diverging fallbacks).
	CreatureAssigned bool  `json:"creatureAssigned"`
	BonusXP          int   `json:"bonusXP"`
	WorkMinutes      int   `json:"workMinutes"`   // total minutes spent working
	LastWorkCheck    int64 `json:"lastWorkCheck"` // unix timestamp of last work tick
}

// Store reads and writes agent profiles to ~/.cloovies/agents.json.
type Store struct {
	mu       sync.RWMutex
	path     string
	profiles map[string]*AgentProfile // keyed by cwd
}

// New creates a store at ~/.cloovies/agents.json.
func New() (*Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	dir := filepath.Join(home, ".cloovies")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}

	s := &Store{
		path:     filepath.Join(dir, "agents.json"),
		profiles: make(map[string]*AgentProfile),
	}

	s.load()
	return s, nil
}

// Get returns the profile for a cwd, or a default.
func (s *Store) Get(cwd string) AgentProfile {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if p, ok := s.profiles[cwd]; ok {
		return *p
	}
	return AgentProfile{}
}

// GetAll returns all profiles.
func (s *Store) GetAll() map[string]AgentProfile {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string]AgentProfile, len(s.profiles))
	for k, v := range s.profiles {
		result[k] = *v
	}
	return result
}

// SetName updates the agent name.
func (s *Store) SetName(cwd, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	p := s.getOrCreate(cwd)
	p.Name = name
	s.save()
}

// SetCreature updates the creature index.
func (s *Store) SetCreature(cwd string, index int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	p := s.getOrCreate(cwd)
	p.CreatureIndex = index
	p.CreatureAssigned = true
	s.save()
}

// AddXP adds bonus XP.
func (s *Store) AddXP(cwd string, amount int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	p := s.getOrCreate(cwd)
	p.BonusXP += amount
	s.save()
}

// TickWork records that an agent is actively working right now.
// Called every scan cycle (3s). Accumulates work minutes and awards
// 2 XP for every 60 minutes of work.
func (s *Store) TickWork(cwd string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	p := s.getOrCreate(cwd)
	now := time.Now().Unix()

	// Only count if last check was recent (within 30s) to avoid
	// counting gaps where agent was idle
	if p.LastWorkCheck > 0 && (now-p.LastWorkCheck) < 30 {
		elapsed := now - p.LastWorkCheck
		p.WorkMinutes += int(elapsed) // store as seconds actually, convert below
	}
	p.LastWorkCheck = now

	// Award 2 XP per 3600 seconds (1 hour) of work
	xpEarned := p.WorkMinutes / 3600
	if xpEarned > 0 {
		p.BonusXP += xpEarned * 2
		p.WorkMinutes = p.WorkMinutes % 3600
		s.save()
		return
	}
	s.save()
}

func (s *Store) getOrCreate(cwd string) *AgentProfile {
	if p, ok := s.profiles[cwd]; ok {
		return p
	}
	p := &AgentProfile{}
	s.profiles[cwd] = p
	return p
}

func (s *Store) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	json.Unmarshal(data, &s.profiles)
	// Migration: profiles written before creatureAssigned existed are
	// treated as assigned, so existing avatars are preserved as-is and the
	// frontend doesn't randomize them on next load. Only brand-new agents
	// (no profile yet) are left unassigned for random assignment.
	for _, p := range s.profiles {
		p.CreatureAssigned = true
	}
}

func (s *Store) save() {
	data, _ := json.MarshalIndent(s.profiles, "", "  ")
	os.WriteFile(s.path, data, 0644)
}
