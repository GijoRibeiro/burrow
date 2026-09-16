package agentcli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gijo/cloovies/internal/workspace"
)

func TestCLIUsesAgentCredentialsAndStructuredMessages(t *testing.T) {
	var received workspace.AgentAction
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspace/agent" || r.Header.Get("X-Burrow-Agent") != "fixture-agent" || r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("incorrect agent request")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	dir := t.TempDir()
	state := filepath.Join(dir, "workspace.json")
	runtime := filepath.Join(dir, "runtime.json")
	os.WriteFile(state, []byte(`{"agentTokens":{"fixture-agent":"fixture-token"}}`), 0600)
	data, _ := json.Marshal(workspace.AgentRuntime{URL: server.URL, StateFile: state})
	os.WriteFile(runtime, data, 0600)
	args := []string{"--runtime", runtime, "--agent", "fixture-agent"}
	var out bytes.Buffer
	if err := Run(append(args, "send", "parent", "spaces, quotes ' and $() stay literal"), &out); err != nil {
		t.Fatal(err)
	}
	if received.Action != "send" || received.To != "parent" || received.Text != "spaces, quotes ' and $() stay literal" {
		t.Fatalf("wrong message: %+v", received)
	}
	if strings.Contains(out.String(), "fixture-token") {
		t.Fatal("credential printed")
	}
	if err := Run(append(args, "wait", "2junk"), &out); err == nil {
		t.Fatal("invalid duration accepted")
	}
	if err := Run(append(args, "delegate", "api", "codex", "API task", "Do the work"), &out); err != nil {
		t.Fatal(err)
	}
	if received.Delegate == nil || received.Delegate.Program != "codex" {
		t.Fatalf("wrong delegate: %+v", received)
	}
	if err := Run(append(args, "start", "existing-plan"), &out); err != nil {
		t.Fatal(err)
	}
	if received.Action != "start" || received.Query != "existing-plan" {
		t.Fatalf("wrong start: %+v", received)
	}
	if err := Run(append(args, "start"), &out); err == nil {
		t.Fatal("missing plan accepted")
	}
	data, _ = json.Marshal(workspace.AgentRuntime{URL: "https://example.com", StateFile: state})
	os.WriteFile(runtime, data, 0600)
	if err := Run(append(args, "inbox"), &out); err == nil {
		t.Fatal("non-local runtime accepted")
	}
}
func TestCLIHelpDoesNotNeedWorkspace(t *testing.T) {
	var out bytes.Buffer
	if err := Run([]string{"help"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "ack <message-id>") {
		t.Fatal("missing usage")
	}
}
