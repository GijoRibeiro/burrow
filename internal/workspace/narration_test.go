package workspace

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

func narrationTestSignature(kind string) string {
	field := func(tag byte, value []byte) []byte {
		result := []byte{tag}
		result = binary.AppendUvarint(result, uint64(len(value)))
		return append(result, value...)
	}
	metadata := append([]byte{8, 17, 24, 2, 56, 1}, field(66, []byte(kind))...)
	envelope := append([]byte{8, 4}, field(18, field(10, metadata))...)
	return base64.StdEncoding.EncodeToString(envelope)
}

func TestNarrationVisibilityMarker(t *testing.T) {
	for _, tc := range []struct {
		name, signature string
		want            bool
	}{
		{"visible narration", narrationTestSignature("narration"), true},
		{"private thinking", narrationTestSignature("thinking"), false},
		{"unknown kind", narrationTestSignature("other"), false},
		{"missing marker", "", false},
		{"invalid base64", "not a signature!", false},
		{"word elsewhere", base64.StdEncoding.EncodeToString([]byte("narration")), false},
		{"truncated protobuf", base64.StdEncoding.EncodeToString([]byte{8, 4, 18, 100, 10, 3}), false},
		{"oversized signature", strings.Repeat("A", 65537), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isClaudeNarration(tc.signature); got != tc.want {
				t.Fatalf("visibility %v, want %v", got, tc.want)
			}
		})
	}
}

func TestConversationIncludesPublicNarrationBetweenReplies(t *testing.T) {
	var log strings.Builder
	add := func(id, kind, text, signature string) {
		entry := map[string]any{"type": "assistant", "uuid": id, "message": map[string]any{"content": []any{map[string]any{"type": kind, "text": text, "thinking": text, "signature": signature}}}}
		data, _ := json.Marshal(entry)
		log.Write(data)
		log.WriteByte('\n')
	}
	add("round2", "text", "Round 2 is ready.", "")
	add("private", "thinking", "Hidden reasoning should never reach the UI.", narrationTestSignature("thinking"))
	add("round3", "thinking", "Round 3 is progressing.", narrationTestSignature("narration"))
	add("round4", "thinking", "Round 4 is being tested.", narrationTestSignature("narration"))
	add("unknown", "thinking", "Unknown private block.", "")
	add("round4", "thinking", "Round 4 is complete.", narrationTestSignature("narration"))
	activity := parseConversation([]byte(log.String()))
	if len(activity.Messages) != 3 || activity.Messages[2].Text != "Round 4 is complete." {
		t.Fatalf("missing or duplicated narration: %+v", activity.Messages)
	}
	for _, message := range activity.Messages {
		if message.Role != "assistant" || strings.Contains(message.Text, "private") || strings.Contains(message.Text, "Hidden") {
			t.Fatalf("unexpected visibility: %+v", message)
		}
	}
}
