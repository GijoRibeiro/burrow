import { api } from "./api";
import { button, el } from "./dom";
import { creature } from "./creature";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalTheme } from "./theme";

type ToolName = "git" | "tmux" | "claude" | "codex" | "gh";
type ToolStatus = {
  installed: boolean;
  path?: string;
  version?: string;
  required: boolean;
  label: string;
  purpose: string;
};
type SetupStatus = {
  platform: string;
  ready: boolean;
  git: boolean;
  tmux: boolean;
  claude: boolean;
  codex: boolean;
  gh?: boolean;
  homebrew?: boolean;
  installer?: boolean;
  tools?: Partial<Record<ToolName, ToolStatus>>;
};
type InstallChoice = "required" | "claude" | "codex" | "github" | "assist";
type NativeBridge<T> = { postMessage(value: unknown): Promise<T> };
export function nativeHandler<T = string>(
  name: string,
): NativeBridge<T> | undefined {
  return (
    window as unknown as {
      webkit?: { messageHandlers?: Record<string, NativeBridge<T>> };
    }
  ).webkit?.messageHandlers?.[name];
}

const TOOLS: [ToolName, string, string, boolean][] = [
  ["git", "Git", "Projects, branches and worktrees", true],
  ["tmux", "tmux", "Keeps terminals running when you close the app", true],
  ["claude", "Claude Code", "Optional agent · sign in on first launch", false],
  ["codex", "Codex", "Optional agent · sign in on first launch", false],
  [
    "gh",
    "GitHub CLI",
    "Optional · clone repositories and show PR links",
    false,
  ],
];
const CHOICE: Record<ToolName, InstallChoice | undefined> = {
  git: "required",
  tmux: "required",
  claude: "claude",
  codex: "codex",
  gh: "github",
};
// Shown when nothing can run the installer for the user (Linux, or a browser
// pointed at a server without the bundled script).
const MANUAL: Record<InstallChoice, string> = {
  required: "brew install git tmux",
  claude: "brew install --cask claude-code",
  codex: "brew install --cask codex",
  github: "brew install gh && gh auth login --web",
  assist: "",
};

// The installer runs on a real PTY inside the dialog so Homebrew's password
// prompt, progress bars and errors are visible without leaving the app.
class SetupConsole {
  readonly element = el("section", "setup-console");
  private host = el("div", "setup-console-host");
  private title = el("div", "setup-console-title");
  private terminal: Terminal;
  private fit = new FitAddon();
  private socket?: WebSocket;
  private observer: ResizeObserver;
  constructor(private onExit: (code: number) => void) {
    this.element.hidden = true;
    this.element.setAttribute("aria-label", "Installer output");
    this.element.append(this.title, this.host);
    this.terminal = new Terminal({
      fontSize: 12,
      fontFamily: '"Google Sans Code", monospace',
      lineHeight: 1.25,
      scrollback: 5000,
      convertEol: false,
      theme: terminalTheme(),
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.host);
    this.terminal.onData((data) => {
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({ type: "input", data }));
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
  }
  get running(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  private resize(): void {
    if (!this.host.clientWidth || !this.host.clientHeight) return;
    this.fit.fit();
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({
          type: "resize",
          cols: this.terminal.cols,
          rows: this.terminal.rows,
        }),
      );
  }
  start(choice: InstallChoice, label: string): void {
    this.element.hidden = false;
    this.title.textContent = `${label} · running`;
    this.terminal.reset();
    requestAnimationFrame(() => this.resize());
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${scheme}//${location.host}/api/workspace/setup/install?tool=${choice}&cols=${this.terminal.cols}&rows=${this.terminal.rows}`,
    );
    ws.binaryType = "arraybuffer";
    this.socket = ws;
    let exited = false;
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.terminal.write(new Uint8Array(event.data));
        return;
      }
      try {
        const frame = JSON.parse(event.data as string) as {
          type?: string;
          code?: number;
        };
        if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        if (frame.type === "exit") {
          exited = true;
          const code = frame.code ?? -1;
          this.title.textContent =
            code === 0
              ? `${label} · finished`
              : `${label} · stopped with exit code ${code}`;
          this.onExit(code);
        }
      } catch {
        /* Not a control frame. */
      }
    };
    ws.onclose = () => {
      if (!exited) {
        this.title.textContent = `${label} · connection closed`;
        this.onExit(-1);
      }
    };
    ws.onerror = () => ws.close();
    this.terminal.focus();
  }
  dispose(): void {
    this.observer.disconnect();
    this.socket?.close();
    this.terminal.dispose();
  }
}

export function setupDialog(): void {
  if (document.querySelector(".setup-dialog")) return;
  const d = el("dialog", "dialog setup-dialog");
  d.setAttribute("aria-label", "Workspace setup");
  const heading = el("div", "setup-heading");
  heading.append(creature("Grook"), el("h2", "", "Meet your workspace."));
  const intro = el(
    "p",
    "dialog-description",
    "A home for your projects and terminal companions. Here is what this Mac has and what is still missing.",
  );
  const status = el("div", "setup-checks");
  const note = el("p", "history-note", "Checking installed tools…");
  note.setAttribute("role", "status");
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  const manual = el("div", "setup-manual");
  manual.hidden = true;
  let loading = false,
    signature = "",
    latest: SetupStatus | undefined;
  const console_ = new SetupConsole((code) => {
    note.textContent =
      code === 0
        ? "Installation finished. Checking the tools again…"
        : "The installer stopped before finishing. Read its output above, then try again or ask Claude for help.";
    signature = "";
    void check();
  });
  const showManual = (choice: InstallChoice) => {
    const command = MANUAL[choice];
    manual.replaceChildren(
      el(
        "p",
        "",
        "Run this in any terminal, then come back; the list updates by itself.",
      ),
      el("code", "", command),
      button(
        "Copy command",
        () => void navigator.clipboard?.writeText(command).catch(() => {}),
        "secondary",
        "Copy",
      ),
    );
    manual.hidden = false;
  };
  const install = async (choice: InstallChoice, label: string) => {
    error.textContent = "";
    manual.hidden = true;
    try {
      if (latest?.installer) {
        if (console_.running)
          throw new Error("Wait for the current installation to finish.");
        note.textContent =
          "Installing here. Homebrew or macOS may ask for your password in the output below; type it there.";
        console_.start(choice, label);
        return;
      }
      const bridge = nativeHandler("installTools");
      if (bridge && choice !== "assist") {
        await bridge.postMessage(choice);
        note.textContent =
          "Finish installation in the new Terminal window. Setup will detect the tools here automatically. macOS or Homebrew may ask for your password.";
        return;
      }
      if (choice === "assist")
        throw new Error("Claude assistance needs the bundled installer.");
      showManual(choice);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  const done = button(
    "Start using the workspace",
    () => {
      localStorage.setItem("cloovies.workspace.onboarded.v1", "yes");
      d.close();
    },
    "primary",
  );
  done.disabled = true;
  const check = async () => {
    if (loading) return;
    loading = true;
    try {
      const value = await api<SetupStatus>("/setup");
      if (!d.open) return;
      latest = value;
      done.disabled = !value.ready;
      const next = JSON.stringify(value);
      if (next === signature) return;
      signature = next;
      status.replaceChildren();
      const canInstall = !!value.installer || !!nativeHandler("installTools");
      for (const [tool, fallbackLabel, fallbackPurpose, required] of TOOLS) {
        const detail = value.tools?.[tool];
        const installed = detail ? detail.installed : !!value[tool];
        const label = detail?.label || fallbackLabel;
        const row = el("div", "setup-check");
        row.dataset.tool = tool;
        row.dataset.installed = String(installed);
        const info = el("div");
        info.append(
          el("strong", "", label),
          el("p", "", detail?.purpose || fallbackPurpose),
        );
        const state = el(
          "span",
          installed ? "setup-installed" : "setup-missing",
          installed
            ? detail?.version
              ? `Installed · ${detail.version}`
              : "Installed"
            : required
              ? "Missing · required"
              : "Not installed",
        );
        if (detail?.path) state.title = detail.path;
        row.append(info, state);
        const choice = CHOICE[tool];
        if (!installed && choice && (!required || !canInstall))
          row.append(
            button(
              `Install ${label}`,
              () => void install(choice, `Install ${label}`),
              "secondary",
              "Install",
            ),
          );
        status.append(row);
      }
      if (!value.ready) {
        const actions = el("div", "setup-actions");
        if (canInstall)
          actions.append(
            button(
              "Install required tools",
              () => void install("required", "Install Git and tmux"),
              "primary",
            ),
          );
        if (value.installer && value.claude)
          actions.append(
            button(
              "Ask Claude to set this up",
              () => void install("assist", "Claude setup assistant"),
              "secondary",
            ),
          );
        if (value.installer && nativeHandler("installTools"))
          actions.append(
            button(
              "Open installer in Terminal",
              () => {
                latest = { ...value, installer: false };
                void install("required", "Install Git and tmux");
                latest = value;
              },
              "secondary",
              "Use Terminal app instead",
            ),
          );
        actions.append(
          button(
            "Show manual command",
            () => showManual("required"),
            "secondary",
            "Manual command",
          ),
        );
        status.append(actions);
      }
      if (
        value.ready &&
        value.platform === "darwin" &&
        value.homebrew === false
      )
        note.textContent =
          "Ready. Homebrew is not installed; optional tools can still be added with the installer, which sets Homebrew up first.";
      else
        note.textContent = value.ready
          ? "Ready. Add a project, create a terminal, and choose Claude, Codex, or a shell. Agents use your own accounts and start in YOLO mode with broad access to your files and commands."
          : value.installer
            ? "Install runs here inside the app: Homebrew first if needed, then Git and tmux. Homebrew may also install Apple’s Command Line Tools."
            : value.platform === "darwin"
              ? "Setup installs Homebrew if needed, then Git and tmux. The app is already bundled."
              : "Install Git and tmux using your system’s package manager, then check again.";
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  };
  const actions = el("div", "dialog-actions");
  actions.append(
    button("Close setup", () => d.close(), "secondary", "Later"),
    button("Check again", () => void check(), "secondary"),
    done,
  );
  d.append(
    heading,
    intro,
    status,
    console_.element,
    manual,
    note,
    error,
    actions,
  );
  document.body.append(d);
  d.showModal();
  void check();
  const poll = setInterval(check, 2500);
  d.addEventListener("close", () => {
    clearInterval(poll);
    console_.dispose();
    d.remove();
  });
}
