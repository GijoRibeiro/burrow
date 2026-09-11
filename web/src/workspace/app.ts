import "./workspace.css";
import { captureLayout } from "./motion";
import { nextColor, nextCreature } from "./appearance";
import { renderProjectList } from "./sidebar";
import { renderSplitTree } from "./split-view";
import { api } from "./api";
import { badge, button, dialog, el } from "./dom";
import {
  arrange,
  ids,
  insert,
  parseLayout,
  remove,
  swap,
  type Axis,
  type Tree,
} from "./layout";
import {
  creature,
  defaultCreature,
  creatures,
  terminalColor,
  validColor,
} from "./creature";
import { TerminalPane, type PaneAppearance } from "./terminal";
import type { Project, Session, Workspace } from "./types";

const STORAGE = "cloovies.workspace.layout.v1";
class WorkspaceApp {
  private state: Workspace = {
    version: 1,
    projects: [],
    terminals: [],
    tmuxAvailable: true,
  };
  private tree: Tree | null = null;
  private active: string | null = null;
  private zoomed: string | null = null;
  private panes = new Map<string, TerminalPane>();
  private sidebar = el("aside", "sidebar");
  private projects = el("div", "project-list");
  private canvas = el("main", "canvas");
  private status = el("span", "server-status", "Connecting…");
  private count = el("span", "workspace-count");
  private footer = el("span", "footer-state");
  private alert = el("div", "alert");
  private search = el("input", "project-search");
  private initialized = false;
  private signature = "";
  private selectedProject = "";
  private selectedPath = "";
  private collapsed = new Set<string>();
  private fontSize = 14;
  private polling = false;
  private revision = 0;
  private canvasKey = "";
  private drafts: Record<string, string> = {};
  private appearances: Record<string, PaneAppearance> = {};
  constructor() {
    const root = document.querySelector("#workspace")!;
    const brand = el("div", "brand");
    brand.append(
      creature("Grook", "brand-symbol"),
      el("span", "brand-name", "cloovies"),
      badge("WORKSPACE"),
    );
    const sideHeading = el("div", "sidebar-heading");
    sideHeading.append(
      el("span", "", "PROJECTS"),
      button("Add project", () => this.addProject(), "icon-button", "+"),
    );
    this.search.placeholder = "Find projects or terminals";
    this.search.setAttribute("aria-label", "Find projects or terminals");
    this.search.oninput = () => this.renderSidebar();
    const sideBottom = el("div", "sidebar-bottom");
    const legacy = button(
      "Keyboard shortcuts",
      () => this.help(),
      "legacy-link",
      "Keyboard shortcuts  ⌘?",
    );
    sideBottom.append(
      button(
        "Add project",
        () => this.addProject(),
        "secondary add-project",
        "+  Add project",
      ),
      legacy,
    );
    this.sidebar.append(
      brand,
      sideHeading,
      this.search,
      this.projects,
      sideBottom,
    );
    const body = el("div", "workspace-body");
    const toolbar = el("header", "toolbar");
    const title = el("div", "workspace-title");
    title.append(
      button(
        "Toggle sidebar",
        () => this.toggleSidebar(),
        "icon-button sidebar-toggle",
        "☰",
      ),
      el("h1", "", "Workspace"),
      this.count,
    );
    const tools = el("div", "toolbar-actions");
    const presets = el("div", "layout-presets");
    presets.append(
      button(
        "Arrange in columns",
        () => this.preset("columns"),
        "icon-button",
        "▥",
      ),
      button("Arrange in rows", () => this.preset("rows"), "icon-button", "▤"),
      button("Arrange in grid", () => this.preset("grid"), "icon-button", "▦"),
    );
    tools.append(
      presets,
      button(
        "Decrease text size (⌘−)",
        () => this.font(-1),
        "icon-button font-button",
        "A−",
      ),
      button(
        "Increase text size (⌘+)",
        () => this.font(1),
        "icon-button font-button",
        "A+",
      ),
      button(
        "Choose terminals",
        () => this.choose(),
        "secondary",
        "Choose terminals",
      ),
      button(
        "New terminal",
        () => this.newTerminal(),
        "primary",
        "+  Terminal",
      ),
    );
    toolbar.append(title, tools);
    this.alert.setAttribute("role", "alert");
    this.alert.hidden = true;
    const bottom = el("footer", "workspace-footer");
    const hint = el(
      "span",
      "footer-hint",
      "Drag headers to swap · ⌘K choose terminals · ⌘↵ focus pane",
    );
    bottom.append(this.status, this.footer, hint);
    body.append(toolbar, this.alert, this.canvas, bottom);
    root.append(this.sidebar, body);
    document.addEventListener("keydown", (e) => this.shortcut(e), true);
    window.addEventListener("beforeunload", () => this.persist());
    Object.assign(window, {
      clooviesCommand: (command: string) => this.command(command),
      clooviesSelectedText: () => {
        if (!document.activeElement?.closest(".terminal-host")) return "";
        return this.panes.get(this.active || "")?.selection() || "";
      },
    });
    this.refresh();
    setInterval(() => this.refresh(), 3000);
  }
  private error(err: unknown): void {
    this.alert.textContent = err instanceof Error ? err.message : String(err);
    this.alert.hidden = false;
  }
  private async refresh(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const revision = this.revision;
    try {
      const state = await api<Workspace>();
      if (revision !== this.revision) return;
      const signature = JSON.stringify(state);
      this.state = state;
      this.status.textContent = "●  Connected";
      this.status.dataset.online = "true";
      if (!this.initialized) {
        try {
          const saved = JSON.parse(localStorage.getItem(STORAGE) || "{}");
          this.tree = parseLayout(
            saved.tree,
            new Set(state.terminals.map((t) => t.id)),
          );
          if (saved.drafts && typeof saved.drafts === "object") {
            for (const [id, value] of Object.entries(saved.drafts)) {
              if (
                typeof value === "string" &&
                state.terminals.some((t) => t.id === id)
              )
                this.drafts[id] = value;
            }
          }
          if (saved.appearances && typeof saved.appearances === "object") {
            for (const [id, value] of Object.entries(saved.appearances)) {
              const a = value as Partial<PaneAppearance> | null;
              if (
                a &&
                (a.view === "agent" || a.view === "terminal") &&
                typeof a.creature === "string" &&
                creatures.includes(a.creature) &&
                state.terminals.some((t) => t.id === id)
              )
                this.appearances[id] = {
                  view: a.view,
                  creature: a.creature,
                  color: validColor(a.color) ? a.color : terminalColor(id),
                };
            }
          }
          this.ensureAppearances(saved.appearanceVersion !== 2);
          this.active = typeof saved.active === "string" ? saved.active : null;
          this.fontSize = Math.min(
            22,
            Math.max(10, Number(saved.fontSize) || 14),
          );
        } catch {
          /* An invalid layout leaves an empty canvas, never loses sessions. */
        }
        this.initialized = true;
        this.ensureAppearances();
        this.persist();
      }
      if (signature !== this.signature) {
        this.signature = signature;
        this.ensureAppearances();
        this.persist();
        const allowed = new Set(state.terminals.map((t) => t.id));
        for (const id of ids(this.tree))
          if (!allowed.has(id)) this.tree = remove(this.tree, id);
        this.renderSidebar();
        this.renderCanvas();
      }
      if (!state.tmuxAvailable)
        this.error(
          "Install tmux to start terminals. On macOS: brew install tmux",
        );
    } catch (err) {
      this.status.textContent = "●  Offline · retrying";
      this.status.dataset.online = "false";
      if (!this.initialized) this.error(err);
    } finally {
      this.polling = false;
    }
  }
  private ensureAppearances(repair = false): void {
    const colors: string[] = [],
      names: string[] = [];
    // Reserve saved identities before allocating any newly discovered sessions.
    const sessions = [...this.state.terminals].sort(
      (a, b) =>
        Number(!!this.appearances[b.id]) - Number(!!this.appearances[a.id]),
    );
    for (const terminal of sessions) {
      const appearance = this.appearances[terminal.id];
      const color =
        appearance && !(repair && colors.includes(appearance.color))
          ? appearance.color
          : nextColor(colors);
      const name =
        appearance && !(repair && names.includes(appearance.creature))
          ? appearance.creature
          : nextCreature(names);
      this.appearances[terminal.id] = {
        view:
          appearance?.view ||
          (terminal.program === "codex" ? "terminal" : "agent"),
        color,
        creature: name,
      };
      colors.push(color);
      names.push(name);
    }
  }
  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          tree: this.tree,
          active: this.active,
          fontSize: this.fontSize,
          drafts: this.drafts,
          appearances: this.appearances,
          appearanceVersion: 2,
        }),
      );
    } catch {
      this.error(
        "Layout could not be saved in this browser. Terminal sessions are still safe.",
      );
    }
  }
  private change(): void {
    this.zoomed = null;
    this.persist();
    this.renderSidebar();
    this.renderCanvas();
  }
  private async mutate<T>(
    path: string,
    method: string,
    data?: unknown,
  ): Promise<T> {
    this.revision++;
    const result = await api<T>(path, method, data);
    this.revision++;
    this.alert.hidden = true;
    // A mutation must await a fresh snapshot even if a periodic poll is in flight.
    this.state = await api<Workspace>();
    this.signature = JSON.stringify(this.state);
    this.ensureAppearances();
    this.persist();
    this.renderSidebar();
    this.renderCanvas();
    return result;
  }
  private renderSidebar(): void {
    renderProjectList({
      projects: this.projects,
      state: this.state,
      search: this.search,
      tree: this.tree,
      active: this.active,
      selectedPath: this.selectedPath,
      collapsed: this.collapsed,
      renderSidebar: () => this.renderSidebar(),
      terminalColor: (id) => this.appearances[id]?.color || terminalColor(id),
      creatureName: (id) =>
        this.appearances[id]?.creature || defaultCreature(id),
      newWorktree: (p) => this.newWorktree(p),
      removeProject: (p) => this.removeProject(p),
      newTerminal: (p, path) => this.newTerminal(p, path),
      removeWorktree: (p, path, name) => this.removeWorktree(p, path, name),
      select: (p, path) => {
        this.selectedProject = p;
        this.selectedPath = path;
        this.renderSidebar();
      },
      hide: (id) => this.hide(id),
      show: (id) => this.show(id),
      renameTerminal: (id) => this.rename(id),
      stopTerminal: (id) => this.stop(id),
      restartTerminal: (id) => this.restart(id),
      focusTerminal: (id) => this.focusPane(id),
      removeTerminal: async (id) => {
        await this.mutate(`/terminals/${id}`, "PATCH", { action: "remove" });
        this.tree = remove(this.tree, id);
        this.change();
      },
    });
  }
  private renderCanvas(): void {
    const visible = new Set(ids(this.tree));
    if (!visible.has(this.zoomed || "")) this.zoomed = null;
    // Status updates must not detach focused inputs or interrupt typing.
    // Divider changes already update the DOM, so ratios do not affect this key.
    const key = JSON.stringify(
      {
        tree: this.tree,
        zoomed: this.zoomed,
        empty: this.tree
          ? null
          : [this.state.projects.length, this.state.terminals.length],
      },
      (name, value) => (name === "ratio" ? undefined : value),
    );
    const animate =
      key !== this.canvasKey
        ? captureLayout(
            this.canvas,
            this.zoomed ? new Set([this.zoomed]) : visible,
          )
        : () => {};
    for (const [id, pane] of this.panes) {
      if (!visible.has(id)) {
        pane.dispose();
        this.panes.delete(id);
      }
    }
    for (const t of this.state.terminals) {
      if (!visible.has(t.id)) continue;
      let pane = this.panes.get(t.id);
      if (!pane) {
        const project = this.state.projects.find((p) => p.id === t.projectId);
        if (!project) continue;
        pane = new TerminalPane(
          t,
          project,
          {
            startAgent: async (program) => {
              const next = await this.mutate<Session>("/terminals", "POST", {
                projectId: t.projectId,
                path: t.path,
                name: `${program === "claude" ? "Claude" : "Codex"} · ${t.name}`,
                program,
              });
              this.drafts[next.id] = this.drafts[t.id] || "";
              delete this.drafts[t.id];
              this.tree = insert(this.tree, next.id, t.id, "row");
              this.tree = remove(this.tree, t.id);
              this.active = next.id;
              this.change();
              this.panes.get(next.id)?.focus();
            },
            appearance: (value) => {
              this.appearances[t.id] = value;
              this.persist();
              this.renderSidebar();
            },
            draft: (value) => {
              if (value) this.drafts[t.id] = value;
              else delete this.drafts[t.id];
              this.persist();
            },
            focus: () => this.activate(t.id),
            hide: () => this.hide(t.id),
            zoom: () => this.zoom(t.id),
            split: (axis) => this.choose(t.id, axis),
            rename: () => this.rename(t.id),
            stop: () => this.stop(t.id),
            restart: () => this.restart(t.id),
            drop: (id) => {
              if (this.tree && id !== t.id && visible.has(id)) {
                this.tree = swap(this.tree, id, t.id);
                this.change();
              }
            },
          },
          this.fontSize,
          this.drafts[t.id] || "",
          this.appearances[t.id],
        );

        this.panes.set(t.id, pane);
      }
      pane.update(t);
    }
    if (!visible.has(this.active || ""))
      this.active = ids(this.tree)[0] || null;
    if (!visible.has(this.zoomed || "")) this.zoomed = null;
    if (key !== this.canvasKey) {
      this.canvasKey = key;
      // Move existing pane nodes; never recreate terminals on a layout change.
      this.canvas.replaceChildren();
      if (this.tree) {
        if (this.zoomed) {
          const pane = this.panes.get(this.zoomed);
          if (pane) this.canvas.append(pane.element);
        } else
          this.canvas.append(
            renderSplitTree(this.tree, this.panes, () => this.persist()),
          );
      } else this.renderEmpty();
      animate();
    }
    this.count.textContent = `${visible.size} on screen`;
    const running = this.state.terminals.filter(
      (t) => t.status === "running",
    ).length;
    this.footer.textContent = `${this.state.projects.length} projects · ${running} running · ${this.state.terminals.filter((t) => t.status === "running" && !visible.has(t.id)).length} in background${this.zoomed ? " · focused view" : ""}`;
    this.paintFocus();
    for (const pane of this.panes.values()) pane.fit();
  }
  private renderEmpty(): void {
    const empty = el("div", "empty-workspace");
    const diagram = el("div", "empty-diagram");
    for (const [i, label] of [
      "checkout",
      "newbit",
      "your next idea",
    ].entries()) {
      const tile = el("div", `empty-tile tile-${i}`);
      tile.append(
        creature(["Grook", "ghost", "crab"][i]),
        el("span", "", label),
        el("div", "fake-line"),
        el("div", "fake-line short"),
      );
      diagram.append(tile);
    }
    empty.append(
      badge("ONE CANVAS. EVERY PROJECT.", "eyebrow"),
      el("h2", "", "Make room for your work."),
      el(
        "p",
        "",
        "A shell here. An agent there. Bring terminals from any project into one space, arranged your way.",
      ),
      diagram,
    );
    const actions = el("div", "empty-actions");
    if (!this.state.projects.length)
      actions.append(
        button("Add your first project", () => this.addProject(), "primary"),
      );
    else {
      actions.append(
        button(
          "New terminal",
          () => this.newTerminal(),
          "primary",
          "+  New terminal",
        ),
      );
      if (this.state.terminals.length)
        actions.append(
          button("Choose existing terminals", () => this.choose(), "secondary"),
        );
    }
    empty.append(
      actions,
      el(
        "p",
        "empty-note",
        "Terminals keep running when you hide them or close the app.",
      ),
    );
    this.canvas.append(empty);
  }
  private show(id: string, target = this.active, axis: Axis = "row"): void {
    this.tree = insert(this.tree, id, target, axis);
    this.active = id;
    this.change();
    this.panes.get(id)?.focus();
  }
  private hide(id: string): void {
    this.tree = remove(this.tree, id);
    this.change();
  }
  private activate(id: string): void {
    if (this.active === id) return;
    this.active = id;
    this.paintFocus();
    this.persist();
  }
  private paintFocus(): void {
    for (const row of this.projects.querySelectorAll<HTMLElement>(
      ".session-row",
    ))
      row.classList.toggle("active", row.dataset.sessionId === this.active);
    for (const [id, pane] of this.panes)
      pane.element.classList.toggle("focused", id === this.active);
  }
  private zoom(id: string): void {
    this.zoomed = this.zoomed === id ? null : id;
    this.active = id;
    this.renderCanvas();
    this.panes.get(id)?.focus();
  }
  private preset(mode: "columns" | "rows" | "grid"): void {
    this.tree = arrange(ids(this.tree), mode);
    this.change();
  }
  private font(delta: number): void {
    this.fontSize = Math.max(10, Math.min(22, this.fontSize + delta));
    for (const p of this.panes.values()) p.setFontSize(this.fontSize);
    this.persist();
  }
  private addProject(): void {
    dialog(
      "Add a project",
      "Choose a local Git repository. Its existing worktrees will appear automatically.",
      [
        {
          name: "path",
          label: "Project folder",
          placeholder: "/Users/you/Code/checkout",
        },
        {
          name: "name",
          label: "Display name (optional)",
          placeholder: "Use folder name",
          required: false,
        },
      ],
      "Add project",
      async (values) => {
        const p = await this.mutate<Project>("/projects", "POST", values);
        this.selectedProject = p.id;
        this.selectedPath = p.path;
        this.renderSidebar();
      },
    );
  }
  private newWorktree(p: Project): void {
    dialog(
      "Create a worktree",
      `A separate checkout inside ${p.path}/.worktrees, with its own branch.`,
      [
        {
          name: "name",
          label: "Worktree and branch name",
          placeholder: "redesign",
        },
        { name: "base", label: "Start from", value: "HEAD" },
      ],
      "Create worktree",
      async (values) => {
        await this.mutate(`/projects/${p.id}/worktrees`, "POST", values);
      },
    );
  }
  private newTerminal(
    projectId = this.selectedProject,
    path = this.selectedPath,
    target = this.active,
    axis: Axis = "row",
  ): void {
    if (!this.state.projects.length) {
      this.addProject();
      return;
    }
    const options = this.state.projects.flatMap((p) =>
      p.worktrees.map((w) => ({
        value: JSON.stringify([p.id, w.path]),
        label: `${p.name} / ${w.main ? "main checkout" : w.name} · ${w.branch || "detached"}`,
      })),
    );
    if (!options.length) {
      this.error("No available project folders. Add a Git repository first.");
      return;
    }
    dialog(
      "New terminal",
      "Choose Claude Code, Codex, or a shell. Agents start in YOLO mode.",
      [
        {
          name: "folder",
          label: "Project / worktree",
          options,
          value: options.some(
            (o) => o.value === JSON.stringify([projectId, path]),
          )
            ? JSON.stringify([projectId, path])
            : options[0].value,
        },
        {
          name: "program",
          label: "Run",
          value: "claude",
          options: [
            { value: "claude", label: "Claude Code — YOLO" },
            { value: "codex", label: "Codex — YOLO" },
            { value: "shell", label: "Shell — commands and other programs" },
          ],
        },
        {
          name: "name",
          label: "Terminal name",
          value: `Terminal ${this.state.terminals.length + 1}`,
        },
      ],
      "Start terminal",
      async (values) => {
        const [projectId, path] = JSON.parse(values.folder);
        const t = await this.mutate<Session>("/terminals", "POST", {
          projectId,
          path,
          name: values.name,
          program: values.program,
        });
        this.appearances[t.id].view =
          values.program === "claude" ? "agent" : "terminal";
        this.show(t.id, target, axis);
      },
    );
  }
  private choose(target = this.active, axis: Axis = "row"): void {
    const d = el("dialog", "dialog terminal-picker");
    const head = el("div", "picker-heading");
    head.append(
      el("h2", "", "Choose terminals"),
      button("Close terminal picker", () => d.close(), "icon-button", "×"),
    );
    const search = el("input", "picker-search");
    search.placeholder = "Search all projects and terminals…";
    search.setAttribute("aria-label", "Search terminals");
    const list = el("div", "picker-list");
    const render = () => {
      list.replaceChildren();
      const visible = new Set(ids(this.tree));
      for (const t of this.state.terminals) {
        const p = this.state.projects.find((p) => p.id === t.projectId);
        const w = p?.worktrees.find((w) => w.path === t.path);
        const detail = `${p?.name} / ${w?.main ? "main checkout" : w?.name || t.path}`;
        if (
          !`${detail} ${t.name}`
            .toLowerCase()
            .includes(search.value.toLowerCase())
        )
          continue;
        const b = button(
          `${visible.has(t.id) ? "Hide" : "Show"} ${t.name}`,
          () => {
            visible.has(t.id) ? this.hide(t.id) : this.show(t.id, target, axis);
            render();
          },
          "picker-item",
          "",
        );
        b.style.setProperty(
          "--terminal-color",
          this.appearances[t.id]?.color || terminalColor(t.id),
        );
        const text = el("span", "picker-item-text");
        text.append(el("strong", "", t.name), el("small", "", detail));
        b.append(
          creature(this.appearances[t.id]?.creature || defaultCreature(t.id)),
          text,
          badge(visible.has(t.id) ? "ON SCREEN" : t.status.toUpperCase()),
        );
        list.append(b);
      }
      if (!list.childElementCount)
        list.append(
          el(
            "p",
            "sidebar-empty",
            "No matching terminals. Start a new one below.",
          ),
        );
    };
    search.oninput = render;
    render();
    d.append(
      head,
      el(
        "p",
        "dialog-description",
        "Mix projects freely. Hiding a terminal keeps its process running.",
      ),
      search,
      list,
      button(
        "New terminal",
        () => {
          d.close();
          this.newTerminal(
            this.selectedProject,
            this.selectedPath,
            target,
            axis,
          );
        },
        "primary",
        "+  New terminal",
      ),
    );
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }
  private rename(id: string): void {
    const t = this.state.terminals.find((t) => t.id === id)!;
    dialog(
      "Rename terminal",
      "Give this session a name you can find at a glance.",
      [{ name: "name", label: "Name", value: t.name }],
      "Save name",
      async (values) => {
        await this.mutate(`/terminals/${id}`, "PATCH", {
          action: "rename",
          name: values.name,
        });
      },
    );
  }
  private stop(id: string): void {
    const t = this.state.terminals.find((t) => t.id === id)!;
    dialog(
      `Stop ${t.name}?`,
      "This ends the shell and its running processes. To keep it running, cancel and use Hide terminal instead.",
      [],
      "Stop terminal",
      async () => {
        await this.mutate(`/terminals/${id}`, "PATCH", { action: "stop" });
      },
      true,
    );
  }
  private restart(id: string): void {
    this.mutate(`/terminals/${id}`, "PATCH", { action: "restart" }).catch(
      (err) => this.error(err),
    );
  }
  private removeProject(p: Project): void {
    dialog(
      `Remove ${p.name}?`,
      "Removes the project from this workspace. Files and Git worktrees stay on disk. Remove its terminal sessions first.",
      [],
      "Remove project",
      async () => {
        await this.mutate(`/projects/${p.id}`, "DELETE");
      },
      true,
    );
  }
  private removeWorktree(p: Project, path: string, name: string): void {
    dialog(
      `Remove ${name}?`,
      "Removes this checkout from disk. Git will refuse if there are uncommitted changes. The branch is retained. Stop its terminals first.",
      [],
      "Remove worktree",
      async () => {
        await this.mutate(`/projects/${p.id}/worktrees`, "DELETE", { path });
      },
      true,
    );
  }
  private help(): void {
    dialog(
      "Your workspace, from the keyboard",
      "Tab / Shift+Tab: next / previous pane · ⌘K: choose terminals · ⌘⇧N: new terminal · ⌘B: sidebar · ⌘Enter: focus pane · ⌘1–9: select pane · ⌘+/−: text size · ⌘0: reset text size · ⌘?: shortcuts. On Linux use Ctrl+Shift. Drag headers to swap terminals. Drag a divider to resize; double-click to balance it. Scroll in a terminal to browse history; press Q to return to the prompt. Hold Shift while dragging to select text, then ⌘C to copy. Shift+Enter adds a line to a message.",
      [],
      "Got it",
      async () => {},
    );
  }
  private toggleSidebar(): void {
    document.body.classList.toggle("sidebar-hidden");
  }
  private focusPane(id: string): void {
    this.activate(id);
    if (this.zoomed && this.zoomed !== id) {
      this.zoomed = id;
      this.renderCanvas();
    }
    this.panes.get(id)?.focus();
  }
  private command(command: string): void {
    if (document.querySelector("dialog[open]")) return;
    if (command === "increase") this.font(1);
    else if (command === "decrease") this.font(-1);
    else if (command === "reset") this.font(14 - this.fontSize);
    else if (command === "choose") this.choose();
    else if (command === "sidebar") this.toggleSidebar();
    else if (command === "zoom" && this.active) this.zoom(this.active);
    else if (command === "new") this.newTerminal();
    else if (command === "help") this.help();
    else if (/^[1-9]$/.test(command)) {
      const id = ids(this.tree)[Number(command) - 1];
      if (id) this.focusPane(id);
    }
  }
  private shortcut(e: KeyboardEvent): void {
    if (e.isComposing || document.querySelector('dialog[open], [role="menu"]'))
      return;
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const order = ids(this.tree);
      if (order.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        const current = order.indexOf(this.active || "");
        const next =
          current < 0
            ? e.shiftKey
              ? order.length - 1
              : 0
            : (current + (e.shiftKey ? -1 : 1) + order.length) % order.length;
        this.focusPane(order[next]);
      }
      return;
    }
    const appModifier = /Mac|iPhone|iPad/.test(navigator.platform)
      ? e.metaKey
      : e.ctrlKey && e.shiftKey;
    if (!appModifier || e.altKey) return;
    const key =
      !e.metaKey && /^Digit[0-9]$/.test(e.code)
        ? e.code.slice(5)
        : e.key.toLowerCase();
    const command =
      key === "+" || key === "="
        ? "increase"
        : key === "-" || key === "_"
          ? "decrease"
          : key === "0"
            ? "reset"
            : key === "k"
              ? "choose"
              : key === "b"
                ? "sidebar"
                : key === "enter"
                  ? "zoom"
                  : key === "n" && e.shiftKey
                    ? "new"
                    : key === "?"
                      ? "help"
                      : /^[1-9]$/.test(key)
                        ? key
                        : null;
    if (!command) return;
    // Capture before xterm or the composer can consume application shortcuts.
    e.preventDefault();
    e.stopPropagation();
    this.command(command);
  }
}
new WorkspaceApp();
