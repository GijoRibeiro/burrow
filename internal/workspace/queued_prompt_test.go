package workspace

import (
	"encoding/json"
	"testing"
)

func TestBusyClaudePromptAcknowledgements(t *testing.T) {
	for _, blocks := range []bool{false, true} {
		var prompt any = "Follow-up while you work."
		if blocks {
			prompt = []any{map[string]string{"type": "text", "text": "Follow-up while you work."}, map[string]string{"type": "image"}}
		}
		entry := map[string]any{"type": "attachment", "uuid": "attachment", "attachment": map[string]any{"type": "queued_command", "commandMode": "prompt", "origin": map[string]string{"kind": "human"}, "source_uuid": "prompt-id", "prompt": prompt}}
		data, _ := json.Marshal(entry)
		c := newConversationLog()
		c.consume(data)
		c.consume(data)
		if len(c.activity.Messages) != 1 || c.activity.Messages[0].ID != "prompt-id" || c.activity.Messages[0].Role != "user" || c.activity.Messages[0].Text != "Follow-up while you work." {
			t.Fatalf("lost or duplicated queued prompt: %+v", c.activity.Messages)
		}
		c.consume([]byte(`{"type":"user","uuid":"prompt-id","message":{"content":"Follow-up while you work."}}`))
		if len(c.activity.Messages) != 1 {
			t.Fatal("duplicated normal/queued representation")
		}
	}
	for _, mode := range []string{"task-notification", "bash"} {
		data, _ := json.Marshal(map[string]any{"type": "attachment", "uuid": "internal", "attachment": map[string]any{"type": "queued_command", "commandMode": mode, "prompt": "Not a human prompt"}})
		if a := parseConversation(data); len(a.Messages) != 0 {
			t.Fatal("internal attachment exposed", mode)
		}
	}
}
