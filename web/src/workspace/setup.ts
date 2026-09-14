import { api } from "./api";
import { button, el } from "./dom";
import { creature } from "./creature";

type SetupStatus = {
  platform: string;
  ready: boolean;
  git: boolean;
  tmux: boolean;
  claude: boolean;
  codex: boolean;
};
type NativeBridge = { postMessage(value: unknown): Promise<string> };
export function nativeHandler(name: string): NativeBridge | undefined {
  return (
    window as unknown as {
      webkit?: { messageHandlers?: Record<string, NativeBridge> };
    }
  ).webkit?.messageHandlers?.[name];
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
    "A home for your projects and terminal companions. Let’s get this Mac ready.",
  );
  const status = el("div", "setup-checks");
  const note = el("p", "history-note", "Checking installed tools…");
  note.setAttribute("role", "status");
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  let loading = false,
    signature = "";
  const install = async (tool: string) => {
    error.textContent = "";
    try {
      const bridge = nativeHandler("installTools");
      if (!bridge)
        throw new Error("Open the native macOS app to use automatic setup.");
      await bridge.postMessage(tool);
      note.textContent =
        "Finish installation in the new Terminal window. Setup will detect the tools here automatically. macOS or Homebrew may ask for your password.";
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
      done.disabled = !value.ready;
      const next = JSON.stringify(value);
      if (next === signature) return;
      signature = next;
      status.replaceChildren();
      for (const [tool, label, description] of [
        ["git", "Git", "Projects and branches"],
        ["tmux", "tmux", "Keeps terminals running when you close the app"],
        [
          "claude",
          "Claude Code",
          "Optional · sign in when you first launch Claude",
        ],
        ["codex", "Codex", "Optional · sign in when you first launch Codex"],
      ] as const) {
        const row = el("div", "setup-check");
        const info = el("div");
        info.append(el("strong", "", label), el("p", "", description));
        row.append(
          info,
          el(
            "span",
            value[tool] ? "setup-installed" : "setup-missing",
            value[tool] ? "Installed" : "Not installed",
          ),
        );
        if (
          !value[tool] &&
          (tool === "claude" || tool === "codex") &&
          nativeHandler("installTools")
        )
          row.append(
            button(
              `Install ${label}`,
              () => void install(tool),
              "secondary",
              "Install",
            ),
          );
        status.append(row);
      }
      if (!value.ready) {
        if (nativeHandler("installTools"))
          status.append(
            button(
              "Install required tools",
              () => void install("required"),
              "primary",
            ),
          );
        else
          status.append(
            el(
              "p",
              "history-note",
              value.platform === "darwin"
                ? "Install Git and tmux with Homebrew: brew install git tmux. The macOS app can run setup for you."
                : "Install Git and tmux using your system’s package manager, then check again.",
            ),
          );
      }
      note.textContent = value.ready
        ? "Ready. Add a Git project, create a terminal, and choose Claude, Codex, or a shell. Agents use your own accounts and start in YOLO mode with broad access to your files and commands."
        : "Setup installs Homebrew if needed, then Git and tmux. The app is already bundled. Homebrew may also install Apple’s Command Line Tools.";
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
  d.append(heading, intro, status, note, error, actions);
  document.body.append(d);
  d.showModal();
  void check();
  const poll = setInterval(check, 2500);
  d.addEventListener("close", () => {
    clearInterval(poll);
    d.remove();
  });
}
