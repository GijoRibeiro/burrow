package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestConversationReaderRetainsMessagesAcrossLargeToolOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	var log strings.Builder
	for i := 0; i < 150; i++ {
		fmt.Fprintf(&log, "{\"type\":\"assistant\",\"uuid\":\"a%d\",\"message\":{\"content\":\"Visible message %d\"}}\n", i, i)
	}
	payload, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "content": strings.Repeat("x", 5<<20)}}}})
	log.Write(payload)
	log.WriteByte('\n')
	log.WriteString(`{"type":"assistant","uuid":"last","message":{"content":"Latest visible reply"}}` + "\n")
	if err := os.WriteFile(path, []byte(log.String()), 0600); err != nil {
		t.Fatal(err)
	}
	m := &Manager{}
	a, err := m.readConversation("test", path)
	if err != nil || len(a.Messages) != 151 || a.Messages[0].Text != "Visible message 0" || a.Messages[150].Text != "Latest visible reply" || a.Truncated {
		t.Fatalf("lost visible history: messages=%d truncated=%v err=%v", len(a.Messages), a.Truncated, err)
	}
	value, _ := m.conversations.Load("test")
	reader := value.(*conversationReader)
	offset := reader.offset
	if offset != int64(log.Len()) {
		t.Fatal("did not commit complete records")
	}
	a.Messages[0].Text = "Caller mutation"
	a, err = m.readConversation("test", path)
	if err != nil || len(a.Messages) != 151 || a.Messages[0].Text != "Visible message 0" || reader.offset != offset {
		t.Fatal("cache mutation or duplicate replay")
	}
	// Partial writes cannot blank the chat, even if the unfinished record is huge.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	partial := `{"type":"user","message":{"content":[{"type":"tool_result","content":"` + strings.Repeat("y", 5<<20)
	f.WriteString(partial)
	f.Close()
	a, err = m.readConversation("test", path)
	if err != nil || len(a.Messages) != 151 || reader.offset != offset {
		t.Fatal("partial tool record lost the conversation")
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString(`"}]}}` + "\n" + `{"type":"assistant","uuid":"last","message":{"content":"Latest visible reply, completed","stop_reason":"end_turn"}}` + "\n")
	f.Close()
	a, err = m.readConversation("test", path)
	if err != nil || len(a.Messages) != 151 || a.Messages[150].Text != "Latest visible reply, completed" || a.Status != "ready" {
		t.Fatal("appended replacement lost", err)
	}
	// Simultaneous status and UI polls see independent, consistent snapshots.
	var group sync.WaitGroup
	for i := 0; i < 4; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			a, err := m.readConversation("test", path)
			if err != nil || len(a.Messages) != 151 {
				t.Error("concurrent read failed", err)
			}
		}()
	}
	group.Wait()
}

func TestConversationReaderResetsAfterRotationTruncationAndSessionChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "one.jsonl")
	m := &Manager{}
	record := func(text string) []byte {
		return []byte(fmt.Sprintf("{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"content\":%q}}\n", text))
	}
	check := func(path, text string) {
		t.Helper()
		a, err := m.readConversation("test", path)
		if err != nil || len(a.Messages) != 1 || a.Messages[0].Text != text {
			t.Fatalf("wrong session: %+v %v", a, err)
		}
	}
	os.WriteFile(path, record("Original longer message"), 0600)
	check(path, "Original longer message")
	os.WriteFile(path, record("Short"), 0600)
	check(path, "Short")
	next := filepath.Join(dir, "replacement.jsonl")
	os.WriteFile(next, record("A much longer rotated conversation"), 0600)
	os.Rename(next, path)
	check(path, "A much longer rotated conversation")
	other := filepath.Join(dir, "two.jsonl")
	os.WriteFile(other, record("New session"), 0600)
	check(other, "New session")
}
