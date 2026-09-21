package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in against a dedicated smoke socket only; never the user's app sessions.
func TestLiveCodexChatImage(t *testing.T) {
	if os.Getenv("BURROW_LIVE_CODEX_SMOKE") != "1" {
		t.Skip("opt-in real Codex image smoke")
	}
	m, err := New(filepath.Join(t.TempDir(), "workspace.json"), "burrow-codex-chat-smoke")
	if err != nil {
		t.Fatal(err)
	}
	m.state.Terminals = []Terminal{{ID: "smoke", Program: "codex", Path: "/tmp/burrow-codex-chat-smoke"}}
	a, err := m.Activity("smoke")
	if err != nil || !a.CanMessage {
		t.Fatalf("Codex not ready: %+v %v", a, err)
	}
	before := len(a.Messages)
	data, err := os.ReadFile("/tmp/burrow-codex-chat-smoke/red.png")
	if err != nil {
		t.Fatal(err)
	}
	dir := m.imageUploadDir("smoke")
	os.MkdirAll(dir, 0700)
	path := filepath.Join(dir, "image-smoke.png")
	os.WriteFile(path, data, 0600)
	if err = m.SendChatMessage("smoke", "What color is this newly attached image? Reply with only the color. Do not use tools or change files.", []string{path}); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(60 * time.Second)
	for time.Now().Before(until) {
		a, err = m.Activity("smoke")
		if err != nil {
			t.Fatal(err)
		}
		if len(a.Messages) > before+1 && a.Status == "ready" {
			last := a.Messages[len(a.Messages)-1]
			if last.Role != "assistant" || !strings.Contains(strings.ToLower(last.Text), "red") {
				t.Fatalf("vision reply: %+v", last)
			}
			if !strings.Contains(a.Messages[len(a.Messages)-2].Text, "image-smoke.png") {
				t.Fatal("native image missing from public receipt")
			}
			t.Log("Real native Codex received the image and answered Red; chat receipt and reply reconciled.")
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatal("Codex reply not mirrored before deadline")
}
