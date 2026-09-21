package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexPublicTranscript(t *testing.T) {
	log := newConversationLog()
	consume := func(kind string, payload any) {
		b, _ := json.Marshal(map[string]any{"type": kind, "payload": payload})
		log.consume(b)
	}
	consume("session_meta", map[string]any{"id": "thread"})
	consume("response_item", map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "injected environment"}}})
	consume("event_msg", map[string]any{"type": "task_started"})
	consume("event_msg", map[string]any{"type": "item_completed", "item": map[string]any{"type": "UserMessage", "id": "u1", "content": []any{map[string]any{"type": "local_image", "path": "/attachments/t/image-1.png"}, map[string]any{"type": "text", "text": "[Image #1] Look at this"}}}})
	consume("event_msg", map[string]any{"type": "item_completed", "item": map[string]any{"type": "Reasoning", "id": "r1", "content": []any{map[string]any{"type": "Text", "text": "private"}}}})
	consume("response_item", map[string]any{"type": "function_call", "name": "shell"})
	if log.activity.Status != "working" || log.activity.Tools != 1 {
		t.Fatalf("working: %+v", log.activity)
	}
	for i := 0; i < 2; i++ {
		consume("event_msg", map[string]any{"type": "item_completed", "item": map[string]any{"type": "AgentMessage", "id": "a1", "content": []any{map[string]any{"type": "Text", "text": "The image is red."}}}})
	}
	consume("response_item", map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "The image is red."}}})
	consume("event_msg", map[string]any{"type": "task_complete", "last_agent_message": "The image is red."})
	a := log.activity
	if a.Kind != "codex" || a.Status != "ready" || len(a.Messages) != 2 {
		t.Fatalf("public transcript: %+v", a)
	}
	if a.Messages[0].Text != messageWithImages("Look at this", []string{"/attachments/t/image-1.png"}) {
		t.Fatalf("image reconciliation: %q", a.Messages[0].Text)
	}
	if a.Messages[1].ID != "a1" || a.Messages[1].Text != "The image is red." {
		t.Fatal(a.Messages)
	}
}

func TestCodexBoundedHistoryAndPartialRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	var b strings.Builder
	for i := 0; i < 250; i++ {
		fmt.Fprintf(&b, `{"type":"event_msg","payload":{"type":"agent_message","message":"Reply %d"}}`+"\n", i)
	}
	partial := `{"type":"event_msg","payload":{"type":"user_message","message":"Later"}}`
	os.WriteFile(path, []byte(b.String()+partial[:30]), 0600)
	m := &Manager{}
	a, err := m.readConversationPage("test", path, conversationQuery{Limit: 60})
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Messages) != 60 || a.History.Total != 250 || a.Messages[0].Text != "Reply 190" {
		t.Fatalf("latest: %+v", a.History)
	}
	before := 60
	old, err := m.readConversationPage("test", path, conversationQuery{Limit: 60, Before: &before})
	if err != nil {
		t.Fatal(err)
	}
	if old.Messages[0].Text != "Reply 0" || old.Messages[0].ID != "codex-0" {
		t.Fatal(old.Messages[0])
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString(partial[30:] + "\n")
	f.Close()
	a, err = m.readConversationPage("test", path, conversationQuery{Limit: 60})
	if err != nil {
		t.Fatal(err)
	}
	if a.History.Total != 251 || a.Messages[59].Text != "Later" || a.Status != "working" {
		t.Fatalf("partial: %+v", a)
	}
}

func TestChatImagesStayWithTheirTerminal(t *testing.T) {
	m := &Manager{file: filepath.Join(t.TempDir(), "workspace.json")}
	for _, id := range []string{"one", "two"} {
		os.MkdirAll(m.imageUploadDir(id), 0700)
		os.WriteFile(filepath.Join(m.imageUploadDir(id), "image-test.png"), []byte("image"), 0600)
	}
	own := filepath.Join(m.imageUploadDir("one"), "image-test.png")
	if _, err := m.validateChatImages("one", []string{own}); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(m.imageUploadDir("two"), "image-test.png")
	if _, err := m.validateChatImages("one", []string{other}); err == nil {
		t.Fatal("cross-terminal image accepted")
	}
	link := filepath.Join(m.imageUploadDir("one"), "image-link.png")
	os.Symlink(other, link)
	if _, err := m.validateChatImages("one", []string{link}); err == nil {
		t.Fatal("symlink escaped image boundary")
	}
}

func TestCodexRootAndWorkerShareProcess(t *testing.T) {
	dir := t.TempDir()
	root := "11111111-1111-1111-1111-111111111111"
	child := "22222222-2222-2222-2222-222222222222"
	log := func(id, source string) string {
		p := filepath.Join(dir, "rollout-"+id+".jsonl")
		os.WriteFile(p, []byte(fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"source":%s}}`+"\n", id, source)), 0600)
		return p
	}
	workerLog := log(child, `{"subagent":{"thread_spawn":{"parent_thread_id":"root"}}}`)
	rootLog := log(root, `"cli"`)
	files := []string{filepath.Join(dir, "thread-writer-locks", child+".lock"), workerLog, filepath.Join(dir, "thread-writer-locks", root+".lock"), rootLog}
	id, path := codexSessionFiles(files)
	if id != root || path != rootLog {
		t.Fatalf("picked worker instead of CLI: %s %s", id, path)
	}
}
