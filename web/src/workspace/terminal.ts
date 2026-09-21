import { PullRequestLink } from "./pull-request";
import { terminalTheme } from "./theme";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { HostedApps } from "./hosted-apps";
import { ComposerImages, uploadImage } from "./composer-images";
import { SlashCommands, isSlashCommand } from "./slash-commands";
import { reveal } from "./motion";
import conversationIcon from "../../assets/icons/conversation.svg";
import terminalIcon from "../../assets/icons/terminal.svg";
import { contextMenu } from "./context-menu";
import { button, el } from "./dom";
import type { Project, Session } from "./types";
import { AgentView, type Activity } from "./agent-view";
import { defaultCreature, chooseCreature, terminalColor } from "./creature";
export interface PaneAppearance {
  color: string;
  view: "agent" | "terminal";
  creature: string;
}

interface Actions {
  startAgent(program: "claude" | "codex"): Promise<void>;
  draft(value: string): void;
  appearance(value: PaneAppearance): void;
  focus(): void;
  hide(): void;
  zoom(): void;
  split(axis: "row" | "column"): void;
  rename(): void;
  stop(): void;
  restart(): void;
  drop(id: string): void;
}
export class TerminalPane {
  readonly element = el("section", "terminal-pane");
  private terminal: Terminal;
  private hostedApps: HostedApps;
  private pullRequest: PullRequestLink;
  private host = el("div", "terminal-host");
  private agent: AgentView;
  private appearance: PaneAppearance;
  private agentButton: HTMLButtonElement;
  private terminalButton: HTMLButtonElement;
  private activityTimer?: ReturnType<typeof setTimeout>;
  private screenTimer?: ReturnType<typeof setTimeout>;
  private activityRequest?: AbortController;
  private fitAddon = new FitAddon();
  private socket?: WebSocket;
  private observer: ResizeObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private connection = el("span", "connection-state", "Connecting");
  private name = el("span", "terminal-name");
  private stopButton: HTMLButtonElement;
  private restartButton: HTMLButtonElement;
  private message = el("textarea", "message-input");
  private images: ComposerImages;
  private commands: SlashCommands;
  private composerMeasureKey = "";
  private composerMeasure = el("div", "composer-measure");
  private lastSentSize = "";
  private currentStatus = "";
  private activity?: Activity;
  private viewVisible = false;
  private pendingDeliveries = 0;
  private deliveryQueue: Promise<unknown> = Promise.resolve();
  private frame = 0;
  private terminalScroll = { top: 0, follow: true };
  private restoringTerminalScroll = false;
  private saveDraft: (value: string) => void;
  constructor(
    private session: Session,
    project: Project,
    private actions: Actions,
    fontSize: number,
    draft = "",
    appearance?: PaneAppearance,
  ) {
    this.appearance = appearance || {
      view: "agent",
      creature: defaultCreature(session.id),
      color: terminalColor(session.id),
    };
    this.element.style.setProperty("--terminal-color", this.appearance.color);
    this.agent = new AgentView(
      this.appearance.creature,
      session.id,
      () => this.setView("terminal"),
      actions.startAgent,
      () => {
        this.input("\x1b");
      },
      () => this.customize(),
    );
    if (session.program === "claude" || session.program === "codex") {
      this.agent.setActivity({
        kind: session.program,
        status: "starting",
        canMessage: false,
        messages: [],
        tools: 0,
        truncated: false,
      });
    }
    this.hostedApps = new HostedApps(session.id);
    this.pullRequest = new PullRequestLink(session.id);
    this.images = new ComposerImages(
      session.id,
      () => {
        this.refreshComposer();
        this.fit();
      },
      (text) => this.agent.showError(text),
    );
    this.message.addEventListener("paste", (event) => this.images.paste(event));
    this.message.addEventListener("workspace-paste-image", (event) => {
      const base64 = (event as CustomEvent<string>).detail;
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      );
      void this.images.add(
        new File([bytes], "Screenshot.png", { type: "image/png" }),
      );
    });
    this.saveDraft = actions.draft;
    this.message.value = draft;
    this.message.addEventListener("input", () => {
      this.saveDraft(this.message.value);
      if (this.resizeComposer()) this.fit();
    });
    document.body.append(this.composerMeasure);
    this.element.dataset.terminalId = session.id;
    const header = el("header", "pane-header");
    header.draggable = true;
    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      contextMenu(
        this.session.name,
        event.clientX,
        event.clientY,
        [{ label: "Customize terminal…", run: () => this.customize() }],
        () => this.focus(),
        this.appearance.color,
      );
    });
    const identity = el("div", "pane-identity");
    identity.append(
      el("span", "pane-project", project.name),
      el("span", "slash", "/"),
      this.name,
    );
    const controls = el("div", "pane-controls");
    this.stopButton = button(
      "Stop terminal",
      actions.stop,
      "icon-button stop-button",
      "■",
    );
    this.restartButton = button(
      "Start terminal",
      actions.restart,
      "icon-button",
      "↻",
    );
    controls.append(
      button("Rename terminal", actions.rename, "icon-button", "✎"),
      button("Split right", () => actions.split("row"), "icon-button", "◫"),
      button("Split below", () => actions.split("column"), "icon-button", "⬒"),
      button("Focus pane", actions.zoom, "icon-button", "⛶"),
      this.stopButton,
      this.restartButton,
      button("Hide terminal", actions.hide, "icon-button", "×"),
    );
    controls.prepend(this.hostedApps.toggle);
    header.append(identity, this.pullRequest.element, controls);
    const context = el("div", "pane-context");
    const tree = project.worktrees.find((w) => w.path === session.path);
    this.connection.hidden = true;
    context.append(this.connection);
    context.title =
      project.git === false
        ? session.path
        : `Branch: ${tree?.branch || "detached"}\n${session.path}`;
    const switcher = el("div", "view-switcher");
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Pane view");
    this.agentButton = button(
      "Agent view",
      () => this.toggleView(),
      "view-button",
      "",
    );
    this.terminalButton = button(
      "Terminal view",
      () => this.toggleView(),
      "view-button",
      "",
    );
    for (const [button, source] of [
      [this.agentButton, conversationIcon],
      [this.terminalButton, terminalIcon],
    ] as const) {
      const icon = el("span", "view-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.style.maskImage = `url("${source}")`;
      icon.style.setProperty("-webkit-mask-image", `url("${source}")`);
      button.append(icon);
    }
    switcher.append(this.agentButton, this.terminalButton);
    controls.prepend(switcher);
    identity.title = context.title;
    const surface = el("div", "pane-surface");
    surface.append(this.host, this.agent.element);
    const composer = el("form", "composer");
    this.commands = new SlashCommands(
      this.message,
      session.program === "codex" ? "Codex" : "Claude",
    );
    this.message.rows = 1;
    this.message.spellcheck = false;
    this.message.setAttribute("autocorrect", "off");
    this.message.setAttribute("autocapitalize", "off");
    this.message.placeholder = "Send a command or message…";
    this.refreshComposer();
    this.message.addEventListener("keydown", (e) => {
      if (this.commands.handleKey(e)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    composer.onsubmit = (e) => {
      e.preventDefault();
      this.submit();
    };
    composer.append(this.commands.element, this.message);
    composer.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    });
    composer.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      for (const file of Array.from(event.dataTransfer.files))
        void this.images.add(file);
    });
    this.agent.heading.classList.add("composer-activity");
    this.element.append(
      header,
      context,
      this.hostedApps.element,
      surface,
      this.agent.notices,
      this.agent.heading,
      this.images.element,
      composer,
    );
    context.hidden = true;
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: "monospace",
      lineHeight: 1.25,
      scrollback: 10000,
      allowProposedApi: false,
      // Preserve the terminal's ANSI palette and program styling.
      theme: terminalTheme(),
    });
    window.addEventListener("workspace-theme", this.updateTheme);
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.host);
    this.terminal.onData((data) => this.input(data));
    this.host.addEventListener(
      "paste",
      (event) => {
        const files = Array.from(event.clipboardData?.files || []).filter(
          (file) => file.type.startsWith("image/"),
        );
        if (!files.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        for (const file of files) this.pasteTerminalImage(file);
      },
      true,
    );
    this.host.addEventListener("workspace-paste-image", (event) => {
      const bytes = Uint8Array.from(
        atob((event as CustomEvent<string>).detail),
        (c) => c.charCodeAt(0),
      );
      this.pasteTerminalImage(
        new File([bytes], "Screenshot.png", { type: "image/png" }),
      );
    });
    this.host.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    });
    this.host.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      for (const file of Array.from(event.dataTransfer.files))
        this.pasteTerminalImage(file);
    });
    this.terminal.onScroll(() => {
      if (
        this.viewVisible &&
        !this.restoringTerminalScroll &&
        this.appearance.view === "terminal"
      )
        this.captureTerminalScroll();
    });
    this.terminal.attachCustomKeyEventHandler((e) => {
      if (
        (e.metaKey || (e.ctrlKey && e.shiftKey)) &&
        e.key.toLowerCase() === "c" &&
        this.terminal.hasSelection()
      ) {
        if (e.type === "keydown")
          navigator.clipboard
            ?.writeText(this.terminal.getSelection())
            .catch(() => {});
        return false;
      }
      return !(
        e.metaKey &&
        ["k", "n", "b", "1", "2", "3", "0"].includes(e.key.toLowerCase())
      );
    });
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.host);
    this.observer.observe(this.element);
    document.fonts
      .load(`${fontSize}px "Google Sans Code"`)
      .then(() => {
        if (this.disposed) return;
        this.terminal.options.fontFamily = '"Google Sans Code", monospace';
        this.composerMeasureKey = "";
        this.fit();
      })
      .catch(() => {
        /* The system monospace fallback remains usable. */
      });
    this.element.addEventListener("pointerdown", actions.focus);
    this.element.addEventListener("focusin", actions.focus);
    header.ondragstart = (e) => {
      if ((e.target as HTMLElement).closest("button")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer?.setData("text/cloovies-terminal", session.id);
    };
    header.ondragover = (e) => {
      if (e.dataTransfer?.types.includes("text/cloovies-terminal")) {
        e.preventDefault();
        header.classList.add("drop-target");
      }
    };
    header.ondragleave = () => header.classList.remove("drop-target");
    header.ondrop = (e) => {
      e.preventDefault();
      header.classList.remove("drop-target");
      const id = e.dataTransfer?.getData("text/cloovies-terminal");
      if (id) actions.drop(id);
    };
    this.setFontSize(fontSize);
    this.setView(this.appearance.view, false);
    this.update(session);
    this.connect();
  }
  private nativeImageQueue: Promise<void> = Promise.resolve();
  private pasteTerminalImage(file: File): void {
    this.nativeImageQueue = this.nativeImageQueue.then(async () => {
      if (this.disposed) return;
      const notice = el("div", "terminal-paste-notice", "Attaching image…");
      notice.setAttribute("role", "status");
      this.host.append(notice);
      try {
        const path = await uploadImage(this.session.id, file);
        if (this.disposed) return;
        if (this.socket?.readyState !== WebSocket.OPEN)
          throw new Error(
            "Terminal disconnected. Paste the image again after reconnecting.",
          );
        this.terminal.paste(
          !["claude", "codex"].includes(this.session.program || "")
            ? "'" + path.replaceAll("'", "'\"'\"'") + "'"
            : path,
        );
        notice.remove();
        if (this.appearance.view === "terminal") this.terminal.focus();
      } catch (error) {
        notice.textContent =
          error instanceof Error ? error.message : String(error);
        notice.append(
          button(
            "Dismiss attachment error",
            () => notice.remove(),
            "icon-button",
            "×",
          ),
        );
      }
    });
  }
  private captureTerminalScroll(): void {
    const b = this.terminal.buffer.active;
    this.terminalScroll = { top: b.viewportY, follow: b.viewportY >= b.baseY };
  }
  private customize(): void {
    chooseCreature(
      this.appearance.creature,
      (name) => {
        this.appearance.creature = name;
        this.agent.setCreature(name);
        this.actions.appearance({ ...this.appearance });
      },
      this.appearance.color,
      (color) => {
        this.appearance.color = color;
        this.element.style.setProperty("--terminal-color", color);
        this.actions.appearance({ ...this.appearance });
      },
    );
  }
  settleArrivals(): void {
    this.agent.settleArrivals();
  }
  captureScroll(): void {
    this.agent.captureScroll();
    if (this.viewVisible && this.appearance.view === "terminal")
      this.captureTerminalScroll();
  }
  restoreScroll(): void {
    this.agent.restoreScroll();
    this.restoringTerminalScroll = true;
    if (this.terminalScroll.follow) this.terminal.scrollToBottom();
    else this.terminal.scrollToLine(this.terminalScroll.top);
    this.restoringTerminalScroll = false;
  }
  setVisible(visible: boolean): void {
    if (this.viewVisible === visible) return;
    this.viewVisible = visible;
    this.hostedApps.setVisible(visible);
    this.pullRequest.setVisible(visible);
    this.agent.setVisible(visible);
    clearTimeout(this.activityTimer);
    if (visible && !this.activityRequest) void this.pollActivity();
  }
  update(session: Session): void {
    const previous = this.currentStatus;
    this.session = session;
    this.currentStatus = session.status;
    this.element.classList.toggle(
      "is-working",
      session.liveStatus === "working",
    );
    this.name.textContent = session.name;
    this.element.setAttribute("aria-label", `${session.name} terminal`);
    this.refreshComposer();
    this.stopButton.hidden = session.status === "stopped";
    this.restartButton.hidden = session.status === "running";
    if (
      session.status === "exited" &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      this.status("Exited");
    }
    if (session.status === "stopped") {
      this.socket?.close();
      this.status("Stopped");
    } else if (previous === "stopped") {
      this.connect();
    }
  }
  private toggleView(): void {
    this.setView(this.appearance.view === "agent" ? "terminal" : "agent");
  }
  private setView(view: "agent" | "terminal", focus = true): void {
    if (view === "terminal") this.element.classList.remove("has-long-draft");
    const changed = this.appearance.view !== view;
    this.agent.settleArrivals();
    this.appearance.view = view;
    this.element.dataset.view = view;
    this.agentButton.setAttribute("aria-pressed", String(view === "agent"));
    this.terminalButton.setAttribute(
      "aria-pressed",
      String(view === "terminal"),
    );
    this.host.inert = view !== "terminal";
    this.host.setAttribute("aria-hidden", String(view !== "terminal"));
    this.agent.element.hidden = view !== "agent";
    this.refreshComposer();
    this.fit();
    this.agent.restoreScroll(changed && view === "agent");
    if (focus) {
      reveal(view === "agent" ? this.agent.element : this.host);
      this.saveAppearance();
      this.focus();
    }
  }
  private saveAppearance(): void {
    this.actions.appearance({ ...this.appearance });
  }
  private async pollActivity(): Promise<void> {
    if (this.disposed) return;
    try {
      if (
        this.viewVisible &&
        this.session.status === "running" &&
        !document.hidden
      ) {
        this.activityRequest = new AbortController();
        const timeout = setTimeout(() => this.activityRequest?.abort(), 8000);
        try {
          const response = await fetch(
            `/api/workspace/terminals/${this.session.id}/activity`,
            { signal: this.activityRequest.signal },
          );
          if (!response.ok) throw new Error("Activity unavailable");
          const activity = (await response.json()) as Activity;
          if (!this.disposed) {
            this.activity = activity;
            this.agent.setActivity(activity);
            this.refreshComposer();
          }
        } finally {
          clearTimeout(timeout);
          this.activityRequest = undefined;
        }
      }
    } catch {
      if (!this.disposed) {
        if (this.activity)
          this.activity = { ...this.activity, canMessage: false };
        this.agent.unavailable();
        this.refreshComposer();
      }
    }
    if (!this.disposed && this.viewVisible)
      this.activityTimer = setTimeout(() => this.pollActivity(), 2000);
  }
  private readScreen(): void {
    if (this.screenTimer) return;
    this.screenTimer = setTimeout(() => {
      this.screenTimer = undefined;
      if (this.disposed) return;
      const buffer = this.terminal.buffer.active;
      const lines: string[] = [];
      const start = Math.max(0, buffer.length - 200);
      for (let i = start; i < buffer.length; i++)
        lines.push(buffer.getLine(i)?.translateToString(true) || "");
      this.agent.setScreen(
        lines.join("\n"),
        lines.slice(Math.max(0, buffer.baseY - start)).join("\n"),
      );
    }, 120);
  }
  private status(text: string): void {
    this.agent.setConnection(text);
    this.connection.textContent = text;
    this.connection.dataset.status = text.toLowerCase();
    this.refreshComposer();
  }
  private connect(): void {
    if (
      this.disposed ||
      this.session.status === "stopped" ||
      (this.socket && this.socket.readyState < 2)
    )
      return;
    clearTimeout(this.timer);
    this.status("Connecting");
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${scheme}//${location.host}/api/workspace/terminals/${this.session.id}/connect?cols=${this.terminal.cols}&rows=${this.terminal.rows}`,
    );
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.disposed) {
        ws.close();
        return;
      }
      this.lastSentSize = "";
      this.terminal.reset();
      this.status(this.session.status === "exited" ? "Exited" : "Live");
      this.refreshComposer();
      this.fit();
    };
    ws.onmessage = (e) => {
      if (!this.disposed && e.data instanceof ArrayBuffer)
        this.terminal.write(new Uint8Array(e.data), () => this.readScreen());
    };
    ws.onclose = () => {
      if (this.disposed) return;
      if (this.session.status === "stopped") {
        this.status("Stopped");
        return;
      }
      this.status("Reconnecting");
      this.timer = setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
  }
  private input(data: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "input", data }));
    return true;
  }
  private refreshComposer(): void {
    const chat = this.appearance.view === "agent";
    this.message.setAttribute(
      "aria-label",
      `${chat ? "Message to" : "Command for"} ${this.session.name}`,
    );
    const provider = this.session.program === "codex" ? "Codex" : "Claude";
    this.message.placeholder = chat
      ? this.activity?.canMessage
        ? `Message ${provider}…`
        : `Finish ${provider} setup in Terminal…`
      : "Run a shell command or send terminal input…";
    this.commands?.setEnabled(chat && !!this.activity?.canMessage);
    const canSend =
      !this.images?.busy &&
      this.connection.textContent === "Live" &&
      (!chat || this.activity?.canMessage);
    this.message.setAttribute(
      "aria-description",
      canSend
        ? "Enter to send. Shift+Enter for a new line."
        : "You can write a draft. Sending is not available yet.",
    );
  }

  private async submit(): Promise<void> {
    const text = this.message.value;
    const attachments = this.images.snapshot();
    if (
      (!text.trim() && !attachments.length) ||
      this.images.busy ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    if (attachments.length && this.appearance.view !== "agent") {
      this.agent.showError("Switch to Chat to send your attached images.");
      this.setView("agent");
      return;
    }
    if (this.appearance.view === "agent") {
      if (!this.activity?.canMessage) {
        this.agent.showError(
          "The agent is not ready. Open Terminal to complete setup or check its prompt.",
        );
        return;
      }
      this.agent.showError("");
      if (isSlashCommand(text)) {
        if (attachments.length) {
          this.agent.showError(
            "Send your attached images in a separate message before running a command.",
          );
          return;
        }
        await this.runSlashCommand(text);
        return;
      }
      const message = this.images.message(text, attachments);
      // Commit the visual send in one frame. Network acknowledgement must not
      // clear/resize the composer a second time during the bubble's entrance.
      this.message.value = "";
      this.saveDraft("");
      this.images.detach(attachments);
      this.resizeComposer();
      const pendingId = this.agent.beginMessage(message);
      this.fit();
      this.focus();
      // Accept rapid follow-ups immediately, but deliver them to the PTY in
      // order. An in-flight request must not swallow the next Enter press.
      this.pendingDeliveries++;
      const delivery = this.deliveryQueue.then(() =>
        api(
          `/terminals/${this.session.id}/message`,
          "POST",
          this.session.program === "codex"
            ? { text, images: attachments.map((item) => item.path) }
            : { text: message },
        ),
      );
      this.deliveryQueue = delivery.catch(() => {});
      try {
        // The server rechecks the foreground process on every chat submission.
        await delivery;
        this.agent.finishMessage(pendingId, true);
        this.images.release(attachments);
        clearTimeout(this.activityTimer);
        if (!this.activityRequest && this.viewVisible) void this.pollActivity();
      } catch (error) {
        // Keep anything typed while sending and recover the failed draft too.
        this.message.value = this.message.value
          ? `${text}\n\n${this.message.value}`
          : text;
        this.saveDraft(this.message.value);
        this.images.restore(attachments);
        this.resizeComposer();
        this.fit();
        this.agent.finishMessage(pendingId, false);
        this.agent.showError(
          error instanceof Error ? error.message : String(error),
        );
        return;
      } finally {
        this.pendingDeliveries--;
      }
      return;
    } else {
      this.terminal.paste(text);
      this.input("\r");
    }
    if (this.message.value === text) {
      this.message.value = "";
      this.saveDraft("");
      this.resizeComposer();
      this.fit();
    }
    this.focus();
  }
  private async runSlashCommand(text: string): Promise<void> {
    this.message.value = "";
    this.saveDraft("");
    this.commands.hide();
    this.resizeComposer();
    this.pendingDeliveries++;
    const delivery = this.deliveryQueue.then(() =>
      api(`/terminals/${this.session.id}/message`, "POST", {
        text: text.trim(),
      }),
    );
    this.deliveryQueue = delivery.catch(() => {});
    // CLI commands often open interactive menus and never produce a chat receipt.
    // Show the actual terminal and avoid a permanently pending chat bubble.
    this.setView("terminal");
    try {
      await delivery;
    } catch (error) {
      this.message.value = this.message.value
        ? `${text}\n\n${this.message.value}`
        : text;
      this.saveDraft(this.message.value);
      this.resizeComposer();
      this.setView("agent", this.element.contains(document.activeElement));
      this.saveAppearance();
      this.agent.showError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.pendingDeliveries--;
    }
  }
  setTeamPlan(title: string, count: number, review?: () => void): void {
    let notice =
      this.element.querySelector<HTMLButtonElement>(".head-plan-notice");
    if (!review) {
      notice?.remove();
      return;
    }
    if (!notice) {
      notice = button("Team details", () => {}, "head-plan-notice");
      this.element.querySelector(".pane-header")?.after(notice);
    }
    notice.textContent = `Team · ${count} agents · ${title} → Details`;
    notice.onclick = review;
  }
  prepareMessage(text: string): void {
    // Preserve an unfinished user draft and append the connection instructions.
    this.message.value = this.message.value.trim()
      ? `${this.message.value}\n\n${text}`
      : text;
    this.saveDraft(this.message.value);
    this.resizeComposer();
    this.setView("agent");
    this.message.focus();
  }
  private resizeComposer(): boolean {
    if (this.appearance.view !== "agent" || !this.message.clientWidth)
      return false;
    let changed = false;
    const style = getComputedStyle(this.message);
    const key = JSON.stringify([
      this.message.value,
      this.message.clientWidth,
      style.fontSize,
      style.lineHeight,
      style.fontFamily,
    ]);
    if (key !== this.composerMeasureKey) {
      this.composerMeasureKey = key;
      // Measure away from the live layout: collapsing the textarea to zero on
      // every keystroke shifts the viewport and makes terminal TUIs repaint.
      for (const property of [
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "line-height",
        "letter-spacing",
        "word-spacing",
        "padding-top",
        "padding-bottom",
        "padding-left",
        "padding-right",
      ]) {
        this.composerMeasure.style.setProperty(
          property,
          style.getPropertyValue(property),
        );
      }
      this.composerMeasure.style.width = `${this.message.clientWidth}px`;
      this.composerMeasure.textContent = this.message.value + "\u200b";
      const height = `${Math.max(30, Math.ceil(this.composerMeasure.getBoundingClientRect().height))}px`;
      if (this.message.style.height !== height) {
        this.message.style.height = height;
        changed = true;
      }
      this.message.scrollTop = 0;
    }
    // Long drafts scroll with the pane rather than inside a tiny input box.
    const long = this.message.offsetHeight + 180 > this.element.clientHeight;
    if (this.element.classList.contains("has-long-draft") !== long) {
      this.element.classList.toggle("has-long-draft", long);
      changed = true;
    }
    if (!this.message.value) this.element.scrollTop = 0;
    return changed;
  }
  fit(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (
        this.disposed ||
        !this.element.isConnected ||
        !this.element.clientWidth ||
        !this.element.clientHeight
      )
        return;
      this.resizeComposer();
      this.restoringTerminalScroll = true;
      const dimensions = this.fitAddon.proposeDimensions();
      if (
        dimensions &&
        (dimensions.cols !== this.terminal.cols ||
          dimensions.rows !== this.terminal.rows)
      )
        this.fitAddon.fit();
      if (this.terminalScroll.follow) this.terminal.scrollToBottom();
      else this.terminal.scrollToLine(this.terminalScroll.top);
      this.restoringTerminalScroll = false;
      this.agent.reflow();
      const size = `${this.terminal.cols}x${this.terminal.rows}`;
      if (
        this.socket?.readyState === WebSocket.OPEN &&
        size !== this.lastSentSize
      ) {
        this.lastSentSize = size;
        this.socket.send(
          JSON.stringify({
            type: "resize",
            cols: this.terminal.cols,
            rows: this.terminal.rows,
          }),
        );
      }
    });
  }
  private updateTheme = (): void => {
    this.terminal.options.theme = terminalTheme();
  };
  setFontSize(size: number): void {
    this.element.style.setProperty("--content-font-size", `${size}px`);
    this.terminal.options.fontSize = size;
    this.fit();
  }
  selection(): string {
    return this.terminal.getSelection();
  }
  focus(): void {
    if (this.appearance.view === "agent")
      this.message.focus({ preventScroll: true });
    else this.terminal.focus();
  }
  dispose(): void {
    window.removeEventListener("workspace-theme", this.updateTheme);
    this.images.dispose();
    this.disposed = true;
    this.hostedApps.dispose();
    this.pullRequest.dispose();
    this.composerMeasure.remove();
    this.agent.dispose();
    clearTimeout(this.timer);
    clearTimeout(this.activityTimer);
    clearTimeout(this.screenTimer);
    this.activityRequest?.abort();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.socket?.close();
    this.terminal.dispose();
    this.element.remove();
  }
  get hasPendingSend(): boolean {
    return this.pendingDeliveries > 0;
  }
}
