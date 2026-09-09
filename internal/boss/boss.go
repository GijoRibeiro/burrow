package boss

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// claudeMD is the orchestrator system prompt written to ~/.cloovies/boss/CLAUDE.md.
const claudeMD = `# Cloovies Boss — Agent Orchestrator

You are the Boss agent for Cloovies. You manage the user's running Claude Code agents.

## Your Role
- Receive requests from the user in natural language
- Route messages to the right agent based on context
- Report what agents are doing
- Only spawn new agents when no existing agent covers the project

## Existing Agents vs Workers

The system registry shows agents the user already has running. These are REAL Claude Code sessions in terminal windows. ALWAYS prefer messaging an existing agent over spawning a new worker.

- **Existing agents** have a session_id and pid in the registry. Use the "chat" tool to send them messages.
- **Workers** are headless processes you spawn. Only use "spawn" when no existing agent covers the target project.

## Communication Format

When you need to take actions, output a JSON block fenced with ` + "```actions```" + ` containing an array:

` + "```actions" + `
[
  {"tool": "chat", "session_id": "abc123", "text": "message to send to existing agent", "images": ["/path/to/image.png"]},
  {"tool": "spawn", "path": "/full/path/to/project", "task": "description"},
  {"tool": "message", "agent_id": "worker-1", "text": "message to worker"},
  {"tool": "stop", "agent_id": "worker-1"},
  {"tool": "status"}
]
` + "```" + `

Always include natural language before or after the actions block explaining what you're doing and why.

## Rules
- ALWAYS check the registry for an existing agent before spawning
- Use "chat" to message existing agents — they are already running in the right project
- Use "spawn" ONLY when no agent exists for that project
- If a task is ambiguous, ask the user to clarify
- Keep responses concise and natural
- When the user says something like "tell X to do Y", find agent X and chat to it

## Images
When the user attaches images, you will see a [SYSTEM: ...] message with file paths. When delegating to an agent, include those paths in the "images" field of your chat action. The agent will receive the file paths and can read the images directly. Do NOT try to describe or interpret images yourself.

## CRITICAL: You are a DELEGATOR, not a DOER
- NEVER investigate, research, read files, or explore codebases yourself
- NEVER try to answer technical questions by looking things up
- Your ONLY job is to forward the user's request to the right agent
- When the user asks you something, find the right agent and pass the request to them verbatim
- If the user asks "check X" or "investigate Y", delegate that task to an agent — do NOT do it yourself
- You are a dispatcher. You receive orders and route them. That's it.

## System Messages
You will receive [SYSTEM: ...] messages with agent registry state. These are ground truth — use them to know what's running. Each entry shows the agent name, status, session_id, pid, and project path.
`

// systemPrompt is prepended to every conversation as context.
// Route mode — verbatim message forwarding.
const systemPrompt = `You are Cloovies Boss, an orchestrator for Claude Code agents. Follow the instructions in your CLAUDE.md.

When the user asks you to do something:
1. Figure out WHICH existing agent should handle it based on the project context
2. Send the user's message EXACTLY as they wrote it using the "chat" tool with the agent's session_id
3. Do NOT rewrite, refine, expand, or "improve" the user's message — pass it verbatim

Only refine or rewrite the message if the user explicitly asks you to (e.g. "refine this", "improve this prompt", "reword this").

You are a router. You pick the right agent and forward the message. That's it.`

// Manager mode — think about the request and distribute tasks with context.
const thinkSystemPrompt = `You are Cloovies Boss in MANAGER MODE. You are not just a router — you are the engineering manager for the user's agents.

Your job: Take the user's request, understand it deeply, then distribute well-scoped tasks to the right agents using each project's context.

## The manager workflow

1. UNDERSTAND THE REQUEST
   - What does the user actually want? (the real goal, not the literal words)
   - Is this a question, a task, or a plan?
   - What success looks like

2. READ THE REGISTRY
   - What agents exist and what projects do they cover?
   - Which one(s) have the context needed for this request?
   - Project paths and names tell you what each agent "owns"

3. DECOMPOSE (if needed)
   - Single clear task → one agent, one message
   - Cross-cutting work → multiple agents, each with their own piece
   - Sequential work → dispatch in order, note dependencies in your plan

4. WRITE TASKS LIKE A MANAGER
   For EACH agent you dispatch to, write a task that:
   - Starts with WHAT to do in one clear sentence
   - Gives WHY if the user's intent matters (keeps them aligned)
   - Lists any SPECIFIC constraints, files, or patterns mentioned by the user
   - Is written in the user's voice ("we need to..." / "can you...") not as a bureaucratic ticket
   - Is scoped to that agent's project — don't tell CLOOVIES things about INSTALLER
   - Short. 2-5 sentences typical. Longer only when the user gave detail that matters.

5. EXPLAIN YOUR PLAN to the user BEFORE the actions block
   - One sentence per agent: "Sending X to INSTALLER to update the form, and Y to CLOOVIES to add the corresponding API."
   - Don't over-explain. The user hit enter; they want action.

## Rules

- NEVER investigate or do the work yourself. You are a manager, not an IC.
- DO rewrite the user's message when distributing — that's the whole point of manager mode.
- But DON'T invent requirements the user didn't say. Stay grounded in what they asked.
- If the request is genuinely simple (e.g. "CLOOVIES, restart your dev server"), just forward it — don't ceremoniously repackage trivial tasks.
- If you genuinely cannot decide which agent fits, ASK the user before dispatching.
- If context is missing to do the job well, say so and ask ONE focused question.

You use the same ` + "`chat`" + ` tool and actions block format. The difference from route mode is that YOU craft the message per agent instead of forwarding verbatim.`

// Action represents a structured command from the boss.
type Action struct {
	Tool      string   `json:"tool"`                 // "chat", "spawn", "message", "stop", "status"
	Path      string   `json:"path"`                 // for spawn
	Task      string   `json:"task"`                 // for spawn
	AgentID   string   `json:"agent_id"`             // for message, stop (workers)
	SessionID string   `json:"session_id"`           // for chat (existing agents)
	Text      string   `json:"text"`                 // for chat, message
	Images    []string `json:"images,omitempty"`      // image file paths to attach to chat
}

// BossEvent is a single event emitted while reading the boss response.
type BossEvent struct {
	Type    string   // "text", "actions", or "error"
	Text    string   // for text events — the streamed text chunk
	Actions []Action // for action events — parsed from ```actions``` blocks
	Error   string   // for error events
}

// historyEntry is a message in the boss conversation.
type historyEntry struct {
	Role string `json:"role"` // "user" or "assistant"
	Text string `json:"text"`
}

// Boss manages per-message claude -p invocations with conversation history.
type Boss struct {
	mu      sync.Mutex
	dir     string // ~/.cloovies/boss/
	history []historyEntry
	ready   bool
	running *exec.Cmd // currently running claude process, nil when idle
}

// New creates a Boss and ensures the working directory exists.
func New() (*Boss, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("boss: get home dir: %w", err)
	}
	b := &Boss{
		dir: filepath.Join(home, ".cloovies", "boss"),
	}
	if err := b.ensureDir(); err != nil {
		return nil, err
	}
	b.ready = true
	return b, nil
}

// ensureDir creates the boss working directory and CLAUDE.md if needed.
func (b *Boss) ensureDir() error {
	if err := os.MkdirAll(b.dir, 0o755); err != nil {
		return fmt.Errorf("boss: create dir %s: %w", b.dir, err)
	}

	mdPath := filepath.Join(b.dir, "CLAUDE.md")
	if _, err := os.Stat(mdPath); os.IsNotExist(err) {
		if err := os.WriteFile(mdPath, []byte(claudeMD), 0o644); err != nil {
			return fmt.Errorf("boss: write CLAUDE.md: %w", err)
		}
	}
	return nil
}

// Start is a no-op for compatibility. The boss is ready after New().
func (b *Boss) Start() error {
	return nil
}

// IsRunning returns true if the boss is ready to accept messages.
func (b *Boss) IsRunning() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ready
}

// Stop marks the boss as not ready.
func (b *Boss) Stop() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ready = false
	return nil
}

// Cancel kills the currently running boss process, if any.
func (b *Boss) Cancel() {
	b.mu.Lock()
	cmd := b.running
	b.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
}

// Send spawns a fresh `claude -p` process with the full conversation context,
// and returns a channel that streams BossEvents. The channel closes when done.
func (b *Boss) Send(userMessage string, registrySnapshot string, thinkMode bool) (<-chan BossEvent, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.ready {
		return nil, fmt.Errorf("boss: not ready")
	}

	// Build the full prompt including history + new message.
	prompt := b.buildPrompt(userMessage, registrySnapshot, thinkMode)

	// Append user message to history.
	b.history = append(b.history, historyEntry{Role: "user", Text: userMessage})

	// Keep history manageable — summarize if too long.
	if len(b.history) > 40 {
		b.history = b.history[len(b.history)-30:]
	}

	ch := make(chan BossEvent, 64)

	go func() {
		defer close(ch)

		cmd := exec.Command("claude", "-p", prompt,
			"--output-format", "stream-json",
			"--verbose",
			"--allowedTools", "Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git shortlog:*),Read",
		)
		cmd.Dir = b.dir

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			ch <- BossEvent{Type: "error", Error: fmt.Sprintf("boss: stdout pipe: %v", err)}
			return
		}

		if err := cmd.Start(); err != nil {
			ch <- BossEvent{Type: "error", Error: fmt.Sprintf("boss: start: %v", err)}
			return
		}

		b.mu.Lock()
		b.running = cmd
		b.mu.Unlock()
		defer func() {
			b.mu.Lock()
			b.running = nil
			b.mu.Unlock()
		}()

		var accumulated strings.Builder
		var fullResponse strings.Builder

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}

			var msg streamJSON
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}

			text := extractText(msg)
			if text != "" {
				accumulated.WriteString(text)
				fullResponse.WriteString(text)
			}

			// Check for actions blocks in accumulated text.
			// Strip actions from the text before emitting so the
			// raw JSON is never shown to the user.
			full := accumulated.String()
			if actions, remainder, ok := parseActionsBlock(full); ok {
				// Emit the text before the actions block.
				before := full[:strings.Index(full, "```actions")]
				before = strings.TrimRight(before, " \n\r\t")
				if before != "" {
					ch <- BossEvent{Type: "text", Text: before}
				}
				ch <- BossEvent{Type: "actions", Actions: actions}
				accumulated.Reset()
				remainder = strings.TrimLeft(remainder, " \n\r\t")
				accumulated.WriteString(remainder)
			} else if text != "" {
				// No actions block found (yet) — emit text as-is.
				// But hold back if it looks like an actions block is starting.
				if !strings.Contains(full, "```") {
					ch <- BossEvent{Type: "text", Text: text}
					accumulated.Reset()
				}
			}

			// A "result" type signals end of this turn.
			if msg.Type == "result" {
				full = accumulated.String()
				if actions, remainder, ok := parseActionsBlock(full); ok {
					before := full[:strings.Index(full, "```actions")]
					before = strings.TrimRight(before, " \n\r\t")
					if before != "" {
						ch <- BossEvent{Type: "text", Text: before}
					}
					ch <- BossEvent{Type: "actions", Actions: actions}
					remainder = strings.TrimSpace(remainder)
					if remainder != "" {
						ch <- BossEvent{Type: "text", Text: remainder}
					}
				} else if full != "" {
					// Flush any remaining buffered text.
					ch <- BossEvent{Type: "text", Text: full}
				}
				break
			}
		}

		cmd.Wait()

		// Save assistant response to history.
		if resp := fullResponse.String(); resp != "" {
			b.mu.Lock()
			b.history = append(b.history, historyEntry{Role: "assistant", Text: resp})
			b.mu.Unlock()
		}
	}()

	return ch, nil
}

// buildPrompt creates the full prompt string with system context, history, and new message.
func (b *Boss) buildPrompt(userMessage string, registrySnapshot string, thinkMode bool) string {
	var sb strings.Builder

	if thinkMode {
		sb.WriteString(thinkSystemPrompt)
	} else {
		sb.WriteString(systemPrompt)
	}
	sb.WriteString("\n\n")

	// Include conversation history for continuity.
	if len(b.history) > 0 {
		sb.WriteString("## Previous conversation\n\n")
		for _, h := range b.history {
			if h.Role == "user" {
				sb.WriteString("User: ")
			} else {
				sb.WriteString("You (Boss): ")
			}
			sb.WriteString(h.Text)
			sb.WriteString("\n\n")
		}
		sb.WriteString("## Current message\n\n")
	}

	if registrySnapshot != "" {
		sb.WriteString("[SYSTEM: Current agent registry]\n")
		sb.WriteString(registrySnapshot)
		sb.WriteString("\n\n")
	}

	sb.WriteString(userMessage)

	return sb.String()
}

// --- Stream JSON parsing ---

type streamJSON struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
	Message *streamMessage  `json:"message,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
}

type streamMessage struct {
	Content []contentBlock `json:"content"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func extractText(msg streamJSON) string {
	switch msg.Type {
	case "assistant":
		// Content is in message.content[], not top-level content.
		if msg.Message != nil {
			var sb strings.Builder
			for _, b := range msg.Message.Content {
				if b.Type == "text" {
					sb.WriteString(b.Text)
				}
			}
			return sb.String()
		}
		return ""
	case "content_block_delta":
		var delta struct {
			Delta struct {
				Text string `json:"text"`
			} `json:"delta"`
		}
		raw, _ := json.Marshal(msg)
		if json.Unmarshal(raw, &delta) == nil {
			return delta.Delta.Text
		}
	}
	return ""
}

func extractContentText(raw json.RawMessage) string {
	if raw == nil {
		return ""
	}
	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" {
			sb.WriteString(b.Text)
		}
	}
	return sb.String()
}

func extractResultText(result json.RawMessage) string {
	if result == nil {
		return ""
	}
	// Result can be a plain string.
	var s string
	if json.Unmarshal(result, &s) == nil {
		return s
	}
	return ""
}

// parseActionsBlock looks for a fenced ```actions ... ``` block in s.
func parseActionsBlock(s string) ([]Action, string, bool) {
	const openFence = "```actions"
	const closeFence = "```"

	idx := strings.Index(s, openFence)
	if idx == -1 {
		return nil, s, false
	}

	afterOpen := idx + len(openFence)
	rest := s[afterOpen:]
	closeIdx := strings.Index(rest, closeFence)
	if closeIdx == -1 {
		return nil, s, false
	}

	jsonStr := strings.TrimSpace(rest[:closeIdx])
	var actions []Action
	if err := json.Unmarshal([]byte(jsonStr), &actions); err != nil {
		return nil, s, false
	}

	remainder := rest[closeIdx+len(closeFence):]
	return actions, remainder, true
}
