import { ConversationScroll } from "./conversation-scroll";
import { busyPhrases } from "./busy-phrases";
import { renderChatMarkdown } from "./chat-markdown";
import { ReplyReveal } from "./reply-reveal";
import { el, button } from "./dom";
import { imagePaths, imagePreviews, chatMessageText } from "./image-previews";
import { creature } from "./creature";
import claudeIcon from "../../assets/brands/claude.svg";
import codexIcon from "../../assets/brands/openai.svg";

export interface Activity {
  history?: { session: string; start: number; end: number; total: number };
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
  private avatar = button(
    "Customize terminal",
    () => this.onCustomize?.(),
    "agent-avatar",
    "",
  );
  private label = el("span", "agent-status-label", "Ready");
  private detail = el("span", "agent-detail", "Shell · live output");
  private content = el("div", "agent-content");
  private stack = el("div", "conversation-stack");
  private latest = button(
    "Follow latest messages",
    () => this.showLatest(),
    "follow-latest",
    "Latest messages ↓",
  );
  private scroller: ConversationScroll;
  private liveActivity?: Activity;
  private historyActivity?: Activity;
  private historyRequest?: AbortController;
  private historyVersion = 0;
  private historyBar = el("div", "conversation-history");
  private historyRange = el("span", "history-range");
  private earlier = button(
    "Earlier messages",
    () => void this.loadHistory("before"),
    "history-button",
    "← Earlier",
  );
  private newer = button(
    "Newer messages",
    () => void this.loadHistory("after"),
    "history-button",
    "Newer →",
  );
  private live = button(
    "Back to latest messages",
    () => this.showLatest(),
    "history-button",
    "Back to latest ↓",
  );
  private messageNodes = new Map<
    string,
    { element: HTMLElement; text: string; role: string; reply?: ReplyReveal }
  >();
  private messageKeys = new Map<string, string>();
  private receivedActivity = false;
  private catchUpOnActivity = false;
  private notice = button(
    "Open terminal to respond",
    () => this.openTerminal(),
    "terminal-notice",
    "Input needed · Open terminal →",
  );
  private notices = el("div", "agent-notices");
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
    afterId?: string;
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
    private onCustomize?: () => void,
  ) {
    this.name = name;
    this.interruptButton = button(
      "Interrupt current response",
      interrupt,
      "terminal-notice interrupt-notice",
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
    const finishArrival = (event: AnimationEvent) => {
      if (
        event.target instanceof HTMLElement &&
        ["message-arrive", "reply-reveal"].includes(event.animationName)
      )
        this.clearArrival(event.target);
    };
    this.stack.addEventListener("animationend", finishArrival);
    this.stack.addEventListener("animationcancel", finishArrival);
    this.scroller = new ConversationScroll(
      this.content,
      this.stack,
      (following) => {
        this.latest.hidden = following && !this.historyActivity;
      },
    );
    this.content.setAttribute("aria-label", "Agent conversation and output");
    this.error.setAttribute("role", "alert");
    this.notices.hidden = true;
    this.notices.append(this.notice, this.interruptButton);
    this.historyBar.hidden = true;
    this.historyBar.setAttribute("aria-label", "Conversation history");
    this.historyBar.append(
      this.earlier,
      this.historyRange,
      this.newer,
      this.live,
    );
    this.element.append(
      this.notices,
      this.error,
      this.historyBar,
      this.content,
      this.latest,
    );
    this.setCreature(name);
  }
  private clearArrival(element: HTMLElement): void {
    element.classList.remove("message-arrival", "reply-chunk-arrival");
    element.style.removeProperty("--reveal-delay");
  }
  settleArrivals(): void {
    for (const element of this.stack.querySelectorAll<HTMLElement>(
      ".message-arrival, .reply-chunk-arrival",
    ))
      this.clearArrival(element);
  }
  captureScroll(): void {
    this.scroller.capture();
  }
  reflow(): void {
    this.scroller.reflow();
  }
  restoreScroll(catchUp = false): void {
    this.settleArrivals();
    if (catchUp) this.catchUpOnActivity = true;
    this.scroller.restore();
  }
  dispose(): void {
    this.setVisible(false);
    this.historyRequest?.abort();
    this.historyVersion++;
    this.scroller.dispose();
  }
  setVisible(visible: boolean): void {
    this.settleArrivals();
    this.catchUpOnActivity = visible;
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
    // Session metadata can momentarily disappear while Claude writes/restarts.
    // A transient lookup failure must not remove the entire DOM then repopulate
    // it on the next poll (which clamps scrollTop and looks like a random jump).
    if (
      !activity.history &&
      this.liveActivity?.history &&
      activity.kind === "claude"
    ) {
      activity = {
        ...activity,
        messages: this.liveActivity.messages,
        history: this.liveActivity.history,
      };
    }
    const previous = this.liveActivity?.history;
    if (
      previous &&
      activity.history &&
      previous.session !== activity.history.session
    ) {
      this.historyVersion++;
      this.historyRequest?.abort();
      this.historyRequest = undefined;
      this.historyActivity = undefined;
      this.seenUserMessages.clear();
      this.messageKeys.clear();
      this.messageNodes.clear();
      this.catchUpOnActivity = true;
    }
    // Freeze the current page when the reader has scrolled up. Live polling
    // may advance its window, but must never evict what someone is reading.
    if (
      !this.historyActivity &&
      !this.scroller.isFollowing &&
      previous &&
      activity.history?.session === previous.session &&
      activity.history.start !== previous.start
    ) {
      this.historyActivity = this.activity;
    }
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
    this.seenUserMessages = new Set(
      activity.messages
        .filter((message) => message.role === "user")
        .map((message) => message.id),
    );
    this.liveActivity = activity;
    this.activity = this.historyActivity
      ? {
          ...activity,
          messages: this.historyActivity.messages,
          history: this.historyActivity.history && {
            ...this.historyActivity.history,
            total:
              activity.history?.total ?? this.historyActivity.history.total,
          },
        }
      : activity;
    const windowMoved =
      !this.historyActivity &&
      previous &&
      activity.history?.start !== previous.start;
    this.render(this.catchUpOnActivity, !!windowMoved);
    this.catchUpOnActivity = false;
    this.receivedActivity ||=
      activity.canMessage || activity.messages.length > 0;
  }
  private showLatest(): void {
    this.historyVersion++;
    this.historyRequest?.abort();
    this.historyRequest = undefined;
    if (this.historyActivity && this.liveActivity) {
      this.historyActivity = undefined;
      this.activity = this.liveActivity;
      this.render(true);
      this.scroller.showPage("end", true);
    } else this.scroller.latest();
    this.updateHistory();
  }
  private updateHistory(): void {
    const page = this.activity?.history;
    this.historyBar.hidden =
      !page ||
      (!this.historyActivity && page.start === 0 && page.end === page.total);
    if (!page) return;
    this.historyRange.textContent = `${page.start + 1}–${page.end} of ${page.total}`;
    this.earlier.disabled = !!this.historyRequest || page.start === 0;
    this.newer.disabled = !!this.historyRequest || page.end === page.total;
    this.live.hidden = !this.historyActivity;
  }
  private async loadHistory(direction: "before" | "after"): Promise<void> {
    const page = this.activity?.history;
    if (!page || this.historyRequest) return;
    const version = ++this.historyVersion;
    const controller = new AbortController();
    this.historyRequest = controller;
    this.updateHistory();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const query = new URLSearchParams({
        session: page.session,
        [direction]: String(direction === "before" ? page.start : page.end),
      });
      const response = await fetch(
        `/api/workspace/terminals/${encodeURIComponent(this.terminalId)}/activity?${query}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error("Could not load history. Try again.");
      const activity = (await response.json()) as Activity;
      if (version !== this.historyVersion) return;
      if (!activity.history)
        throw new Error("History is temporarily unavailable. Try again.");
      if (activity.history?.session !== this.liveActivity?.history?.session) {
        // The agent restarted while a page was loading; discard its old cursor.
        this.historyActivity = undefined;
        this.setActivity(activity);
        this.scroller.showPage("end", true);
      } else {
        this.historyActivity = activity;
        this.activity = activity;
        this.render(true);
        this.scroller.showPage(direction === "before" ? "end" : "start");
      }
    } catch (error) {
      if (version === this.historyVersion)
        this.historyRange.textContent =
          error instanceof Error && error.name !== "AbortError"
            ? error.message
            : "History timed out. Try again.";
    } finally {
      clearTimeout(timeout);
      if (version === this.historyVersion) {
        this.historyRequest = undefined;
        this.earlier.disabled = this.activity?.history?.start === 0;
        this.newer.disabled =
          this.activity?.history?.end === this.activity?.history?.total;
      }
    }
  }
  beginMessage(text: string): string {
    if (this.historyActivity) this.showLatest();
    const id = crypto.randomUUID();
    // A retry supersedes the previous failed copy, not an earlier delivered turn.
    this.pending = this.pending.filter(
      (p) => p.state !== "failed" || p.text !== text,
    );
    const last = this.activity?.messages.at(-1)?.id;
    const afterId =
      this.pending.at(-1)?.id || (last && (this.messageKeys.get(last) || last));
    this.pending.push({ id, text, afterId, state: "sending" });
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
  private render(catchUp = false, windowMoved = false): void {
    this.captureScroll();
    this.updateHistory();
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
    this.notices.hidden = this.notice.hidden && this.interruptButton.hidden;
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
        ? [a.messages, a.truncated, a.history?.start, a.history?.end]
        : [this.screen, a?.kind, a?.status, live],
      this.pending,
    ]);
    if (key === this.signature) return;
    this.signature = key;
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
            this.receivedActivity && !catchUp,
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
    for (const message of this.historyActivity ? [] : this.pending) {
      const item = this.messageNode(message.id, "user", message.text, true);
      item.classList.add("pending-message", message.state);
      let status = item.querySelector<HTMLElement>(".message-delivery");
      if (!status) {
        status = el("span", "message-delivery");
        status.setAttribute("role", "status");
        item.append(status);
      }
      status.removeAttribute("aria-hidden");
      const caption =
        message.state === "sending"
          ? "Sending…"
          : message.state === "sent"
            ? "Sent to terminal"
            : "Not sent · retry below";
      if (status.textContent !== caption) status.textContent = caption;
      // Keep the draft at its send position while awaiting the native receipt.
      // New replies must appear below it, not behind a permanently last bubble.
      const anchor = nodes.findIndex(
        (node) => node.dataset.messageId === message.afterId,
      );
      const first = nodes.findIndex((node) =>
        node.classList.contains("conversation-message"),
      );
      nodes.splice(
        anchor >= 0 ? anchor + 1 : first >= 0 ? first : nodes.length,
        0,
        item,
      );
    }
    // Keep unchanged messages mounted: selection, images and arrival animations
    // survive polling and acknowledgement of optimistic outgoing messages.
    // Remove evicted rows first. Otherwise a sliding window moves every retained
    // row before the obsolete first child, restarting animations unnecessarily.
    const wanted = new Set(nodes);
    for (const child of [...this.stack.children]) {
      if (!wanted.has(child as HTMLElement)) child.remove();
    }
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
    const activeIds = new Set(
      this.liveActivity?.messages.map((message) => message.id),
    );
    for (const key of this.messageKeys.keys())
      if (!activeIds.has(key)) this.messageKeys.delete(key);
    if (this.historyActivity) this.latest.hidden = false;
    if (!this.receivedActivity || catchUp || windowMoved)
      this.scroller.restore();
    else this.scroller.reflow();
  }
  private messageNode(
    id: string,
    role: string,
    text: string,
    animate: boolean,
  ): HTMLElement {
    let cached = this.messageNodes.get(id);
    if (!cached) {
      const element = el("article", `conversation-message ${role}`);
      element.dataset.messageId = id;
      if (animate && role === "user") element.classList.add("message-arrival");
      cached = { element, text: "", role: "" };
      this.messageNodes.set(id, cached);
    }
    const item = cached.element;
    item.classList.remove("pending-message", "sending", "sent", "failed");
    // Retain the tiny status overlay so confirmation fades without collapsing
    // the bubble or replaying its entrance animation.
    item
      .querySelector(".message-delivery")
      ?.setAttribute("aria-hidden", "true");
    if (cached.text !== text || cached.role !== role) {
      if (role !== "user" && cached.reply) {
        cached.reply.update(text, animate);
      } else {
        cached.reply =
          role === "user" ? undefined : new ReplyReveal(text, animate);
        item.replaceChildren(
          el("span", "message-role", role === "user" ? "YOU" : "CLAUDE"),
          cached.reply?.element ||
            renderChatMarkdown(chatMessageText(this.terminalId, text)),
        );
      }
      const paths = imagePaths(text);
      if (
        JSON.stringify(imagePaths(cached.text)) !== JSON.stringify(paths) ||
        (paths.length > 0 && !item.querySelector(".image-previews"))
      ) {
        item.querySelector(".image-previews")?.remove();
        const previews = imagePreviews(this.terminalId, text);
        if (previews) item.append(previews);
      }
      cached.text = text;
      cached.role = role;
    }
    return item;
  }
}
