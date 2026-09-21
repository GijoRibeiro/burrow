package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var codexThreadID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
var codexImagePlaceholder = regexp.MustCompile(`\[Image #\d+\]\s*`)

// Bind to the exact live process, never the most recent session in a directory.
// The writer lock exists even before the first prompt creates a rollout file.
func (m *Manager) codexActivity(t Terminal, panePID int, paneID string, query conversationQuery) Activity {
	a := Activity{Kind: "codex", Status: "starting", Messages: []ConversationMessage{}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := commandContext(ctx, "", "ps", "-axo", "pid=,ppid=")
	if err != nil {
		return a
	}
	parents := map[int]int{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		parent, _ := strconv.Atoi(f[1])
		parents[pid] = parent
	}
	var pids []string
	for pid := range parents {
		if descendantDepth(pid, panePID, parents) >= 0 {
			pids = append(pids, strconv.Itoa(pid))
		}
	}
	if len(pids) == 0 {
		return a
	}
	out, err = commandContext(ctx, "", "lsof", "-nP", "-a", "-p", strings.Join(pids, ","), "-Fn")
	if err != nil {
		return a
	}
	// Bind each descriptor to its process; root and subagents can share a PID.
	files := map[int][]string{}
	pid := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "p") {
			pid, _ = strconv.Atoi(line[1:])
		}
		if strings.HasPrefix(line, "n") {
			files[pid] = append(files[pid], line[1:])
		}
	}
	owner, bestDepth := 0, 1000
	thread, path := "", ""
	for pid, paths := range files {
		depth := descendantDepth(pid, panePID, parents)
		if depth < 0 || depth >= bestDepth {
			continue
		}
		candidate, rollout := codexSessionFiles(paths)
		if candidate != "" {
			owner, bestDepth, thread, path = pid, depth, candidate, rollout
		}
	}
	if owner == 0 {
		return a
	}
	// A shell retaining an unrelated descriptor must not become a chat target.
	executable, err := commandContext(ctx, "", "ps", "-p", strconv.Itoa(owner), "-o", "command=")
	if err != nil || !strings.Contains(strings.ToLower(executable), "codex") {
		return a
	}
	groups, err := commandContext(ctx, "", "ps", "-p", strconv.Itoa(owner), "-o", "pgid=,tpgid=")
	f := strings.Fields(groups)
	a.CanMessage = err == nil && len(f) == 2 && f[0] != "0" && f[0] != "-1" && f[0] == f[1]
	a.paneID = paneID
	a.Status = "ready"
	if path != "" && codexRolloutThread(path) == thread {
		if history, err := m.readConversationPage(t.ID, path, query); err == nil {
			history.Kind = "codex"
			history.CanMessage = a.CanMessage
			history.paneID = paneID
			a = history
		}
	}
	return a
}

// A CLI process may hold its workers' locks too. Only its public CLI rollout
// can own the chat; never display a child agent's conversation as the parent.
func codexSessionFiles(files []string) (string, string) {
	locks := map[string]bool{}
	for _, file := range files {
		if filepath.Base(filepath.Dir(file)) == "thread-writer-locks" {
			candidate := strings.TrimSuffix(filepath.Base(file), ".lock")
			if codexThreadID.MatchString(candidate) {
				locks[candidate] = true
			}
		}
	}
	for _, file := range files {
		if !strings.HasPrefix(filepath.Base(file), "rollout-") || !strings.HasSuffix(file, ".jsonl") {
			continue
		}
		thread := codexRolloutThread(file)
		if locks[thread] {
			return thread, file
		}
	}
	if len(locks) == 1 {
		for thread := range locks {
			return thread, ""
		}
	}
	return "", ""
}

func codexRolloutThread(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	if !scanner.Scan() {
		return ""
	}
	var record struct {
		Type    string `json:"type"`
		Payload struct {
			ID        string          `json:"id"`
			Source    json.RawMessage `json:"source"`
			SessionID string          `json:"session_id"`
		} `json:"payload"`
	}
	if json.Unmarshal(scanner.Bytes(), &record) != nil || record.Type != "session_meta" {
		return ""
	}
	if len(record.Payload.Source) > 0 && string(record.Payload.Source) != `"cli"` {
		return ""
	}
	if record.Payload.ID != "" {
		return record.Payload.ID
	}
	return record.Payload.SessionID
}

// Only public event items are mirrored. Response items also contain injected
// environment prompts and private reasoning, and duplicate public event text.
func (c *conversationLog) consumeCodex(line []byte) {
	var record struct {
		Type    string `json:"type"`
		Payload struct {
			Type        string   `json:"type"`
			Name        string   `json:"name"`
			Message     string   `json:"message"`
			ID          string   `json:"id"`
			Images      []string `json:"images"`
			LocalImages []string `json:"local_images"`
			Item        struct {
				Type    string `json:"type"`
				ID      string `json:"id"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
					Path string `json:"path"`
				} `json:"content"`
			} `json:"item"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil {
		return
	}
	c.activity.Kind = "codex"
	p := record.Payload
	if record.Type == "response_item" {
		switch p.Type {
		case "function_call", "custom_tool_call":
			c.activity.Status = "working"
			c.activity.Tool = p.Name
			c.activity.Tools++
		}
		return
	}
	if record.Type != "event_msg" {
		return
	}
	role := ""
	key := p.ID
	text := p.Message
	images := p.LocalImages
	switch p.Type {
	case "task_started":
		c.activity.Status = "working"
		return
	case "task_complete", "task_completed", "turn_aborted":
		c.activity.Status = "ready"
		c.activity.Tool = ""
		return
	case "user_message":
		role = "user"
	case "agent_message":
		role = "assistant"
	case "item_completed":
		switch p.Item.Type {
		case "UserMessage":
			role = "user"
		case "AgentMessage":
			role = "assistant"
		default:
			return
		}
		key = p.Item.ID
		var parts []string
		for _, block := range p.Item.Content {
			switch block.Type {
			case "text", "Text":
				parts = append(parts, block.Text)
			case "local_image", "localImage":
				images = append(images, block.Path)
			}
		}
		text = strings.Join(parts, "\n\n")
	default:
		return
	}
	if len(images) > 0 && role == "user" {
		text = strings.TrimSpace(codexImagePlaceholder.ReplaceAllString(text, ""))
		if text == "" {
			text = "Please inspect these images."
		}
		text += "\n\nAttached images (open these files to view them):"
		for i, path := range images {
			text += "\n[Image " + strconv.Itoa(i+1) + "](<" + path + ">)"
		}
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if key == "" {
		key = "codex-" + strconv.Itoa(len(c.seen))
	}
	index, exists := c.seen[key]
	if !exists {
		index = len(c.seen)
		c.seen[key] = index
	}
	msg := ConversationMessage{ID: key, Role: role, Text: text}
	if c.emit != nil {
		c.emit(msg, index)
	} else if exists {
		c.activity.Messages[index] = msg
	} else {
		c.activity.Messages = append(c.activity.Messages, msg)
	}
	if role == "user" {
		c.activity.Status = "working"
	}
}
