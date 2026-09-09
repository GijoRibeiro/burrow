import { creature } from "./creature";
import { badge, button, dialog, el } from "./dom";
import { ids, type Tree } from "./layout";
import type { Project, Session, Workspace } from "./types";
export interface SidebarContext {
  projects: HTMLElement;
  state: Workspace;
  search: HTMLInputElement;
  tree: Tree | null;
  active: string | null;
  selectedPath: string;
  collapsed: Set<string>;
  renderSidebar(): void;
  creatureName(id: string): string;
  terminalColor(id: string): string;
  newWorktree(p: Project): void;
  removeProject(p: Project): void;
  newTerminal(project: string, path: string): void;
  removeWorktree(p: Project, path: string, name: string): void;
  select(project: string, path: string): void;
  hide(id: string): void;
  show(id: string): void;
  removeTerminal(id: string): Promise<void>;
}
export function renderProjectList(ctx: SidebarContext): void {
  ctx.projects.replaceChildren();
  const filter = ctx.search.value.toLowerCase();
  const visible = new Set(ids(ctx.tree));
  for (const p of ctx.state.projects) {
    const terminals = ctx.state.terminals.filter((t) => t.projectId === p.id);
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
        "⑂+",
      ),
      button(
        `Remove ${p.name} from workspace`,
        () => ctx.removeProject(p),
        "icon-button subtle",
        "×",
      ),
    );
    heading.append(select, controls);
    group.append(heading, body);
    {
      if (p.error)
        content.append(
          el("p", "project-error", "Folder unavailable. Check its location."),
        );
      for (const w of p.worktrees) {
        const row = el(
          "div",
          `worktree-row${ctx.selectedPath === w.path ? " selected" : ""}`,
        );
        const selectTree = button(
          `Select ${p.name} ${w.branch || w.name}`,
          () => {
            ctx.select(p.id, w.path);
          },
          "worktree-label",
          "",
        );
        selectTree.title = w.path;
        selectTree.append(
          el("span", "worktree-icon", w.main ? "⌂" : "⑂"),
          el(
            "span",
            "worktree-name",
            w.main ? w.branch || "main checkout" : w.name,
          ),
        );
        if (w.main) selectTree.append(badge("MAIN", "main-badge"));
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
        content.append(row);
        for (const t of terminals.filter((t) => t.path === w.path))
          content.append(sessionRow(ctx, t, visible));
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
  row.append(toggle);
  if (t.status === "stopped")
    row.append(
      button(
        `Remove terminal ${t.name}`,
        () =>
          dialog(
            "Remove terminal?",
            "Remove this stopped session from your workspace.",
            [],
            "Remove",
            () => ctx.removeTerminal(t.id),
            true,
          ),
        "icon-button subtle",
        "×",
      ),
    );
  return row;
}
