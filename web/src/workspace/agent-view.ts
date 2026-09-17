import { ConversationScroll } from "./conversation-scroll";
import { busyPhrases } from "./busy-phrases";
import { renderChatMarkdown } from "./chat-markdown";
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
  private stack = el("div", "conversation-stack");
  private latest = button(
    "Follow latest messages",
    () => this.scroller.latest(),
    "follow-latest",
    "Latest messages ↓",
  );
  private scroller: ConversationScroll;
  private messageNodes = new Map<
    string,
    { element: HTMLElement; text: string; role: string }
  >();
  private messageKeys = new Map<string, string>();
  private receivedActivity = false;
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
  private nextPhrase = busyPhrases();
  private busyLabel = this.nextPhrase();
  private phraseAt = 0;
  private visibleTimer?: ReturnType<typeof setInterval>;
  private interruptButton: HTMLButtonElement;
  private activity?: Activity;
  private refreshFailed = false;
  private pending: {
    id: string;
    text: string;
    state: "sending" | "sent" | "failed";
  }[] = [];
  private seenUserMessages = new Set<string>();
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
    this.latest.hidden = true;
    this.content.append(this.stack);
    this.scroller = new ConversationScroll(
      this.content,
      this.stack,
      (following) => {
        this.latest.hidden = following;
      },
    );
    this.content.setAttribute("aria-label", "Agent conversation and output");
    this.error.setAttribute("role", "alert");
    this.element.append(
      this.notice,
      this.interruptButton,
      this.error,
      this.content,
      this.latest,
    );
    this.setCreature(name);
  }
  captureScroll(): void {
    this.scroller.capture();
  }
  reflow(): void {
    this.scroller.reflow();
  }
  restoreScroll(): void {
    this.scroller.restore();
  }
  dispose(): void {
    this.setVisible(false);
    this.scroller.dispose();
  }
  setVisible(visible: boolean): void {
    this.scroller.setVisible(visible);
    clearInterval(this.visibleTimer);
    this.visibleTimer = visible
      ? setInterval(() => {
          if (this.wasWorking) this.render();
        }, 8000)
      : undefined;
  }
  showError(text: string): void {
    this.error.textContent = text;
  }
  setCreature(name: string): void {
    this.name = name;
    this.avatar.replaceChildren(creature(name));
  }
  setActivity(activity: Activity): void {
    this.refreshFailed = false;
    for (const message of activity.messages) {
      if (message.role !== "user" || this.seenUserMessages.has(message.id))
        continue;
      this.seenUserMessages.add(message.id);
      const index = this.pending.findIndex(
        (p) => p.state !== "failed" && p.text.trim() === message.text.trim(),
      );
      if (index >= 0) {
        this.messageKeys.set(message.id, this.pending[index].id);
        this.pending.splice(index, 1);
      }
    }
    if (this.seenUserMessages.size > 2000)
      this.seenUserMessages = new Set([...this.seenUserMessages].slice(-1000));
    this.activity = activity;
    this.render();
    this.receivedActivity ||=
      activity.canMessage || activity.messages.length > 0;
  }
  beginMessage(text: string): string {
    const id = crypto.randomUUID();
    // A retry supersedes the previous failed copy, not an earlier delivered turn.
    this.pending = this.pending.filter(
      (p) => p.state !== "failed" || p.text !== text,
    );
    this.pending.push({ id, text, state: "sending" });
    this.render();
    this.scroller.latest();
    return id;
  }
  finishMessage(id: string, sent: boolean): void {
    const message = this.pending.find((p) => p.id === id);
    if (message) message.state = sent ? "sent" : "failed";
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
    this.refreshFailed = true;
    if (this.activity) this.activity = { ...this.activity, canMessage: false };
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
    if (working && (!this.wasWorking || Date.now() - this.phraseAt >= 8000)) {
      this.busyLabel = this.nextPhrase();
      this.phraseAt = Date.now();
    }
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
      : this.refreshFailed
        ? "Reconnecting to agent…"
        : attention
          ? "Your move"
          : working
            ? this.busyLabel
            : a?.kind === "codex"
              ? "Codex · Terminal ready"
              : a?.kind === "claude"
                ? a.canMessage
                  ? "Ready when you are"
                  : a.status === "starting"
                    ? "Claude · Connecting…"
                    : "Finish setup in Terminal"
                : a
                  ? "No agent running"
                  : "Terminal connected";
    if (label !== this.statusText) {
      this.label.textContent = label;
      this.statusText = label;
    }
    this.detail.textContent =
      a?.kind === "claude"
        ? `${this.name} · Claude${working && a.tool ? ` · ${a.tool}` : ""}${a.tools ? ` · ${a.tools} tool calls` : ""}`
        : `${this.name} · ${a?.kind === "codex" ? "Codex" : "Shell"}`;
    const conversation = a?.kind === "claude" && a.messages.length > 0;
    const key = JSON.stringify([
      conversation
        ? [a.messages, a.truncated]
        : [this.screen, a?.kind, a?.status, live],
      this.pending,
    ]);
    if (key === this.signature) return;
    this.signature = key;
    this.captureScroll();
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
        const key = this.messageKeys.get(message.id) || message.id;
        nodes.push(
          this.messageNode(
            key,
            message.role,
            message.text,
            this.receivedActivity,
          ),
        );
      }
    } else if (this.pending.length) {
      // The first outgoing turn is already useful content while the transcript loads.
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
          a.status === "starting"
            ? "Connecting to Claude…"
            : a.canMessage
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
    for (const message of this.pending) {
      const item = this.messageNode(message.id, "user", message.text, true);
      item.classList.add("pending-message", message.state);
      const status = el(
        "span",
        "message-delivery",
        message.state === "sending"
          ? "Sending…"
          : message.state === "sent"
            ? "Sent · waiting for agent"
            : "Not sent · your draft is ready to retry",
      );
      status.setAttribute("role", "status");
      item.append(status);
      nodes.push(item);
    }
    // Keep unchanged messages mounted: selection, images and arrival animations
    // survive polling and acknowledgement of optimistic outgoing messages.
    let cursor = this.stack.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else this.stack.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    for (const [key, value] of this.messageNodes) {
      if (value.element.parentElement !== this.stack)
        this.messageNodes.delete(key);
    }
    const activeIds = new Set(a?.messages.map((message) => message.id));
    for (const key of this.messageKeys.keys())
      if (!activeIds.has(key)) this.messageKeys.delete(key);
    if (!this.receivedActivity) this.scroller.restore();
    else this.scroller.reflow();
  }
  private messageNode(
    id: string,
    role: string,
    text: string,
    animate: boolean,
  ): HTMLElement {
    let cached = this.messageNodes.get(id);
    const arriving = !cached && animate;
    if (!cached) {
      const element = el("article", `conversation-message ${role}`);
      element.dataset.messageId = id;
      if (animate) element.classList.add("message-arrival");
      cached = { element, text: "", role: "" };
      this.messageNodes.set(id, cached);
    }
    const item = cached.element;
    item.classList.remove("pending-message", "sending", "sent", "failed");
    item.querySelector(".message-delivery")?.remove();
    if (cached.text !== text || cached.role !== role) {
      const body = renderChatMarkdown(text);
      if (arriving) {
        const selector = "p,h1,h2,h3,h4,h5,h6,li,pre,.message-table";
        const lines = [...body.querySelectorAll<HTMLElement>(selector)].filter(
          (line) => !line.querySelector(selector),
        );
        for (const [index, line] of lines.entries()) {
          line.classList.add("message-line-arrival");
          line.style.setProperty(
            "--arrival-delay",
            `${Math.min(index * 28, 196)}ms`,
          );
        }
      }
      item.replaceChildren(
        el("span", "message-role", role === "user" ? "YOU" : "CLAUDE"),
        body,
      );
      const previews = imagePreviews(this.terminalId, text);
      if (previews) item.append(previews);
      cached.text = text;
      cached.role = role;
    }
    return item;
  }
}
