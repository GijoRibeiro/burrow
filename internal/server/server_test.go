package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gijo/cloovies/internal/config"
	"github.com/gijo/cloovies/internal/orchestrator"
	"github.com/gijo/cloovies/internal/registry"
	"github.com/gijo/cloovies/internal/scanner"
	"github.com/gijo/cloovies/internal/server"
)

func TestWebSocketSendsState(t *testing.T) {
	reg := registry.New()
	reg.UpdateFromScan([]scanner.AgentState{
		{PID: 100, SessionID: "s1", Cwd: "/proj", Alive: true, CurrentTask: "Test task", TaskStatus: "in_progress"},
	})

	cfg, _ := config.Load(filepath.Join(t.TempDir(), "settings.json"))
	srv := server.New(reg, orchestrator.NewExecutor(reg), nil, cfg, nil, nil, "", "", nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read error: %v", err)
	}

	var envelope struct {
		Type   string           `json:"type"`
		Agents []registry.Agent `json:"agents"`
	}
	if err := json.Unmarshal(msg, &envelope); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if envelope.Type != "state" {
		t.Errorf("expected type 'state', got '%s'", envelope.Type)
	}
	if len(envelope.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(envelope.Agents))
	}
	if envelope.Agents[0].CurrentTask != "Test task" {
		t.Errorf("expected task 'Test task', got '%s'", envelope.Agents[0].CurrentTask)
	}
}

func TestWebSocketReceivesCommand(t *testing.T) {
	reg := registry.New()
	cfg, _ := config.Load(filepath.Join(t.TempDir(), "settings.json"))
	srv := server.New(reg, orchestrator.NewExecutor(reg), nil, cfg, nil, nil, "", "", nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	ws.ReadMessage() // read initial state

	cmd := map[string]string{"type": "command", "text": "status"}
	data, _ := json.Marshal(cmd)
	if err := ws.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write error: %v", err)
	}

	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read error: %v", err)
	}

	var resp struct {
		Type string `json:"type"`
	}
	json.Unmarshal(msg, &resp)
	if resp.Type != "command_response" {
		t.Errorf("expected type 'command_response', got '%s'", resp.Type)
	}
}

// Ensure unused imports are referenced.
var _ http.Handler
