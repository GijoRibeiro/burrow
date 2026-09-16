# Install Cloovies (Burrow working name)

This package contains the app, its local server, fonts, and first-run installer. It supports Apple Silicon and Intel Macs running macOS 13 or later. Windows and Linux do not have a native app package yet; the browser workspace can be built from source.

1. Unzip `Cloovies-mac-universal.zip`.
2. Move `Cloovies.app` into Applications and open it.
3. This preview build is ad-hoc signed, not Apple-notarized. If macOS blocks it and you trust this download, follow Apple's first-open procedure in **System Settings → Privacy & Security → Open Anyway**. Managed Macs may require your administrator. [Apple's instructions](https://support.apple.com/en-us/102445).
4. First-run setup checks Git and tmux. Click **Install required tools** if needed. A separate Terminal window runs Homebrew's installer (if missing), then installs the required packages. Installation may request your Mac password or Apple's Command Line Tools. Return to the app when it finishes; setup detects installed tools automatically.
5. Optionally install Claude Code or Codex from setup, then choose **Start using the workspace**. You can also use a plain shell.
6. Add any project folder, create a terminal, and choose your agent. Git is only needed for worktrees and delegated teams. Sign into your own Claude or Codex account in Terminal view on first launch. Agents start in YOLO mode, allowing broad file and command access; use trusted project folders.
7. To create a worktree from Linear, choose **+ → From Linear**, connect your own personal API key, and select a ticket. Linear is optional.

To start from GitHub, choose **Add project → GitHub repository**. The app uses
your active GitHub CLI account, or **Connect GitHub** opens a guided installation
and browser sign-in. Search your personal and organization repositories, select
one, and choose the parent folder and a new folder name. **Clone and open** adds
the checkout to your workspace. Existing folders are never overwritten. Cancel
stops the clone; closing the app cancels unfinished clones while existing agent
terminals keep running. GitHub CLI manages your credentials; the app does not
ask for a token or store a copy. In the browser edition, run
`gh auth login --hostname github.com --git-protocol https --web` and click
**Refresh**. See [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login).

To create an agent directly, choose **Team canvas → + Agent**, or right-click
empty canvas space. Select Claude or Codex, choose a folder, and start. A head
agent or Git repository is not required.

You can reopen **Setup and tools** from the sidebar. Use **⌘W** to close the window, **⌘M** to minimize, **⌘Q** to quit, and **⌃⌘F** for full screen. Drag the app's wordmark or empty toolbar area to move the window.

No projects, conversations, credentials, or terminal sessions from the developer's computer are included. Data is stored locally in your home folder; CLI accounts are managed by their providers. An internet connection is needed for installing tools and using agents or Linear. Git and tmux remain installed when the app is removed.

If installation fails, read the error in the installer Terminal window, correct it, and use **Check again** or retry **Install**. The app does not bypass administrator restrictions, install your project's own dependencies, or provide paid agent subscriptions.

Installer sources: [Homebrew](https://docs.brew.sh/Installation), [tmux](https://formulae.brew.sh/formula/tmux), [Claude Code](https://formulae.brew.sh/cask/claude-code), [Codex](https://formulae.brew.sh/cask/codex). Provider sign-in: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).
