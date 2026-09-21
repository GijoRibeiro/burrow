import { worktreeHierarchy } from "./hierarchy";
import { contextMenu } from "./context-menu";
import { creature } from "./creature";
import { badge, button, dialog, el } from "./dom";
import { ids, type Tree } from "./layout";
import type { Project, Session, Workspace } from "./types";
export interface SidebarContext {
  projects: HTMLElement;
  state: Workspace;
  onlyActive?: boolean;
  search: HTMLInputElement;
  tree: Tree | null;
  visible?: Set<string>;
  active: string | null;
  selectedPath: string;
  collapsed: Set<string>;
  renderSidebar(): void;
  creatureName(id: string): string;
  terminalColor(id: string): string;
  newWorktree(p: Project, parentPath?: string): void;
  delegate(id: string): void;
  coordination(taskId?: string): void;
  removeProject(p: Project): void;
  newTerminal(project: string, path: string): void;
  removeWorktree(p: Project, path: string, name: string): void;
  select(project: string, path: string): void;
  hide(id: string): void;
  show(id: string): void;
  removeTerminal(id: string): Promise<void>;
  renameTerminal(id: string): void;
  stopTerminal(id: string): void;
  restartTerminal(id: string): void;
  focusTerminal(id: string): void;
}
export function renderProjectList(ctx: SidebarContext): void {
  ctx.projects.replaceChildren();
  const filter = ctx.search.value.toLowerCase();
  const visible = ctx.visible || new Set(ids(ctx.tree));
  for (const p of ctx.state.projects) {
    const terminals = ctx.state.terminals.filter(
      (t) =>
        t.projectId === p.id &&
        (!ctx.onlyActive ||
          (t.status === "running" &&
            (t.program === "claude" || t.program === "codex"))),
    );
    if (ctx.onlyActive && !terminals.length) continue;
    if (
      filter &&
      ![
        p.name,
        p.path,
        ...terminals.map((t) => t.name),
        ...p.worktrees.map((w) => w.branch),
      ]
        .join(" ")
        .toLowerCase()
        .includes(filter)
    )
      continue;
    const group = el("section", "project-group");

    const body = el("div", "project-content");
    const content = el("div", "project-content-inner");
    body.append(content);
    const expanded = !ctx.collapsed.has(p.id) || !!filter;
    group.classList.toggle("collapsed", !expanded);
    content.inert = !expanded;
    const heading = el("div", "project-heading");
    const select = button(
      `Toggle ${p.name}`,
      () => {
        ctx.collapsed.has(p.id)
          ? ctx.collapsed.delete(p.id)
          : ctx.collapsed.add(p.id);
        const expanded = !ctx.collapsed.has(p.id);
        group.classList.toggle("collapsed", !expanded);
        content.inert = !expanded;
        select.setAttribute("aria-expanded", String(expanded));
        select.querySelector(".chevron")!.textContent = expanded ? "⌄" : "›";
      },
      "project-label",
      "",
    );
    select.setAttribute("aria-expanded", String(expanded));
    select.append(
      el("span", "chevron", ctx.collapsed.has(p.id) ? "›" : "⌄"),
      el("span", "project-dot"),
      el("span", "project-name", p.name),
      badge(String(terminals.length)),
    );
    const controls = el("div", "project-actions");
    controls.append(
      button(
        p.git === false
          ? `New terminal in ${p.name}`
          : `Create worktree in ${p.name}`,
        () =>
          p.git === false ? ctx.newTerminal(p.id, p.path) : ctx.newWorktree(p),
        "icon-button",
        "+",
      ),
    );
    const openProjectMenu = (x: number, y: number) =>
      contextMenu(
        p.name,
        x,
        y,
        [
          ...(p.git === false
            ? []
            : [{ label: "Create worktree…", run: () => ctx.newWorktree(p) }]),
          { label: "New terminal…", run: () => ctx.newTerminal(p.id, p.path) },
          { label: "Worktrees…", run: () => worktreesDialog(ctx, p) },
          {
            label: "Remove project from workspace…",
            run: () => ctx.removeProject(p),
            danger: true,
          },
        ],
        () =>
          ctx.projects
            .querySelector<HTMLButtonElement>(
              `[data-project-id="${p.id}"] .project-label`,
            )
            ?.focus({ preventScroll: true }),
        "var(--ink)",
      );
    group.dataset.projectId = p.id;
    select.setAttribute("aria-haspopup", "menu");
    heading.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openProjectMenu(event.clientX, event.clientY);
    });
    select.addEventListener("keydown", (event) => {
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        const bounds = select.getBoundingClientRect();
        openProjectMenu(bounds.left + 12, bounds.bottom);
      }
    });
    heading.append(select, controls);
    group.append(heading, body);
    {
      if (p.error)
        content.append(
          el("p", "project-error", "Folder unavailable. Check its location."),
        );
      const parentOf = (t: Session) =>
        t.headId ||
        ctx.state.tasks?.find((task) => task.id === t.taskId)?.parentId;
      const known = new Set(terminals.map((t) => t.id));
      const shown = new Set<string>();
      const append = (t: Session, depth: number) => {
        if (shown.has(t.id)) return;
        shown.add(t.id);
        const row = sessionRow(ctx, t, visible);
        row.style.marginInlineStart = `${8 + Math.min(depth, 4) * 16}px`;
        row.dataset.depth = String(depth);
        content.append(row);
        for (const child of terminals.filter(
          (child) => parentOf(child) === t.id,
        ))
          append(child, depth + 1);
      };
      for (const t of terminals.filter((t) => !known.has(parentOf(t) || "")))
        append(t, 0);
      // Keep malformed/cyclic or partially restored teams reachable, too.
      for (const t of terminals) append(t, 0);
      if (!terminals.length)
        content.append(
          button(
            "Add agent or terminal to " + p.name,
            () => ctx.newTerminal(p.id, p.path),
            "project-empty-agent",
            "+ Add an agent or terminal",
          ),
        );
    }
    ctx.projects.append(group);
  }
  if (!ctx.state.projects.length)
    ctx.projects.append(
      el(
        "p",
        "sidebar-empty",
        "Add a folder to start working with terminals and agents.",
      ),
    );
  else if (!ctx.projects.childElementCount)
    ctx.projects.append(
      el("p", "sidebar-empty", "No matching projects or terminals."),
    );
}
function sessionRow(
  ctx: SidebarContext,
  t: Session,
  visible: Set<string>,
): HTMLElement {
  const row = el(
    "div",
    `session-row${visible.has(t.id) ? " visible" : ""}${ctx.active === t.id ? " active" : ""}`,
  );
  row.dataset.sessionId = t.id;
  row.style.setProperty("--terminal-color", ctx.terminalColor(t.id));
  const toggle = button(
    `${visible.has(t.id) ? "Hide" : "Show"} ${t.name}`,
    () => (visible.has(t.id) ? ctx.hide(t.id) : ctx.show(t.id)),
    "session-toggle",
    "",
  );
  const project = ctx.state.projects.find((p) => p.id === t.projectId);
  const checkout = project?.worktrees.find((w) => w.path === t.path);
  toggle.title = `${t.name}\n${checkout?.branch || t.path}`;
  toggle.append(
    creature(
      ctx.creatureName(t.id),
      `session-creature ${t.status}${t.liveStatus === "working" ? " working" : ""}`,
    ),
    el("span", "session-label", t.name),
    el(
      "span",
      "visibility-label",
      visible.has(t.id)
        ? "on screen"
        : t.status === "running"
          ? "background"
          : t.status,
    ),
  );
  const task = ctx.state.tasks?.find((task) => task.id === t.taskId);
  if (task) {
    const status = button(
      `Open task ${task.title}`,
      () => ctx.coordination(task.id),
      `task-indicator ${task.status}`,
      task.integratedCommit ? "integrated" : task.status,
    );
    row.append(status);
  }
  const remove = () =>
    dialog(
      "Remove terminal?",
      `Remove ${t.name} from your workspace.`,
      [],
      "Remove",
      () => ctx.removeTerminal(t.id),
      true,
    );
  const open = (x: number, y: number) => {
    const actions = [
      {
        label: visible.has(t.id) ? "Hide terminal" : "Show terminal",
        run: () => (visible.has(t.id) ? ctx.hide(t.id) : ctx.show(t.id)),
      },
      {
        label: "Focus terminal",
        run: () => {
          ctx.show(t.id);
          ctx.focusTerminal(t.id);
        },
      },
      { label: "Rename terminal…", run: () => ctx.renameTerminal(t.id) },
      ...(project
        ? [
            {
              label: "Checkout details…",
              run: () => worktreesDialog(ctx, project, t.path),
            },
          ]
        : []),
      ...(project && project.git !== false
        ? [
            {
              label: "Create child worktree…",
              run: () => ctx.newWorktree(project, t.path),
            },
          ]
        : []),
    ];
    if (t.program === "claude" || t.program === "codex") {
      if (ctx.state.projects.find((p) => p.id === t.projectId)?.git !== false)
        actions.push({
          label: "Delegate task…",
          run: () => ctx.delegate(t.id),
        });
      actions.push({
        label: "Tasks and inbox…",
        run: () => ctx.coordination(t.taskId),
      });
    }
    if (t.status !== "running")
      actions.push({
        label: "Start terminal",
        run: () => ctx.restartTerminal(t.id),
      });
    contextMenu(
      t.name,
      x,
      y,
      [
        ...actions,
        t.status === "stopped"
          ? { label: "Remove terminal…", run: remove, danger: true }
          : {
              label: "Terminate terminal…",
              run: () => ctx.stopTerminal(t.id),
              danger: true,
            },
      ],
      () =>
        ctx.projects
          .querySelector<HTMLButtonElement>(
            `[data-session-id="${t.id}"] .session-toggle`,
          )
          ?.focus({ preventScroll: true }),
      ctx.terminalColor(t.id),
    );
  };
  toggle.setAttribute("aria-haspopup", "menu");
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    open(event.clientX, event.clientY);
  });
  toggle.addEventListener("keydown", (event) => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      const bounds = toggle.getBoundingClientRect();
      open(bounds.left + 12, bounds.bottom);
    }
  });
  row.prepend(toggle);
  if (t.status === "stopped")
    row.append(
      button(`Remove terminal ${t.name}`, remove, "icon-button subtle", "×"),
    );
  return row;
}

function worktreesDialog(
  ctx: SidebarContext,
  project: Project,
  selectedPath = ctx.selectedPath,
): void {
  const d = el("dialog", "dialog project-worktrees-dialog");
  d.setAttribute("aria-label", `${project.name} worktrees`);
  d.append(
    el("h2", "", "Worktrees"),
    el("p", "dialog-description", project.name),
  );
  const list = el("div", "project-worktrees-list");
  const act = (run: () => void) => () => {
    d.close();
    run();
  };
  for (const { tree: w, depth } of worktreeHierarchy(project.worktrees)) {
    const row = el(
      "div",
      `checkout-detail${w.path === selectedPath ? " selected" : ""}`,
    );
    row.dataset.worktreePath = w.path;
    row.style.marginInlineStart = `${Math.min(depth, 4) * 12}px`;
    const copy = el("div", "checkout-detail-copy");
    copy.append(el("strong", "", w.branch || w.name), el("small", "", w.path));
    if (w.main && project.git !== false)
      copy.append(el("span", "checkout-main", "Main checkout"));
    if (project.git === false)
      copy.append(el("span", "checkout-main", "No Git repository"));
    if (w.issue) {
      const link = el("a", "", w.issue.identifier);
      link.setAttribute("aria-label", `Open ${w.issue.identifier} in Linear`);
      link.href = w.issue.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      copy.append(link);
    }
    const actions = el("div", "checkout-detail-actions");
    actions.append(
      button(
        `Select ${project.name} ${w.branch || w.name}`,
        act(() => ctx.select(project.id, w.path)),
        "secondary",
        "Select",
      ),
      button(
        `New terminal in ${project.name} ${w.name}`,
        act(() => ctx.newTerminal(project.id, w.path)),
        "secondary",
        "+ Terminal",
      ),
    );
    if (project.git !== false)
      actions.append(
        button(
          `Create child of ${w.branch || w.name}`,
          act(() => ctx.newWorktree(project, w.path)),
          "secondary",
          "+ Worktree",
        ),
      );
    if (!w.main)
      actions.append(
        button(
          `Remove worktree ${w.name}`,
          act(() => ctx.removeWorktree(project, w.path, w.name)),
          "secondary",
          "Remove…",
        ),
      );
    row.append(copy, actions);
    list.append(row);
  }
  const footer = el("div", "dialog-actions");
  footer.append(button("Done", () => d.close(), "primary"));
  d.append(list, footer);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  footer.querySelector("button")?.focus();
}
