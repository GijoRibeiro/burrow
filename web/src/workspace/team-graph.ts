import { button, el } from "./dom";
import { creature } from "./creature";
import type {
  Workspace,
  Session,
  TeamPlan,
  TeamItem,
  AgentTask,
} from "./types";
import "./team-graph.css";

export interface TeamGraphContext {
  state(): Workspace;
  color(id: string): string;
  creature(id: string): string;
  select(id: string): void;
  menu(id: string, x: number, y: number, restore: () => void): void;
  newHead(): void;
  review(plan: TeamPlan): void;
  task(id: string): void;
}
export interface GraphNode {
  id: string;
  parent?: string;
  session?: Session;
  task?: AgentTask;
  plan?: TeamPlan;
  item?: TeamItem;
}
export function teamNodes(state: Workspace): GraphNode[] {
  const nodes: GraphNode[] = state.terminals
    .filter((t) => t.program === "claude" || t.program === "codex")
    .map((session) => {
      const task = state.tasks?.find((t) => t.agentId === session.id);
      return {
        id: session.id,
        session,
        task,
        parent: session.headId || task?.parentId,
        plan: [...(state.plans || [])]
          .reverse()
          .find((p) => p.headId === session.id && p.status !== "canceled"),
      };
    });
  for (const plan of state.plans || []) {
    if (
      plan.status === "canceled" ||
      !state.terminals.some((t) => t.id === plan.headId)
    )
      continue;
    for (const item of plan.items) {
      const task = state.tasks?.find(
        (t) => t.planId === plan.id && t.planItemId === item.id,
      );
      if (item.canceled || item.taskId || task) continue;
      nodes.push({ id: `planned-${item.id}`, parent: plan.headId, plan, item });
    }
  }
  return nodes;
}
export function arrangeTeam(
  nodes: GraphNode[],
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {},
    visited = new Set<string>();
  let row = 0;
  const visit = (node: GraphNode, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const children = nodes.filter(
      (n) => n.parent === node.id && !visited.has(n.id),
    );
    for (const child of children) visit(child, depth + 1);
    const placed = children.map((c) => positions[c.id]).filter(Boolean);
    const y = placed.length
      ? (placed[0].y + placed[placed.length - 1].y) / 2
      : 100 + row++ * 226;
    positions[node.id] = { x: 72 + depth * 410, y };
  };
  for (const n of nodes.filter(
    (n) => !n.parent || !nodes.some((p) => p.id === n.parent),
  ))
    visit(n, 0);
  for (const n of nodes) visit(n, 0);
  return positions;
}
const STORE = "burrow.team-canvas.v1";
const svg = <K extends keyof SVGElementTagNameMap>(name: K) =>
  document.createElementNS("http://www.w3.org/2000/svg", name);
export class TeamGraph {
  readonly element = el("section", "team-graph");
  private surface = el("div", "team-surface");
  private world = el("div", "team-world");
  private wires = svg("svg");
  private cards = el("div", "team-cards");
  private summary = el("span", "team-overview");
  private notice = el("div", "team-notice");
  private zoomLabel = el("span", "team-zoom-label", "100%");
  private positions: Record<string, { x: number; y: number }> = {};
  private manual = new Set<string>();
  private viewport = { x: 0, y: 0, scale: 1 };
  private nodes: GraphNode[] = [];
  private signature = "";
  private selected = "";
  private headFilter = "";
  private teamSelect = el("select", "team-selector");
  private dragging = false;
  private space = false;
  constructor(private ctx: TeamGraphContext) {
    this.element.setAttribute("aria-label", "Agent team canvas");
    this.surface.setAttribute("aria-label", "Pan and zoom team canvas");
    this.surface.tabIndex = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
      this.headFilter =
        typeof saved.headFilter === "string" ? saved.headFilter : "";
      this.manual = new Set(
        Array.isArray(saved.manual)
          ? saved.manual.filter((id: unknown) => typeof id === "string")
          : [],
      );
      for (const [id, p] of Object.entries(saved.positions || {})) {
        const value = p as { x: number; y: number };
        if (Number.isFinite(value?.x) && Number.isFinite(value?.y))
          this.positions[id] = value;
      }
      if (
        [saved.viewport?.x, saved.viewport?.y, saved.viewport?.scale].every(
          Number.isFinite,
        )
      )
        this.viewport = saved.viewport;
      this.viewport.scale = Math.max(0.2, Math.min(1.6, this.viewport.scale));
    } catch {
      /* A corrupt view must never affect sessions. */
    }
    const header = el("div", "team-heading"),
      titles = el("div");
    titles.append(
      el("span", "team-eyebrow", "THE BIG PICTURE"),
      el("h2", "", "A little team. A lot in motion."),
      this.summary,
    );
    const actions = el("div", "team-heading-actions");
    this.teamSelect.setAttribute("aria-label", "Team shown on canvas");
    this.teamSelect.onchange = () => {
      this.headFilter = this.teamSelect.value;
      this.update(this.selected);
      this.fit();
    };
    actions.append(
      this.teamSelect,
      button(
        "Start a head agent",
        () => ctx.newHead(),
        "primary",
        "+ Head agent",
      ),
    );
    header.append(titles, actions);
    this.wires.classList.add("team-wires");
    this.wires.setAttribute("aria-hidden", "true");
    this.world.append(this.wires, this.cards);
    this.surface.append(this.world);
    const controls = el("div", "team-controls");
    controls.append(
      button("Zoom out canvas", () => this.zoom(0.8), "icon-button", "−"),
      this.zoomLabel,
      button("Zoom in canvas", () => this.zoom(1.25), "icon-button", "+"),
      button("Fit team to canvas", () => this.fit(), "subtle", "Fit"),
      button(
        "Arrange team canvas",
        () => {
          this.manual.clear();
          this.positions = arrangeTeam(this.nodes);
          this.position();
          this.fit();
        },
        "subtle",
        "Arrange",
      ),
    );
    this.element.append(
      header,
      this.surface,
      this.notice,
      controls,
      el(
        "span",
        "team-canvas-hint",
        "Drag to explore · pinch to zoom · select a creature to talk",
      ),
    );
    this.surface.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey)
          this.zoom(Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
        else {
          this.viewport.x -= e.deltaX;
          this.viewport.y -= e.deltaY;
          this.transform();
          this.save();
        }
      },
      { passive: false },
    );
    // WebKit exposes trackpad pinches as GestureEvents; Chromium uses ctrl-wheel.
    let gestureScale = 1;
    this.surface.addEventListener("gesturestart", (event) => {
      event.preventDefault();
      gestureScale = 1;
    });
    this.surface.addEventListener("gesturechange", (event) => {
      event.preventDefault();
      const gesture = event as Event & {
        scale: number;
        clientX?: number;
        clientY?: number;
      };
      if (Number.isFinite(gesture.scale) && gesture.scale > 0) {
        this.zoom(
          gesture.scale / gestureScale,
          gesture.clientX,
          gesture.clientY,
        );
        gestureScale = gesture.scale;
      }
    });
    this.surface.addEventListener("gestureend", (event) => {
      event.preventDefault();
    });
    this.surface.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (e.code === "Space") {
        e.preventDefault();
        this.space = true;
      }
      if (e.key === "0") this.fit();
      if (e.key === "+" || e.key === "=") this.zoom(1.2);
      if (e.key === "-") this.zoom(0.8);
    });
    window.addEventListener("keyup", () => {
      this.space = false;
    });
    window.addEventListener("blur", () => {
      this.space = false;
    });
    this.surface.addEventListener("pointerdown", (e) => this.startDrag(e));
    this.transform();
  }
  update(selected: string): void {
    this.selected = selected;
    if (this.dragging) return;
    const state = this.ctx.state();
    if (
      this.headFilter &&
      !state.terminals.some((t) => t.id === this.headFilter)
    )
      this.headFilter = "";
    const key = JSON.stringify([
      this.headFilter,
      state.terminals,
      state.tasks,
      state.plans,
      state.terminals.map((t) => [
        this.ctx.color(t.id),
        this.ctx.creature(t.id),
      ]),
    ]);
    if (key === this.signature) {
      this.paintSelection();
      return;
    }
    this.signature = key;
    const all = teamNodes(state);
    this.nodes = this.headFilter
      ? all.filter((n) => this.belongsTo(n, this.headFilter, all))
      : all;
    this.teamSelect.replaceChildren();
    const option = el("option", "", "All agents");
    option.value = "";
    this.teamSelect.append(option);
    for (const head of state.terminals.filter((t) => t.role === "head")) {
      const o = el("option", "", head.name);
      o.value = head.id;
      this.teamSelect.append(o);
    }
    this.teamSelect.value = this.headFilter;
    const defaults = arrangeTeam(this.nodes);
    for (const node of this.nodes) {
      // Keep a proposed worker's place when it becomes a real terminal.
      const prior = node.task?.planItemId
        ? this.positions[`planned-${node.task.planItemId}`]
        : undefined;
      if (
        prior &&
        node.task?.planItemId &&
        this.manual.has(`planned-${node.task.planItemId}`)
      ) {
        this.positions[node.id] = prior;
        this.manual.add(node.id);
      }
      if (!this.manual.has(node.id))
        this.positions[node.id] = defaults[node.id];
      else this.positions[node.id] ||= defaults[node.id];
    }
    const shown = new Set(this.nodes.map((n) => n.id));
    const working =
      state.tasks?.filter((t) => shown.has(t.agentId) && t.status === "working")
        .length || 0;
    const waiting =
      state.tasks?.filter((t) => shown.has(t.agentId) && t.status === "waiting")
        .length || 0;
    const headCount = state.terminals.filter(
      (t) => shown.has(t.id) && t.role === "head",
    ).length;
    this.summary.textContent = `${headCount} ${headCount === 1 ? "head" : "heads"} · ${working} working${waiting ? ` · ${waiting} need an answer` : ""}`;
    this.cards.replaceChildren(...this.nodes.map((node) => this.card(node)));
    if (!this.nodes.length) {
      const empty = el("div", "team-empty");
      const pets = el("div", "team-empty-pets");
      for (const name of ["Grook", "ghost", "crab"])
        pets.append(creature(name));
      empty.append(
        pets,
        el("h3", "", "Give your day a head start."),
        el(
          "p",
          "",
          "Ask a head agent to look at your Linear tickets. Discuss the plan, then watch your team branch out.",
        ),
        button(
          "Create your first head agent",
          () => this.ctx.newHead(),
          "primary",
          "Let's build a team",
        ),
      );
      this.cards.append(empty);
    }
    this.notice.replaceChildren();
    const pending =
      state.plans?.filter(
        (p) =>
          (!this.headFilter || p.headId === this.headFilter) &&
          ["proposed", "partial", "launching"].includes(p.status),
      ) || [];
    for (const plan of pending)
      this.notice.append(
        button(
          `Review plan ${plan.title}`,
          () => this.ctx.review(plan),
          "team-plan-notice",
          `${plan.status === "proposed" ? "↗ Pending launch" : "↗ Launch status"}  ·  ${plan.title}  ·  ${plan.items.length} workers  →`,
        ),
      );
    this.position();
    this.paintSelection();
    this.save();
  }
  private belongsTo(node: GraphNode, head: string, all: GraphNode[]): boolean {
    const seen = new Set<string>();
    let current: GraphNode | undefined = node;
    while (current && !seen.has(current.id)) {
      if (current.id === head) return true;
      seen.add(current.id);
      current = all.find((n) => n.id === current!.parent);
    }
    return false;
  }
  reveal(id: string): void {
    const all = teamNodes(this.ctx.state());
    const node = all.find((n) => n.id === id);
    if (!node) return;
    const head = all.find(
      (n) => n.session?.role === "head" && this.belongsTo(node, n.id, all),
    );
    const next = head?.id || "";
    if (next !== this.headFilter) {
      this.headFilter = next;
      this.update(id);
      requestAnimationFrame(() => this.fit());
    }
  }
  private card(node: GraphNode): HTMLElement {
    const card = el(
      "article",
      `team-node${node.item ? " proposed" : ""}${node.session?.role === "head" ? " head" : ""}`,
    );
    card.dataset.nodeId = node.id;
    const color = this.ctx.color(node.session?.id || node.parent || node.id);
    card.style.setProperty("--node-color", color);
    const title = node.session?.name || node.item?.title || "Worker";
    const select = () =>
      node.session
        ? this.ctx.select(node.session.id)
        : node.plan && this.ctx.review(node.plan);
    const top = el("div", "team-node-top");
    top.append(
      creature(this.ctx.creature(node.session?.id || node.id)),
      el(
        "span",
        "team-role",
        node.session?.role === "head"
          ? "HEAD AGENT"
          : node.item
            ? "STARTING WORKER"
            : node.task || node.session?.headId
              ? "WORKER"
              : "INDEPENDENT",
      ),
      el("span", "team-provider", node.session?.program || node.item?.program),
    );
    const open = button(
      `Open ${title} on canvas`,
      select,
      "team-node-open",
      "",
    );
    open.append(top, el("strong", "team-node-title", title));
    const issue = node.task?.issue || node.item?.issue;
    const project = this.ctx
      .state()
      .projects.find((p) => p.id === node.session?.projectId);
    const detail = issue
      ? `${issue.identifier} · ${issue.state.name}`
      : node.session?.role === "head"
        ? project?.name || "Coordinator"
        : node.item?.name ||
          node.task?.path.split("/").pop() ||
          project?.name ||
          "Terminal";
    open.append(el("span", "team-node-detail", detail));
    let status = node.item
      ? "Starting…"
      : node.task?.integratedCommit
        ? "Integrated"
        : node.task?.status === "waiting"
          ? "Needs an answer"
          : node.task?.status === "done"
            ? "Ready for review"
            : node.task?.status === "canceled"
              ? "Canceled"
              : node.session?.role === "head"
                ? "Coordinating"
                : node.task
                  ? "Working"
                  : "Available";
    if (node.session && node.session.status !== "running")
      status = "Agent stopped";
    if (node.item?.error) status = "Launch needs attention";
    const foot = el("div", `team-node-footer ${node.task?.status || ""}`);
    foot.append(
      el("span", "team-node-state", status),
      el("span", "team-node-arrow", "↗"),
    );
    open.append(foot);
    card.append(open);
    {
      open.setAttribute("aria-haspopup", "menu");
      const menu = (x: number, y: number) =>
        this.ctx.menu(node.id, x, y, () => {
          this.cards
            .querySelector<HTMLButtonElement>(
              `[data-node-id="${node.id}"] .team-node-open`,
            )
            ?.focus({ preventScroll: true });
        });
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu(e.clientX, e.clientY);
      });
      open.addEventListener("keydown", (e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          e.stopPropagation();
          const b = open.getBoundingClientRect();
          menu(b.left + 12, b.bottom);
        }
      });
    }
    if (node.task?.status === "waiting" || node.task?.status === "done")
      card.append(
        button(
          `Task details for ${title}`,
          () => this.ctx.task(node.task!.id),
          "team-task-link",
          node.task.status === "done" ? "Review result →" : "Read question →",
        ),
      );
    return card;
  }
  private paintSelection(): void {
    for (const card of this.cards.querySelectorAll<HTMLElement>(".team-node")) {
      const selected = card.dataset.nodeId === this.selected;
      card.classList.toggle("selected", selected);
      card
        .querySelector("button")
        ?.setAttribute("aria-pressed", String(selected));
    }
  }
  private position(): void {
    for (const card of this.cards.querySelectorAll<HTMLElement>(".team-node")) {
      const point = this.positions[card.dataset.nodeId!];
      card.style.transform = `translate(${point.x}px, ${point.y}px)`;
    }
    this.wires.replaceChildren();
    for (const node of this.nodes) {
      if (!node.parent || !this.nodes.some((n) => n.id === node.parent))
        continue;
      const a = this.positions[node.parent],
        b = this.positions[node.id];
      const path = svg("path"),
        x = a.x + 288,
        y = a.y + 86,
        end = b.y + 86;
      const bend = Math.max(55, Math.abs(b.x - x) * 0.5);
      path.setAttribute(
        "d",
        `M ${x} ${y} C ${x + bend} ${y}, ${b.x - bend} ${end}, ${b.x} ${end}`,
      );
      path.style.setProperty(
        "--wire-color",
        this.ctx.color(node.session?.id || node.parent),
      );
      path.classList.toggle("pending", !!node.item);
      path.classList.toggle(
        "working",
        node.task?.status === "working" && node.session?.status === "running",
      );
      this.wires.append(path);
      for (const point of [
        { x, y },
        { x: b.x, y: end },
      ]) {
        const dot = svg("circle");
        dot.setAttribute("cx", String(point.x));
        dot.setAttribute("cy", String(point.y));
        dot.setAttribute("r", "4");
        this.wires.append(dot);
      }
    }
  }
  private startDrag(e: PointerEvent): void {
    // macOS Control-click opens the context menu; capturing it would retarget
    // WebKit's contextmenu event to the empty canvas.
    if (e.ctrlKey && e.button === 0) return;
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest(".team-task-link, .team-empty")) return;
    const card =
      !this.space && e.button === 0
        ? target.closest<HTMLElement>(".team-node")
        : null;
    const id = card?.dataset.nodeId;
    const start = id ? { ...this.positions[id] } : { ...this.viewport };
    const x = e.clientX,
      y = e.clientY;
    let moved = false;
    this.dragging = true;
    this.surface.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      const dx = event.clientX - x,
        dy = event.clientY - y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      if (!moved) return;
      this.surface.classList.add("dragging");
      if (id) {
        this.manual.add(id);
        this.positions[id] = {
          x: start.x + dx / this.viewport.scale,
          y: start.y + dy / this.viewport.scale,
        };
        this.position();
      } else {
        this.viewport.x = start.x + dx;
        this.viewport.y = start.y + dy;
        this.transform();
      }
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      this.surface.removeEventListener("pointermove", move);
      this.surface.removeEventListener("pointerup", end);
      this.surface.removeEventListener("pointercancel", end);
      this.surface.classList.remove("dragging");
      this.dragging = false;
      if (this.surface.hasPointerCapture(e.pointerId))
        this.surface.releasePointerCapture(e.pointerId);
      if (!moved && id && event.type !== "pointercancel") {
        const node = this.nodes.find((n) => n.id === id);
        if (node?.session) this.ctx.select(node.session.id);
        else if (node?.plan) this.ctx.review(node.plan);
      }
      this.save();
      this.update(this.selected);
    };
    // Pointer capture moves the click target to the surface; selection is handled
    // on pointerup, while semantic button clicks remain available to keyboards.
    this.surface.addEventListener("pointermove", move);
    this.surface.addEventListener("pointerup", end);
    this.surface.addEventListener("pointercancel", end);
  }
  private transform(): void {
    const { x, y, scale } = this.viewport;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.surface.style.backgroundPosition = `${x}px ${y}px`;
    this.surface.style.backgroundSize = `${24 * scale}px ${24 * scale}px`;
    this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }
  private zoom(factor: number, clientX?: number, clientY?: number): void {
    const bounds = this.surface.getBoundingClientRect(),
      old = this.viewport.scale;
    const scale = Math.max(0.2, Math.min(1.6, old * factor));
    const x = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const y = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    this.viewport = {
      x: x - ((x - this.viewport.x) * scale) / old,
      y: y - ((y - this.viewport.y) * scale) / old,
      scale,
    };
    this.transform();
    this.save();
  }
  fit(): void {
    if (!this.nodes.length || !this.surface.clientWidth) return;
    const points = this.nodes.map((n) => this.positions[n.id]);
    const left = Math.min(...points.map((p) => p.x)),
      top = Math.min(...points.map((p) => p.y));
    const width = Math.max(...points.map((p) => p.x)) + 288 - left,
      height = Math.max(...points.map((p) => p.y)) + 196 - top;
    const scale = Math.max(
      0.2,
      Math.min(
        1,
        (this.surface.clientWidth - 80) / width,
        (this.surface.clientHeight - 250) / height,
      ),
    );
    this.viewport = {
      x: (this.surface.clientWidth - width * scale) / 2 - left * scale,
      y:
        160 +
        (this.surface.clientHeight - 250 - height * scale) / 2 -
        top * scale,
      scale,
    };
    this.transform();
    this.save();
  }
  private save(): void {
    try {
      localStorage.setItem(
        STORE,
        JSON.stringify({
          positions: this.positions,
          viewport: this.viewport,
          headFilter: this.headFilter,
          manual: [...this.manual],
        }),
      );
    } catch {
      /* Optional view persistence. */
    }
  }
}
