package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Only normalized allowance data leaves the server. Credentials, account IDs,
// billing details and provider errors are never part of the public response.
type UsageWindow struct {
	Label    string  `json:"label"`
	Used     float64 `json:"used"`
	ResetsAt string  `json:"resetsAt,omitempty"`
}
type ModelUsage struct {
	Provider string        `json:"provider"`
	Model    string        `json:"model"`
	Status   string        `json:"status"`
	Windows  []UsageWindow `json:"windows"`
	Shared   bool          `json:"shared"`
}
type AccountUsage struct {
	Models    []ModelUsage `json:"models"`
	CheckedAt time.Time    `json:"checkedAt"`
}
type usageCache struct {
	mu    sync.Mutex
	value AccountUsage
}

func (m *Manager) accountUsage(ctx context.Context) AccountUsage {
	m.usage.mu.Lock()
	defer m.usage.mu.Unlock()
	if !m.usage.value.CheckedAt.IsZero() && time.Since(m.usage.value.CheckedAt) < time.Minute {
		return m.usage.value
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	var codex, claude ModelUsage
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); codex = readCodexUsage(ctx) }()
	go func() { defer wg.Done(); claude = readClaudeUsage(ctx) }()
	wg.Wait()
	m.usage.value = AccountUsage{Models: []ModelUsage{codex, claude}, CheckedAt: time.Now()}
	return m.usage.value
}

func (m *Manager) usageRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/usage", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		respond(w, m.accountUsage(r.Context()), nil)
	})
}

func unavailableUsage(provider, model string) ModelUsage {
	return ModelUsage{Provider: provider, Model: model, Status: "unavailable", Windows: []UsageWindow{}}
}

func readCodexUsage(ctx context.Context) ModelUsage {
	u := unavailableUsage("openai", "Astra")
	// This separate, read-only RPC client never creates a thread or sends a turn
	// to a user's terminal. Killing it cannot interrupt their agents.
	cmd := exec.CommandContext(ctx, "codex", "app-server", "--listen", "stdio://")
	cmd.WaitDelay = time.Second
	in, err := cmd.StdinPipe()
	if err != nil {
		return u
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return u
	}
	if cmd.Start() != nil {
		in.Close()
		return u
	}
	defer func() { in.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	encoder := json.NewEncoder(in)
	if encoder.Encode(map[string]any{"id": 0, "method": "initialize", "params": map[string]any{"clientInfo": map[string]string{"name": "cloovies_usage", "version": "1.0"}}}) != nil {
		return u
	}
	scanner := bufio.NewScanner(io.LimitReader(out, 2<<20))
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var envelope struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &envelope) != nil || envelope.ID == nil {
			continue
		}
		if len(envelope.Error) > 0 && string(envelope.Error) != "null" {
			return u
		}
		switch *envelope.ID {
		case 0:
			if encoder.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}) != nil {
				return u
			}
			if encoder.Encode(map[string]any{"id": 1, "method": "account/rateLimits/read"}) != nil {
				return u
			}
		case 1:
			return parseCodexUsage(envelope.Result)
		}
	}
	return u
}

type codexUsageWindow struct {
	Used    *float64 `json:"usedPercent"`
	Minutes int      `json:"windowDurationMins"`
	Reset   int64    `json:"resetsAt"`
}
type codexUsageBucket struct {
	ID        string            `json:"limitId"`
	Name      string            `json:"limitName"`
	Model     string            `json:"normalModelSlug"`
	Primary   *codexUsageWindow `json:"primary"`
	Secondary *codexUsageWindow `json:"secondary"`
}

func parseCodexUsage(data []byte) ModelUsage {
	u := unavailableUsage("openai", "Astra")
	var response struct {
		Limits  *codexUsageBucket           `json:"rateLimits"`
		Buckets map[string]codexUsageBucket `json:"rateLimitsByLimitId"`
	}
	if json.Unmarshal(data, &response) != nil {
		return u
	}
	var specific, shared *codexUsageBucket
	for key, bucket := range response.Buckets {
		identity := strings.ToLower(key + " " + bucket.ID + " " + bucket.Name + " " + bucket.Model)
		if strings.Contains(identity, "astra") {
			b := bucket
			specific = &b
		}
		if key == "codex" && (bucket.ID == "codex" || bucket.ID == "") {
			b := bucket
			shared = &b
		}
	}
	if shared == nil && response.Limits != nil && response.Limits.ID == "codex" {
		shared = response.Limits
	}
	appendBucket := func(bucket *codexUsageBucket, prefix string) {
		if bucket == nil {
			return
		}
		for _, window := range []*codexUsageWindow{bucket.Primary, bucket.Secondary} {
			if window == nil || window.Used == nil || !validUsage(*window.Used) {
				continue
			}
			label := "Allowance"
			switch window.Minutes {
			case 300:
				label = "5-hour"
			case 1440:
				label = "Daily"
			case 10080:
				label = "Weekly"
			}
			reset := ""
			if window.Reset > 0 {
				reset = time.Unix(window.Reset, 0).UTC().Format(time.RFC3339)
			}
			u.Windows = append(u.Windows, UsageWindow{Label: prefix + label, Used: math.Min(100, *window.Used), ResetsAt: reset})
		}
	}
	// Shared limits still apply even when a model-specific bucket is present.
	appendBucket(shared, "Codex · ")
	appendBucket(specific, "Astra · ")
	u.Shared = specific == nil
	if len(u.Windows) > 0 {
		u.Status = "ready"
	}
	return u
}
func validUsage(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 }

func claudeAccountToken(ctx context.Context) (string, error) {
	// Honor Claude's configured account, and never fall back to another account
	// in the default keychain for a custom config directory.
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	custom := dir != ""
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".claude")
	}
	data, _ := os.ReadFile(filepath.Join(dir, ".credentials.json"))
	token := func(data []byte) string {
		var credentials struct {
			OAuth struct {
				AccessToken string `json:"accessToken"`
			} `json:"claudeAiOauth"`
		}
		_ = json.Unmarshal(data, &credentials)
		return credentials.OAuth.AccessToken
	}
	if value := token(data); value != "" {
		return value, nil
	}
	if runtime.GOOS == "darwin" && !custom {
		cmd := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
		cmd.WaitDelay = time.Second
		var out boundedOutput
		out.limit = 1 << 20
		cmd.Stdout = &out
		if cmd.Run() == nil {
			if value := token(out.data); value != "" {
				return value, nil
			}
		}
	}
	return "", errors.New("Claude account usage unavailable")
}
func readClaudeUsage(ctx context.Context) ModelUsage {
	u := unavailableUsage("anthropic", "Fable")
	token, err := claudeAccountToken(ctx)
	if err != nil {
		return u
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		return u
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return u
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return u
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return u
	}
	return parseClaudeUsage(data)
}
func parseClaudeUsage(data []byte) ModelUsage {
	u := unavailableUsage("anthropic", "Fable")
	type window struct {
		Used  *float64 `json:"utilization"`
		Reset string   `json:"resets_at"`
	}
	var response struct {
		Limits []struct {
			Kind    string   `json:"kind"`
			Percent *float64 `json:"percent"`
			Reset   string   `json:"resets_at"`
			Scope   *struct {
				Model *struct {
					ID   string `json:"id"`
					Name string `json:"display_name"`
				} `json:"model"`
				Surface json.RawMessage `json:"surface"`
			} `json:"scope"`
		} `json:"limits"`
		Session *window `json:"five_hour"`
		Weekly  *window `json:"seven_day"`
		Fable   *window `json:"seven_day_fable"`
	}
	if json.Unmarshal(data, &response) != nil {
		return u
	}
	add := func(label string, used *float64, reset string) {
		if used == nil || !validUsage(*used) {
			return
		}
		if _, err := time.Parse(time.RFC3339Nano, reset); err != nil {
			reset = ""
		}
		u.Windows = append(u.Windows, UsageWindow{Label: label, Used: math.Min(100, *used), ResetsAt: reset})
	}
	fable := false
	for _, limit := range response.Limits {
		label := ""
		if limit.Scope == nil {
			switch limit.Kind {
			case "session":
				label = "5-hour"
			case "weekly_all":
				label = "Weekly · all models"
			}
		} else if limit.Scope.Model != nil && (len(limit.Scope.Surface) == 0 || string(limit.Scope.Surface) == "null") {
			model := strings.ToLower(limit.Scope.Model.ID + " " + limit.Scope.Model.Name)
			if strings.Contains(model, "fable") {
				label = "Fable · weekly"
				fable = true
			}
		}
		if label != "" {
			add(label, limit.Percent, limit.Reset)
		}
	}
	if len(u.Windows) == 0 {
		if response.Session != nil {
			add("5-hour", response.Session.Used, response.Session.Reset)
		}
		if response.Weekly != nil {
			add("Weekly · all models", response.Weekly.Used, response.Weekly.Reset)
		}
	}
	if !fable && response.Fable != nil {
		add("Fable · weekly", response.Fable.Used, response.Fable.Reset)
		fable = true
	}
	u.Shared = !fable
	if len(u.Windows) > 0 {
		u.Status = "ready"
	}
	return u
}
