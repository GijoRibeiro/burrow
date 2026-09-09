package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

func normalizeFolder(folder string) string {
	if folder == "" {
		return ""
	}
	if abs, err := filepath.Abs(folder); err == nil {
		return filepath.Clean(abs)
	}
	return filepath.Clean(folder)
}

func dedupeFolders(folders []string) []string {
	seen := make(map[string]struct{}, len(folders))
	out := make([]string, 0, len(folders))
	for _, f := range folders {
		n := normalizeFolder(f)
		if n == "" {
			continue
		}
		if _, ok := seen[n]; ok {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	return out
}

type Config struct {
	TerminalApp   string       `json:"terminalApp"`             // "terminal" or "iterm2"
	RecentFolders []string     `json:"recentFolders,omitempty"` // last 10 spawn folders, most recent first
	LinearAPIKey  string       `json:"linearApiKey,omitempty"`  // personal API key for Linear
	mu            sync.RWMutex `json:"-"`
	path          string       `json:"-"`
}

func Load(path string) (*Config, error) {
	cfg := &Config{
		TerminalApp: "terminal",
		path:        path,
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	cfg.path = path
	cfg.RecentFolders = dedupeFolders(cfg.RecentFolders)
	return cfg, nil
}

func (c *Config) Save() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.path, data, 0644)
}

func (c *Config) Get() Config {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Config{
		TerminalApp:   c.TerminalApp,
		RecentFolders: c.RecentFolders,
		LinearAPIKey:  c.LinearAPIKey,
	}
}

// AddRecentFolder records a folder at the front of the recent list (max 10, no duplicates).
func (c *Config) AddRecentFolder(folder string) error {
	folder = normalizeFolder(folder)
	if folder == "" {
		return nil
	}
	c.mu.Lock()
	filtered := make([]string, 0, len(c.RecentFolders))
	for _, f := range c.RecentFolders {
		if normalizeFolder(f) != folder {
			filtered = append(filtered, f)
		}
	}
	c.RecentFolders = append([]string{folder}, filtered...)
	if len(c.RecentFolders) > 10 {
		c.RecentFolders = c.RecentFolders[:10]
	}
	c.mu.Unlock()
	return c.Save()
}

func (c *Config) SetTerminalApp(app string) error {
	c.mu.Lock()
	c.TerminalApp = app
	c.mu.Unlock()
	return c.Save()
}

func (c *Config) SetLinearAPIKey(key string) error {
	c.mu.Lock()
	c.LinearAPIKey = key
	c.mu.Unlock()
	return c.Save()
}
