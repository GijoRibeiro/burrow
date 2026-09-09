package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gijo/cloovies/internal/boss"
	"github.com/gijo/cloovies/internal/config"
	"github.com/gijo/cloovies/internal/env"
	"github.com/gijo/cloovies/internal/orchestrator"
	"github.com/gijo/cloovies/internal/registry"
	"github.com/gijo/cloovies/internal/scanner"
	"github.com/gijo/cloovies/internal/server"
	"github.com/gijo/cloovies/internal/store"
	"github.com/gijo/cloovies/internal/terminal"
	"github.com/gijo/cloovies/internal/workers"
)

func main() {
	port := flag.Int("port", 3333, "HTTP/WebSocket port")
	webDir := flag.String("web", "", "Path to built web client directory")
	spritesDir := flag.String("sprites", "", "Path to sprites directory for editor saves")
	interval := flag.Duration("interval", 3*time.Second, "Scan interval")
	flag.Parse()

	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("cannot find home dir: %v", err)
	}

	// Ensure common tool paths are in PATH (needed when launched from Finder/app bundle).
	env.AugmentPATH(home)

	sessionsDir := filepath.Join(home, ".claude", "sessions")
	tasksDir := filepath.Join(home, ".claude", "tasks")

	sc := scanner.New(sessionsDir, tasksDir)
	reg := registry.New()
	exec := orchestrator.NewExecutor(reg)

	st, err := store.New()
	if err != nil {
		log.Printf("store warning: %v", err)
	}

	cfgPath := filepath.Join(home, ".cloovies", "settings.json")
	cfg, cfgErr := config.Load(cfgPath)
	if cfgErr != nil {
		log.Printf("config warning: %v", cfgErr)
	}

	// Boss agent
	b, err := boss.New()
	if err != nil {
		log.Printf("boss warning: %v", err)
	} else {
		log.Printf("Boss agent ready")
	}

	// Worker manager
	wm := workers.NewManager()

	srv := server.New(reg, exec, st, cfg, b, wm, *webDir, *spritesDir, nil)

	// Initial scan
	agents, err := sc.Scan()
	if err != nil {
		log.Printf("initial scan warning: %v", err)
	} else {
		_ = reg.UpdateFromScan(agents)
		log.Printf("Initial scan: found %d agents", len(agents))
	}

	// Background scan loop
	go func() {
		ticker := time.NewTicker(*interval)
		defer ticker.Stop()
		for range ticker.C {
			agents, err := sc.Scan()
			if err != nil {
				log.Printf("scan error: %v", err)
				continue
			}
			finished := reg.UpdateFromScan(agents)
			// Tick work time for active agents
			if st != nil {
				for _, a := range agents {
					if a.Alive && a.TaskStatus == "in_progress" {
						st.TickWork(a.Cwd)
					}
				}
			}
			// Detect + parse Claude Code pickers from each agent's tmux
			// pane. The parsed payload (question + options) goes onto
			// the agent state so the frontend can render the picker
			// inline in the agent's lane. Best-effort: a missing
			// tmux pane just clears the picker field.
			for _, a := range reg.All() {
				if a.Status == "done" {
					continue
				}
				text, matched, err := terminal.CapturePane(a.PID)
				if err != nil {
					reg.SetPicker(a.SessionID, nil, false)
					continue
				}
				// `matched` (the loose chevron / "Enter to select" signal)
				// drives the awaiting indicator; ParsePicker fills the inline
				// panel. Decoupled so a picker we can't fully parse still
				// lights up as needing the user — see Registry.SetPicker.
				reg.SetPicker(a.SessionID, terminal.ParsePicker(text), matched)
			}
			// Notify clients about agents that just finished
			for _, f := range finished {
				srv.BroadcastAgentFinished(f.SessionID, f.Cwd, f.Name)
			}
			srv.SyncTails()
			srv.Broadcast()
		}
	}()

	addr := fmt.Sprintf("localhost:%d", *port)
	log.Printf("clooviesd running at http://%s", addr)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
