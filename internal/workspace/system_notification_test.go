package workspace

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSystemNotificationsAreNotHumanMessages(t *testing.T) {
	notification := `<task-notification><task-id>background-job</task-id><tool-use-id>toolu_test</tool-use-id><output-file>/tmp/job.output</output-file><status>completed</status><summary>Background command completed (exit code 0)</summary></task-notification>`
	for _, tc := range []struct {
		name, source, origin string
		blocks               bool
	}{
		{"real string event", "system", "task-notification", false},
		{"block event", "system", "task-notification", true},
		{"source only", "system", "", false},
		{"origin only", "", "task-notification", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newConversationLog()
			c.consume([]byte(`{"type":"assistant","uuid":"before","message":{"content":"Checking CI.","stop_reason":"end_turn"}}`))
			var content any = notification
			if tc.blocks {
				content = []any{map[string]any{"type": "text", "text": notification}}
			}
			event := map[string]any{"type": "user", "uuid": "event", "promptSource": tc.source, "origin": map[string]string{"kind": tc.origin}, "message": map[string]any{"content": content}}
			data, _ := json.Marshal(event)
			c.consume(data)
			if len(c.activity.Messages) != 1 || c.activity.Status != "ready" {
				t.Fatalf("internal event became a user message or changed activity: %+v", c.activity)
			}
			c.consume([]byte(`{"type":"assistant","uuid":"after","message":{"content":"CI passed.","stop_reason":"end_turn"}}`))
			if len(c.activity.Messages) != 2 || c.activity.Messages[1].Text != "CI passed." {
				t.Fatal("lost the agent's actual response")
			}
			encoded, _ := json.Marshal(c.activity)
			if strings.Contains(string(encoded), "task-notification") || strings.Contains(string(encoded), "job.output") {
				t.Fatal("leaked event XML")
			}
		})
	}
	// A person may paste XML to ask about it. Classify by origin, not text shape.
	for _, source := range []string{"typed", "queued", ""} {
		event := map[string]any{"type": "user", "uuid": "human", "promptSource": source, "origin": map[string]string{"kind": "human"}, "message": map[string]string{"content": notification}}
		data, _ := json.Marshal(event)
		a := parseConversation(data)
		if len(a.Messages) != 1 || a.Messages[0].Role != "user" || a.Messages[0].Text != notification {
			t.Fatalf("lost human %s message", source)
		}
	}
}
