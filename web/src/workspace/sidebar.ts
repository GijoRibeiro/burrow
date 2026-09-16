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
  const visible = new Set(ids(ctx.tree));
  for (const p of ctx.state.projects) {
    const terminals = ctx.state.terminals.filter((t) => t.projectId === p.id);
    if (
      ctx.onlyActive &&
      !terminals.some(
        (t) =>
          t.status === "running" &&
          (t.program === "claude" || t.program === "codex"),
      )
    )
      continue;
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
        `Create worktree in ${p.name}`,
        () => ctx.newWorktree(p),
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
          { label: "Create worktree…", run: () => ctx.newWorktree(p) },
          { label: "New terminal…", run: () => ctx.newTerminal(p.id, p.path) },
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
      for (const { tree: w, depth } of worktreeHierarchy(p.worktrees)) {
        const row = el(
          "div",
          `worktree-row${ctx.selectedPath === w.path ? " selected" : ""}`,
        );
        row.style.marginInlineStart = `${Math.min(depth, 8) * 14}px`;
        row.classList.toggle("child-worktree", !!w.parentPath);
        const selectTree = button(
          `Select ${p.name} ${w.branch || w.name}`,
          () => {
            ctx.select(p.id, w.path);
          },
          "worktree-label",
          "",
        );
        selectTree.title = w.parentPath
          ? `Child of ${w.parentPath}\n${w.path}`
          : w.path;
        selectTree.append(
          el("span", "worktree-icon", w.main ? "⌂" : "⑂"),
          el(
            "span",
            "worktree-name",
            w.main ? w.branch || "main checkout" : w.name,
          ),
        );
        if (w.main) {
          const main = badge("MAIN", "main-badge");
          main.title = "Main project checkout";
          selectTree.append(main);
        }
        selectTree.setAttribute("aria-haspopup", "menu");
        row.dataset.worktreePath = w.path;
        const openWorktreeMenu = (x: number, y: number) =>
          contextMenu(
            `${p.name} · ${w.branch || w.name}`,
            x,
            y,
            [
              {
                label: "Create child worktree…",
                run: () => ctx.newWorktree(p, w.path),
              },
              {
                label: "New terminal…",
                run: () => ctx.newTerminal(p.id, w.path),
              },
              w.main
                ? {
                    label: "Remove project from workspace…",
                    run: () => ctx.removeProject(p),
                    danger: true,
                  }
                : {
                    label: "Remove worktree…",
                    run: () => ctx.removeWorktree(p, w.path, w.name),
                    danger: true,
                  },
            ],
            () =>
              [...ctx.projects.querySelectorAll<HTMLElement>(".worktree-row")]
                .find((node) => node.dataset.worktreePath === w.path)
                ?.querySelector<HTMLButtonElement>(".worktree-label")
                ?.focus({ preventScroll: true }),
            "var(--ink)",
          );
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openWorktreeMenu(event.clientX, event.clientY);
        });
        selectTree.addEventListener("keydown", (event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            const bounds = selectTree.getBoundingClientRect();
            openWorktreeMenu(bounds.left + 12, bounds.bottom);
          }
        });
        row.append(
          selectTree,
          button(
            `New terminal in ${p.name} ${w.name}`,
            () => ctx.newTerminal(p.id, w.path),
            "icon-button",
            "+",
          ),
        );
        if (!w.main)
          row.append(
            button(
              `Remove worktree ${w.name}`,
              () => ctx.removeWorktree(p, w.path, w.name),
              "icon-button subtle",
              "×",
            ),
          );
        if (w.issue) {
          const link = el("a", "worktree-issue", w.issue.identifier);
          link.href = w.issue.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.title = w.issue.title;
          link.setAttribute(
            "aria-label",
            `Open ${w.issue.identifier} in Linear`,
          );
          row.append(link);
        }
        content.append(row);
        for (const t of terminals.filter((t) => t.path === w.path)) {
          const session = sessionRow(ctx, t, visible);
          session.style.marginInlineStart = `${Math.min(depth, 8) * 14}px`;
          content.append(session);
        }
      }
      for (const t of terminals.filter(
        (t) => !p.worktrees.some((w) => w.path === t.path),
      ))
        content.append(sessionRow(ctx, t, visible));
    }
    ctx.projects.append(group);
  }
  if (!ctx.state.projects.length)
    ctx.projects.append(
      el(
        "p",
        "sidebar-empty",
        "Add a Git repository to bring its projects and worktrees together.",
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
  toggle.append(
    creature(ctx.creatureName(t.id), `session-creature ${t.status}`),
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
    ];
    if (t.program === "claude" || t.program === "codex") {
      actions.push({ label: "Delegate task…", run: () => ctx.delegate(t.id) });
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
