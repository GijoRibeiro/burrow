import { el, button } from "./dom";
import { imagePreviews } from "./image-previews";
import { creature } from "./creature";
import claudeIcon from "../../assets/brands/claude.svg";
import codexIcon from "../../assets/brands/openai.svg";

export interface Activity {
  processStatus?: string;
  kind: "shell" | "claude" | "codex";
  canMessage: boolean;
  status:
    "ready" | "working" | "unavailable" | "starting" | "stopped" | "exited";
  messages: { id: string; role: string; text: string }[];
  tools: number;
  tool?: string;
  truncated: boolean;
}
// Read the terminal's rendered text, never try to strip ANSI escape sequences
// from a stream. xterm remains the source of truth for arbitrary CLI programs.
export class AgentView {
  readonly element = el("div", "agent-view");
  readonly heading = el("div", "agent-heading");
  private avatar = el("div", "agent-avatar");
  private label = el("span", "agent-status-label", "Ready");
  private detail = el("span", "agent-detail", "Shell · live output");
  private content = el("div", "agent-content");
  private notice = button(
    "Open terminal to respond",
    () => this.openTerminal(),
    "terminal-notice",
    "Input needed · Open terminal →",
  );
  private error = el("p", "agent-error");
  private launching = false;
  private progressKey = "";
  private progressAt = Date.now();
  private wasWorking = false;
  private interruptButton: HTMLButtonElement;
  private activity?: Activity;
  private screen = "";
  private visibleScreen = "";
  private connection = "Connecting";
  private signature = "";
  private statusText = "";
  private name: string;
  constructor(
    name: string,
    private terminalId: string,
    private openTerminal: () => void,
    private startAgent: (program: "claude" | "codex") => Promise<void>,
    interrupt: () => void,
  ) {
    this.name = name;
    this.interruptButton = button(
      "Interrupt current response",
      interrupt,
      "terminal-notice",
      "Interrupt response",
    );
    this.interruptButton.hidden = true;
    const info = el("div", "agent-info");
    const status = el("div", "agent-status");
    status.setAttribute("role", "status");
    status.append(el("span", "thinking-star"), this.label);
    info.append(status, this.detail);
    this.heading.append(this.avatar, info);
    this.notice.hidden = true;
    this.content.tabIndex = 0;
    this.content.setAttribute("aria-label", "Agent conversation and output");
    this.error.setAttribute("role", "alert");
    this.element.append(
      this.notice,
      this.interruptButton,
      this.error,
      this.content,
    );
    this.setCreature(name);
  }
  showError(text: string): void {
    this.error.textContent = text;
  }
  setCreature(name: string): void {
    this.name = name;
    this.avatar.replaceChildren(creature(name));
  }
  setActivity(activity: Activity): void {
    this.activity = activity;
    this.render();
  }
  setConnection(value: string): void {
    this.connection = value;
    this.render();
  }
  setScreen(screen: string, visible: string): void {
    this.screen = screen;
    this.visibleScreen = visible;
    this.render();
  }
  unavailable(): void {
    this.activity = undefined;
    this.render();
  }
  private render(): void {
    const a = this.activity;
    const live = this.connection === "Live";
    const attention =
      live &&
      /(?:Do you want to (?:proceed|allow)|Allow (?:once|always)|Enter to (?:confirm|select)|Yes,? (?:allow|proceed)|trust this (?:folder|directory)|needs your (?:approval|permission))/i.test(
        this.visibleScreen,
      );
    const working =
      live &&
      !attention &&
      a?.processStatus !== "idle" &&
      (a?.status === "working" ||
        /(?:esc to interrupt)/i.test(this.visibleScreen));
    this.element.classList.toggle("is-thinking", working);
    this.heading.classList.toggle("is-thinking", working);
    this.element.classList.toggle("needs-attention", attention);
    this.heading.classList.toggle("needs-attention", attention);
    const progressKey = JSON.stringify([a?.messages, a?.tools, a?.tool]);
    if (!working || !this.wasWorking || progressKey !== this.progressKey)
      this.progressAt = Date.now();
    this.progressKey = progressKey;
    this.wasWorking = working;
    const stalled = working && Date.now() - this.progressAt >= 60_000;
    const providerError =
      live &&
      /(?:API Error|rate limit|overloaded|retrying|connection error|authentication failed|timed out)/i.test(
        this.visibleScreen,
      );
    this.notice.hidden = !attention && !stalled && !providerError;
    this.notice.textContent = attention
      ? "Input needed · Open terminal →"
      : providerError
        ? "Provider needs attention · Open terminal →"
        : "No new progress for a minute · Open terminal →";
    this.interruptButton.hidden = !stalled;
    const label = !live
      ? this.connection
      : attention
        ? "Your move"
        : working
          ? "thinking..."
          : a?.kind === "codex"
            ? "Codex · Terminal ready"
            : a?.kind === "claude"
              ? a.canMessage
                ? "Ready when you are"
                : "Finish setup in Terminal"
              : a
                ? "No agent running"
                : "Checking for an agent…";
    if (label !== this.statusText) {
      this.label.textContent = label;
      this.statusText = label;
    }
    this.detail.textContent =
      a?.kind === "claude"
        ? `${this.name} · Claude${working && a.tool ? ` · ${a.tool}` : ""}${a.tools ? ` · ${a.tools} tool calls` : ""}`
        : `${this.name} · ${a?.kind === "codex" ? "Codex" : "Shell"}`;
    const conversation = a?.kind === "claude" && a.messages.length > 0;
    const key = JSON.stringify(
      conversation
        ? [a.messages, a.truncated]
        : [this.screen, a?.kind, a?.status, live],
    );
    if (key === this.signature) return;
    this.signature = key;
    const follow =
      this.content.scrollHeight -
        this.content.scrollTop -
        this.content.clientHeight <
      60;
    const scroll = this.content.scrollTop;
    const nodes: HTMLElement[] = [];
    if (conversation) {
      if (a.truncated)
        nodes.push(
          el(
            "p",
            "history-note",
            "Recent conversation · earlier history is in the terminal",
          ),
        );
      for (const message of a.messages) {
        const item = el("article", `conversation-message ${message.role}`);
        item.append(
          el(
            "span",
            "message-role",
            message.role === "user" ? "YOU" : "CLAUDE",
          ),
        );
        // Safe text rendering. Fenced code gets its own selectable block.
        const parts = message.text.split(/```[^\n]*\n([\s\S]*?)```/g);
        for (const [i, text] of parts.entries())
          if (text)
            item.append(
              el(
                i % 2 ? "pre" : "p",
                i % 2 ? "message-code" : "message-text",
                text.trim(),
              ),
            );
        const previews = imagePreviews(this.terminalId, message.text);
        if (previews) item.append(previews);
        nodes.push(item);
      }
    } else if (a?.kind === "codex") {
      nodes.push(
        el(
          "p",
          "history-note",
          "Codex runs in Terminal. Open it to send prompts, use slash commands, and see its full output.",
        ),
      );
      nodes.push(button("Open Codex terminal", this.openTerminal, "secondary"));
      if (this.screen.trim())
        nodes.push(el("pre", "quiet-output", this.screen.trim()));
    } else if (a?.kind === "claude") {
      nodes.push(
        el(
          "p",
          "history-note",
          a.canMessage
            ? "Claude is connected. Send a message below."
            : "Open Terminal to complete Claude’s setup or respond to its prompt.",
        ),
      );
      nodes.push(button("Open terminal", this.openTerminal, "secondary"));
      if (this.screen.trim())
        nodes.push(el("pre", "quiet-output", this.screen.trim()));
    } else {
      const empty = el("div", "agent-empty");
      empty.append(
        el("h3", "", "Give your creature a voice."),
        el(
          "p",
          "",
          "Start Claude or Codex in YOLO mode, or use Terminal for shell commands.",
        ),
      );
      const launchActions = el("div", "agent-launch-actions");
      for (const [program, label] of [
        ["claude", "Claude"],
        ["codex", "Codex"],
      ] as const) {
        const caption = el("span", "", `Start ${label}`);
        const icon = el("img", "agent-launch-icon");
        icon.src = program === "claude" ? claudeIcon : codexIcon;
        icon.alt = "";
        icon.setAttribute("aria-hidden", "true");
        const launch = button(
          `Start ${label}`,
          async () => {
            if (this.launching) return;
            this.launching = true;
            launch.disabled = true;
            caption.textContent = `Starting ${label}…`;
            this.showError("");
            try {
              await this.startAgent(program);
            } catch (error) {
              this.showError(
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              this.launching = false;
              launch.disabled = false;
              caption.textContent = `Start ${label}`;
            }
          },
          `primary agent-launch agent-launch-${program}`,
          "",
        );
        launch.append(icon, caption);
        launch.disabled = !live || !a || this.launching;
        launchActions.append(launch);
      }
      launchActions.append(
        button(
          "Use shell terminal",
          this.openTerminal,
          "secondary",
          ">_ Use terminal",
        ),
      );
      empty.append(launchActions);
      nodes.push(empty);
    }
    if (!conversation && (a?.kind === "claude" || a?.kind === "codex")) {
      const previews = imagePreviews(this.terminalId, this.screen);
      if (previews) nodes.push(previews);
    }
    this.content.replaceChildren(...nodes);
    this.content.scrollTop = follow ? this.content.scrollHeight : scroll;
  }
}
