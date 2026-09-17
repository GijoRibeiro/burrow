# Burrow

A local workspace for projects, Git worktrees, and persistent terminals. Put terminals from different projects on one screen, split and resize them, and keep processes running when their panes are hidden or the app is closed.

The workspace pairs DM Sans for the UI with Google Sans Code for terminals and code. Bitwise’s creatures, dithered borders, and per-terminal color palette keep their character; click a pane’s creature to customize its color and companion. Fonts are bundled locally and work offline. The original dashboard and integrations remain in the source tree; see [docs/LEGACY-DASHBOARD.md](docs/LEGACY-DASHBOARD.md).

![Workspace with terminals from multiple projects and pixel companions](docs/images/workspace.png)

The repository uses **Burrow** as a working name. The current app bundle and compatibility identifiers still use Cloovies.

## Download and setup

Download the app from [Releases](https://github.com/GijoRibeiro/burrow/releases). It runs on Apple Silicon and Intel Macs with macOS 13 or newer. First-run setup offers installation of Git and tmux, plus optional Claude Code and Codex. Each person signs in with their own accounts. See [installation and sharing instructions](docs/INSTALL.md), including the first-open step for this unnotarized build.

To produce the shareable ZIP yourself, run `make workspace-package`. The archive contains the app and setup instructions, without personal workspace data.

## Run

On macOS, open `build/macos/Cloovies.app` after building with:

```sh
make workspace-app
```

This produces a standalone universal macOS app with its server and web assets embedded. It needs Git and tmux at runtime; Claude, Codex, and other agent CLIs are optional. Build requirements: Go 1.26.1+, Node 20.19+ (or 22.12+), npm, and Xcode Command Line Tools.

For the browser:

```sh
make build-workspace
./bin/cloovies-workspace --port 4340
# Open http://127.0.0.1:4340
```

For frontend development:

```sh
# Terminal 1
make workspace
# Terminal 2
cd web
CLOOVIES_BACKEND_URL=http://127.0.0.1:4340 npm run dev
```

## Working in the workspace

1. **Add project**: choose any local folder, or select **GitHub repository** to connect your account, search personal and organization repositories, choose a parent folder and clone name, and **Clone and open**. GitHub CLI is optional and the native app can install it during sign-in. Existing destinations are never overwritten; clones show progress and can be canceled. For local Git repositories, existing worktrees are discovered automatically, including worktrees created outside Cloovies. Adding a linked worktree resolves to its parent project.
2. **Create worktree**: use the project's **+** button. Choose Manual or **From Linear** to search your tickets, select one, and prefill an editable branch name. Linear links remain with the worktree; new agent drafts include the ticket context. For manual creation, give it a name and a starting branch or commit. New worktrees live in `<project>/.worktrees/<name>` on a branch with the same name. The folder is excluded through Git's local `info/exclude`; the committed `.gitignore` is unchanged.
3. **New terminal**: choose any project/worktree and a session name. Choose **Claude Code** (the default), **Codex**, or **Shell**. Both agents start in YOLO mode, including after restart. Codex opens its native CLI in Terminal view.
4. **Choose terminals**: show or hide sessions from across all projects. Project selection does not replace the visible canvas. Use a pane's split buttons to add another terminal to its right or below.
5. Drag dividers to resize. Double-click a divider to balance it. Drag one header onto another to swap panes. Columns, rows, and grid presets arrange all visible terminals. Focus mode temporarily enlarges one pane.
6. Each pane has an **Agent / Terminal** switch. Agent shows Claude’s conversation without tool payloads. If no agent is running, **Start Claude** opens an agent in that pane and keeps the original shell available in the sidebar. Chat uses a separate endpoint that checks for a foreground Claude process before sending. Terminal mode explicitly accepts shell commands and other terminal input. The creature animates while Claude works. Click its header sprite to choose a color and companion. New terminals get distinct colors and randomized creatures, preferring unused creatures. View choice, color, creature, and drafts survive hide/show and reload.
7. Agent view renders local PNG, JPEG, GIF, and WebP references as thumbnails. Click a thumbnail to enlarge it, choose Fit or Actual size, and press Escape to close. Images must be inside the terminal’s checkout.
8. Type in the terminal directly, or use its message input. Enter sends; Shift+Enter inserts a newline. Scroll in the terminal for history, and press Q to leave history mode. Hold Shift while dragging to select terminal text, then copy normally.

Right-click a sidebar terminal for Show/Hide, Focus, Rename, Terminate, and (when stopped) Start or Remove. Right-click a project heading to create a worktree, start a terminal, or remove the project from the workspace. Right-click a checkout row for its actions too: the main checkout offers removal of the project from the workspace; linked worktrees offer removal of that checkout from disk, retaining the branch. The **MAIN** badge identifies the main checkout, while the adjacent name is its current branch. The heading’s **+** creates a worktree. Shift+F10 opens the same menus from the keyboard; arrows navigate and Escape closes.

**Hide** only removes the pane from view. **Stop** ends its shell and running processes after confirmation. **Start** opens a fresh shell in a stopped or exited session. Removing a worktree refuses dirty checkouts and worktrees with active terminal sessions; removing a project never deletes its files.

Tab moves to the next visible pane; Shift+Tab moves to the previous one, wrapping around. This also works in focused view. Dialogs retain normal Tab navigation.

macOS shortcuts: Cmd+K opens the terminal picker, Cmd+Shift+N creates a terminal, Cmd+B toggles the sidebar, Cmd+Enter focuses a pane, and Cmd+1–9 selects a visible pane. Linux uses Ctrl+Shift for application shortcuts, leaving ordinary Ctrl keys available to the shell.

## Optional teamwork

On **Team canvas**, click **+ Agent** or right-click empty space → **New agent…**.
Choose Claude or Codex and an existing checkout or any other folder, then start.
New folders are added to the workspace automatically; project subfolders are
supported too. Right-click an agent → **New agent in this folder…** to start
another companion nearby. These agents work independently; you can attach them
to a head later. They also appear in the ordinary Terminals view.

Projects can be any local folder. Open a folder and start Claude, Codex, or shell
terminals without initializing Git. Git repositories also discover existing
worktrees; creating worktrees and delegated teams requires Git and a first commit.
If you initialize Git later, the app detects it while keeping the same project
and terminal sessions.

Adding a folder without Git offers **Create Git repository** or **Keep as folder**.
The head picker also lists these projects as **No Git**, with a creation button.
Initialization creates local repository metadata and preserves existing files and
sessions. It does not stage files or make commits; the head can help prepare the
first commit before launching workers in worktrees. Main checkouts are explicitly
labeled in the picker alongside their current branch.

Ask a **Head agent** to work on your Linear tickets and it starts one worker
and terminal per ticket immediately. Discuss scope in its terminal whenever you need to. **Team canvas** shows
heads branching into workers; click a creature to talk, or switch to **Terminals**
to keep your familiar split layout. The head can read worker questions and send
replies while supervising. **Active agents only** shows running Claude and Codex
agents, their worktrees, and any parent worktrees needed for context. Empty
worktrees, stopped agents, and shell-only projects are hidden until you switch
the filter off. Filtering never stops or removes a terminal.

Agent conversations render Markdown headings, lists, emphasis, tables, and code
inside a comfortable reading column. Links and local image previews remain
interactive, and text-size controls also resize the conversation. Your message appears
immediately while delivery is confirmed. Recent conversations stay mounted in a
bounded cache when you switch nodes; returning refreshes them in the background.

Drag the divider beside the canvas to widen a conversation. **Pin** keeps one agent
open while you select a second; drag between the two conversations to resize them.
Double-click either divider to balance it. Connections choose facing node edges
and use dashed lines. Claude’s live process status drives working animations,
separately from a task being ready for review. The creature and rotating activity
caption sit immediately above the input.


Right-click a checkout to **Create child worktree…**, or right-click an agent to **Delegate task…**. Delegation starts Claude or Codex in an independent child checkout with task context. Use **Tasks and inbox** to read messages, reply, follow status, and review completed changes before explicitly integrating them into the parent. Existing agents can opt in using the panel's connection instructions. Messages are persistent and read when agents check their inbox; ordinary terminals and worktrees continue to work independently.

See [the teamwork guide](docs/COORDINATION.md) for the CLI, integration safeguards, and delivery behavior.

For development app replacements while agents are running, follow the
[macOS update procedure](docs/MACOS-UPDATES.md) to preserve sessions without
creating repeated folder permission prompts.

## Running apps

Each terminal shows **Open app** links below its header when a web server is
listening in that terminal or checkout. Links work in both conversation and raw
terminal views, including the Team canvas dock. Click the monitor icon in the
header to show or hide the links, or check whether any app is running.

Detection refreshes every five seconds while panels are visible. It follows
terminal processes and also finds detached background servers by their checkout
folder, keeping sibling worktrees separate. Shared checkout servers are labeled
in the link tooltip. HTTP and HTTPS are detected; local development certificate
hostnames are used when they resolve to loopback. Database ports and unrelated
apps are excluded. Discovery uses macOS’s built-in `lsof` and does not restart
servers or change their configuration.

## Product complaints inbox

Open **Product inbox** in the sidebar, choose Slack channels, and click **Scan now**.
The scanner uses Claude Code and its connected Slack account to search product,
UI/UX, backoffice, portal, KYC, finance, and bug reports. Each finding has a short
source quote and a link to the original Slack message. Search or filter by area,
mark findings reviewed, or dismiss them; overlapping scans preserve that state.
The sidebar shows the number of new findings.

The first scan covers seven days. Later scans overlap the last successful scan by
a day. A scan is bounded to three minutes, 50 findings, and a $1 Claude CLI budget;
partial coverage and connection errors are shown explicitly. Scanning uses your
Claude account usage. Start with named channels for useful coverage; a blank scope
searches accessible channels excluding direct messages. Search-based discovery
cannot guarantee every complaint will be found.

**Scan hourly** is off by default. When enabled, it runs while the app/server is
running, including with the window closed. Quitting the app pauses scans. Settings
and findings are saved privately in `~/.cloovies/complaints.json`. Scans use read
tools with non-interactive permissions, no project settings or hooks, and explicit
Slack write-tool denials. They do not send Slack replies or create tickets.

## Persistence and boundaries

- Project and terminal metadata: `~/.cloovies/workspace.json`, saved atomically.
- Shell processes and history: a dedicated tmux server named `cloovies-workspace`. It does not attach to or kill Orca's or other apps' sessions.
- Visible layout, pane view choices, creatures, unsent message drafts, and terminal font size: the browser/webview's local storage. Native and browser layouts are independent.
- Closing or restarting Cloovies preserves shells. Quitting stops the app’s HTTP
  server, so head coordination tools and scheduled scans resume when the app
  reopens; the underlying agents and terminals keep running. Rebooting the computer ends processes; the saved sessions can then be started again.
- The server listens only on loopback. Workspace requests require a local host and same-origin requests; mutations require JSON.
- The native app uses port 4340. Its log is `~/Library/Logs/Cloovies/workspace.log`. `CLOOVIES_NATIVE_PORT` can select a different native port.
- Tests use separate folders and tmux sockets. For another isolated instance, set both `CLOOVIES_WORKSPACE_DIR` and `CLOOVIES_TMUX_SOCKET`.

See the [Orca comparison and naming ideas](docs/ORCA-COMPARISON.md) for current feature gaps.

## Code and verification

The new implementation lives in `internal/workspace`, `web/src/workspace`, `cmd/workspace`, and `app/workspace.swift`. See [docs/WORKSPACE.md](docs/WORKSPACE.md) for the data model and transport details.

```sh
go test ./...
go test -race ./internal/workspace
python3 scripts/test-workspace-installer.py
cd web
npm ci
npm run build
npm test
npm run test:workspace
npm run test:e2e
npm audit
```

The workspace browser suite runs against real temporary Git repositories and tmux processes. It covers three projects on one canvas, direct terminal input, the message composer, resizing, layout restoration, worktree creation, hide/show, focus, rename, stop/start, reconnects, scrollback, and exited-shell restart. Go integration tests also recreate the server and verify that shell state survives. The retro journey exercises mixed views, creature selection, transcript filtering, thinking/idle states, interactive prompts, view persistence, and compact panes.

The legacy entry points (`cmd/bitwise`, `cmd/clooviesd`) serve the new workspace at `/` and preserve the original agent dashboard at `/legacy.html`. The standalone workspace server intentionally does not run the legacy agent services.

Text controls apply to both views: **A+ / A−**, **⌘+ / ⌘−**, and **⌘0** to reset. Pane changes, sidebar toggles, and project groups animate, respecting reduced-motion preferences. Terminal view retains the CLI’s own ANSI colors and formatting with the workspace background.
