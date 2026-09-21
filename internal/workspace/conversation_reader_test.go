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

func TestPagedConversationBoundsMemoryAndKeepsAllHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "days.jsonl")
	var log strings.Builder
	for i := 0; i < 10000; i++ {
		fmt.Fprintf(&log, "{\"type\":\"assistant\",\"uuid\":\"a%d\",\"message\":{\"content\":%q}}\n", i, fmt.Sprintf("Update %d ", i)+strings.Repeat("public text ", 100))
	}
	os.WriteFile(path, []byte(log.String()), 0600)
	m := &Manager{}
	page := func(q conversationQuery) Activity {
		t.Helper()
		q.Limit = conversationPageSize
		a, err := m.readConversationPage("days", path, q)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	recent := page(conversationQuery{})
	if len(recent.Messages) != 60 || recent.History.Start != 9940 || recent.History.End != 10000 || recent.History.Total != 10000 {
		t.Fatalf("wrong latest page: %+v", recent.History)
	}
	value, _ := m.conversations.Load("days")
	reader := value.(*conversationReader)
	if len(reader.log.activity.Messages) != 0 || reader.cacheBytes > conversationCacheBytes || len(reader.cache) > 120 {
		t.Fatal("unbounded hydrated history")
	}
	before := recent.History.Start
	older := page(conversationQuery{Before: &before, Session: recent.History.Session})
	if older.History.End != 9940 || older.Messages[0].ID != "a9880" {
		t.Fatal("wrong previous page")
	}
	after := older.History.End
	newer := page(conversationQuery{After: &after, Session: recent.History.Session})
	if newer.Messages[0].ID != "a9940" {
		t.Fatal("gap in forward navigation")
	}
	// An old streamed message is replaced at its original position, even after
	// its parsed body has been evicted. System records never become chat rows.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("{\"type\":\"assistant\",\"uuid\":\"a0\",\"message\":{\"content\":\"Revised oldest message\"}}\n")
	f.Close()
	before = 60
	oldest := page(conversationQuery{Before: &before, Session: recent.History.Session})
	if oldest.Messages[0].Text != "Revised oldest message" || oldest.History.Total != 10000 {
		t.Fatal("lost or duplicated evicted message")
	}
	// One page cannot drag megabytes of public prose into every status poll.
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	for i := 10000; i < 10100; i++ {
		fmt.Fprintf(f, "{\"type\":\"assistant\",\"uuid\":\"a%d\",\"message\":{\"content\":%q}}\n", i, strings.Repeat("x", 32<<10))
	}
	f.Close()
	limited := page(conversationQuery{})
	if len(limited.Messages) != 8 || limited.History.End != 10100 || limited.History.Start != 10092 {
		t.Fatal("text budget not applied")
	}
	if reader.cacheBytes > conversationCacheBytes || len(reader.cache) > 120 {
		t.Fatal("cache exceeded budget")
	}
	// A cursor from a replaced session must never address unrelated old offsets.
	os.WriteFile(path, []byte("{\"type\":\"assistant\",\"uuid\":\"fresh\",\"message\":{\"content\":\"New session\"}}\n"), 0600)
	reset := page(conversationQuery{Before: &before, Session: recent.History.Session})
	if reset.History.Session == recent.History.Session || reset.History.Total != 1 || reset.Messages[0].ID != "fresh" {
		t.Fatal("stale session cursor accepted")
	}
}
