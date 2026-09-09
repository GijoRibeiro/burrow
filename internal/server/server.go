package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gijo/cloovies/internal/boss"
	"github.com/gijo/cloovies/internal/chat"
	"github.com/gijo/cloovies/internal/config"
	"github.com/gijo/cloovies/internal/linear"
	"github.com/gijo/cloovies/internal/orchestrator"
	"github.com/gijo/cloovies/internal/registry"
	"github.com/gijo/cloovies/internal/store"
	"github.com/gijo/cloovies/internal/terminal"
	"github.com/gijo/cloovies/internal/workers"
	"github.com/gijo/cloovies/internal/workspace"
	"github.com/gijo/cloovies/internal/worktree"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// buildRepoPath is the absolute path of the repo this binary was built from,
// injected at link time via -ldflags "-X .../server.buildRepoPath=$(PWD)".
// Empty in `go run` and in distributed .app downloads (no source on disk).
var buildRepoPath string

// Server handles HTTP and WebSocket connections.
type Server struct {
	reg        *registry.Registry
	exec       *orchestrator.Executor
	store      *store.Store
	cfg        *config.Config
	boss       *boss.Boss
	workers    *workers.Manager
	webDir     string
	spritesDir string
	embedFS    fs.FS
	clients    map[*websocket.Conn]bool
	mu         sync.Mutex
	chatDone   map[*websocket.Conn]chan struct{}
	// Auto-tail: tracks active tails keyed by sessionID
	activeTails   map[string]chan struct{}
	activeTailsMu sync.Mutex
	// Last assistant text each session's tail broadcast via chat_stream,
	// keyed by sessionID. Lets BroadcastAgentFinished tell "the client
	// already saw this" apart from "the tail missed it" — the backfill
	// only exists for the latter.
	lastStreamed   map[string]string
	lastStreamedMu sync.Mutex
}

// New creates a server that reads state from the registry.
// embedFS is an optional embedded filesystem for serving web assets (used by the
// single-binary distribution). Pass nil for dev mode.
func New(reg *registry.Registry, exec *orchestrator.Executor, st *store.Store, cfg *config.Config, b *boss.Boss, wm *workers.Manager, webDir string, spritesDir string, embedFS fs.FS) *Server {
	s := &Server{
		reg:          reg,
		exec:         exec,
		store:        st,
		cfg:          cfg,
		boss:         b,
		workers:      wm,
		webDir:       webDir,
		spritesDir:   spritesDir,
		embedFS:      embedFS,
		clients:      make(map[*websocket.Conn]bool),
		chatDone:     make(map[*websocket.Conn]chan struct{}),
		activeTails:  make(map[string]chan struct{}),
		lastStreamed: make(map[string]string),
	}

	// Wire worker events to broadcast boss events to clients.
	if wm != nil {
		wm.OnEvent(func(evt workers.WorkerEvent) {
			s.broadcastBossEvent(evt)
		})
	}

	return s
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	workspaceManager, workspaceErr := workspace.NewDefault()
	var workspaceHandler http.Handler
	if workspaceErr != nil {
		log.Printf("workspace: %v", workspaceErr)
		workspaceHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "Workspace could not be loaded. Check the daemon log.", 503)
		})
	} else {
		workspaceHandler = workspaceManager.Handler()
	}
	mux.Handle("/api/workspace", workspaceHandler)
	mux.Handle("/api/workspace/", workspaceHandler)
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/api/sprite", s.handleSaveSprite)
	mux.HandleFunc("/api/creatures", s.handleCreatures)
	mux.HandleFunc("/api/settings", s.handleSettingsAPI)
	mux.HandleFunc("/api/profiles", s.handleProfiles)
	mux.HandleFunc("/api/rebuild", s.handleRebuild)
	mux.HandleFunc("/api/now-playing", s.handleNowPlaying)
	mux.HandleFunc("/api/spotify/control", s.handleSpotifyControl)
	mux.HandleFunc("/api/spotify/request-access", s.handleSpotifyRequestAccess)
	mux.HandleFunc("/api/linear/issues", s.handleLinearIssues)
	mux.HandleFunc("/api/linear/issues/move", s.handleLinearMove)
	mux.HandleFunc("/api/linear/issues/priority", s.handleLinearPriority)
	mux.HandleFunc("/api/linear/test", s.handleLinearTest)
	mux.HandleFunc("/api/open-url", s.handleOpenURL)
	mux.HandleFunc("/api/debug/picker", s.handleDebugPicker)
	mux.HandleFunc("/api/agents-summary", s.handleAgentsSummary)
	mux.HandleFunc("/api/preflight", s.handlePreflight)
	mux.HandleFunc("/api/update/check", s.handleUpdateCheck)
	// Sprites are stored on disk in spritesDir (either the dev source tree or
	// ~/.cloovies/sprites for installed builds). The frontend requests them at
	// /assets/sprites/<name>-<n>.png.
	if s.spritesDir != "" {
		mux.Handle("/assets/sprites/", http.StripPrefix("/assets/sprites/", http.FileServer(http.Dir(s.spritesDir))))
	}
	if s.webDir != "" {
		mux.Handle("/", http.FileServer(http.Dir(s.webDir)))
	} else if s.embedFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.embedFS)))
	}
	return mux
}

func (s *Server) handleSaveSprite(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	if s.spritesDir == "" {
		http.Error(w, "sprites dir not configured", 500)
		return
	}

	var req struct {
		Filename string `json:"filename"`
		Data     string `json:"data"` // base64 PNG data (without data:image/png;base64, prefix)
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", 400)
		return
	}

	// Sanitize filename — only allow alphanumeric, dash, dot
	name := filepath.Base(req.Filename)
	if !strings.HasSuffix(name, ".png") {
		http.Error(w, "must be .png", 400)
		return
	}

	// Strip data URL prefix if present
	data := req.Data
	if idx := strings.Index(data, ","); idx != -1 {
		data = data[idx+1:]
	}

	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		http.Error(w, "bad base64", 400)
		return
	}

	path := filepath.Join(s.spritesDir, name)
	if err := os.WriteFile(path, decoded, 0644); err != nil {
		http.Error(w, "write error: "+err.Error(), 500)
		return
	}

	log.Printf("Saved sprite: %s", path)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "path": path})
}

// allAgents returns registry agents plus a synthetic boss entry.
func (s *Server) allAgents() []registry.Agent {
	agents := s.reg.All()
	if s.boss != nil {
		home, _ := os.UserHomeDir()
		status := "idle"
		task := ""
		if s.boss.IsRunning() {
			status = "idle"
			task = "orchestrator — ready"
		}
		agents = append(agents, registry.Agent{
			SessionID:   "boss",
			Cwd:         filepath.Join(home, ".cloovies", "boss"),
			Name:        "Boss",
			Status:      status,
			CurrentTask: task,
			StartedAt:   time.Now(),
		})
	}
	return agents
}

// safeWrite serializes all writes to a single websocket connection under
// s.mu. gorilla/websocket's docs are explicit that concurrent WriteMessage
// calls against the same conn are undefined behavior — when they race, the
// connection gets corrupted, the client sees onclose, and starts a 2s
// reconnect during which every message from the user is silently dropped.
// Every write on an *websocket.Conn owned by this server MUST go through
// here (or hold s.mu manually for multi-step sequences).
func (s *Server) safeWrite(conn *websocket.Conn, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return conn.WriteMessage(websocket.TextMessage, data)
}

// Broadcast sends the current state to all connected clients.
func (s *Server) Broadcast() {
	agents := s.allAgents()
	msg := stateMessage{Type: "state", Agents: agents}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for conn := range s.clients {
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			conn.Close()
			delete(s.clients, conn)
		}
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	s.mu.Lock()
	s.clients[conn] = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if done, ok := s.chatDone[conn]; ok {
			close(done)
			delete(s.chatDone, conn)
		}
		delete(s.clients, conn)
		s.mu.Unlock()
		conn.Close()
	}()

	// Send initial state
	agents := s.allAgents()
	initial := stateMessage{Type: "state", Agents: agents}
	data, _ := json.Marshal(initial)
	s.safeWrite(conn, data)

	// Read loop for commands
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var base struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(msg, &base); err != nil {
			continue
		}

		switch base.Type {
		case "command":
			var cmd commandMessage
			if err := json.Unmarshal(msg, &cmd); err != nil {
				continue
			}
			resp := s.handleCommand(cmd)
			respData, _ := json.Marshal(resp)
			s.safeWrite(conn, respData)

		case "chat":
			var cm chatMessage
			if err := json.Unmarshal(msg, &cm); err != nil {
				continue
			}
			go s.handleChat(conn, cm)

		case "chat_with_images":
			var cm chatWithImagesMessage
			if err := json.Unmarshal(msg, &cm); err != nil {
				continue
			}
			go s.handleChatWithImages(conn, cm)

		case "picker_key":
			var pk pickerKeyMessage
			if err := json.Unmarshal(msg, &pk); err != nil {
				continue
			}
			go s.handlePickerKey(conn, pk)

		case "boss_message":
			var bm bossMessage
			if err := json.Unmarshal(msg, &bm); err != nil {
				continue
			}
			go s.handleBossMessage(conn, bm)

		case "boss_cancel":
			if s.boss != nil {
				s.boss.Cancel()
			}

		case "settings":
			var sm settingsMessage
			if err := json.Unmarshal(msg, &sm); err != nil {
				continue
			}
			s.handleSettings(conn, sm)

		case "spawn_agent":
			var sp spawnAgentMessage
			if err := json.Unmarshal(msg, &sp); err != nil {
				continue
			}
			go s.handleSpawnAgent(conn, sp.OpenInTerminal, sp.SkipPermissions)

		case "spawn_agent_path":
			var sp spawnAgentPathMessage
			if err := json.Unmarshal(msg, &sp); err != nil {
				continue
			}
			go s.handleSpawnAgentPath(conn, sp.Path, sp.OpenInTerminal, sp.SkipPermissions)

		case "spawn_worktree_agent":
			var sp spawnWorktreeAgentMessage
			if err := json.Unmarshal(msg, &sp); err != nil {
				s.debugLog("[WS] bad spawn_worktree_agent: %v", err)
				continue
			}
			go s.handleSpawnWorktreeAgent(conn, sp)

		case "list_worktrees":
			var lw listWorktreesMessage
			if err := json.Unmarshal(msg, &lw); err != nil {
				s.debugLog("[WS] bad list_worktrees: %v", err)
				continue
			}
			go s.handleListWorktrees(conn, lw)

		case "remove_worktree":
			var rm removeWorktreeMessage
			if err := json.Unmarshal(msg, &rm); err != nil {
				s.debugLog("[WS] bad remove_worktree: %v", err)
				continue
			}
			go s.handleRemoveWorktree(conn, rm)

		case "stop_agent":
			var sa stopAgentMessage
			if err := json.Unmarshal(msg, &sa); err != nil {
				continue
			}
			go s.handleStopAgent(conn, sa)

		case "attach_agent":
			var sa stopAgentMessage // reuse — same shape (type + pid)
			if err := json.Unmarshal(msg, &sa); err != nil {
				continue
			}
			go s.handleAttachAgent(conn, sa.PID)

		case "interrupt_agent":
			var sa stopAgentMessage // reuse — same shape (type + pid)
			if err := json.Unmarshal(msg, &sa); err != nil {
				continue
			}
			go s.handleInterruptAgent(conn, sa.PID)
		}
	}
}

func (s *Server) handleCommand(cmd commandMessage) commandResponse {
	parsed, err := orchestrator.Parse(cmd.Text)
	if err != nil {
		return commandResponse{Type: "command_response", Text: err.Error()}
	}
	result := s.exec.Execute(parsed)
	text := result.Text
	if result.Error != "" {
		text = "Error: " + result.Error
	}
	return commandResponse{Type: "command_response", Text: text}
}

// handleCreatures lists, renames, and duplicates creatures.
// GET /api/creatures — list all creatures (reads sprite files from spritesDir)
// POST /api/creatures — create/rename/duplicate
func (s *Server) handleCreatures(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}

	if s.spritesDir == "" {
		http.Error(w, "sprites dir not configured", 500)
		return
	}

	if r.Method == "GET" {
		// List creatures by finding *-1.png files
		entries, err := os.ReadDir(s.spritesDir)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		var creatures []string
		for _, e := range entries {
			name := e.Name()
			if strings.HasSuffix(name, "-1.png") {
				creatures = append(creatures, strings.TrimSuffix(name, "-1.png"))
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(creatures)
		return
	}

	if r.Method == "POST" {
		var req struct {
			Action  string `json:"action"`  // "rename" or "duplicate"
			Name    string `json:"name"`    // current creature name
			NewName string `json:"newName"` // new name
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", 400)
			return
		}

		switch req.Action {
		case "rename":
			for _, suffix := range []string{"-1.png", "-2.png"} {
				old := filepath.Join(s.spritesDir, req.Name+suffix)
				new := filepath.Join(s.spritesDir, req.NewName+suffix)
				if err := os.Rename(old, new); err != nil {
					http.Error(w, "rename error: "+err.Error(), 500)
					return
				}
			}
			log.Printf("Renamed creature: %s -> %s", req.Name, req.NewName)

		case "duplicate":
			for _, suffix := range []string{"-1.png", "-2.png"} {
				src := filepath.Join(s.spritesDir, req.Name+suffix)
				dst := filepath.Join(s.spritesDir, req.NewName+suffix)
				data, err := os.ReadFile(src)
				if err != nil {
					http.Error(w, "read error: "+err.Error(), 500)
					return
				}
				if err := os.WriteFile(dst, data, 0644); err != nil {
					http.Error(w, "write error: "+err.Error(), 500)
					return
				}
			}
			log.Printf("Duplicated creature: %s -> %s", req.Name, req.NewName)

		default:
			http.Error(w, "unknown action: "+req.Action, 400)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		return
	}

	http.Error(w, "method not allowed", 405)
}

// handleProfiles — GET returns all profiles, POST updates a profile.
func (s *Server) handleProfiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}

	if r.Method == "GET" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.store.GetAll())
		return
	}

	if r.Method == "POST" {
		var req struct {
			Cwd           string `json:"cwd"`
			Action        string `json:"action"` // "setName", "setCreature", "addXP"
			Name          string `json:"name,omitempty"`
			CreatureIndex int    `json:"creatureIndex,omitempty"`
			XP            int    `json:"xp,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", 400)
			return
		}

		switch req.Action {
		case "setName":
			s.store.SetName(req.Cwd, req.Name)
		case "setCreature":
			s.store.SetCreature(req.Cwd, req.CreatureIndex)
		case "addXP":
			s.store.AddXP(req.Cwd, req.XP)
		default:
			http.Error(w, "unknown action", 400)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.store.Get(req.Cwd))
		return
	}

	http.Error(w, "method not allowed", 405)
}

type stateMessage struct {
	Type   string           `json:"type"`
	Agents []registry.Agent `json:"agents"`
}

type commandMessage struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type commandResponse struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type debugLogMessage struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// debugLog logs a message and broadcasts it to all connected clients.
func (s *Server) debugLog(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)

	resp := debugLogMessage{Type: "debug_log", Text: msg}
	data, _ := json.Marshal(resp)

	s.mu.Lock()
	defer s.mu.Unlock()
	for conn := range s.clients {
		conn.WriteMessage(websocket.TextMessage, data)
	}
}

type chatMessage struct {
	Type      string `json:"type"`
	Cwd       string `json:"cwd"`
	SessionID string `json:"sessionId"`
	PID       int    `json:"pid"`
	Text      string `json:"text"`
}

type chatWithImagesMessage struct {
	Type      string   `json:"type"`
	Cwd       string   `json:"cwd"`
	SessionID string   `json:"sessionId"`
	PID       int      `json:"pid"`
	Text      string   `json:"text"`
	Images    []string `json:"images"`
}

// pickerKeyMessage drives a Claude Code picker without the chat send path's
// text handling. Digit (when set) toggles/selects an option; Submit (when
// true) sends Enter to confirm. Used by the multi-select picker UI: toggle
// with {digit, submit:false}, confirm with {submit:true}.
type pickerKeyMessage struct {
	Type   string `json:"type"`
	PID    int    `json:"pid"`
	Digit  string `json:"digit"`
	Submit bool   `json:"submit"`
}

type chatStreamResponse struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Done bool   `json:"done"`
	Cwd  string `json:"cwd,omitempty"`
}

type chatStreamVerboseResponse struct {
	Type   string              `json:"type"` // "chat_stream_verbose"
	Blocks []chat.VerboseBlock `json:"blocks"`
	Cwd    string              `json:"cwd"`
}

type settingsMessage struct {
	Type   string `json:"type"`
	Action string `json:"action"`
	Key    string `json:"key"`
	Value  string `json:"value"`
}

type settingsResponse struct {
	Type     string        `json:"type"`
	Settings config.Config `json:"settings"`
}

type spawnAgentMessage struct {
	Type            string `json:"type"`
	OpenInTerminal  bool   `json:"openInTerminal,omitempty"`
	SkipPermissions bool   `json:"skipPermissions,omitempty"`
}

type spawnAgentPathMessage struct {
	Type            string `json:"type"`
	Path            string `json:"path"`
	OpenInTerminal  bool   `json:"openInTerminal,omitempty"`
	SkipPermissions bool   `json:"skipPermissions,omitempty"`
}

type spawnAgentResponse struct {
	Type    string `json:"type"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Path    string `json:"path,omitempty"`
}

type spawnWorktreeAgentMessage struct {
	Type            string `json:"type"`
	SourceCwd       string `json:"sourceCwd"`
	Name            string `json:"name"`
	OpenInTerminal  bool   `json:"openInTerminal,omitempty"`
	SkipPermissions bool   `json:"skipPermissions,omitempty"`
}

type spawnWorktreeAgentResponse struct {
	Type    string `json:"type"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Path    string `json:"path,omitempty"`
	Name    string `json:"name,omitempty"`
}

type removeWorktreeMessage struct {
	Type         string `json:"type"`
	WorktreePath string `json:"worktreePath"`
	Force        bool   `json:"force,omitempty"`
}

type removeWorktreeResponse struct {
	Type    string `json:"type"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type stopAgentMessage struct {
	Type string `json:"type"`
	PID  int    `json:"pid"`
}

type listWorktreesMessage struct {
	Type      string `json:"type"`
	SourceCwd string `json:"sourceCwd"`
}

type worktreeEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	HasSession bool   `json:"hasSession"`
}

type listWorktreesResponse struct {
	Type      string          `json:"type"`
	Success   bool            `json:"success"`
	Error     string          `json:"error,omitempty"`
	SourceCwd string          `json:"sourceCwd"`
	Worktrees []worktreeEntry `json:"worktrees"`
}

func (s *Server) handleChat(conn *websocket.Conn, cm chatMessage) {
	termApp := s.cfg.Get().TerminalApp
	if err := chat.SendMessage(termApp, cm.PID, cm.Text); err != nil {
		resp := chatStreamResponse{Type: "chat_stream", Text: "error: " + err.Error(), Done: true, Cwd: cm.Cwd}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
		return
	}
	// SyncTails will handle broadcasting the agent's response.
}

// handlePickerKey toggles or submits a multi-select picker on the agent's
// tmux pane. The next terminal scan re-broadcasts the updated picker state
// (refreshed checkboxes, or the picker gone once submitted).
func (s *Server) handlePickerKey(conn *websocket.Conn, pk pickerKeyMessage) {
	if err := chat.SendPickerKey(pk.PID, pk.Digit, pk.Submit); err != nil {
		resp := chatStreamResponse{Type: "chat_stream", Text: "picker error: " + err.Error(), Done: true}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}
}

func (s *Server) handleChatWithImages(conn *websocket.Conn, cm chatWithImagesMessage) {
	// Save images to temp files
	var imagePaths []string
	for i, b64 := range cm.Images {
		p, err := chat.SaveTempImage(b64, i)
		if err != nil {
			s.debugLog("[CHAT] Failed to save image %d: %v", i, err)
			continue
		}
		imagePaths = append(imagePaths, p)
	}

	// Build message with image file references
	msg := cm.Text
	if len(imagePaths) > 0 {
		msg += " (attached images: "
		for i, p := range imagePaths {
			if i > 0 {
				msg += ", "
			}
			msg += p
		}
		msg += ")"
	}

	// Send via the same terminal path as text-only messages
	termApp := s.cfg.Get().TerminalApp
	if err := chat.SendMessage(termApp, cm.PID, msg); err != nil {
		resp := chatStreamResponse{Type: "chat_stream", Text: "error: " + err.Error(), Done: true, Cwd: cm.Cwd}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
		return
	}
	// SyncTails will handle broadcasting the agent's response.
}

func (s *Server) handleSettings(conn *websocket.Conn, sm settingsMessage) {
	switch sm.Action {
	case "get":
		// just return current settings
	case "set":
		switch sm.Key {
		case "terminalApp":
			s.cfg.SetTerminalApp(sm.Value)
		case "linearApiKey":
			s.cfg.SetLinearAPIKey(sm.Value)
		}
	}

	resp := settingsResponse{Type: "settings_response", Settings: s.cfg.Get()}
	data, _ := json.Marshal(resp)
	s.safeWrite(conn, data)
}

func (s *Server) handleSpawnAgent(conn *websocket.Conn, openInTerminal, skipPermissions bool) {
	respond := func(success bool, errMsg, path string) {
		resp := spawnAgentResponse{Type: "spawn_agent_response", Success: success, Error: errMsg, Path: path}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}

	// 1. Show native folder picker via osascript
	out, err := exec.Command("osascript", "-e",
		`POSIX path of (choose folder with prompt "Select project folder for new agent")`).Output()
	if err != nil {
		respond(false, "cancelled", "")
		return
	}
	folder := strings.TrimSpace(string(out))
	if folder == "" {
		respond(false, "no folder selected", "")
		return
	}

	// Launch via the shared helper so the folder-picker, recent-folder, and
	// worktree spawn paths stay in sync on session naming, pre-trust, and
	// skip-permissions / open-in-terminal behavior.
	if _, err := s.launchClaudeTmux(folder, openInTerminal, skipPermissions); err != nil {
		respond(false, err.Error(), "")
		return
	}

	respond(true, "", folder)
}

// launchClaudeTmux starts a detached tmux session running `claude` in the
// given folder, picking a unique session name based on the folder's
// basename. Returns the session name on success. Shared by both the
// folder-picker spawn flow and the worktree-spawn flow so they stay in
// sync about session naming / skip-permissions / open-in-terminal
// behavior.
func (s *Server) launchClaudeTmux(folder string, openInTerminal, skipPermissions bool) (string, error) {
	folder = strings.TrimRight(folder, "/")

	// Pre-trust the folder so claude doesn't block on the first-run trust
	// prompt. Without this, a spawn into a never-before-seen folder hangs
	// invisibly in the detached tmux session — no session file is written,
	// so the scanner never sees it and nothing shows in the app. Best-effort:
	// if the write fails we still launch and fall back to the prompt.
	if home, err := os.UserHomeDir(); err == nil {
		if err := TrustFolder(home, folder); err != nil {
			s.debugLog("[SPAWN] pre-trust failed for %s: %v", folder, err)
		}
	}

	base := filepath.Base(folder)
	sessionName := "bitwise-" + base
	for i := 2; ; i++ {
		check := exec.Command("tmux", "has-session", "-t", sessionName)
		if check.Run() != nil {
			break
		}
		sessionName = fmt.Sprintf("bitwise-%s-%d", base, i)
	}

	claudeCmd := "claude"
	if skipPermissions {
		claudeCmd = "claude --dangerously-skip-permissions"
	}
	if err := exec.Command("tmux", "new-session", "-d", "-s", sessionName, "-c", folder, claudeCmd).Run(); err != nil {
		return "", fmt.Errorf("tmux error: %v", err)
	}

	s.cfg.AddRecentFolder(folder)
	s.debugLog("[SPAWN] Started tmux session %s in %s", sessionName, folder)

	if openInTerminal {
		if err := s.openTerminalForSession(sessionName); err != nil {
			s.debugLog("[SPAWN] session started but terminal open failed: %v", err)
		}
	}

	return sessionName, nil
}

func (s *Server) handleSpawnAgentPath(conn *websocket.Conn, folder string, openInTerminal, skipPermissions bool) {
	respond := func(success bool, errMsg, path string) {
		resp := spawnAgentResponse{Type: "spawn_agent_response", Success: success, Error: errMsg, Path: path}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}

	if folder == "" {
		respond(false, "empty path", "")
		return
	}
	folder = strings.TrimRight(folder, "/")

	if _, err := s.launchClaudeTmux(folder, openInTerminal, skipPermissions); err != nil {
		respond(false, err.Error(), "")
		return
	}
	respond(true, "", folder)
}

// handleSpawnWorktreeAgent atomically: resolves the repo's default
// branch, creates a new git worktree at <sourceCwd>/.claude/worktrees/
// <name> on a new branch `worktree/<name>`, then launches a tmux+claude
// session in that worktree. On post-create failure (tmux), the
// worktree is rolled back via `git worktree remove --force`.
func (s *Server) handleSpawnWorktreeAgent(conn *websocket.Conn, sp spawnWorktreeAgentMessage) {
	respond := func(success bool, errMsg, path, name string) {
		resp := spawnWorktreeAgentResponse{
			Type: "spawn_worktree_agent_response", Success: success, Error: errMsg, Path: path, Name: name,
		}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}

	if sp.SourceCwd == "" {
		respond(false, "empty sourceCwd", "", "")
		return
	}
	if err := worktree.ValidateName(sp.Name); err != nil {
		respond(false, err.Error(), "", "")
		return
	}
	base, err := worktree.DefaultBranch(sp.SourceCwd)
	if err != nil {
		respond(false, err.Error(), "", "")
		return
	}
	path, err := worktree.Create(sp.SourceCwd, sp.Name, base)
	if err != nil {
		respond(false, err.Error(), "", "")
		return
	}
	if _, err := s.launchClaudeTmux(path, sp.OpenInTerminal, sp.SkipPermissions); err != nil {
		// Roll back the worktree so we don't leave an orphan dir.
		if rmErr := worktree.Remove(sp.SourceCwd, path, true); rmErr != nil {
			s.debugLog("[SPAWN-WT] tmux launch failed AND rollback failed: %v / %v", err, rmErr)
		}
		respond(false, err.Error(), "", "")
		return
	}
	respond(true, "", path, sp.Name)
}

// handleListWorktrees enumerates the existing cloovies-managed worktrees
// under <sourceCwd>/.claude/worktrees/ and reports which ones already
// have a running tmux session (so the UI can offer "resume" vs hide
// the action). The tmux check is best-effort: if tmux isn't installed
// or fails, HasSession is reported as false rather than blocking the
// whole response.
func (s *Server) handleListWorktrees(conn *websocket.Conn, lw listWorktreesMessage) {
	respond := func(success bool, errMsg string, entries []worktreeEntry) {
		resp := listWorktreesResponse{
			Type: "list_worktrees_response", Success: success, Error: errMsg,
			SourceCwd: lw.SourceCwd, Worktrees: entries,
		}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}
	if lw.SourceCwd == "" {
		respond(false, "empty sourceCwd", nil)
		return
	}
	list, err := worktree.List(lw.SourceCwd)
	if err != nil {
		respond(false, err.Error(), nil)
		return
	}
	entries := make([]worktreeEntry, 0, len(list))
	for _, w := range list {
		sessName := "bitwise-" + filepath.Base(w.Path)
		hasSession := exec.Command("tmux", "has-session", "-t", sessName).Run() == nil
		entries = append(entries, worktreeEntry{
			Name: w.Name, Path: w.Path, Branch: w.Branch, HasSession: hasSession,
		})
	}
	respond(true, "", entries)
}

// handleRemoveWorktree runs `git worktree remove` on the given path.
// The repo cwd is the path with `.claude/worktrees/<name>` stripped;
// requiring the full path from the UI keeps the protocol obvious.
func (s *Server) handleRemoveWorktree(conn *websocket.Conn, rm removeWorktreeMessage) {
	respond := func(success bool, errMsg string) {
		resp := removeWorktreeResponse{Type: "remove_worktree_response", Success: success, Error: errMsg}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}
	if rm.WorktreePath == "" {
		respond(false, "empty worktreePath")
		return
	}
	repoCwd, ok := repoFromWorktreePath(rm.WorktreePath)
	if !ok {
		respond(false, "worktreePath isn't under any .claude/worktrees/<name>")
		return
	}
	if err := worktree.Remove(repoCwd, rm.WorktreePath, rm.Force); err != nil {
		respond(false, err.Error())
		return
	}
	respond(true, "")
}

// repoFromWorktreePath strips the `.claude/worktrees/<name>` suffix
// from a worktree path to recover the source repo's cwd. Returns
// ok=false if the suffix isn't there — we don't want to run `git -C`
// against a path that isn't actually a cloovies-managed worktree.
func repoFromWorktreePath(worktreePath string) (string, bool) {
	worktreePath = strings.TrimRight(worktreePath, "/")
	dir := filepath.Dir(worktreePath) // <repo>/.claude/worktrees
	if filepath.Base(dir) != "worktrees" {
		return "", false
	}
	parent := filepath.Dir(dir) // <repo>/.claude
	if filepath.Base(parent) != ".claude" {
		return "", false
	}
	return filepath.Dir(parent), true // <repo>
}

// findTmuxSessionForAgent returns the tmux session name for an agent's PID,
// or empty string if the agent isn't in tmux.
func findTmuxSessionForAgent(pid int) string {
	ttyPath, err := chat.FindTTY(pid)
	if err != nil {
		return ""
	}
	out, err := exec.Command("tmux", "list-panes", "-a", "-F", "#{session_name} #{pane_tty}").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, " ", 2)
		if len(parts) == 2 && parts[1] == ttyPath {
			return parts[0]
		}
	}
	return ""
}

func (s *Server) handleStopAgent(conn *websocket.Conn, sa stopAgentMessage) {
	respond := func(success bool, errMsg string) {
		resp := spawnAgentResponse{Type: "stop_agent_response", Success: success, Error: errMsg}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}

	// Try tmux kill first
	if session := findTmuxSessionForAgent(sa.PID); session != "" {
		if err := exec.Command("tmux", "kill-session", "-t", session).Run(); err != nil {
			respond(false, fmt.Sprintf("tmux kill error: %v", err))
			return
		}
		s.debugLog("[STOP] Killed tmux session %s (pid %d)", session, sa.PID)
		respond(true, "")
		return
	}

	// Fallback: SIGINT the process directly
	proc, err := os.FindProcess(sa.PID)
	if err != nil {
		respond(false, fmt.Sprintf("process not found: %v", err))
		return
	}
	if err := proc.Signal(syscall.SIGINT); err != nil {
		respond(false, fmt.Sprintf("signal error: %v", err))
		return
	}
	s.debugLog("[STOP] Sent SIGINT to pid %d", sa.PID)
	respond(true, "")
}

// handleInterruptAgent sends a single Escape keypress to the agent's
// tmux pane — the equivalent of pressing ESC inside Claude Code to
// interrupt mid-think. The agent stays alive; only the in-flight
// thought is cancelled.
func (s *Server) handleInterruptAgent(conn *websocket.Conn, pid int) {
	respond := func(success bool, errMsg string) {
		resp := spawnAgentResponse{Type: "interrupt_agent_response", Success: success, Error: errMsg}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}
	if err := chat.SendEscape(pid); err != nil {
		s.debugLog("[INTERRUPT] pid %d: %v", pid, err)
		respond(false, err.Error())
		return
	}
	s.debugLog("[INTERRUPT] Sent Escape to pid %d", pid)
	respond(true, "")
}

// openTerminalForSession opens a new terminal window attached to the given
// tmux session. Returns nil on success or an error describing what went wrong.
func (s *Server) openTerminalForSession(session string) error {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		return fmt.Errorf("tmux not found — install it with: brew install tmux")
	}

	if err := exec.Command(tmuxPath, "has-session", "-t", session).Run(); err != nil {
		return fmt.Errorf("terminal session ended")
	}

	termApp := s.cfg.Get().TerminalApp
	var script, appName, bundleName string
	switch termApp {
	case "iterm2":
		appName = "iTerm2"
		bundleName = "iTerm" // the .app bundle is iTerm.app even though AppleScript targets "iTerm2"
		script = fmt.Sprintf(`tell application "iTerm2"
	create window with default profile command "%s attach-session -t %s"
end tell`, tmuxPath, session)
	default:
		appName = "Terminal"
		bundleName = "Terminal"
		script = fmt.Sprintf(`tell application "Terminal"
	do script "%s attach-session -t %s"
	activate
end tell`, tmuxPath, session)
	}

	// Make sure the terminal app is launched before we tell it to open a
	// window. `open -a` is idempotent (no-op if already running, launches it
	// if not). AppleScript's `tell application` waits for the target to be
	// ready, so no sleep is needed after this.
	if err := exec.Command("open", "-a", bundleName).Run(); err != nil {
		s.debugLog("[ATTACH] open -a %s failed: %v", bundleName, err)
		return fmt.Errorf("%s is not installed — install it or switch terminal in settings", appName)
	}

	cmd := exec.Command("osascript", "-e", script)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		s.debugLog("[ATTACH] osascript failed: %v — stderr: %s", err, stderr.String())
		return fmt.Errorf("failed to open %s window: %s", appName, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (s *Server) handleAttachAgent(conn *websocket.Conn, pid int) {
	respond := func(success bool, errMsg string) {
		resp := struct {
			Type    string `json:"type"`
			Success bool   `json:"success"`
			Error   string `json:"error,omitempty"`
		}{Type: "attach_agent_response", Success: success, Error: errMsg}
		data, _ := json.Marshal(resp)
		s.safeWrite(conn, data)
	}

	session := findTmuxSessionForAgent(pid)
	if session == "" {
		s.debugLog("[ATTACH] No tmux session for pid %d", pid)
		respond(false, "no terminal session — agent was started outside tmux")
		return
	}

	if err := s.openTerminalForSession(session); err != nil {
		s.debugLog("[ATTACH] %v", err)
		respond(false, err.Error())
		return
	}
	s.debugLog("[ATTACH] Opened terminal for tmux session %s", session)
	respond(true, "")
}

// --- Boss message handling ---

type bossMessage struct {
	Type      string   `json:"type"`
	Text      string   `json:"text"`
	Images    []string `json:"images,omitempty"` // base64 image data
	ThinkMode bool     `json:"thinkMode,omitempty"`
}

type bossReplyResponse struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}

type bossEventResponse struct {
	Type   string `json:"type"`
	Event  string `json:"event"`
	Detail string `json:"detail"`
}

func (s *Server) handleBossMessage(conn *websocket.Conn, bm bossMessage) {
	s.debugLog("[BOSS] Received message: %q", bm.Text)
	s.debugLog("[BOSS] boss=%v isRunning=%v", s.boss != nil, s.boss != nil && s.boss.IsRunning())
	if s.boss == nil || !s.boss.IsRunning() {
		resp := bossReplyResponse{Type: "boss_reply", Text: "Boss agent is not running. Restart the daemon.", Done: true}
		data, _ := json.Marshal(resp)
		s.mu.Lock()
		conn.WriteMessage(websocket.TextMessage, data)
		s.mu.Unlock()
		return
	}

	// Save any attached images to temp files
	var imagePaths []string
	if len(bm.Images) > 0 {
		for i, b64 := range bm.Images {
			p, err := chat.SaveTempImage(b64, i)
			if err != nil {
				s.debugLog("[BOSS] Failed to save image %d: %v", i, err)
				continue
			}
			imagePaths = append(imagePaths, p)
		}
		s.debugLog("[BOSS] Saved %d images to temp files", len(imagePaths))
	}

	// Build registry snapshot for the boss.
	snapshot := s.buildRegistrySnapshot()

	// If images were attached, tell the boss about them
	messageText := bm.Text
	if len(imagePaths) > 0 {
		messageText += " [SYSTEM: The user attached " + fmt.Sprintf("%d", len(imagePaths)) + " image(s). File paths: "
		for i, p := range imagePaths {
			if i > 0 {
				messageText += ", "
			}
			messageText += p
		}
		messageText += ". When delegating this to an agent via the 'chat' tool, include these image paths using the 'images' field so the agent can see them.]"
	}

	s.debugLog("[BOSS] Sending to boss, snapshot len=%d thinkMode=%v", len(snapshot), bm.ThinkMode)
	ch, err := s.boss.Send(messageText, snapshot, bm.ThinkMode)
	if err != nil {
		s.debugLog("[BOSS] Send error: %v", err)
		resp := bossReplyResponse{Type: "boss_reply", Text: "Error: " + err.Error(), Done: true}
		data, _ := json.Marshal(resp)
		s.mu.Lock()
		conn.WriteMessage(websocket.TextMessage, data)
		s.mu.Unlock()
		return
	}

	s.debugLog("[BOSS] Reading events from channel...")
	for evt := range ch {
		s.debugLog("[BOSS] Event: type=%s text=%q err=%q actions=%d", evt.Type, evt.Text, evt.Error, len(evt.Actions))
		switch evt.Type {
		case "text":
			resp := bossReplyResponse{Type: "boss_reply", Text: evt.Text, Done: false}
			data, _ := json.Marshal(resp)
			s.mu.Lock()
			conn.WriteMessage(websocket.TextMessage, data)
			s.mu.Unlock()

		case "actions":
			s.executeBossActions(conn, evt.Actions)

		case "error":
			resp := bossReplyResponse{Type: "boss_reply", Text: "Error: " + evt.Error, Done: true}
			data, _ := json.Marshal(resp)
			s.mu.Lock()
			conn.WriteMessage(websocket.TextMessage, data)
			s.mu.Unlock()
		}
	}

	// Signal done.
	resp := bossReplyResponse{Type: "boss_reply", Text: "", Done: true}
	data, _ := json.Marshal(resp)
	s.mu.Lock()
	conn.WriteMessage(websocket.TextMessage, data)
	s.mu.Unlock()
}

func (s *Server) buildRegistrySnapshot() string {
	agents := s.reg.All()
	if len(agents) == 0 {
		return "No agents currently running."
	}

	var sb strings.Builder
	sb.WriteString("Existing agents (use 'chat' tool with session_id):\n")
	for _, a := range agents {
		name := a.Name
		if name == "" {
			name = shortenAgentPath(a.Cwd)
		}
		task := a.CurrentTask
		if task == "" {
			task = "idle"
		}
		worktreeInfo := ""
		if a.Worktree != "" {
			worktreeInfo = fmt.Sprintf(" worktree=%s", a.Worktree)
		}
		sb.WriteString(fmt.Sprintf("- %s [%s] session_id=%s pid=%d path=%s%s — %q\n",
			name, a.Status, a.SessionID, a.PID, a.Cwd, worktreeInfo, task))
	}

	// Also include boss-managed workers.
	if s.workers != nil {
		ww := s.workers.All()
		if len(ww) > 0 {
			sb.WriteString("\nWorkers (use 'message' tool with agent_id):\n")
			for _, w := range ww {
				sb.WriteString(fmt.Sprintf("- %s [%s] %s — %q\n", w.ID, w.Status, w.Path, w.Task))
			}
		}
	}

	// Include recent conversation context from each agent so Boss can
	// route intelligently without asking.
	sb.WriteString("\n## Recent agent conversations\n")
	for _, a := range agents {
		if a.SessionID == "boss" {
			continue
		}
		name := a.Name
		if name == "" {
			name = shortenAgentPath(a.Cwd)
		}
		logPath := chat.ConversationLogPath(a.Cwd, a.SessionID)
		msgs := chat.ReadRecentMessages(logPath, 6)
		if len(msgs) == 0 {
			continue
		}
		sb.WriteString(fmt.Sprintf("\n### %s\n", name))
		for _, m := range msgs {
			text := m.Text
			// Truncate long messages to keep the snapshot manageable.
			if len(text) > 300 {
				text = text[:300] + "..."
			}
			if m.Role == "user" {
				sb.WriteString(fmt.Sprintf("  User: %s\n", text))
			} else {
				sb.WriteString(fmt.Sprintf("  Agent: %s\n", text))
			}
		}
	}

	return sb.String()
}

func shortenAgentPath(path string) string {
	parts := strings.Split(path, "/")
	if len(parts) > 2 {
		return "~/" + strings.Join(parts[len(parts)-2:], "/")
	}
	return path
}

func (s *Server) executeBossActions(conn *websocket.Conn, actions []boss.Action) {
	for _, action := range actions {
		switch action.Tool {
		case "chat":
			// Message an existing agent via its terminal TTY.
			agent, ok := s.reg.Get(action.SessionID)
			if !ok {
				s.sendBossEvent(conn, "error", fmt.Sprintf("Agent %s not found in registry", action.SessionID))
				continue
			}
			name := agent.Name
			if name == "" {
				name = shortenAgentPath(agent.Cwd)
			}

			// If images are attached, include file paths in the message
			msgText := action.Text
			if len(action.Images) > 0 {
				msgText += " (attached images: "
				for i, p := range action.Images {
					if i > 0 {
						msgText += ", "
					}
					msgText += p
				}
				msgText += ")"
			}

			termApp := s.cfg.Get().TerminalApp
			if err := chat.SendMessage(termApp, agent.PID, msgText); err != nil {
				s.sendBossEvent(conn, "error", fmt.Sprintf("Failed to message %s: %v", name, err))
			} else {
				s.sendBossEvent(conn, "messaged", fmt.Sprintf("%s is now working on it", name))
			}

		case "spawn":
			if s.workers == nil {
				s.sendBossEvent(conn, "error", "Worker manager not available")
				continue
			}
			id, err := s.workers.Spawn(action.Path, action.Task)
			if err != nil {
				s.sendBossEvent(conn, "error", fmt.Sprintf("Failed to spawn in %s: %v", action.Path, err))
			} else {
				s.sendBossEvent(conn, "spawned", fmt.Sprintf("Agent %s started in %s", id, action.Path))
			}

		case "message":
			if s.workers == nil {
				s.sendBossEvent(conn, "error", "Worker manager not available")
				continue
			}
			err := s.workers.SendMessage(action.AgentID, action.Text)
			if err != nil {
				s.sendBossEvent(conn, "error", fmt.Sprintf("Failed to message %s: %v", action.AgentID, err))
			} else {
				s.sendBossEvent(conn, "messaged", fmt.Sprintf("Sent message to %s", action.AgentID))
			}

		case "stop":
			if s.workers == nil {
				s.sendBossEvent(conn, "error", "Worker manager not available")
				continue
			}
			err := s.workers.Stop(action.AgentID)
			if err != nil {
				s.sendBossEvent(conn, "error", fmt.Sprintf("Failed to stop %s: %v", action.AgentID, err))
			} else {
				s.sendBossEvent(conn, "stopped", fmt.Sprintf("Stopped %s", action.AgentID))
			}

		case "status":
			snapshot := s.buildRegistrySnapshot()
			s.sendBossEvent(conn, "status", snapshot)
		}
	}
}

func (s *Server) sendBossEvent(conn *websocket.Conn, event string, detail string) {
	resp := bossEventResponse{Type: "boss_event", Event: event, Detail: detail}
	data, _ := json.Marshal(resp)
	s.mu.Lock()
	conn.WriteMessage(websocket.TextMessage, data)
	s.mu.Unlock()
}

func (s *Server) broadcastBossEvent(evt workers.WorkerEvent) {
	var event, detail string
	switch evt.Type {
	case "status_change":
		event = "worker_status"
		detail = fmt.Sprintf("%s is now %s", evt.WorkerID, evt.Status)
	case "done":
		event = "worker_done"
		detail = fmt.Sprintf("%s finished", evt.WorkerID)
	case "error":
		event = "worker_error"
		detail = fmt.Sprintf("%s error: %s", evt.WorkerID, evt.Error)
	default:
		return
	}

	resp := bossEventResponse{Type: "boss_event", Event: event, Detail: detail}
	data, _ := json.Marshal(resp)

	s.mu.Lock()
	defer s.mu.Unlock()
	for conn := range s.clients {
		conn.WriteMessage(websocket.TextMessage, data)
	}
}

// BroadcastAgentFinished notifies clients that an agent's active stream has
// ended. Text is normally streamed live via SyncTails, but the live stream
// can drop content (tail opened mid-turn, WebSocket blip, etc.), so we also
// read the last assistant message from the log and include it here as a
// backfill — but ONLY when the tail didn't already stream that exact text.
// Re-sending it every turn-end put the client's fragile lookback dedupe on
// the critical path: any turn that ended without fresh assistant text
// (interrupt, tool-only finish) re-broadcast the PREVIOUS turn's message,
// which is exactly the "old messages keep repeating" bug. An empty-text
// agent_finished still matters to the client — it finalizes the lane's
// streaming entry and drives the notification.
func (s *Server) BroadcastAgentFinished(sessionID, cwd, name string) {
	if name == "" {
		name = shortenAgentPath(cwd)
	}

	text := chat.ReadLastAssistantMessage(chat.ConversationLogPath(cwd, sessionID))
	s.lastStreamedMu.Lock()
	if text != "" && text == s.lastStreamed[sessionID] {
		text = ""
	}
	s.lastStreamedMu.Unlock()

	type agentFinishedResponse struct {
		Type string `json:"type"`
		Name string `json:"name"`
		Cwd  string `json:"cwd"`
		Text string `json:"text"`
	}

	resp := agentFinishedResponse{Type: "agent_finished", Name: name, Cwd: cwd, Text: text}
	data, _ := json.Marshal(resp)

	s.mu.Lock()
	for conn := range s.clients {
		conn.WriteMessage(websocket.TextMessage, data)
	}
	s.mu.Unlock()

	// The clients have this text now — treat it as streamed so the next
	// turn-end broadcast (tail marker + registry transition both fire
	// one) doesn't backfill it a second time.
	if text != "" {
		s.lastStreamedMu.Lock()
		s.lastStreamed[sessionID] = text
		s.lastStreamedMu.Unlock()
	}
}

// SyncTails starts auto-tailing for any alive agent that isn't already tailed,
// and stops tails for agents that are no longer in the registry or are done.
// Tails stay open through active/idle transitions so we don't miss content
// written during long model responses (which can take 30+ seconds).
func (s *Server) SyncTails() {
	agents := s.reg.All()

	// Build set of agents to tail: anything in the registry that isn't "done"
	aliveSet := make(map[string]bool)
	for _, a := range agents {
		if a.Status != "done" {
			aliveSet[a.SessionID] = true
		}
	}

	s.activeTailsMu.Lock()
	defer s.activeTailsMu.Unlock()

	// Stop tails for agents no longer alive
	for sid, done := range s.activeTails {
		if !aliveSet[sid] {
			close(done)
			delete(s.activeTails, sid)
			s.lastStreamedMu.Lock()
			delete(s.lastStreamed, sid)
			s.lastStreamedMu.Unlock()
		}
	}

	// Start tails for newly-tracked alive agents
	for _, a := range agents {
		if !aliveSet[a.SessionID] {
			continue
		}
		if _, exists := s.activeTails[a.SessionID]; exists {
			continue
		}
		logPath := chat.ConversationLogPath(a.Cwd, a.SessionID)
		if _, err := os.Stat(logPath); err != nil {
			continue
		}
		done := make(chan struct{})
		s.activeTails[a.SessionID] = done
		agentSID := a.SessionID
		agentCwd := a.Cwd
		agentName := a.Name
		go func() {
			_ = chat.TailLogVerbose(logPath, done,
				func(text string, blocks []chat.VerboseBlock) {
					s.mu.Lock()
					defer s.mu.Unlock()
					// Normal stream (existing behavior)
					if text != "" {
						resp := chatStreamResponse{Type: "chat_stream", Text: text, Done: false, Cwd: agentCwd}
						data, _ := json.Marshal(resp)
						for conn := range s.clients {
							conn.WriteMessage(websocket.TextMessage, data)
						}
						// Remember what the clients have already seen so
						// BroadcastAgentFinished can skip its backfill.
						s.lastStreamedMu.Lock()
						s.lastStreamed[agentSID] = text
						s.lastStreamedMu.Unlock()
					}
					// Verbose stream
					if len(blocks) > 0 {
						resp := chatStreamVerboseResponse{Type: "chat_stream_verbose", Blocks: blocks, Cwd: agentCwd}
						data, _ := json.Marshal(resp)
						for conn := range s.clients {
							conn.WriteMessage(websocket.TextMessage, data)
						}
					}
				},
				func() {
					// Turn-end marker seen in the log. Broadcast agent_finished
					// directly so short turns that start-and-finish within one
					// 3s scan-tick window (and therefore never register an
					// active→idle transition) still get the last-assistant
					// backfill. The client dedupes against any text already
					// rendered via chat_stream.
					s.BroadcastAgentFinished(agentSID, agentCwd, agentName)
				},
			)
		}()
	}
}

func (s *Server) handleSettingsAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}
	if r.Method == "GET" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.cfg.Get())
		return
	}
	if r.Method == "POST" {
		var req struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		switch req.Key {
		case "terminalApp":
			s.cfg.SetTerminalApp(req.Value)
		case "linearApiKey":
			s.cfg.SetLinearAPIKey(req.Value)
		default:
			http.Error(w, "unknown setting: "+req.Key, 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.cfg.Get())
		return
	}
	http.Error(w, "method not allowed", 405)
}

// handleOpenURL opens a URL in the user's default browser via `open` on
// macOS. This is the reliable path from inside the WKWebView wrapper, where
// `window.open` is sometimes silently dropped. Restricted to http(s) URLs.
func (s *Server) handleOpenURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if !strings.HasPrefix(body.URL, "http://") && !strings.HasPrefix(body.URL, "https://") {
		http.Error(w, "only http(s) urls allowed", http.StatusBadRequest)
		return
	}
	if runtime.GOOS != "darwin" {
		http.Error(w, "open-url is macOS only", http.StatusNotImplemented)
		return
	}
	if err := exec.Command("open", body.URL).Run(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAgentsSummary returns a small JSON payload with at-a-glance
// counts (active / idle / awaiting / total). Used by the macOS
// menu-bar status item in app/main.swift to drive the icon's title
// and submenu without having to maintain a websocket from Swift.
// Cheap, polled every few seconds.
func (s *Server) handleAgentsSummary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	active, idle, awaiting := 0, 0, 0
	for _, a := range s.reg.All() {
		switch a.Status {
		case "active":
			active++
		case "idle":
			idle++
		}
		if a.AwaitingChoice {
			awaiting++
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]int{
		"active":   active,
		"idle":     idle,
		"awaiting": awaiting,
		"total":    active + idle,
	})
}

// handleDebugPicker exposes the terminal-picker scanner for live
// inspection and manual testing.
//
// GET  /api/debug/picker?session=<id>          → returns the raw
//
//	tmux capture for that agent + whether the picker regex
//	matched. Use this to diagnose "I had a picker open and the
//	badge didn't appear" — it shows exactly what we read from
//	the pane and what pattern we tested it against.
//
// POST /api/debug/picker?session=<id>&seconds=N → forces the
//
//	awaiting-choice flag on for N seconds (default 30) so you
//	can preview the indicator without triggering a real picker.
//	The next scan tick can't clear it; expires automatically.
//
// Either form accepts `cwd=<path>` instead of `session=<id>` so you
// can target an agent by working directory if you don't know the
// session id offhand.
func (s *Server) handleDebugPicker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	target := s.resolveAgentForDebug(r.URL.Query().Get("session"), r.URL.Query().Get("cwd"))
	if target == nil {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": "agent not found — pass ?session=<id> or ?cwd=<path>",
			"hint":  "all running agents are in the websocket state payload",
		})
		return
	}

	switch r.Method {
	case http.MethodGet:
		text, matched, err := terminal.CapturePane(target.PID)
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sessionId":      target.SessionID,
			"cwd":            target.Cwd,
			"pid":            target.PID,
			"awaitingChoice": target.AwaitingChoice,
			"capture":        text,
			"matched":        matched,
			"regex":          terminal.PickerRegex(),
			"error":          errStr,
		})
	case http.MethodPost:
		seconds := 30
		if v := r.URL.Query().Get("seconds"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				seconds = n
			}
		}
		ok := s.reg.ForceAwaitingChoice(target.SessionID, time.Duration(seconds)*time.Second)
		// Push the flip immediately so the user doesn't have to
		// wait for the next 3-second scan tick to see the badge.
		s.Broadcast()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"forced":     ok,
			"sessionId":  target.SessionID,
			"cwd":        target.Cwd,
			"durationMs": seconds * 1000,
		})
	default:
		http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
	}
}

// resolveAgentForDebug looks up an agent by session id (preferred)
// or cwd (fallback). Returns nil when neither matches.
func (s *Server) resolveAgentForDebug(sessionID, cwd string) *registry.Agent {
	for _, a := range s.reg.All() {
		if sessionID != "" && a.SessionID == sessionID {
			return &a
		}
		if cwd != "" && a.Cwd == cwd {
			return &a
		}
	}
	return nil
}

// handleLinearIssues fetches the current user's assigned Linear issues so the
// web panel can render them. Returns 409 with a "needsKey" marker when no API
// key is configured so the frontend can prompt the user without a noisy error.
func (s *Server) handleLinearIssues(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	key := s.cfg.Get().LinearAPIKey
	if key == "" {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"needsKey": true, "issues": []any{}, "teamStates": map[string]any{}})
		return
	}
	result, err := linear.FetchAssigned(key)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}

// handleLinearPriority updates an issue's priority. Body: { id, priority }.
// Priority values: 0 none · 1 urgent · 2 high · 3 medium · 4 low.
func (s *Server) handleLinearPriority(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	key := s.cfg.Get().LinearAPIKey
	if key == "" {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]bool{"needsKey": true})
		return
	}
	var body struct {
		ID       string `json:"id"`
		Priority int    `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if err := linear.SetIssuePriority(key, body.ID, body.Priority); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleLinearMove updates an issue's workflow state. Body: { id, stateId }.
// The frontend resolves stateId from the team-states map it received with
// the issues list.
func (s *Server) handleLinearMove(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	key := s.cfg.Get().LinearAPIKey
	if key == "" {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"needsKey": true})
		return
	}
	var body struct {
		ID      string `json:"id"`
		StateID string `json:"stateId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if err := linear.MoveIssue(key, body.ID, body.StateID); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleLinearTest validates a Linear API key by hitting the `viewer`
// query and returning the authenticated account info. The body may
// supply a key to test (so the user can verify a freshly-typed key
// before saving it); when omitted, the saved key is used.
func (s *Server) handleLinearTest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		APIKey string `json:"apiKey"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	key := body.APIKey
	if key == "" {
		key = s.cfg.Get().LinearAPIKey
	}
	if key == "" {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "no api key set"})
		return
	}
	info, err := linear.TestKey(key)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":    true,
		"id":    info.ID,
		"name":  info.Name,
		"email": info.Email,
	})
}

// handleRebuild kicks off `make rebuild` in a detached process group so it
// outlives this daemon. `make rebuild` quits bitwise.app (and therefore us),
// does `make build-app`, then relaunches the fresh bundle. Dev-only.
func (s *Server) handleRebuild(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")

	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}

	// Resolution shared with the preflight check so the diagnostics
	// panel reflects exactly what this handler would do.
	repoPath, _ := resolveRebuildRepo()
	if repoPath == "" {
		http.Error(w, "rebuild unavailable: this binary was not built from source — set BITWISE_REPO_PATH to the repo root", 404)
		return
	}
	if _, err := os.Stat(filepath.Join(repoPath, "Makefile")); err != nil {
		http.Error(w, "no Makefile at "+repoPath+" — set BITWISE_REPO_PATH to the repo root", 404)
		return
	}

	// Log output to ~/Library/Logs/bitwise/rebuild.log so failures are
	// inspectable even after the window dies mid-build.
	home, _ := os.UserHomeDir()
	logDir := filepath.Join(home, "Library", "Logs", "bitwise")
	_ = os.MkdirAll(logDir, 0o755)
	logPath := filepath.Join(logDir, "rebuild.log")
	logFile, _ := os.Create(logPath)

	// Spawn make through the user's interactive+login shell so it inherits
	// nvm/asdf/fnm activations and Homebrew's PATH. GUI-launched .app bundles
	// inherit the minimal launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin), so
	// `make build-web` (which calls npm) fails with `npm: command not found`
	// before reaching the relaunch step — leaving the user with a quit app.
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	inner := fmt.Sprintf("exec /usr/bin/make -C %s rebuild", shellQuote(repoPath))
	cmd := exec.Command(shell, "-ilc", inner)
	// Setpgid=true puts the child in its own process group so SIGHUP from the
	// daemon's death (when `make rebuild` quits bitwise.app) doesn't cascade.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}

	if err := cmd.Start(); err != nil {
		http.Error(w, "failed to start make: "+err.Error(), 500)
		return
	}
	// Release the child; we'd otherwise leak a zombie after exit.
	go func() { _ = cmd.Wait() }()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	fmt.Fprintf(w, `{"ok":true,"pid":%d,"log":%q,"repo":%q}`, cmd.Process.Pid, logPath, repoPath)
}

// shellQuote wraps s in single quotes for safe interpolation into a sh -c
// string. Any embedded single quotes are escaped by closing the quoted
// section, emitting a literal `\'`, and reopening — the standard POSIX
// idiom that works in every shell we'd dispatch through.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
