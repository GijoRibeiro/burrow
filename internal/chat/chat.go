package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// collapseForTmux flattens multi-line text into a single line before it
// hits `tmux send-keys -l`. Claude Code's terminal treats any multi-line
// input as a paste and wraps it in `[Pasted text #N +M lines]`, which
// clutters the agent's conversation log (and sometimes confuses the agent
// about where the user's message actually starts).
//
// Dictation tools like Wispr routinely produce 3–10 line outputs, so
// collapsing is the default. We lose the line breaks; we never lose content.
var tmuxWhitespace = regexp.MustCompile(`\s+`)

func collapseForTmux(message string) string {
	return strings.TrimSpace(tmuxWhitespace.ReplaceAllString(message, " "))
}

// avoidTrailingBackslash pads a trailing '\' with a space so the receiving
// shell doesn't treat the backslash as line-continuation when Enter arrives.
// Claude Code's prompt and bash-style readline both swallow `\` + Enter as a
// newline instead of submitting, leaving the typed text parked in the input.
// The space makes the character right before Enter a space — harmless as user
// input, and the backslash is preserved in the rendered content.
func avoidTrailingBackslash(s string) string {
	if strings.HasSuffix(s, `\`) {
		return s + " "
	}
	return s
}

// sendMu serializes all terminal sends so clipboard-based paste
// (Terminal.app) never races with a concurrent send.
var sendMu sync.Mutex

type logEntry struct {
	Type    string `json:"type"`
	Message *struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type contentBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	Thinking string          `json:"thinking"`
	Name     string          `json:"name"`            // tool_use: tool name
	ID       string          `json:"id"`              // tool_use: call id
	Input    json.RawMessage `json:"input,omitempty"` // tool_use input params
}

// toolResultEntry represents a tool_result log line.
type toolResultEntry struct {
	Type      string `json:"type"`       // "tool_result"
	ToolUseID string `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
}

// ParseLogLine extracts displayable text from any JSONL log line.
// Returns (text, role, ok). Only returns assistant text responses, no tool use/results.
func ParseLogLine(line string) (string, string, bool) {
	var entry logEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		return "", "", false
	}
	if entry.Type != "assistant" || entry.Message == nil || entry.Message.Role != "assistant" {
		return "", "", false
	}
	var blocks []contentBlock
	if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
		return "", "", false
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "thinking" && b.Thinking != "" {
			parts = append(parts, b.Thinking)
		}
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	if len(parts) == 0 {
		return "", "", false
	}
	return strings.Join(parts, "\n"), "assistant", true
}

func parseToolResultContent(raw json.RawMessage) string {
	// Content can be a string or an array of {type, text} blocks.
	var s string
	if json.Unmarshal(raw, &s) == nil && s != "" {
		return s
	}
	var blocks []contentBlock
	if json.Unmarshal(raw, &blocks) == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func ParseAssistantText(line string) (string, bool) {
	var entry logEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		return "", false
	}
	if entry.Type != "assistant" || entry.Message == nil || entry.Message.Role != "assistant" {
		return "", false
	}
	var blocks []contentBlock
	if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
		return "", false
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "thinking" && b.Thinking != "" {
			parts = append(parts, b.Thinking)
		}
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, "\n"), true
}

func ConversationLogPath(cwd, sessionID string) string {
	home, _ := os.UserHomeDir()
	projDir := strings.ReplaceAll(cwd, "/", "-")
	projDir = strings.ReplaceAll(projDir, " ", "-")
	if !strings.HasPrefix(projDir, "-") {
		projDir = "-" + projDir
	}
	path := filepath.Join(home, ".claude", "projects", projDir, sessionID+".jsonl")
	// Fallback: if the encoded path doesn't exist but another directory has
	// the session file, scan sibling project dirs. Claude Code's encoding
	// rules may transform additional characters we don't handle.
	if _, err := os.Stat(path); err != nil {
		if alt := findSessionLog(home, sessionID); alt != "" {
			return alt
		}
	}
	return path
}

// findSessionLog searches all project dirs for a conversation log with the
// given sessionID. This is a fallback for cwds whose encoding doesn't match
// our own rules.
func findSessionLog(home, sessionID string) string {
	projectsDir := filepath.Join(home, ".claude", "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(projectsDir, entry.Name(), sessionID+".jsonl")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// VerboseBlock represents a single piece of content from the conversation log.
type VerboseBlock struct {
	Type     string `json:"type"`               // "text", "thinking", "tool_use", "tool_result"
	Text     string `json:"text,omitempty"`      // for text/thinking blocks
	ToolName string `json:"toolName,omitempty"`  // for tool_use: "Edit", "Bash", "Read", etc.
	Input    string `json:"input,omitempty"`     // for tool_use: JSON string of input params
	Output   string `json:"output,omitempty"`    // for tool_result: result text
}

// ParseLogLineVerbose extracts all content blocks from a JSONL log line.
// Returns (blocks, role, ok).
func ParseLogLineVerbose(line string) ([]VerboseBlock, string, bool) {
	var entry logEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		// Try tool_result
		var tr toolResultEntry
		if err2 := json.Unmarshal([]byte(line), &tr); err2 == nil && tr.Type == "tool_result" {
			output := parseToolResultContent(tr.Content)
			if output != "" {
				return []VerboseBlock{{Type: "tool_result", Output: output}}, "tool_result", true
			}
		}
		return nil, "", false
	}
	if entry.Message == nil {
		// Could be a tool_result at the top level
		var tr toolResultEntry
		if err2 := json.Unmarshal([]byte(line), &tr); err2 == nil && tr.Type == "tool_result" {
			output := parseToolResultContent(tr.Content)
			if output != "" {
				return []VerboseBlock{{Type: "tool_result", Output: output}}, "tool_result", true
			}
		}
		return nil, "", false
	}

	if entry.Type == "assistant" && entry.Message.Role == "assistant" {
		var blocks []contentBlock
		if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
			return nil, "", false
		}
		var result []VerboseBlock
		for _, b := range blocks {
			switch b.Type {
			case "text":
				if b.Text != "" {
					result = append(result, VerboseBlock{Type: "text", Text: b.Text})
				}
			case "thinking":
				if b.Thinking != "" {
					result = append(result, VerboseBlock{Type: "thinking", Text: b.Thinking})
				}
			case "tool_use":
				inputStr := string(b.Input)
				result = append(result, VerboseBlock{Type: "tool_use", ToolName: b.Name, Input: inputStr})
			}
		}
		if len(result) > 0 {
			return result, "assistant", true
		}
	}
	return nil, "", false
}

type TailFunc func(text string)

// tailTickInterval governs how often the tail polls for new log lines.
// 100ms keeps the streaming feel snappy without burning CPU — the previous
// 200ms tick combined with bufio.Reader's stickiness around EOF could let
// agent responses pile up in the page cache before bitwise picked them up,
// producing the bursty "messages stay then suddenly scroll" pattern.
const tailTickInterval = 100 * time.Millisecond

// readNewBytes reads anything appended to f past *offset, advances *offset,
// and returns the new bytes. Detects truncation (size < *offset) and resets
// to the current size in that case. Uses Stat() + ReadAt() rather than a
// buffered Reader so we don't get stuck on bufio's internal EOF state for
// long-running tails.
func readNewBytes(f *os.File, offset *int64) ([]byte, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size < *offset {
		// File truncated or rotated; resync to whatever's left.
		*offset = size
		return nil, nil
	}
	if size == *offset {
		return nil, nil
	}
	buf := make([]byte, size-*offset)
	n, err := f.ReadAt(buf, *offset)
	if n > 0 {
		*offset += int64(n)
		return buf[:n], nil
	}
	if err != nil && err != io.EOF {
		return nil, err
	}
	return nil, nil
}

// drainLines splits accumulated bytes into complete `\n`-terminated lines,
// invoking handle for each, and returns whatever trailing partial line is
// left. Caller should pass that back in on the next call.
func drainLines(partial []byte, handle func(line string)) []byte {
	for {
		idx := bytes.IndexByte(partial, '\n')
		if idx < 0 {
			break
		}
		line := strings.TrimSpace(string(partial[:idx]))
		partial = partial[idx+1:]
		if line == "" {
			continue
		}
		handle(line)
	}
	return append([]byte(nil), partial...)
}

func TailLog(logPath string, done <-chan struct{}, fn TailFunc) error {
	f, err := os.Open(logPath)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	offset := st.Size()

	ticker := time.NewTicker(tailTickInterval)
	defer ticker.Stop()

	var partial []byte

	for {
		select {
		case <-done:
			return nil
		case <-ticker.C:
			buf, err := readNewBytes(f, &offset)
			if err != nil || len(buf) == 0 {
				continue
			}
			partial = append(partial, buf...)
			partial = drainLines(partial, func(line string) {
				if text, _, ok := ParseLogLine(line); ok {
					fn(text)
				}
			})
		}
	}
}

// TailVerboseFunc receives both human-readable text and structured verbose blocks.
type TailVerboseFunc func(text string, blocks []VerboseBlock)

// TailTurnEndFunc fires once per detected turn-end marker in the tail. This
// lets the server announce "agent_finished" directly from the tail — the
// registry's scan-tick-based transition detection can miss short turns that
// start and finish between ticks.
type TailTurnEndFunc func()

// IsTurnEndLine reports whether the given JSONL line is a Claude Code
// end-of-turn marker. These are appended after the final assistant message,
// so seeing one is an authoritative "turn over" signal independent of the
// registry's scan loop.
func IsTurnEndLine(line string) bool {
	// Substring checks match the same markers IsWorkingFromTail uses to flip
	// an agent from active → idle.
	return strings.Contains(line, `"subtype":"turn_duration"`) ||
		strings.Contains(line, `"subtype":"stop_hook_summary"`) ||
		strings.Contains(line, `"hookEvent":"Stop"`)
}

// TailLogVerbose tails a conversation log, calling fn with both ParseLogLine text
// and ParseLogLineVerbose blocks for each new line. onTurnEnd may be nil; when
// non-nil, it fires once per recognised turn-end marker line.
func TailLogVerbose(logPath string, done <-chan struct{}, fn TailVerboseFunc, onTurnEnd TailTurnEndFunc) error {
	f, err := os.Open(logPath)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	offset := st.Size()

	ticker := time.NewTicker(tailTickInterval)
	defer ticker.Stop()
	var partial []byte

	// Claude Code writes several turn-end marker lines per turn
	// (turn_duration + stop_hook_summary + a Stop hook event), so a
	// naive per-line onTurnEnd fires 3× back-to-back. Collapse them:
	// fire once, then stay quiet until new content proves a fresh turn
	// actually started.
	turnEnded := false

	for {
		select {
		case <-done:
			return nil
		case <-ticker.C:
			buf, err := readNewBytes(f, &offset)
			if err != nil || len(buf) == 0 {
				continue
			}
			partial = append(partial, buf...)
			partial = drainLines(partial, func(line string) {
				text := ""
				if t, _, ok := ParseLogLine(line); ok {
					text = t
				}
				blocks, _, _ := ParseLogLineVerbose(line)
				if text != "" || len(blocks) > 0 {
					turnEnded = false
					fn(text, blocks)
				}
				if onTurnEnd != nil && !turnEnded && IsTurnEndLine(line) {
					turnEnded = true
					onTurnEnd()
				}
			})
		}
	}
}

// ConversationMessage represents a single message from the conversation log.
type ConversationMessage struct {
	Role string // "user" or "assistant"
	Text string
}

// ReadRecentMessages reads the last n user+assistant messages from a conversation log.
func ReadRecentMessages(logPath string, n int) []ConversationMessage {
	f, err := os.Open(logPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var msgs []ConversationMessage
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var entry logEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Message == nil {
			continue
		}

		switch entry.Message.Role {
		case "user":
			var blocks []contentBlock
			if json.Unmarshal(entry.Message.Content, &blocks) != nil {
				continue
			}
			var text string
			for _, b := range blocks {
				if b.Type == "text" && b.Text != "" {
					text += b.Text
				}
			}
			if text != "" {
				msgs = append(msgs, ConversationMessage{Role: "user", Text: text})
			}
		case "assistant":
			if text, ok := ParseAssistantText(line); ok {
				msgs = append(msgs, ConversationMessage{Role: "assistant", Text: text})
			}
		}
	}

	if len(msgs) > n {
		msgs = msgs[len(msgs)-n:]
	}
	return msgs
}

// ReadLastAssistantMessage reads the conversation log and returns the last
// assistant text message. Returns empty string if none found.
func ReadLastAssistantMessage(logPath string) string {
	f, err := os.Open(logPath)
	if err != nil {
		return ""
	}
	defer f.Close()

	var last string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)
	for scanner.Scan() {
		if text, ok := ParseAssistantText(scanner.Text()); ok {
			last = text
		}
	}
	return last
}

func FindTTY(pid int) (string, error) {
	out, err := exec.Command("ps", "-o", "tty=", "-p", fmt.Sprintf("%d", pid)).Output()
	if err != nil {
		return "", fmt.Errorf("ps lookup failed for pid %d: %w", pid, err)
	}
	tty := strings.TrimSpace(string(out))
	if tty == "" || tty == "??" {
		return "", fmt.Errorf("no tty for pid %d", pid)
	}
	return "/dev/" + tty, nil
}


func SendMessage(terminalApp string, pid int, message string) error {
	sendMu.Lock()
	defer sendMu.Unlock()

	// Defeat trailing-backslash line-continuation before any path-specific
	// handling. For the tmux path we re-apply after collapseForTmux, which
	// strips trailing whitespace and could re-expose the backslash.
	message = avoidTrailingBackslash(message)

	ttyPath, err := FindTTY(pid)
	if err != nil {
		return err
	}

	// Try tmux first — writes directly to PTY master, no BPM wrapping,
	// no focus switch, completely invisible. Works with any terminal app.
	if paneID, err := FindTmuxPane(ttyPath); err == nil {
		return sendViaTmux(paneID, message)
	}

	// Fall back to AppleScript for non-tmux sessions.
	switch terminalApp {
	case "iterm2":
		escaped := escapeAppleScript(message)
		script := fmt.Sprintf(`tell application "iTerm2"
	activate
	repeat with w in windows
		repeat with t in tabs of w
			repeat with s in sessions of t
				if tty of s is "%s" then
					select t
					select w
					tell s to write text "%s" & return
				end if
			end repeat
		end repeat
	end repeat
end tell`, ttyPath, escaped)
		return runOsascript(script)

	default:
		return sendViaTerminal(ttyPath, message)
	}
}

// SendEscape sends a single Escape keypress to the agent's tmux pane —
// the equivalent of pressing ESC inside the Claude Code terminal. Used
// to interrupt the agent mid-think without killing the process. Falls
// back to a SIGINT on the PID when the agent isn't running inside tmux.
func SendEscape(pid int) error {
	sendMu.Lock()
	defer sendMu.Unlock()
	ttyPath, err := FindTTY(pid)
	if err != nil {
		return err
	}
	paneID, err := FindTmuxPane(ttyPath)
	if err != nil {
		return fmt.Errorf("not a tmux session: %w", err)
	}
	if err := exec.Command("tmux", "send-keys", "-t", paneID, "Escape").Run(); err != nil {
		return fmt.Errorf("tmux send-keys escape: %w", err)
	}
	return nil
}

// SendPickerKey drives a Claude Code picker in the agent's tmux pane without
// the message path's collapsing / paste handling. `digit` (e.g. "3"), when
// non-empty, is sent as a literal keystroke — in a multi-select that TOGGLES
// the option without committing. `submit`, when true, sends a bare Enter to
// confirm the current selection. So:
//
//	SendPickerKey(pid, "3", false) → toggle option 3 (multi-select)
//	SendPickerKey(pid, "", true)   → submit the current selection
//	SendPickerKey(pid, "6", true)  → pick option 6 and commit (single-select
//	                                 or a multi-select action like "Chat about this")
//
// tmux-only: Claude Code pickers always run inside tmux here.
func SendPickerKey(pid int, digit string, submit bool) error {
	sendMu.Lock()
	defer sendMu.Unlock()
	ttyPath, err := FindTTY(pid)
	if err != nil {
		return err
	}
	paneID, err := FindTmuxPane(ttyPath)
	if err != nil {
		return fmt.Errorf("not a tmux session: %w", err)
	}
	if digit != "" {
		if err := exec.Command("tmux", "send-keys", "-t", paneID, "-l", digit).Run(); err != nil {
			return fmt.Errorf("tmux send-keys picker digit: %w", err)
		}
	}
	if submit {
		if err := exec.Command("tmux", "send-keys", "-t", paneID, "Enter").Run(); err != nil {
			return fmt.Errorf("tmux send-keys picker submit: %w", err)
		}
	}
	return nil
}

// FindTmuxPane maps a TTY path to a tmux pane ID. Returns an error if
// tmux isn't running or the TTY doesn't belong to any tmux pane.
func FindTmuxPane(ttyPath string) (string, error) {
	out, err := exec.Command("tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_tty}").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, " ", 2)
		if len(parts) == 2 && parts[1] == ttyPath {
			return parts[0], nil
		}
	}
	return "", fmt.Errorf("tty %s not found in tmux", ttyPath)
}

// sendViaTmux sends a message to a tmux pane via send-keys. This writes
// directly to the PTY master — no bracketed paste wrapping, no focus
// switch, no clipboard. The -l flag sends literal text (no key name
// interpretation), then a separate Enter sends the submit.
//
// Newlines/tabs are collapsed to single spaces before sending (see
// collapseForTmux) so Claude Code doesn't see the input as a paste.
//
// Long-message rescue: when the payload is large, Claude Code's TUI
// often catches the burst of bytes as a paste and shows
// `[Pasted text #N] …` in its input line, requiring a separate
// Enter to commit. The first Enter we send sometimes lands while
// the TUI is mid-render of the placeholder and gets swallowed,
// leaving the message stuck. After a short wait we peek the pane;
// if the placeholder is still visible (i.e. Claude is still
// idling on its prompt instead of replying), we fire one more
// Enter. Bounded retry: we only do this once, and only above a
// size threshold, so short messages aren't slowed down.
func sendViaTmux(paneID, message string) error {
	// collapseForTmux trims trailing whitespace, which can re-expose a
	// backslash that SendMessage already padded. Re-apply the guard here.
	flat := avoidTrailingBackslash(collapseForTmux(message))
	if err := exec.Command("tmux", "send-keys", "-t", paneID, "-l", flat).Run(); err != nil {
		return fmt.Errorf("tmux send-keys text: %w", err)
	}
	if err := exec.Command("tmux", "send-keys", "-t", paneID, "Enter").Run(); err != nil {
		return fmt.Errorf("tmux send-keys enter: %w", err)
	}

	// Threshold tuned to roughly when Claude Code starts using the
	// `[Pasted text #N]` shorthand. Below this, the TUI accepts the
	// chars as normal typed input and the single Enter always
	// commits. Above it, we hedge.
	const largePasteThreshold = 220
	if len(flat) >= largePasteThreshold {
		time.Sleep(500 * time.Millisecond)
		out, err := exec.Command("tmux", "capture-pane", "-p", "-t", paneID).Output()
		if err == nil && bytes.Contains(out, []byte("[Pasted text")) {
			// The placeholder is still on the input line — first
			// Enter didn't commit. Try once more. If this still
			// fails, the user can manually press Enter in the
			// terminal; better than spamming infinite retries.
			_ = exec.Command("tmux", "send-keys", "-t", paneID, "Enter").Run()
		}
	}
	return nil
}

func escapeAppleScript(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	// AppleScript string literals cannot span physical lines — raw newlines,
	// carriage returns, or tabs inside a quoted string cause a syntax error
	// and the entire script fails silently. Replace them with the escape
	// sequences AppleScript understands.
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	s = strings.ReplaceAll(s, "\t", `\t`)
	return s
}

func runOsascript(script string) error {
	cmd := exec.Command("osascript", "-e", script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("osascript error: %w — %s", err, string(out))
	}
	return nil
}

// sendViaTerminal uses Terminal.app's native "do script" AppleScript command
// to type the message into the correct tab. No clipboard, no System Events,
// no accessibility permissions, no focus switch.
func sendViaTerminal(ttyPath, message string) error {
	escaped := escapeAppleScript(message)
	script := fmt.Sprintf(`tell application "Terminal"
	repeat with w in windows
		repeat with t in tabs of w
			if tty of t is "%s" then
				do script "%s" in t
				return
			end if
		end repeat
	end repeat
end tell`, ttyPath, escaped)
	return runOsascript(script)
}
