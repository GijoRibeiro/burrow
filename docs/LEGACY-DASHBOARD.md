# bitwise

A retro pixel-art dashboard for [Claude Code](https://claude.com/claude-code). Every agent running on your machine gets a creature, a name, and a level — the more it works, the more it grows. One window, every project, every agent, live.

<p align="center">
  <img src="../web/assets/sprites/Grook-1.png" width="120" alt="Grook, the bitwise mascot" style="image-rendering: pixelated;">
</p>

Built for people who spin up three, five, ten Claude Code agents in parallel and lose track of what's doing what. Also built because watching pixel creatures grind for you is unreasonably satisfying.

---

## Download (macOS, Apple Silicon)

**[⬇ bitwise.app — latest release](https://github.com/GijoRibeiro/bitwise/releases/latest/download/bitwise-macos.zip)** · ~5 MB · arm64

Unzip and move it to `/Applications` (or wherever). Because bitwise isn't signed with a paid Apple Developer ID, macOS blocks the first launch — you only have to clear it once:

1. **Try right-click → Open** on `bitwise.app`. If a dialog offers an **Open** button, click it. Done.
2. **If there's no Open button** (macOS Ventura and later usually just says *“bitwise.app” was blocked to protect your Mac* and won't open), go to **System Settings → Privacy & Security**, scroll down to the **Security** section, and click **Open Anyway** next to the bitwise message. Confirm with Touch ID / your password.

After that first time, double-click works normally.

<details>
<summary>“bitwise is damaged and can't be opened”</summary>

That's Gatekeeper's weirder failure mode when your browser quarantines the download. One Terminal command fixes it:

```bash
xattr -cr /Applications/bitwise.app
```

Do this once, then open it normally.
</details>

<details>
<summary>Why the warning, and how to make it go away for good</summary>

bitwise is **ad-hoc signed** (free, no Apple account), which is why Gatekeeper nags. There's no way to skip the prompt for an ad-hoc build — the steps above are the intended escape hatch.

To ship a build that opens with **no warning at all**, it has to be **notarized**, which requires:

1. An **Apple Developer Program** membership ($99/year) and a **Developer ID Application** certificate.
2. Signing with that certificate instead of the ad-hoc `-` identity.
3. Submitting the zipped app to Apple with `xcrun notarytool submit … --wait`, then stapling the ticket with `xcrun stapler staple bitwise.app`.

Once notarized + stapled, end users just double-click — no right-click, no Privacy & Security trip. Until then, the one-time **Open Anyway** is expected.
</details>

---

## Before you install — the three things bitwise needs

bitwise is a dashboard. It doesn't run Claude itself; it watches Claude and drives terminals on your behalf. So you need the tools it watches and drives.

### 1. Claude Code

bitwise reads agents from `~/.claude/sessions/` — you need Claude Code installed and to have run it at least once.

```bash
curl -fsSL https://claude.ai/install.sh | sh
```

Then run `claude` once in any project to sign in. Verify:

```bash
claude --version
```

### 2. tmux

bitwise uses tmux to start, attach to, and send chat messages to agents. Your agents live in tmux sessions; bitwise just drives them. This is also why closing the bitwise window doesn't kill your agents — they keep running in tmux.

```bash
brew install tmux
```

No Homebrew? Grab it at [brew.sh](https://brew.sh) — one-line install.

### 3. git

Almost certainly already there. bitwise reads branch names and commit counts per repo to track XP.

```bash
git --version
```

If macOS says "command not found," it'll prompt you to install Xcode Command Line Tools. Say yes, done.

---

## What you can do with it

### Your agents, all in one place
Claude Code writes session files as agents work. bitwise scans `~/.claude/sessions/` every few seconds and shows you every active agent across every project — task name, elapsed time, git branch, thinking spinner, recent commits. No config, no signup.

### Spawn new agents from the `+` button
Click `+` in the top bar, pick a folder (or pick from **Recent Folders**), and bitwise starts a tmux session running `claude` in it. Two toggles live in the same dropdown:

- **terminal** — also open the tmux session in a real terminal window (Terminal.app or iTerm, configurable in settings). Off by default: the agent runs headless in tmux, you chat through bitwise. Turn it on when you want a proper REPL window too.
- **yolo** — spawn with `--dangerously-skip-permissions`. Claude won't pause to ask you about each tool use. Fast but, well, yolo.

### Chat with any agent
Click an agent's card to select it, then type in the input bar. Your message goes straight into the agent's Claude prompt via `tmux send-keys` — no copy-paste, no broken pastes, no terminal focus-stealing. You can send images too: paste with Cmd+V or drag them in.

You can also press **Tab** to cycle through agents mid-typing — handy when you realize you're about to send the wrong message to the wrong agent.

### Boss mode (no agent selected)
Type something without an agent selected and you're talking to **Boss** — bitwise's built-in router. Boss can forward your message to the right agent, answer "what is X working on right now?", or help you plan the next move across your whole fleet.

### Attach to any agent's terminal
Hover an agent card and you'll see a small terminal icon — click it to open the tmux session in your preferred terminal app. Now you've got the full Claude Code REPL for that agent if you need it.

### Stop an agent
Hover a card and you'll also see an `×`. Click it once to arm, click again to kill. This sends SIGINT first and kills the tmux session after a grace period.

### Rename + pick creatures
Click an agent card to open the picker. Pick a creature, give it a name. The name and creature persist in `~/.cloovies/agents.json` so they stick across sessions.

### Level up
Every agent earns XP from total commits in its repo plus time worked (2 XP/hour) plus any bonus you toss in with `/xp`. Levels curve: 0 → 5 → 15 → 30 → 50 → 80 → … each level needs 50 more XP than the last. Color tiers go **white → gold → orange → red**.

---

## Slash commands

Type `/` in the chat input to open the autocomplete menu.

### Built-in (run inside bitwise)

| Command | What it does |
|---|---|
| `/help` | List every command |
| `/status` | Show agent state as JSON |
| `/clear` | Clear the chat log |
| `/debug` | Toggle the debug log panel |
| `/editor` | Open the sprite editor in-window |
| `/exit` | Close the app window |
| `/xp <name> <amount>` | Hand an agent some bonus XP |
| `/utku` | Summon the office critic (he has opinions) |
| `/rebuild` | Rebuild + relaunch bitwise.app (needs the source repo — dev only) |

### Forwarded to the selected agent (Claude Code commands)

Select an agent first (click, or Tab), then:

| Command | What it does |
|---|---|
| `/brainstorming` | Start a brainstorming session |
| `/btw` | “by the way…” — interrupt with a side note |
| `/compact` | Compact the conversation to save context |
| `/effort` | Set effort: `low` / `medium` / `high` / `auto` |
| `/model` | Switch Claude model |
| `/plan` | Enter plan mode |
| `/resume` | Resume the last session |
| `/review` | Trigger a code review |

Anything that isn't a known command gets sent to the agent as a regular chat message.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Tab` | Cycle through agents (even while typing) |
| `Shift+Tab` | Cycle backwards |
| `Enter` | Send |
| `Shift+Enter` | Newline in the chat input |
| `Esc` | Cancel Boss, clear selection, clear input |
| `↑` / `↓` | Browse input history (like a terminal) |
| `Cmd+V` | Paste text or images |

---

## Toggles worth knowing about

Top-right of the window, hidden behind a hover-fade:

- **solo** — fade all other agent cards when one is selected, so you can focus.
- **verbose** — show thinking, tool calls, and tool results inline in the chat. Great for "what is this thing actually *doing*?"
- **font +/−** — chat font size.
- **zoom +/−** — scales the whole UI.
- **grid position ▼/▲** — park the agent grid at the top or bottom of the window.

Settings (the gear icon) lets you pick your preferred terminal app for the "terminal" spawn toggle and the attach-terminal button (Terminal.app or iTerm).

---

## Build from source

If you want to hack on bitwise or build it yourself.

### Quick install (CLI on any Mac)

```bash
git clone https://github.com/GijoRibeiro/bitwise.git
cd bitwise
make install     # builds + drops bin into ~/.local/bin
bitwise          # start it
```

`make install` checks for its build deps (**go 1.26+**, **node 20+**), builds the web UI, and drops the `bitwise` binary in `~/.local/bin`. If that directory isn't on your `$PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to your `~/.zshrc` and restart your shell. On first launch, bitwise creates `~/.claude/{sessions,projects,tasks}` if Claude Code hasn't yet, so you won't sit on a blank dashboard wondering why.

### Native macOS app

```bash
make build       # builds bin/bitwise + build/macos/bitwise.app
make app         # launches the assembled .app
```

This needs **Xcode Command Line Tools** on top of the quick-install deps (for `swiftc` + `iconutil`).

### Useful make targets

| Target | What it does |
|---|---|
| `make install` | Build CLI + drop in `~/.local/bin` (the friendly path) |
| `make build` | Go binary + macOS `.app` |
| `make build-bitwise` | Just the Go binary (`bin/bitwise`) — embeds the web UI |
| `make build-app` | Just the macOS `.app` (`build/macos/`) |
| `make rebuild` | Quit running app, rebuild, relaunch |
| `make daemon` + `make web` | Dev loop: Go backend + Vite on `:5173`, then `bitwise --dev` to connect |
| `make test` | `go test ./...` + `tsc --noEmit` |
| `make package` | Zip the `.app` into `build/release/bitwise-macos.zip` |
| `make release VERSION=vX.Y.Z` | Cut a GitHub release with the zipped `.app` |

---

## How it's wired (the technical bit)

```
~/.claude/sessions/                  Claude Code writes session files here
         │
         ▼
┌────────────────────────────────┐
│ Go scanner (every ~3s)         │   internal/scanner
│   reads session + task files   │
│   reads git stats per repo     │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│ Thread-safe registry           │   internal/registry
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│ HTTP + WebSocket server        │   internal/server (Go)
│   /ws  broadcasts agent state  │
│   /api/*  rebuild, profiles… │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│ TypeScript + Canvas frontend   │   web/src
│   vanilla TS, Vite, no framework│
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│ Swift WKWebView wrapper        │   app/main.swift
│   bundles daemon + UI in .app  │
└────────────────────────────────┘

         │  chat input
         ▼
┌────────────────────────────────┐
│ tmux send-keys to agent pane   │   internal/chat
│   (the only reliable way to    │
│    drive Claude Code remotely) │
└────────────────────────────────┘
```

**Why tmux?** Earlier iterations tried AppleScript into Terminal.app. It was flaky — paste buffers got mangled, bracketed-paste wrapped messages in `[200~…~`, the agent would see garbage. `tmux send-keys` writes straight to the PTY, so whatever you type in bitwise lands in Claude byte-for-byte.

**Why embed the web UI in the Go binary?** Single-file distribution. `go:embed web/dist` means shipping is one binary plus the Swift wrapper — no PATH dependencies, no Node at runtime, no separate web server to babysit.

### Project layout

```
cmd/
  bitwise/           ← single-binary entry point (daemon + embedded web)
  clooviesd/         ← legacy standalone daemon (dev convenience)
  cloovies/          ← legacy TUI client (parked)
internal/            ← Go backend (scanner, registry, server, boss, chat, …)
web/
  src/               ← TypeScript frontend (vanilla TS + Canvas)
  assets/sprites/    ← creature sprites (15×15 PNG, 2-frame anim)
  public/favicon.png ← generated from the Grook sprite
app/
  main.swift         ← macOS WebKit wrapper (the .app)
packaging/
  macos/
    Info.plist       ← .app bundle manifest
    icon/            ← icon generator + README
build/               ← all generated output (gitignored)
  macos/bitwise.app  ← assembled by `make build-app`
  release/           ← zipped artifacts from `make package`
```

---

## License

TBD.
