// Package server: preflight inspects the host environment and returns a
// structured report of dependencies, paths, and binary versions. The
// frontend renders this as a status pill + diagnostics panel so the user
// can see (and fix) anything broken without having to grep the codebase.
//
// Design notes:
//   - Checks are categorised: "required" (blocks core function), "dev"
//     (only the in-app rebuild flow), "optional" (Homebrew, etc.).
//   - Severity drives the pill colour; warn-only by default, so a missing
//     tool doesn't disable the related UI button — the user still gets to
//     click it and see the dedicated error if they ignore the warning.
//   - Fixes embed remediation: a copyable shell command, a URL to open,
//     or plain text for cases we can't automate.
package server

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"time"
)

type checkSeverity string

const (
	sevOK    checkSeverity = "ok"
	sevWarn  checkSeverity = "warn"
	sevError checkSeverity = "error"
)

type fixKind string

const (
	fixShell  fixKind = "shell"
	fixLink   fixKind = "link"
	fixManual fixKind = "manual"
)

type preflightFix struct {
	Kind    fixKind `json:"kind"`
	Command string  `json:"command,omitempty"`
	URL     string  `json:"url,omitempty"`
	Text    string  `json:"text"`
}

type preflightCheck struct {
	ID       string        `json:"id"`
	Label    string        `json:"label"`
	Category string        `json:"category"`
	Status   checkSeverity `json:"status"`
	Detail   string        `json:"detail,omitempty"`
	Fix      *preflightFix `json:"fix,omitempty"`
}

type preflightDiagnostics struct {
	DaemonPID      int               `json:"daemonPid"`
	DaemonUptime   string            `json:"daemonUptime"`
	BuildRepoPath  string            `json:"buildRepoPath"`
	BitwiseVersion string            `json:"bitwiseVersion"`
	GoVersion      string            `json:"goVersion"`
	OS             string            `json:"os"`
	Arch           string            `json:"arch"`
	SpritesDir     string            `json:"spritesDir"`
	HomeDir        string            `json:"homeDir"`
	Versions       map[string]string `json:"versions"`
	VCSRevision    string            `json:"vcsRevision,omitempty"`
	VCSModified    bool              `json:"vcsModified,omitempty"`
}

type preflightResponse struct {
	Status      checkSeverity        `json:"status"`
	OKCount     int                  `json:"okCount"`
	WarnCount   int                  `json:"warnCount"`
	ErrorCount  int                  `json:"errorCount"`
	Checks      []preflightCheck     `json:"checks"`
	Diagnostics preflightDiagnostics `json:"diagnostics"`
	GeneratedAt time.Time            `json:"generatedAt"`
}

// serverStartedAt is captured at handler-registration time so the
// diagnostics panel can show daemon uptime without threading another
// field through every constructor.
var serverStartedAt = time.Now()

func (s *Server) handlePreflight(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}

	resp := runPreflight(s.spritesDir)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func runPreflight(spritesDir string) preflightResponse {
	home, _ := os.UserHomeDir()
	versions := map[string]string{}
	checks := []preflightCheck{}

	// --- Required ---

	tmuxPath, tmuxVer := lookupAndVersion("tmux", []string{"-V"}, `tmux\s+(\S+)`)
	if tmuxPath == "" {
		checks = append(checks, preflightCheck{
			ID: "tmux", Label: "tmux", Category: "required", Status: sevError,
			Detail: "not found on PATH — spawning new agents will fail",
			Fix: &preflightFix{
				Kind: fixShell, Command: "brew install tmux",
				Text: "Install tmux via Homebrew (or your package manager).",
			},
		})
	} else {
		versions["tmux"] = tmuxVer
		checks = append(checks, preflightCheck{
			ID: "tmux", Label: "tmux", Category: "required", Status: sevOK,
			Detail: tmuxVer + " — " + tmuxPath,
		})
	}

	gitPath, gitVer := lookupAndVersion("git", []string{"--version"}, `git\s+version\s+(\S+)`)
	if gitPath == "" {
		checks = append(checks, preflightCheck{
			ID: "git", Label: "git", Category: "required", Status: sevError,
			Detail: "not found on PATH — worktrees and repo stats will fail",
			Fix: &preflightFix{
				Kind: fixShell, Command: "xcode-select --install",
				Text: "Install Xcode Command Line Tools (provides git).",
			},
		})
	} else {
		versions["git"] = gitVer
		checks = append(checks, preflightCheck{
			ID: "git", Label: "git", Category: "required", Status: sevOK,
			Detail: gitVer + " — " + gitPath,
		})
	}

	claudePath, claudeVer := lookupAndVersion("claude", []string{"--version"}, `(\S+)`)
	if claudePath == "" {
		checks = append(checks, preflightCheck{
			ID: "claude", Label: "claude CLI", Category: "required", Status: sevError,
			Detail: "not found on PATH — spawned agents won't be able to run",
			Fix: &preflightFix{
				Kind: fixLink, URL: "https://docs.claude.com/en/docs/claude-code/quickstart",
				Text: "Install Claude Code (the `claude` CLI). See the Claude Code quickstart.",
			},
		})
	} else {
		versions["claude"] = claudeVer
		checks = append(checks, preflightCheck{
			ID: "claude", Label: "claude CLI", Category: "required", Status: sevOK,
			Detail: claudeVer + " — " + claudePath,
		})
	}

	// The scanner reads from both ~/.claude/sessions/ (legacy) and
	// ~/.claude/projects/<slugged-cwd>/ (current). Either being missing
	// makes one of the two code paths return zero agents — collapse them
	// into a single check that's OK if at least one is populated.
	sessionsDir := filepath.Join(home, ".claude", "sessions")
	projectsDir := filepath.Join(home, ".claude", "projects")
	sessOK := dirExists(sessionsDir)
	projOK := dirExists(projectsDir)
	if !sessOK && !projOK {
		checks = append(checks, preflightCheck{
			ID: "claude-state", Label: "~/.claude/ (Claude Code data)", Category: "required", Status: sevError,
			Detail: "neither sessions/ nor projects/ exists — the scanner has no input",
			Fix: &preflightFix{
				Kind: fixManual,
				Text: "Run `claude` at least once in any project to populate ~/.claude/projects/.",
			},
		})
	} else {
		sessN := countFiles(sessionsDir)
		projN := countDirs(projectsDir)
		checks = append(checks, preflightCheck{
			ID: "claude-state", Label: "~/.claude/ (Claude Code data)", Category: "required", Status: sevOK,
			Detail: plural(projN, "project") + ", " + plural(sessN, "session file"),
		})
	}

	// --- Persistence ---

	cloovDir := filepath.Join(home, ".cloovies")
	if err := ensureWritable(cloovDir); err != nil {
		checks = append(checks, preflightCheck{
			ID: "state-dir", Label: "~/.cloovies/ (state)", Category: "required", Status: sevWarn,
			Detail: "not writable: " + err.Error(),
			Fix: &preflightFix{
				Kind: fixShell, Command: "mkdir -p ~/.cloovies && chmod 755 ~/.cloovies",
				Text: "Create the state directory and ensure it's writable.",
			},
		})
	} else {
		checks = append(checks, preflightCheck{
			ID: "state-dir", Label: "~/.cloovies/ (state)", Category: "required", Status: sevOK,
			Detail: cloovDir,
		})
	}

	// --- Dev (only blocks the in-app rebuild flow) ---

	makePath, makeVer := lookupAndVersion("make", []string{"--version"}, `Make\s+(\S+)`)
	if makePath == "" {
		checks = append(checks, preflightCheck{
			ID: "make", Label: "make", Category: "dev", Status: sevWarn,
			Detail: "not found on PATH — in-app rebuild won't work",
			Fix: &preflightFix{
				Kind: fixShell, Command: "xcode-select --install",
				Text: "Install Xcode Command Line Tools (provides make).",
			},
		})
	} else {
		versions["make"] = makeVer
		checks = append(checks, preflightCheck{
			ID: "make", Label: "make", Category: "dev", Status: sevOK,
			Detail: makeVer + " — " + makePath,
		})
	}

	// npm + node are what `make build-web` actually shells out to. PATH is
	// augmented at daemon startup (internal/env.AugmentPATH) so nvm-installed
	// versions are reachable here without a shell-out. If still missing
	// after that, the user genuinely doesn't have Node installed.
	nodePath, nodeVer := lookupAndVersion("node", []string{"--version"}, `v?(\S+)`)
	if nodePath == "" {
		checks = append(checks, preflightCheck{
			ID: "node", Label: "node", Category: "dev", Status: sevWarn,
			Detail: "not found on PATH — in-app rebuild will fail at build-web",
			Fix: &preflightFix{
				Kind: fixShell, Command: "brew install node",
				Text: "Install Node (Homebrew, nvm, or fnm all work).",
			},
		})
	} else {
		versions["node"] = nodeVer
		checks = append(checks, preflightCheck{
			ID: "node", Label: "node", Category: "dev", Status: sevOK,
			Detail: nodeVer + " — " + nodePath,
		})
	}

	npmPath, npmVer := lookupAndVersion("npm", []string{"--version"}, `(\S+)`)
	if npmPath == "" {
		checks = append(checks, preflightCheck{
			ID: "npm", Label: "npm", Category: "dev", Status: sevWarn,
			Detail: "not found on PATH — in-app rebuild will fail at build-web",
			Fix: &preflightFix{
				Kind: fixShell, Command: "brew install node",
				Text: "Install Node (which ships npm). Or `nvm install --lts` if you use nvm.",
			},
		})
	} else {
		versions["npm"] = npmVer
		checks = append(checks, preflightCheck{
			ID: "npm", Label: "npm", Category: "dev", Status: sevOK,
			Detail: npmVer + " — " + npmPath,
		})
	}

	repoPath, repoSource := resolveRebuildRepo()
	switch {
	case repoPath == "":
		checks = append(checks, preflightCheck{
			ID: "rebuild-repo", Label: "in-app rebuild source", Category: "dev", Status: sevWarn,
			Detail: "no repo path resolvable — this binary wasn't built from source and no BITWISE_REPO_PATH override is set",
			Fix: &preflightFix{
				Kind: fixManual,
				Text: "Build from source (`make build-app` inside the repo) to embed the path, or `export BITWISE_REPO_PATH=/path/to/bitwise`.",
			},
		})
	default:
		if _, err := os.Stat(filepath.Join(repoPath, "Makefile")); err != nil {
			checks = append(checks, preflightCheck{
				ID: "rebuild-repo", Label: "in-app rebuild source", Category: "dev", Status: sevWarn,
				Detail: "resolved to " + repoPath + " (" + repoSource + ") but no Makefile is there",
				Fix: &preflightFix{
					Kind: fixManual,
					Text: "Set BITWISE_REPO_PATH to your bitwise clone, or rebuild from the correct directory.",
				},
			})
		} else {
			checks = append(checks, preflightCheck{
				ID: "rebuild-repo", Label: "in-app rebuild source", Category: "dev", Status: sevOK,
				Detail: repoPath + " (" + repoSource + ")",
			})
		}
	}

	// --- Optional ---

	brewPath, brewVer := lookupAndVersion("brew", []string{"--version"}, `Homebrew\s+(\S+)`)
	if brewPath == "" {
		// Also probe the canonical locations — brew may be installed but
		// not yet on PATH (common right after a fresh install).
		for _, p := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
			if _, err := os.Stat(p); err == nil {
				brewPath = p
				if ver := captureVersion(p, []string{"--version"}, `Homebrew\s+(\S+)`); ver != "" {
					brewVer = ver
				}
				break
			}
		}
	}
	if brewPath == "" {
		checks = append(checks, preflightCheck{
			ID: "brew", Label: "Homebrew", Category: "optional", Status: sevWarn,
			Detail: "not installed — recommended on macOS for installing missing dependencies",
			Fix: &preflightFix{
				Kind: fixLink, URL: "https://brew.sh",
				Text: "Install Homebrew. The one-liner is on brew.sh.",
			},
		})
	} else {
		versions["brew"] = brewVer
		checks = append(checks, preflightCheck{
			ID: "brew", Label: "Homebrew", Category: "optional", Status: sevOK,
			Detail: brewVer + " — " + brewPath,
		})
	}

	// --- Tally + diagnostics ---

	okN, warnN, errN := 0, 0, 0
	for _, c := range checks {
		switch c.Status {
		case sevOK:
			okN++
		case sevWarn:
			warnN++
		case sevError:
			errN++
		}
	}
	overall := sevOK
	if warnN > 0 {
		overall = sevWarn
	}
	if errN > 0 {
		overall = sevError
	}

	vcsRev, vcsMod := buildVCSInfo()

	return preflightResponse{
		Status:     overall,
		OKCount:    okN,
		WarnCount:  warnN,
		ErrorCount: errN,
		Checks:     checks,
		Diagnostics: preflightDiagnostics{
			DaemonPID:      os.Getpid(),
			DaemonUptime:   time.Since(serverStartedAt).Round(time.Second).String(),
			BuildRepoPath:  buildRepoPath,
			BitwiseVersion: displayVersion(),
			GoVersion:      runtime.Version(),
			OS:             runtime.GOOS,
			Arch:           runtime.GOARCH,
			SpritesDir:     spritesDir,
			HomeDir:        home,
			Versions:       versions,
			VCSRevision:    vcsRev,
			VCSModified:    vcsMod,
		},
		GeneratedAt: time.Now(),
	}
}

// resolveRebuildRepo mirrors handleRebuild's resolution order so the
// preflight check reflects what would actually happen if the user
// clicked "rebuild" right now.
func resolveRebuildRepo() (path, source string) {
	if v := os.Getenv("BITWISE_REPO_PATH"); v != "" {
		return v, "BITWISE_REPO_PATH"
	}
	if v := os.Getenv("CLOOVIES_REPO_PATH"); v != "" {
		return v, "CLOOVIES_REPO_PATH (deprecated)"
	}
	if buildRepoPath != "" {
		return buildRepoPath, "embedded at build time"
	}
	return "", ""
}

// lookupAndVersion finds a binary on PATH and runs `bin versionArgs...`,
// extracting the first capture group of versionPattern. Returns ("","") if
// the binary isn't on PATH.
func lookupAndVersion(bin string, versionArgs []string, versionPattern string) (path, version string) {
	p, err := exec.LookPath(bin)
	if err != nil {
		return "", ""
	}
	return p, captureVersion(p, versionArgs, versionPattern)
}

func captureVersion(path string, args []string, pattern string) string {
	out, err := exec.Command(path, args...).CombinedOutput()
	if err != nil {
		return ""
	}
	re := regexp.MustCompile(pattern)
	m := re.FindStringSubmatch(strings.TrimSpace(string(out)))
	if len(m) >= 2 {
		return m[1]
	}
	return strings.TrimSpace(string(out))
}

func ensureWritable(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	probe := filepath.Join(dir, ".preflight-probe")
	f, err := os.Create(probe)
	if err != nil {
		return err
	}
	_ = f.Close()
	return os.Remove(probe)
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func countFiles(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			n++
		}
	}
	return n
}

func countDirs(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			n++
		}
	}
	return n
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return itoa(n) + " " + noun + "s"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// buildVCSInfo extracts the embedded vcs.revision / vcs.modified that the
// Go toolchain stamps into binaries by default (since Go 1.18). Empty
// when the binary was built with -trimpath or outside a git repo.
func buildVCSInfo() (rev string, modified bool) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "", false
	}
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	return rev, modified
}
