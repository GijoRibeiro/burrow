package scanner

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// AgentState represents a discovered Claude Code agent read from a session file.
type AgentState struct {
	PID            int    `json:"pid"`
	SessionID      string `json:"sessionId"`
	Cwd            string `json:"cwd"`
	StartedAt      int64  `json:"startedAt"`
	Kind           string `json:"kind"`
	Alive          bool   `json:"alive"`
	CurrentTask    string `json:"currentTask"`
	TaskStatus     string `json:"taskStatus"`
	Tasks          []Task `json:"tasks"`
	ContextTokens  int    `json:"contextTokens"`  // last known context size (input + cache_read)
	TaskElapsedMs  int64  `json:"taskElapsedMs"`  // ms since the current in_progress task started
	ActiveSubs     int         `json:"activeSubs"`
	TotalSubs      int         `json:"totalSubs"`
	Subagents      []SubAgent  `json:"subagents"`
	CommitsToday   int    `json:"commitsToday"`
	PushesToday    int    `json:"pushesToday"`
	MergesToday    int    `json:"mergesToday"`
	TotalCommits   int    `json:"totalCommits"`
	Branch         string `json:"branch"`         // current git branch name
	Worktree       string `json:"worktree"`       // empty = main repo, otherwise worktree name
	WorktreePath   string `json:"worktreePath"`   // full path to worktree dir (for git stats)
	DevURLs        []string `json:"devUrls"`      // local server URLs seen in the session output (dev servers the agent started)
}

// SubAgent represents a discovered subagent.
type SubAgent struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
}

type sessionFile struct {
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	StartedAt int64  `json:"startedAt"`
	Kind      string `json:"kind"`
}

type taskFile struct {
	ID         string `json:"id"`
	Subject    string `json:"subject"`
	Status     string `json:"status"`
	ActiveForm string `json:"activeForm"`
}

// Task is a single todo item exposed to clients.
type Task struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
	Status  string `json:"status"` // pending | in_progress | completed
	// Abandoned marks a pending/in_progress todo the agent has clearly
	// moved past: a later todo (higher numeric ID) in the same session
	// is already completed. TodoWrite lists are worked roughly in order,
	// so finishing #31 while #19 sits pending means #19 was skipped, not
	// queued. The frontend dims these and excludes them from the active
	// count so a long-abandoned straggler doesn't make an idle agent
	// look stuck.
	Abandoned bool `json:"abandoned"`
}

// Scanner reads Claude Code session and task files from disk.
type Scanner struct {
	sessionsDir string
	tasksDir    string
	projectsDir string

	// warnedSessions tracks session IDs we've already logged a
	// projectDirName-mismatch warning for, so the log stays at one line per
	// affected session rather than one per scan tick.
	warnedMu       sync.Mutex
	warnedSessions map[string]bool

	// devURLs caches the local server URLs detected per session, in first-seen
	// order. A dev server prints its URL once at startup, then it scrolls out
	// of the bounded tail window we read each tick — so we accumulate here
	// (pruned when the session file goes away). devURLScanned marks sessions
	// we've already whole-file scanned, so the expensive full read happens at
	// most once per session (e.g. to recover URLs printed before the daemon
	// started); later ticks read only the tail. devURLAlive holds the last
	// liveness-probe result per URL (refreshDevURLLiveness); detectDevURLs
	// filters what it returns by it. All devURL logic lives in devurl.go.
	devURLMu      sync.Mutex
	devURLs       map[string][]string
	devURLScanned map[string]bool
	devURLAlive   map[string]bool
}

// New creates a Scanner that reads from the given directories.
func New(sessionsDir, tasksDir string) *Scanner {
	// Derive projectsDir from sessionsDir (sibling directory)
	claudeDir := filepath.Dir(sessionsDir)
	return &Scanner{
		sessionsDir: sessionsDir,
		tasksDir:    tasksDir,
		projectsDir: filepath.Join(claudeDir, "projects"),
	}
}

// Scan reads all session files and enriches with activity data.
func (s *Scanner) Scan() ([]AgentState, error) {
	entries, err := os.ReadDir(s.sessionsDir)
	if err != nil {
		return nil, fmt.Errorf("read sessions dir: %w", err)
	}

	var agents []AgentState
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(s.sessionsDir, entry.Name()))
		if err != nil {
			continue
		}

		var sf sessionFile
		if err := json.Unmarshal(data, &sf); err != nil {
			continue
		}

		agent := AgentState{
			PID:       sf.PID,
			SessionID: sf.SessionID,
			Cwd:       sf.Cwd,
			StartedAt: sf.StartedAt,
			Kind:      sf.Kind,
			Alive:     isProcessAlive(sf.PID),
		}

		// Task files tell us WHAT the agent is doing (task name + todo status).
		agent.CurrentTask, agent.TaskStatus, agent.Tasks = s.findCurrentTask(sf.SessionID)

		// Conversation tail tells us whether the agent is ACTIVELY mid-turn.
		// TodoWrite task files persist across turns — an agent can finish a
		// turn without marking its todo as completed, leaving a stale
		// in_progress entry behind. The tail of the jsonl is the authoritative
		// signal for current-turn liveness.
		if agent.Alive {
			turnActive := s.isConversationActive(sf.Cwd, sf.SessionID)
			if agent.TaskStatus == "in_progress" && !turnActive {
				// Stale todo: the agent has stopped but the task file still
				// says in_progress. Keep CurrentTask visible (so you can see
				// what they were last working on) but downgrade the status
				// so deriveStatus() doesn't flag them as "active".
				agent.TaskStatus = "pending"
			} else if agent.TaskStatus == "" && turnActive {
				// No task file, but the conversation is mid-turn — generic
				// "working..." placeholder so the UI still shows activity.
				agent.TaskStatus = "in_progress"
				agent.CurrentTask = "working..."
			}
		}

		// Context tokens + task elapsed time
		agent.ContextTokens = s.readContextTokens(sf.Cwd, sf.SessionID)
		agent.TaskElapsedMs = s.readTaskElapsedMs(sf.SessionID)

		// Local dev-server URLs the agent printed (sticky across ticks).
		agent.DevURLs = s.detectDevURLs(sf.Cwd, sf.SessionID)

		// Read git stats from the agent's working directory
		agent.CommitsToday, agent.PushesToday, agent.MergesToday, agent.TotalCommits, agent.Branch = readGitStats(sf.Cwd)

		// Scan subagents
		agent.ActiveSubs, agent.TotalSubs, agent.Subagents = s.scanSubagents(sf.Cwd, sf.SessionID)

		// Subagents re-activate the parent even if the parent's turn looks
		// idle in the tail — the parent is effectively waiting on them.
		if agent.ActiveSubs > 0 && agent.TaskStatus != "in_progress" {
			agent.TaskStatus = "in_progress"
			agent.CurrentTask = fmt.Sprintf("%d subagent(s) working", agent.ActiveSubs)
		}

		agents = append(agents, agent)
	}

	// Detect worktrees and assign to agents sharing a cwd
	var cwds []string
	for _, a := range agents {
		if a.Alive {
			cwds = append(cwds, a.Cwd)
		}
	}
	worktreesByCwd := detectWorktrees(cwds)
	AssignWorktrees(agents, worktreesByCwd)

	// Re-read git stats for worktree agents using worktree path
	for i := range agents {
		if agents[i].WorktreePath != "" {
			agents[i].CommitsToday, agents[i].PushesToday, agents[i].MergesToday, agents[i].TotalCommits, agents[i].Branch = readGitStats(agents[i].WorktreePath)
		}
	}

	// Dev-URL bookkeeping: drop cached URLs for sessions that vanished, then
	// re-probe which detected servers still answer. Probe results apply on
	// the NEXT tick's detectDevURLs — about one tick between closing a
	// server and its chip disappearing.
	liveSessions := make(map[string]bool, len(agents))
	for _, a := range agents {
		liveSessions[a.SessionID] = true
	}
	s.pruneDevURLCache(liveSessions)
	s.refreshDevURLLiveness()

	return agents, nil
}

// projectDirName encodes a cwd to match Claude Code's project directory
// naming. Claude replaces `/`, ` `, AND `.` with `-` (which is why a worktree
// at `<repo>/.claude/worktrees/<name>` shows up under
// `~/.claude/projects/-…-cloovies--claude-worktrees-<name>` — the `.claude`
// segment becomes `-claude`, producing a double hyphen). Previously we only
// replaced `/` and space, so any cwd with a dot — including every spawned
// worktree agent — pointed to a non-existent project dir, the jsonl tailer
// silently returned "no file", `isConversationActive` returned false, and the
// frame never lit up as working.
func projectDirName(cwd string) string {
	d := strings.ReplaceAll(cwd, "/", "-")
	d = strings.ReplaceAll(d, " ", "-")
	d = strings.ReplaceAll(d, ".", "-")
	if !strings.HasPrefix(d, "-") {
		d = "-" + d
	}
	return d
}

// isConversationActive reads the tail of the session's conversation log and
// decides whether the agent is mid-turn (working) or waiting for the user (idle).
// This replaces the old mtime-based heuristic which flickered on long tool
// calls and quiet thinking gaps.
//
// Resolution: try the canonical path derived from projectDirName(cwd) first,
// then fall back to searching every project dir for <sessionID>.jsonl. The
// fallback exists because Claude Code's cwd-to-projectDirName encoding is not
// formally documented and has changed in the past (the `.` → `-` rule was
// added in commit 5b4260e after worktree agents under `.claude/worktrees/`
// silently appeared idle). Session IDs are UUIDs so the search is unique
// enough to trust the first match.
func (s *Scanner) isConversationActive(cwd, sessionID string) bool {
	logPath := s.findSessionLog(cwd, sessionID)
	if logPath == "" {
		return false
	}
	tail, err := readFileTail(logPath, 16*1024)
	if err != nil {
		return false
	}
	return IsWorkingFromTail(tail)
}

// findSessionLog returns the absolute path to the conversation jsonl for the
// given (cwd, sessionID). Empty string means no file found anywhere — agent
// will be treated as idle by the caller.
//
// The fallback search only runs when the canonical path is absent, so a
// correctly-encoded cwd costs one os.Stat. When the fallback succeeds, the
// real-vs-expected mismatch is logged once per session so encoding gaps
// surface in the logs instead of silently rendering as "stuck idle".
func (s *Scanner) findSessionLog(cwd, sessionID string) string {
	canonical := filepath.Join(s.projectsDir, projectDirName(cwd), sessionID+".jsonl")
	if _, err := os.Stat(canonical); err == nil {
		return canonical
	}

	entries, err := os.ReadDir(s.projectsDir)
	if err != nil {
		return ""
	}
	target := sessionID + ".jsonl"
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		candidate := filepath.Join(s.projectsDir, e.Name(), target)
		if _, err := os.Stat(candidate); err == nil {
			s.warnEncodingMismatchOnce(sessionID, cwd, candidate)
			return candidate
		}
	}
	return ""
}

// warnEncodingMismatchOnce logs a single warning per session whenever the
// canonical projectDirName-derived path was absent but the JSONL was found
// elsewhere — i.e. our encoding doesn't match Claude Code's for this cwd.
// Logging once (not per scan tick) keeps the noise low while still flagging
// the gap so we can update projectDirName.
func (s *Scanner) warnEncodingMismatchOnce(sessionID, cwd, found string) {
	s.warnedMu.Lock()
	defer s.warnedMu.Unlock()
	if s.warnedSessions == nil {
		s.warnedSessions = map[string]bool{}
	}
	if s.warnedSessions[sessionID] {
		return
	}
	s.warnedSessions[sessionID] = true
	expected := filepath.Join(s.projectsDir, projectDirName(cwd), sessionID+".jsonl")
	log.Printf("scanner: projectDirName mismatch — cwd=%q expected=%q actual=%q (using actual)",
		cwd, expected, found)
}

// readFileTail returns up to n bytes from the end of the file.
func readFileTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := stat.Size()
	offset := int64(0)
	if size > n {
		offset = size - n
	}
	buf := make([]byte, size-offset)
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return nil, err
	}
	return buf, nil
}

// IsWorkingFromTail inspects the tail of a Claude Code session jsonl and
// returns true if the agent is mid-turn (working), false if the turn has
// ended (idle). Turn-end is signaled by a `turn_duration` system entry, a
// `stop_hook_summary` system entry, or a Stop hook attachment.
//
// Claude Code appends metadata lines (last-prompt, permission-mode,
// file-history-snapshot, attachment) after a turn ends, so we scan backwards
// past those neutral entries to find the last meaningful signal line.
//
// Only fully-terminated lines (ending in '\n' in the original bytes) are
// considered, so a line currently being written by Claude Code does not cause
// false readings.
func IsWorkingFromTail(tail []byte) bool {
	if len(tail) == 0 {
		return false
	}

	// Trim any partial trailing line: work only with bytes up to the last '\n'.
	lastNL := -1
	for i := len(tail) - 1; i >= 0; i-- {
		if tail[i] == '\n' {
			lastNL = i
			break
		}
	}
	if lastNL < 0 {
		return false
	}
	terminated := tail[:lastNL]

	lines := strings.Split(string(terminated), "\n")
	// If the tail clearly started mid-line, discard the first possibly-truncated
	// line.
	if len(lines) > 1 && len(tail) > 0 && tail[0] != '\n' {
		lines = lines[1:]
	}

	// Scan backwards for the last signal line. Instead of listing every
	// metadata type Claude Code might append after a turn (there are many
	// and new ones keep appearing), we check explicitly for the two things
	// that mean "working": assistant/user messages, and mid-turn hook
	// attachments. Everything else is either a turn-end marker (idle) or
	// post-turn metadata (skip).
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		// Turn-end markers → idle.
		if strings.Contains(line, `"subtype":"turn_duration"`) ||
			strings.Contains(line, `"subtype":"stop_hook_summary"`) ||
			strings.Contains(line, `"hookEvent":"Stop"`) {
			return false
		}
		// Assistant or user messages → working.
		if strings.Contains(line, `"type":"assistant"`) ||
			strings.Contains(line, `"type":"user"`) {
			return true
		}
		// Mid-turn hook attachments (PreToolUse, PostToolUse) → working.
		if strings.Contains(line, `"hookEvent"`) {
			return true
		}
		// Anything else (system metadata, last-prompt, permission-mode,
		// file-history-snapshot, away_summary, pr-link, etc.) — skip.
	}
	return false
}

func (s *Scanner) findCurrentTask(sessionID string) (string, string, []Task) {
	taskDir := filepath.Join(s.tasksDir, sessionID)
	entries, err := os.ReadDir(taskDir)
	if err != nil {
		return "", "", nil
	}

	var current, status string

	// Collect tasks and sort by numeric filename so display order matches the terminal list.
	type namedFile struct {
		name string
		num  int
	}
	var files []namedFile
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		n, _ := strconv.Atoi(strings.TrimSuffix(name, ".json"))
		files = append(files, namedFile{name: name, num: n})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].num < files[j].num })

	// Parse every task, keeping its numeric ID so we can reason about
	// ordering for abandonment detection below.
	type parsedTask struct {
		task      Task
		num       int
		activeRaw string
	}
	var parsed []parsedTask
	maxCompletedNum := -1
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(taskDir, f.name))
		if err != nil {
			continue
		}
		var tf taskFile
		if err := json.Unmarshal(data, &tf); err != nil {
			continue
		}
		parsed = append(parsed, parsedTask{
			task:      Task{ID: tf.ID, Subject: tf.Subject, Status: tf.Status},
			num:       f.num,
			activeRaw: tf.ActiveForm,
		})
		if tf.Status == "completed" && f.num > maxCompletedNum {
			maxCompletedNum = f.num
		}
	}

	// A pending/in_progress todo is abandoned when a later todo (higher
	// numeric ID) in the same list is already completed — the agent
	// worked past it. Mark those so the frontend can de-emphasize them
	// and skip them when choosing the agent's current task.
	tasks := make([]Task, 0, len(parsed))
	for _, p := range parsed {
		if p.task.Status != "completed" && p.num < maxCompletedNum {
			p.task.Abandoned = true
		}
		tasks = append(tasks, p.task)
		if p.task.Status == "in_progress" && !p.task.Abandoned && current == "" {
			name := p.activeRaw
			if name == "" {
				name = p.task.Subject
			}
			current = name
			status = p.task.Status
		}
	}

	return current, status, tasks
}

// readTaskElapsedMs returns ms since the current in_progress task file was last modified.
// If no in_progress task is found, returns 0.
func (s *Scanner) readTaskElapsedMs(sessionID string) int64 {
	taskDir := filepath.Join(s.tasksDir, sessionID)
	entries, err := os.ReadDir(taskDir)
	if err != nil {
		return 0
	}
	var oldestActive time.Time
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		path := filepath.Join(taskDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var tf taskFile
		if err := json.Unmarshal(data, &tf); err != nil {
			continue
		}
		if tf.Status != "in_progress" {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		mt := info.ModTime()
		if oldestActive.IsZero() || mt.Before(oldestActive) {
			oldestActive = mt
		}
	}
	if oldestActive.IsZero() {
		return 0
	}
	return time.Since(oldestActive).Milliseconds()
}

// readContextTokens returns the context size from the last usage entry in the conversation log.
// It reads backwards from the end of the file looking for the last "usage" block.
func (s *Scanner) readContextTokens(cwd, sessionID string) int {
	projDirName := projectDirName(cwd)
	logPath := filepath.Join(s.projectsDir, projDirName, sessionID+".jsonl")
	data, err := os.ReadFile(logPath)
	if err != nil {
		return 0
	}
	// Search backwards for the last "usage" block
	lines := strings.Split(string(data), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !strings.Contains(line, `"usage"`) {
			continue
		}
		var entry struct {
			Message *struct {
				Usage *struct {
					InputTokens              int `json:"input_tokens"`
					CacheReadInputTokens     int `json:"cache_read_input_tokens"`
					CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
					OutputTokens             int `json:"output_tokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil || entry.Message == nil || entry.Message.Usage == nil {
			continue
		}
		u := entry.Message.Usage
		return u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
	}
	return 0
}

// scanSubagents reads subagent metadata and activity.
func (s *Scanner) scanSubagents(cwd, sessionID string) (active, total int, subs []SubAgent) {
	projDirName := projectDirName(cwd)
	subDir := filepath.Join(s.projectsDir, projDirName, sessionID, "subagents")
	entries, err := os.ReadDir(subDir)
	if err != nil {
		return 0, 0, nil
	}

	// Collect meta files and their activity
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}

		// Read meta
		data, err := os.ReadFile(filepath.Join(subDir, name))
		if err != nil {
			continue
		}

		var meta struct {
			AgentType   string `json:"agentType"`
			Description string `json:"description"`
		}
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}

		// Check if the corresponding .jsonl is active
		agentID := strings.TrimSuffix(name, ".meta.json")
		logFile := filepath.Join(subDir, agentID+".jsonl")
		isActive := false
		if info, err := os.Stat(logFile); err == nil {
			isActive = time.Since(info.ModTime()) < 10*time.Second
		}

		total++
		if isActive {
			active++
		}

		// Only include active subagents in the list
		if isActive {
			subs = append(subs, SubAgent{
				ID:          agentID,
				Type:        meta.AgentType,
				Description: meta.Description,
				Active:      true,
			})
		}
	}
	return
}

// findGitDir returns the directory to use for git commands.
// If cwd itself is a git repo, returns cwd. Otherwise checks immediate
// subdirectories for a single git repo and returns that.
func findGitDir(cwd string) string {
	cmd := exec.Command("git", "rev-parse", "--git-dir")
	cmd.Dir = cwd
	if err := cmd.Run(); err == nil {
		return cwd
	}
	// Fallback: check immediate subdirectories
	entries, err := os.ReadDir(cwd)
	if err != nil {
		return ""
	}
	var found string
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub := filepath.Join(cwd, e.Name())
		c := exec.Command("git", "rev-parse", "--git-dir")
		c.Dir = sub
		if c.Run() == nil {
			if found != "" {
				return "" // multiple repos, ambiguous
			}
			found = sub
		}
	}
	return found
}

func readGitStats(cwd string) (commitsToday, pushesToday, mergesToday, totalCommits int, branch string) {
	gitDir := findGitDir(cwd)
	if gitDir == "" {
		return 0, 0, 0, 0, ""
	}

	// Current branch
	out, err := exec.Command("git", "-C", gitDir, "branch", "--show-current").Output()
	if err == nil {
		branch = strings.TrimSpace(string(out))
	}

	// Commits today
	out, err = exec.Command("git", "-C", gitDir, "log", "--oneline", "--since=midnight").Output()
	if err == nil {
		commitsToday = countLines(string(out))
	}

	// Merges today (commits with more than 1 parent)
	out, err = exec.Command("git", "-C", gitDir, "log", "--oneline", "--merges", "--since=midnight").Output()
	if err == nil {
		mergesToday = countLines(string(out))
	}

	// Pushes today — count from reflog
	out, err = exec.Command("git", "-C", gitDir, "reflog", "show", "--since=midnight", "--format=%gs").Output()
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, "push") {
				pushesToday++
			}
		}
	}

	// Total commits in repo
	out, err = exec.Command("git", "-C", gitDir, "rev-list", "--count", "HEAD").Output()
	if err == nil {
		n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
		totalCommits = n
	}

	return
}

func countLines(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	return len(strings.Split(s, "\n"))
}

// WorktreeInfo describes a Claude-managed git worktree.
type WorktreeInfo struct {
	Name string // directory name under .claude/worktrees/
	Path string // full filesystem path
}

// ParseWorktreeList parses `git worktree list --porcelain` output and returns
// only Claude-managed worktrees (those under <cwd>/.claude/worktrees/).
func ParseWorktreeList(output, cwd string) []WorktreeInfo {
	prefix := filepath.Join(cwd, ".claude", "worktrees") + "/"
	var result []WorktreeInfo

	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "worktree ") {
			continue
		}
		wtPath := strings.TrimPrefix(line, "worktree ")
		if !strings.HasPrefix(wtPath, prefix) {
			continue
		}
		// Extract name: everything after the prefix
		name := strings.TrimPrefix(wtPath, prefix)
		if name == "" || strings.Contains(name, "/") {
			continue
		}
		result = append(result, WorktreeInfo{Name: name, Path: wtPath})
	}

	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

// AssignWorktrees assigns worktree names to agents that share a cwd,
// when multiple agents exist for the same cwd and Claude-managed worktrees are present.
// Agents are sorted by SessionID and matched 1:1 with sorted worktrees.
// Single agents are never split. Mutates agents in place.
func AssignWorktrees(agents []AgentState, worktreesByCwd map[string][]WorktreeInfo) {
	// Group alive agents by cwd
	byCwd := make(map[string][]*AgentState)
	for i := range agents {
		if agents[i].Alive {
			byCwd[agents[i].Cwd] = append(byCwd[agents[i].Cwd], &agents[i])
		}
	}

	for cwd, group := range byCwd {
		wts, ok := worktreesByCwd[cwd]
		if !ok || len(wts) == 0 || len(group) < 2 {
			continue
		}

		// Sort agents by SessionID for stable assignment
		sort.Slice(group, func(i, j int) bool { return group[i].SessionID < group[j].SessionID })

		// Assign worktrees 1:1 — first agent gets first worktree, etc.
		for i := 0; i < len(group) && i < len(wts); i++ {
			group[i].Worktree = wts[i].Name
			group[i].WorktreePath = wts[i].Path
		}
	}
}

// detectWorktrees runs `git worktree list --porcelain` for each unique cwd
// and returns Claude-managed worktrees grouped by cwd.
func detectWorktrees(cwds []string) map[string][]WorktreeInfo {
	result := make(map[string][]WorktreeInfo)
	seen := make(map[string]bool)

	for _, cwd := range cwds {
		if seen[cwd] {
			continue
		}
		seen[cwd] = true

		out, err := exec.Command("git", "-C", cwd, "worktree", "list", "--porcelain").Output()
		if err != nil {
			continue
		}
		wts := ParseWorktreeList(string(out), cwd)
		if len(wts) > 0 {
			result[cwd] = wts
		}
	}
	return result
}

func isProcessAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil
}
