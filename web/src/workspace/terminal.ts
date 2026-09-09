import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { reveal } from "./motion";
import conversationIcon from "../../assets/icons/conversation.svg";
import terminalIcon from "../../assets/icons/terminal.svg";
import { button, el } from "./dom";
import type { Project, Session } from "./types";
import { AgentView, type Activity } from "./agent-view";
import {
  creature,
  defaultCreature,
  chooseCreature,
  terminalColor,
} from "./creature";
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
  private send: HTMLButtonElement;
  private currentStatus = "";
  private activity?: Activity;
  private sending = false;
  private frame = 0;
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
      view: session.program === "codex" ? "terminal" : "agent",
      creature: defaultCreature(session.id),
      color: terminalColor(session.id),
    };
    this.element.style.setProperty("--terminal-color", this.appearance.color);
    this.agent = new AgentView(
      this.appearance.creature,
      session.id,
      () => this.setView("terminal"),
      actions.startAgent,
    );
    this.saveDraft = actions.draft;
    this.message.value = draft;
    this.message.addEventListener("input", () =>
      this.saveDraft(this.message.value),
    );
    this.element.dataset.terminalId = session.id;
    const header = el("header", "pane-header");
    header.draggable = true;
    const identity = el("div", "pane-identity");
    const avatar = button(
      "Customize terminal",
      () =>
        chooseCreature(
          this.appearance.creature,
          (name) => {
            this.appearance.creature = name;
            avatar.replaceChildren(creature(name));
            this.agent.setCreature(name);
            actions.appearance({ ...this.appearance });
          },
          this.appearance.color,
          (color) => {
            this.appearance.color = color;
            this.element.style.setProperty("--terminal-color", color);
            actions.appearance({ ...this.appearance });
          },
        ),
      "pane-creature",
      "",
    );
    avatar.append(creature(this.appearance.creature));
    identity.append(
      avatar,
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
    header.append(identity, controls);
    const context = el("div", "pane-context");
    const tree = project.worktrees.find((w) => w.path === session.path);
    this.connection.hidden = true;
    context.append(this.agent.heading, this.connection);
    context.title = `Branch: ${tree?.branch || "detached"}\n${session.path}`;
    const switcher = el("div", "view-switcher");
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Pane view");
    this.agentButton = button(
      "Agent view",
      () => this.setView("agent"),
      "view-button",
      "",
    );
    this.terminalButton = button(
      "Terminal view",
      () => this.setView("terminal"),
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
    context.append(switcher);
    const surface = el("div", "pane-surface");
    surface.append(this.host, this.agent.element);
    const composer = el("form", "composer");
    this.message.rows = 1;
    this.message.spellcheck = false;
    this.message.setAttribute("autocorrect", "off");
    this.message.setAttribute("autocapitalize", "off");
    this.message.placeholder = "Send a command or message…";
    this.refreshComposer();
    this.send = button("Send message", () => this.submit(), "send-button", "↑");
    this.send.disabled = true;
    this.message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    composer.onsubmit = (e) => {
      e.preventDefault();
      this.submit();
    };
    composer.append(this.message, this.send);
    this.element.append(header, context, surface, composer);
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: "monospace",
      lineHeight: 1.25,
      scrollback: 10000,
      allowProposedApi: false,
      // Preserve the terminal's ANSI palette and program styling.
      theme: { background: "#2e2f38" },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.host);
    this.terminal.onData((data) => this.input(data));
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
    document.fonts
      .load(`${fontSize}px "Google Sans Code"`)
      .then(() => {
        if (this.disposed) return;
        this.terminal.options.fontFamily = '"Google Sans Code", monospace';
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
    this.pollActivity();
  }
  update(session: Session): void {
    const previous = this.currentStatus;
    this.session = session;
    this.currentStatus = session.status;
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
      this.send.disabled = true;
    }
    if (session.status === "stopped") {
      this.socket?.close();
      this.status("Stopped");
    } else if (previous === "stopped") {
      this.connect();
    }
  }
  private setView(view: "agent" | "terminal", focus = true): void {
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
        this.element.isConnected &&
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
        }
      }
    } catch {
      if (!this.disposed) {
        this.activity = undefined;
        this.agent.unavailable();
        this.refreshComposer();
      }
    }
    if (!this.disposed)
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
      this.send.disabled = true;
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
    this.message.placeholder = chat
      ? this.session.program === "codex"
        ? "Open Terminal to interact with Codex…"
        : this.activity?.canMessage
          ? "Message Claude…"
          : "Start Claude to send messages…"
      : "Run a shell command or send terminal input…";
    if (this.send) {
      this.send.disabled =
        this.sending ||
        this.connection.textContent !== "Live" ||
        (chat && !this.activity?.canMessage);
      this.send.setAttribute(
        "aria-label",
        chat ? "Send message" : "Send terminal input",
      );
      this.send.title = chat
        ? "Send message to Claude"
        : "Send input to terminal";
    }
  }
  private async submit(): Promise<void> {
    const text = this.message.value;
    if (
      !text.trim() ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.sending
    )
      return;
    if (this.appearance.view === "agent") {
      if (!this.activity?.canMessage) {
        this.agent.showError(
          this.session.program === "codex"
            ? "Open Terminal to interact with Codex."
            : "No agent is connected. Start Claude to send this message.",
        );
        return;
      }
      this.sending = true;
      this.refreshComposer();
      this.agent.showError("");
      try {
        // The server rechecks the foreground process on every chat submission.
        await api(`/terminals/${this.session.id}/message`, "POST", { text });
      } catch (error) {
        this.agent.showError(
          error instanceof Error ? error.message : String(error),
        );
        return;
      } finally {
        this.sending = false;
        this.refreshComposer();
      }
    } else {
      this.terminal.paste(text);
      this.input("\r");
    }
    if (this.message.value === text) {
      this.message.value = "";
      this.saveDraft("");
    }
    this.focus();
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
      this.fitAddon.fit();
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(
          JSON.stringify({
            type: "resize",
            cols: this.terminal.cols,
            rows: this.terminal.rows,
          }),
        );
    });
  }
  setFontSize(size: number): void {
    this.element.style.setProperty("--content-font-size", `${size}px`);
    this.terminal.options.fontSize = size;
    this.fit();
  }
  selection(): string {
    return this.terminal.getSelection();
  }
  focus(): void {
    if (this.appearance.view === "agent") this.message.focus();
    else this.terminal.focus();
  }
  dispose(): void {
    this.disposed = true;
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
}
