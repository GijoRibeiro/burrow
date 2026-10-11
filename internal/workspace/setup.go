package workspace

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// toolStatus describes one external dependency as the user sees it on first
// run: whether it was found, where, and which version answered.
type toolStatus struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Required  bool   `json:"required"`
	Label     string `json:"label"`
	Purpose   string `json:"purpose"`
}

var setupTools = []struct {
	name, label, purpose string
	required             bool
	versionArgs          []string
}{
	{"git", "Git", "Projects, branches and worktrees", true, []string{"--version"}},
	{"tmux", "tmux", "Keeps terminals running when the app is closed", true, []string{"-V"}},
	{"claude", "Claude Code", "Optional agent · sign in on first launch", false, []string{"--version"}},
	{"codex", "Codex", "Optional agent · sign in on first launch", false, []string{"--version"}},
	{"gh", "GitHub CLI", "Optional · clone repositories and show PR links", false, []string{"--version"}},
}

var versionNumber = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?`)

// Setup polls every few seconds. Looking a tool up on PATH is cheap, but
// asking it for its version spawns a process, so versions are remembered per
// binary until that file changes.
var versionCache struct {
	mu      sync.Mutex
	entries map[string]versionEntry
}
type versionEntry struct {
	modified time.Time
	version  string
}

func setupStatus() map[string]any {
	tools := map[string]toolStatus{}
	for _, tool := range setupTools {
		status := toolStatus{Required: tool.required, Label: tool.label, Purpose: tool.purpose}
		if path, err := exec.LookPath(tool.name); err == nil {
			status.Installed, status.Path = true, path
			status.Version = cachedVersion(path, tool.versionArgs)
		}
		tools[tool.name] = status
	}
	gitOK := tools["git"].Installed
	if runtime.GOOS == "darwin" && tools["git"].Path == "/usr/bin/git" {
		// Apple's shim only works once the Command Line Tools exist; otherwise
		// running it opens a system dialog instead of Git.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		gitOK = exec.CommandContext(ctx, "/usr/libexec/xcode-select", "-p").Run() == nil || exec.CommandContext(ctx, "/usr/bin/xcode-select", "-p").Run() == nil
		if !gitOK {
			tool := tools["git"]
			tool.Installed, tool.Version = false, ""
			tools["git"] = tool
		}
	}
	_, brewErr := exec.LookPath("brew")
	data := map[string]any{
		"platform":  runtime.GOOS,
		"git":       gitOK,
		"tmux":      tools["tmux"].Installed,
		"claude":    tools["claude"].Installed,
		"codex":     tools["codex"].Installed,
		"gh":        tools["gh"].Installed,
		"homebrew":  brewErr == nil,
		"installer": runtime.GOOS == "darwin",
		"tools":     tools,
		"ready":     gitOK && tools["tmux"].Installed,
	}
	return data
}
func cachedVersion(path string, args []string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	versionCache.mu.Lock()
	defer versionCache.mu.Unlock()
	if entry, ok := versionCache.entries[path]; ok && entry.modified.Equal(info.ModTime()) {
		return entry.version
	}
	version := probeVersion(path, args)
	if versionCache.entries == nil {
		versionCache.entries = map[string]versionEntry{}
	}
	versionCache.entries[path] = versionEntry{modified: info.ModTime(), version: version}
	return version
}
func probeVersion(path string, args []string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).Output()
	if err != nil {
		return ""
	}
	first := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	if match := versionNumber.FindString(first); match != "" {
		return match
	}
	return first
}

// SetInstaller provides the setup script that the in-app installer runs. The
// daemon embeds it so the browser build can install tools too.
func (m *Manager) SetInstaller(script []byte) { m.installer = script }

var installerMu sync.Mutex

func (m *Manager) setupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/setup", func(w http.ResponseWriter, r *http.Request) { respond(w, setupStatus(), nil) })
	// The installer runs inside the app on a real PTY, so Homebrew's password
	// prompt and progress output work exactly as they would in Terminal.
	mux.HandleFunc("GET /api/workspace/setup/install", func(w http.ResponseWriter, r *http.Request) {
		tool := r.URL.Query().Get("tool")
		var cmd *exec.Cmd
		switch tool {
		case "required", "claude", "codex", "github":
		case "assist":
			// When the scripted path fails, an agent can read the error and fix it
			// interactively. Claude must already be installed for this.
			claude, err := exec.LookPath("claude")
			if err != nil {
				http.Error(w, "Claude Code is not installed", http.StatusBadRequest)
				return
			}
			cmd = exec.Command(claude, "--dangerously-skip-permissions", "--name", "Setup assistant", "--", setupAssistPrompt())
		default:
			http.Error(w, "unknown setup option", http.StatusBadRequest)
			return
		}
		if len(m.installer) == 0 {
			http.Error(w, "this server has no bundled installer", http.StatusNotImplemented)
			return
		}
		if !installerMu.TryLock() {
			http.Error(w, "another installation is already running", http.StatusConflict)
			return
		}
		defer installerMu.Unlock()
		dir, err := os.MkdirTemp("", "cloovies-setup-")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer os.RemoveAll(dir)
		script := filepath.Join(dir, "install.command")
		if err := os.WriteFile(script, m.installer, 0700); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		up := websocket.Upgrader{CheckOrigin: localRequest}
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if cmd == nil {
			cmd = exec.Command("/bin/bash", script, tool)
		}
		home, _ := os.UserHomeDir()
		cmd.Dir = home
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "CLOOVIES_IN_APP_SETUP=1", "CLOOVIES_SETUP_SCRIPT="+script)
		streamPTY(conn, cmd, dimension(r.URL.Query().Get("cols"), 100), dimension(r.URL.Query().Get("rows"), 30), true)
	})
}

func setupAssistPrompt() string {
	return strings.Join([]string{
		"You are helping set up Burrow, a local terminal workspace on this Mac. It needs Git and tmux on PATH;",
		"Claude Code, Codex and the GitHub CLI (gh) are optional. Check which are missing with `command -v` and `xcode-select -p`.",
		"Install what is missing using Homebrew (install Homebrew first if it is absent; Apple Silicon uses /opt/homebrew, Intel /usr/local).",
		"The bundled installer script is at $CLOOVIES_SETUP_SCRIPT; run it with `required`, `claude`, `codex` or `github` as its argument, read any error it prints and fix the cause.",
		"Do not change shell startup files beyond what Homebrew itself requires. When done, print a short summary of each tool with its version and tell the user to return to Burrow, which detects tools automatically.",
	}, " ")
}
