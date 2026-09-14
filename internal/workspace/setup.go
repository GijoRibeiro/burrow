package workspace

import (
	"context"
	"net/http"
	"os/exec"
	"runtime"
	"time"
)

func setupStatus() map[string]any {
	available := func(name string) bool { _, err := exec.LookPath(name); return err == nil }
	gitOK := available("git")
	if runtime.GOOS == "darwin" {
		path, _ := exec.LookPath("git")
		if path == "/usr/bin/git" {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			gitOK = exec.CommandContext(ctx, "/usr/bin/xcode-select", "-p").Run() == nil
		}
	}
	tmuxOK := available("tmux")
	return map[string]any{"platform": runtime.GOOS, "git": gitOK, "tmux": tmuxOK, "claude": available("claude"), "codex": available("codex"), "ready": gitOK && tmuxOK}
}
func (m *Manager) setupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/setup", func(w http.ResponseWriter, r *http.Request) { respond(w, setupStatus(), nil) })
}
