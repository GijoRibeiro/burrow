package workspace

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Activity is a read-only companion to the PTY. Only human-facing conversation
// text is returned; tool payloads and reasoning stay out of the quiet view.
type Activity struct {
	CanMessage bool `json:"canMessage"`
	paneID     string
	Kind       string                `json:"kind"`
	Status     string                `json:"status"`
	Messages   []ConversationMessage `json:"messages"`
	Tool       string                `json:"tool,omitempty"`
	Tools      int                   `json:"tools"`
	Truncated  bool                  `json:"truncated"`
}
type ConversationMessage struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Text string `json:"text"`
}
type claudeSession struct {
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	StartedAt int64  `json:"startedAt"`
}

var sessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)

func (m *Manager) Activity(id string) (Activity, error) {
	a := Activity{Kind: "shell", Status: "ready", Messages: []ConversationMessage{}}
	t, err := m.Terminal(id)
	if err != nil {
		return a, err
	}
	if t.Program == "claude" || t.Program == "codex" {
		a.Kind = t.Program
		a.Status = "starting"
	}
	pane, err := m.tmux("display-message", "-p", "-t", "="+sessionName(t.ID)+":", "#{pane_pid} #{pane_dead} #{pane_id}")
	if err != nil {
		a.Status = "stopped"
		return a, nil
	}
	fields := strings.Fields(pane)
	if len(fields) != 3 {
		a.Status = "stopped"
		return a, nil
	}
	if fields[1] == "1" {
		a.Status = "exited"
		return a, nil
	}
	// Codex is a native terminal session. Do not match Claude transcripts from
	// another process or pretend the Claude chat bridge supports Codex.
	if t.Program == "codex" {
		a.Status = "ready"
		return a, nil
	}
	pid, _ := strconv.Atoi(fields[0])
	config := os.Getenv("CLAUDE_CONFIG_DIR")
	if config == "" {
		home, _ := os.UserHomeDir()
		config = filepath.Join(home, ".claude")
	}
	entries, err := os.ReadDir(filepath.Join(config, "sessions"))
	if err != nil {
		return a, nil
	}
	// Match process ancestry, never just cwd: two agents can share one checkout.
	processes, err := command("", "ps", "-axo", "pid=,ppid=")
	if err != nil {
		return a, nil
	}
	parents := map[int]int{}
	for _, line := range strings.Split(processes, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		child, _ := strconv.Atoi(f[0])
		parent, _ := strconv.Atoi(f[1])
		parents[child] = parent
	}
	bestDepth := 1000
	var session claudeSession
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(config, "sessions", entry.Name()))
		if err != nil || len(data) > 64<<10 {
			continue
		}
		var candidate claudeSession
		if json.Unmarshal(data, &candidate) != nil || !sessionIDPattern.MatchString(candidate.SessionID) {
			continue
		}
		depth := descendantDepth(candidate.PID, pid, parents)
		if depth >= 0 && (depth < bestDepth || depth == bestDepth && candidate.StartedAt > session.StartedAt) {
			bestDepth = depth
			session = candidate
		}
	}
	if session.PID == 0 {
		return a, nil
	}
	a.Kind = "claude"
	// A background Claude process must not make an idle shell accept chat.
	foreground := false
	groups, err := command("", "ps", "-o", "pgid=,tpgid=", "-p", strconv.Itoa(session.PID))
	if err == nil {
		g := strings.Fields(groups)
		foreground = len(g) == 2 && g[0] != "0" && g[0] != "-1" && g[0] == g[1]
	}
	a.CanMessage = foreground
	a.paneID = fields[2]
	path := transcriptPath(config, session.Cwd, session.SessionID)
	data, truncated, err := conversationTail(path)
	if err != nil {
		a.Status = "unavailable"
		return a, nil
	}
	a = parseConversation(data)
	a.CanMessage = foreground
	a.paneID = fields[2]
	a.Truncated = a.Truncated || truncated
	return a, nil
}

func descendantDepth(child, root int, parents map[int]int) int {
	if root <= 1 || child <= 1 {
		return -1
	}
	for depth := 0; depth < 64; depth++ {
		if _, live := parents[child]; !live {
			return -1
		}
		if child == root {
			return depth
		}
		parent := parents[child]
		if parent <= 1 || parent == child {
			break
		}
		child = parent
	}
	return -1
}
func transcriptPath(config, cwd, session string) string {
	dir := filepath.Join(config, "projects")
	// Claude's project slug may differ across versions; the session ID remains
	// authoritative. Search only direct project directories, never subagents.
	slug := strings.NewReplacer("/", "-", "\\", "-", " ", "-").Replace(cwd)
	path := filepath.Join(dir, slug, session+".jsonl")
	if _, err := os.Stat(path); err == nil {
		return path
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(dir, entry.Name(), session+".jsonl")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return path
}
func conversationTail(path string) ([]byte, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	const limit int64 = 4 << 20
	truncated := info.Size() > limit
	if truncated {
		if _, err = f.Seek(-limit, io.SeekEnd); err != nil {
			return nil, false, err
		}
	}
	data, err := io.ReadAll(io.LimitReader(f, limit))
	if truncated {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		} else {
			data = nil
		}
	}
	// The writer may be in the middle of a record. Wait for its newline.
	if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
		data = data[:i+1]
	} else {
		data = nil
	}
	return data, truncated, err
}
func parseConversation(data []byte) Activity {
	a := Activity{Kind: "claude", Status: "ready", Messages: []ConversationMessage{}}
	seen := map[string]int{}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		var entry struct {
			Type        string `json:"type"`
			UUID        string `json:"uuid"`
			Subtype     string `json:"subtype"`
			IsMeta      bool   `json:"isMeta"`
			IsSidechain bool   `json:"isSidechain"`
			Attachment  struct {
				HookEvent string `json:"hookEvent"`
			} `json:"attachment"`
			Message struct {
				Content    json.RawMessage `json:"content"`
				StopReason string          `json:"stop_reason"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil || entry.IsSidechain {
			continue
		}
		if entry.Subtype == "turn_duration" || entry.Subtype == "stop_hook_summary" || entry.Attachment.HookEvent == "Stop" {
			a.Status = "ready"
			a.Tool = ""
			continue
		}
		if entry.Type != "assistant" && entry.Type != "user" || entry.IsMeta {
			continue
		}
		a.Status = "working"
		var text string
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Name string `json:"name"`
		}
		if json.Unmarshal(entry.Message.Content, &text) != nil && json.Unmarshal(entry.Message.Content, &blocks) == nil {
			var parts []string
			for _, b := range blocks {
				if b.Type == "text" {
					parts = append(parts, b.Text)
				}
				if b.Type == "tool_use" {
					a.Tools++
					a.Tool = b.Name
					a.Status = "working"
				}
				if b.Type == "thinking" {
					a.Status = "working"
				}
			}
			text = strings.Join(parts, "\n\n")
		}
		if entry.Message.StopReason == "end_turn" || entry.Message.StopReason == "stop_sequence" {
			a.Status = "ready"
			a.Tool = ""
		}
		text = strings.TrimSpace(text)
		if strings.HasPrefix(text, "[Request interrupted by user") {
			a.Status = "ready"
			a.Tool = ""
			continue
		}
		if text == "" || strings.HasPrefix(text, "<local-command-") || strings.HasPrefix(text, "<command-name>") || strings.HasPrefix(text, "[Request interrupted by user") {
			continue
		}
		key := entry.UUID
		if key == "" {
			key = strconv.Itoa(len(a.Messages))
		}
		msg := ConversationMessage{ID: key, Role: entry.Type, Text: text}
		if index, ok := seen[key]; ok {
			a.Messages[index] = msg
		} else {
			seen[key] = len(a.Messages)
			a.Messages = append(a.Messages, msg)
		}
	}
	if len(a.Messages) > 100 {
		a.Messages = a.Messages[len(a.Messages)-100:]
		a.Truncated = true
	}
	return a
}

// Chat is a separate operation from terminal input. Never send it to an
// unrecognized process or a Claude process running in the background.
func (m *Manager) SendMessage(id, text string) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("enter a message")
	}
	if strings.ContainsAny(text, "\x00\x1b") {
		return errors.New("messages cannot contain terminal control characters")
	}
	a, err := m.Activity(id)
	if err != nil {
		return err
	}
	if a.Kind != "claude" || !a.CanMessage || a.paneID == "" {
		return errors.New("No foreground Claude session. Start Claude to chat, or switch to Terminal for shell commands")
	}
	_, err = m.tmux("send-keys", "-t", a.paneID, "-l", "\x1b[200~"+text+"\x1b[201~", ";", "send-keys", "-t", a.paneID, "Enter")
	return err
}
