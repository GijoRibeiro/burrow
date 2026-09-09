package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"time"

	cloovies "github.com/gijo/cloovies"
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
	dev := flag.Bool("dev", false, "Dev mode: skip embedded assets, expect Vite dev server")
	app := flag.Bool("app", false, "Launch native macOS window instead of browser")
	noOpen := flag.Bool("no-open", false, "Serve only; do not open a browser or native window")
	spritesDir := flag.String("sprites", "", "Path to sprites directory")
	interval := flag.Duration("interval", 3*time.Second, "Scan interval")
	flag.Parse()

	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("cannot find home dir: %v", err)
	}

	// Augment PATH with common tool locations BEFORE the dependency check.
	// Required for GUI launches (Finder/.app) where the inherited PATH
	// omits ~/.local/bin, /opt/homebrew/bin, and nvm's per-version dirs.
	env.AugmentPATH(home)

	// Workspace shells need Git and tmux; agent CLIs are optional.
	for _, bin := range []string{"git", "tmux"} {
		if _, err := exec.LookPath(bin); err != nil {
			log.Fatalf("required dependency %q not found in PATH — install it and try again", bin)
		}
	}

	sessionsDir := filepath.Join(home, ".claude", "sessions")
	tasksDir := filepath.Join(home, ".claude", "tasks")

	sc := scanner.New(sessionsDir, tasksDir)
	reg := registry.New()
	ex := orchestrator.NewExecutor(reg)

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

	// Resolve sprites directory.
	if *spritesDir == "" && !*dev {
		*spritesDir = filepath.Join(home, ".cloovies", "sprites")
		if err := extractSprites(*spritesDir); err != nil {
			log.Printf("sprite extraction warning: %v", err)
		}
	}

	// Build the embedded web FS (unless dev mode).
	var webFS fs.FS
	var webDir string
	if !*dev {
		sub, err := fs.Sub(cloovies.EmbeddedWeb, "web/dist")
		if err != nil {
			log.Fatalf("failed to open embedded web assets: %v", err)
		}
		webFS = sub
	}

	srv := server.New(reg, ex, st, cfg, b, wm, webDir, *spritesDir, webFS)

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
			if st != nil {
				for _, a := range agents {
					if a.Alive && a.TaskStatus == "in_progress" {
						st.TickWork(a.Cwd)
					}
				}
			}
			// Detect terminal-only state that doesn't surface in JSONL
			// — Claude Code permission/choice pickers. Capture the
			// pane, parse the question + options, and stash on the
			// agent so the frontend can render the picker inline in
			// its lane. Best-effort: a missing tmux pane (CapturePane
			// errors out) or no picker on screen (ParsePicker → nil)
			// just clears the field.
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
			for _, f := range finished {
				srv.BroadcastAgentFinished(f.SessionID, f.Cwd, f.Name)
			}
			srv.SyncTails()
			srv.Broadcast()
		}
	}()

	addr := fmt.Sprintf("localhost:%d", *port)
	url := fmt.Sprintf("http://%s", addr)
	log.Printf("bitwise running at %s", url)

	// Open UI after server starts (unless running as a headless backend).
	if !*dev && !*noOpen {
		go func() {
			// Small delay to let the HTTP listener bind.
			time.Sleep(300 * time.Millisecond)
			if *app {
				openApp(url)
			} else {
				openBrowser(url)
			}
		}()
	}

	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// extractSprites copies the bundled sprites to ~/.cloovies/sprites, delivering
// any avatars that are new in this build without re-adding ones the user has
// deleted (the user manages add/delete in that folder). See extractSpritesFrom.
func extractSprites(dir string) error {
	spritesFS, err := fs.Sub(cloovies.EmbeddedSprites, "web/assets/sprites")
	if err != nil {
		return fmt.Errorf("no sprites in embedded FS: %w", err)
	}
	return extractSpritesFrom(spritesFS, dir)
}

// spritesManifest lives next to the sprites dir (not inside it, so it isn't
// served or enumerated as a creature). It records every embedded sprite path
// we've ever shipped, so we only ever copy genuinely-new avatars and respect
// the user's deletions.
func spritesManifestPath(dir string) string {
	return filepath.Join(filepath.Dir(dir), ".sprites-manifest.json")
}

func loadShipped(path string) (shipped map[string]bool, existed bool) {
	shipped = map[string]bool{}
	data, err := os.ReadFile(path)
	if err != nil {
		return shipped, false
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return shipped, true // corrupt manifest: treat as existing, adopt baseline
	}
	for _, p := range list {
		shipped[p] = true
	}
	return shipped, true
}

func saveShipped(path string, shipped map[string]bool) error {
	list := make([]string, 0, len(shipped))
	for p := range shipped {
		list = append(list, p)
	}
	sort.Strings(list)
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func dirHasFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

// extractSpritesFrom merges spritesFS into dir using a shipped-paths manifest:
//   - First-ever install (empty dir, no manifest): copy every bundled sprite.
//   - Existing install with no manifest yet: adopt the current dir as the
//     baseline (record all bundled paths as shipped, copy nothing) so we never
//     re-add a sprite the user deleted before manifests existed.
//   - Thereafter: copy only paths not yet in the manifest (new in this build),
//     never clobbering files already on disk, and never re-adding deletions.
func extractSpritesFrom(spritesFS fs.FS, dir string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("mkdir sprites: %w", err)
	}
	manifestPath := spritesManifestPath(dir)
	shipped, manifestExisted := loadShipped(manifestPath)

	// Existing install upgrading to manifest-based merge: adopt current state.
	if !manifestExisted && dirHasFiles(dir) {
		all := map[string]bool{}
		err := fs.WalkDir(spritesFS, ".", func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || path == "." {
				return err
			}
			all[path] = true
			return nil
		})
		if err != nil {
			return err
		}
		return saveShipped(manifestPath, all)
	}

	changed := false
	err := fs.WalkDir(spritesFS, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path == "." {
			return err
		}
		if shipped[path] {
			return nil // shipped in a prior build — respect user deletions
		}
		shipped[path] = true
		changed = true
		dst := filepath.Join(dir, path)
		if _, statErr := os.Stat(dst); statErr == nil {
			return nil // already on disk — don't clobber the user's file
		}
		data, err := fs.ReadFile(spritesFS, path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0644)
	})
	if err != nil {
		return err
	}
	if changed || !manifestExisted {
		return saveShipped(manifestPath, shipped)
	}
	return nil
}

// openBrowser opens the default browser to the given URL.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		log.Printf("open %s in your browser", url)
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("failed to open browser: %v", err)
	}
}

// openApp tries to launch the native macOS wrapper; falls back to browser.
func openApp(url string) {
	if runtime.GOOS != "darwin" {
		log.Printf("--app is only supported on macOS, falling back to browser")
		openBrowser(url)
		return
	}

	// Try to find the .app bundle relative to the binary.
	//   Dev:       bin/bitwise + build/macos/bitwise.app (siblings under repo root).
	//   Installed: the bundle is expected to be staged under ~/.local/share/bitwise/.
	exe, err := os.Executable()
	if err == nil {
		devBundle := filepath.Join(filepath.Dir(exe), "..", "build", "macos", "bitwise.app")
		if _, err := os.Stat(devBundle); err == nil {
			cmd := exec.Command("open", devBundle)
			if err := cmd.Start(); err == nil {
				return
			}
		}
	}

	// Fallback: try common location.
	if home, err := os.UserHomeDir(); err == nil {
		bundlePath := filepath.Join(home, ".local", "share", "bitwise", "bitwise.app")
		if _, err := os.Stat(bundlePath); err == nil {
			cmd := exec.Command("open", bundlePath)
			if err := cmd.Start(); err == nil {
				return
			}
		}
	}

	log.Printf("bitwise.app bundle not found, opening browser instead")
	openBrowser(url)
}
