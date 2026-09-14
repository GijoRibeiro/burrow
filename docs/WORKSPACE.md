# Workspace implementation

## Ownership

`Manager` stores projects and terminal identities. A project is the primary Git checkout, with linked worktrees discovered through `git worktree list --porcelain -z`. Terminal records point to a project and an exact registered checkout path. Agent discovery is an optional read-only companion; shells never depend on it.

`model.go` handles Git and atomic JSON persistence; `terminals.go` manages tmux session lifecycles; `http.go` validates local requests and routes operations; `stream.go` attaches disposable PTYs over WebSocket. Commands use argument arrays, never interpolated shell command strings. Branch bases are resolved to commit IDs before creating worktrees. Test-created data and processes use unique temporary paths and sockets.

A terminal is a tmux session on Cloovies' dedicated socket. Each attached browser pane starts a separate tmux client inside a PTY. Binary PTY output streams to xterm.js; JSON input and resize messages go in the other direction. Browser disconnect closes the PTY and its attachment process, while the session and shell remain owned by tmux. App termination has the same property. A fresh attachment redraws the existing screen; tmux retains scrollback and handles scrolling in copy mode.

See the upstream [xterm addon API](https://xtermjs.org/docs/guides/using-addons/) and [PTY implementation](https://github.com/creack/pty) for the two small terminal dependencies.

## UI

`app.ts` coordinates snapshots, terminal selection, and actions. `sidebar.ts` renders projects/worktrees/session visibility. `layout.ts` is a pure binary split-tree model; it supports insertion, removal, presets, swaps, and defensive restoration. `split-view.ts` renders the tree and handles pointer/keyboard resizing. `terminal.ts` owns one xterm instance, connection recovery, fitting, and disposal. `dom.ts` provides safe text-based elements and forms, including the native directory-picker bridge.

Terminal panes are retained while the layout changes, rather than rebuilding their xterm instances. Hiding disposes the view and attachment only. Focusing a pane temporarily changes the rendering, not the saved layout. Layout storage is separate from server metadata, so selecting a project can never replace the terminal canvas. Poll results from before a mutation are discarded to prevent an older response overwriting the new state. Status-only updates leave the DOM attached so they cannot steal keyboard focus. Unsent composer drafts are saved per session and restored after hiding a pane or reloading.

## Quiet views and creatures

`activity.go` reads Claude’s local session metadata and bounded transcript tails. It matches live PID ancestry against the exact tmux pane, so agents sharing a checkout remain distinct. It exposes user/assistant text and small activity summaries, excluding reasoning, tool payloads, and subagent conversations. It handles partial JSONL records and changed project-slug conventions. No hooks, account settings, or project configuration are installed. Claude must write local sessions/transcripts (under `CLAUDE_CONFIG_DIR` or `~/.claude`); if those are unavailable, live terminal output remains visible. See Claude’s [transcript documentation](https://claude.com/blog/how-to-configure-hooks).

`agent-view.ts` renders the quiet conversation and uses xterm’s parsed screen buffer for Claude startup output and interactive prompt hints. Shells show an explicit Start Claude action in Agent view, with chat submission disabled. The launcher creates a separate managed Claude terminal, transfers the draft and assigns a new color and creature, replaces the visible pane, and preserves the original shell in the sidebar. New-terminal forms offer Claude Code, Codex, or Shell. Both agents start with permission bypass enabled, including after restart. Claude uses `--dangerously-skip-permissions`; Codex uses [`--dangerously-bypass-approvals-and-sandbox`](https://learn.chatgpt.com/docs/developer-commands?surface=cli). Codex starts in Terminal view; its Agent view previews the screen and directs interaction to Terminal. Managed agent terminals are exec’d directly by tmux, so exiting the agent does not fall back to a shell. Prompt detection is best effort; the Terminal switch is always available for any program. Both views share one xterm, WebSocket, and composer. Raw terminal input travels over the WebSocket; Agent messages use a separate POST endpoint that revalidates live process ancestry and foreground process-group membership on every submission, then sends bracketed-paste text to the exact pane. Failed submissions retain the draft. The hidden terminal retains its dimensions and parser but is inert to keyboard and accessibility focus. Requests are aborted on disposal, polling pauses in background documents, and updates preserve conversation scroll position.

`creature.ts` imports the original sprites through Vite and provides the per-terminal picker. DM Sans (UI) and Google Sans Code (terminal, composer, and code blocks) are bundled locally with their OFL licenses. The terminal explicitly loads the code font before updating xterm’s metrics and fitting the PTY. There is no runtime font-service dependency. Terminal colors reuse the original palette and assignment algorithm, can be customized with the creature picker, and persist per terminal alongside layout preferences. The original stepped thinking animation and two-frame creature animations respect reduced-motion preferences. The separate legacy dashboard retains Gridbit and PixelPurl.

## Compatibility

The legacy dashboard is built separately, so its large style sheet and UI do not load in the workspace. The workspace reuses its sprites, palette, and animation in small independent modules, with readable Google Fonts for text.

This implementation targets macOS and Unix systems with tmux and PTY support. The native build script currently targets Apple Silicon. It is a local, single-user workspace, not a remote multi-user terminal service. The native package is locally ad-hoc signed; notarized public distribution is a separate release step.

`appearance.ts` allocates distinct colors and least-used randomized creatures, persisted per terminal. A versioned migration repairs inherited duplicate identities. `motion.ts` animates layout changes using saved pane rectangles and short-lived inert exit snapshots; live PTYs are never replaced for animation. Reduced-motion bypasses these effects. Native menu commands and capture-phase browser shortcuts share the same application actions. Text size updates both xterm and Agent reading content.

Agent view previews local PNG, JPEG, GIF, and WebP references beneath conversation messages and agent screen output. Clicking a thumbnail opens a modal with Fit and Actual size views. Images are read through a terminal-scoped endpoint confined to that checkout; traversal and symlinks outside it are rejected, along with non-image files and files over 24 MiB. Missing references leave the original text intact without broken thumbnails.


## Optional coordination

`coordination.go` stores tasks, explicit completion commits, inbox messages, and worktree lineage in the workspace state. Ordinary worktrees have no parent metadata. Only new child creation records lineage; the discovered Git checkout list remains authoritative. `agent_runtime.go` exposes local UI routes and an authenticated agent endpoint. `internal/agentcli` implements the JSON CLI, including separate read/ack operations and bounded waiting. The standalone server writes a private runtime descriptor and stable launcher; managed agents get an identity and CLI PATH without changing their normal initial prompt unless they are delegated workers.

Review records both the completed child commit and current parent commit. Integration refuses a changed parent commit/branch, dirty checkout, or existing Git operation. Merge conflicts are aborted. Task status and process status are separate: task cancellation is metadata, and terminal termination remains an explicit action. See [COORDINATION.md](COORDINATION.md) for the user workflow and limitations.
