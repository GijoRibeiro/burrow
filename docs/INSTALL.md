# Install Cloovies (Burrow working name)

This package contains the app, its local server, fonts, and first-run installer. It supports Apple Silicon and Intel Macs running macOS 13 or later. Windows and Linux do not have a native app package yet; the browser workspace can be built from source.

## Install

1. Unzip `Cloovies-mac-universal.zip` (also published as `Cloovies-<version>-mac-universal.zip`).
2. Move `Cloovies.app` into Applications and open it.
3. This preview build is ad-hoc signed, not Apple-notarized. If macOS blocks it and you trust this download, follow Apple's first-open procedure in **System Settings → Privacy & Security → Open Anyway**. Managed Macs may require your administrator. [Apple's instructions](https://support.apple.com/en-us/102445).
4. On first launch the app detects which tools are present (Git, tmux, Claude Code, Codex, GitHub CLI) and offers to install the missing ones. **Install required tools** opens a Terminal window that installs Apple's Command Line Tools and Homebrew if needed, then Git and tmux. It may ask for your Mac password and can take several minutes; it ends with a status table for every tool. Return to the app afterwards; it detects installed tools automatically.
5. Optionally install Claude Code or Codex from setup, then choose **Start using the workspace**. You can also use a plain shell.
6. Add any project folder, create a terminal, and choose your agent. Sign into your own Claude or Codex account in Terminal view on first launch.

**Agents run in bypass-permissions mode** (Claude Code `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`): they can read, write, and run commands in the project folder without asking. Only open folders you trust, and keep secrets out of them.

## Using the workspace

- Git is only needed for worktrees and delegated teams. When adding a folder without Git, choose **Create Git repository** or **Keep as folder**; this initializes Git locally without staging, committing, or publishing anything.
- **Add project → GitHub repository** clones through your own GitHub CLI account; **Connect GitHub** guides the installation and browser sign-in. The app never asks for a token or stores one. In the browser edition, run `gh auth login --hostname github.com --git-protocol https --web` and click **Refresh**.
- **Team canvas → + Agent** (or right-click empty canvas space) creates an agent directly; a head agent or Git repository is not required. **+ → From Linear** creates a worktree from a Linear ticket with your own personal API key. Linear is optional.
- Reopen **Setup and tools** from the sidebar. **⌘W** closes the window, **⌘M** minimizes, **⌘Q** quits, **⌃⌘F** is full screen. Drag the app's wordmark or empty toolbar area to move the window.
- **Cloovies → About Cloovies** shows the app and server versions; **Cloovies → Reveal Logs** opens `~/Library/Logs/Cloovies/workspace.log`.

Quitting the app stops only its local server. Terminals and agents keep running inside tmux and reappear on the next launch. If the local server stops unexpectedly, the app restarts it; if that keeps failing, it shows the log location.

## Privacy and requirements

No projects, conversations, credentials, or terminal sessions from the developer's computer are included. Data is stored locally in your home folder; CLI accounts are managed by their providers. An internet connection is needed for installing tools and using agents, GitHub, or Linear. The app does not bypass administrator restrictions, install your project's own dependencies, or provide paid agent subscriptions.

If installation fails, read the error in the installer Terminal window, correct it, and use **Check again** or retry **Install**.

## Uninstall

1. Quit Cloovies and move `Cloovies.app` to the Trash.
2. Stop the terminals it created: `tmux -L cloovies-workspace kill-server`
3. Remove its data: `rm -rf ~/.cloovies` (projects list and settings; your project folders are untouched) and optionally `~/Library/Logs/Cloovies`.

Git, tmux, Homebrew, and the agent CLIs stay installed; remove them with `brew uninstall` if you no longer want them.

Installer sources: [Homebrew](https://docs.brew.sh/Installation), [tmux](https://formulae.brew.sh/formula/tmux), [Claude Code](https://formulae.brew.sh/cask/claude-code), [Codex](https://formulae.brew.sh/cask/codex). Provider sign-in: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).
