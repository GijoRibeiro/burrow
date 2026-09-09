package chat_test

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gijo/cloovies/internal/chat"
)

func TestParseAssistantText(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello from claude"}]}}`
	text, ok := chat.ParseAssistantText(line)
	if !ok {
		t.Fatal("expected ok=true for assistant message")
	}
	if text != "hello from claude" {
		t.Errorf("expected 'hello from claude', got '%s'", text)
	}
}

func TestIsTurnEndLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"turn_duration", `{"type":"system","subtype":"turn_duration","durationMs":1234}`, true},
		{"stop_hook_summary", `{"type":"system","subtype":"stop_hook_summary","hooks":[]}`, true},
		{"stop_hook_event", `{"hookEvent":"Stop","when":"after"}`, true},
		{"assistant_text", `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`, false},
		{"user_message", `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`, false},
		{"empty", "", false},
		{"unrelated_subtype", `{"type":"system","subtype":"last_prompt"}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := chat.IsTurnEndLine(c.line)
			if got != c.want {
				t.Errorf("IsTurnEndLine(%q) = %v, want %v", c.line, got, c.want)
			}
		})
	}
}

func TestParseAssistantTextIgnoresNonAssistant(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":"hello"}}`
	_, ok := chat.ParseAssistantText(line)
	if ok {
		t.Fatal("expected ok=false for user message")
	}
}

func TestParseAssistantTextWithToolUse(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read"},{"type":"text","text":"I read the file"}]}}`
	text, ok := chat.ParseAssistantText(line)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if text != "I read the file" {
		t.Errorf("expected 'I read the file', got '%s'", text)
	}
}

func TestFindTTYInvalidPID(t *testing.T) {
	_, err := chat.FindTTY(999999)
	if err == nil {
		t.Error("expected error for invalid PID")
	}
}

func TestConversationLogPath(t *testing.T) {
	path := chat.ConversationLogPath("/Users/test/project", "session-123")
	if !strings.Contains(path, "session-123.jsonl") {
		t.Errorf("expected path to contain session-123.jsonl, got %s", path)
	}
}

func containsAll(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}

// TestTailLogVerboseTurnEndDebounce verifies onTurnEnd fires once per
// turn even though Claude Code writes several turn-end marker lines
// (turn_duration + stop_hook_summary + Stop hook event) back-to-back,
// and fires again for the next turn once new content has appeared.
func TestTailLogVerboseTurnEndDebounce(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(logPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	defer close(done)

	var mu sync.Mutex
	turnEnds := 0
	texts := 0
	go func() {
		_ = chat.TailLogVerbose(logPath, done,
			func(text string, blocks []chat.VerboseBlock) {
				mu.Lock()
				texts++
				mu.Unlock()
			},
			func() {
				mu.Lock()
				turnEnds++
				mu.Unlock()
			},
		)
	}()

	appendLines := func(lines ...string) {
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		for _, l := range lines {
			if _, err := f.WriteString(l + "\n"); err != nil {
				t.Fatal(err)
			}
		}
	}

	waitFor := func(desc string, cond func() bool) {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			ok := cond()
			mu.Unlock()
			if ok {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("timeout waiting for %s", desc)
	}

	// Let the tail goroutine open the file and record its start offset
	// before we append — TailLogVerbose only reports lines written
	// after it attaches.
	time.Sleep(250 * time.Millisecond)

	assistant := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"turn one"}]}}`
	markers := []string{
		`{"type":"system","subtype":"turn_duration","durationMs":1234}`,
		`{"type":"system","subtype":"stop_hook_summary","hooks":[]}`,
		`{"hookEvent":"Stop","when":"after"}`,
	}

	// Turn 1: content then all three markers → exactly one onTurnEnd.
	appendLines(append([]string{assistant}, markers...)...)
	waitFor("first turn end", func() bool { return turnEnds >= 1 })
	// Give the tail a couple more ticks to (wrongly) fire extras.
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	if turnEnds != 1 {
		mu.Unlock()
		t.Fatalf("expected 1 turn end after first turn, got %d", turnEnds)
	}
	if texts != 1 {
		mu.Unlock()
		t.Fatalf("expected 1 text callback, got %d", texts)
	}
	mu.Unlock()

	// Turn 2: new content resets the debounce; markers fire once more.
	appendLines(append([]string{assistant}, markers...)...)
	waitFor("second turn end", func() bool { return turnEnds >= 2 })
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if turnEnds != 2 {
		t.Fatalf("expected 2 turn ends after second turn, got %d", turnEnds)
	}
}
