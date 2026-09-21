// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { arrangeTeam, teamNodes, TeamGraph } from "./team-graph";
import type { Workspace } from "./types";

describe("team relationships", () => {
  it("keeps independent and orphaned agents and replaces planned cards with workers", () => {
    const state = {
      terminals: [
        { id: "head", role: "head", program: "claude" },
        { id: "worker", program: "codex" },
        { id: "solo", program: "claude" },
        { id: "shell", program: "shell" },
      ],
      tasks: [
        {
          id: "task",
          parentId: "head",
          agentId: "worker",
          planId: "plan",
          planItemId: "one",
        },
      ],
      plans: [
        {
          id: "plan",
          headId: "head",
          status: "partial",
          items: [{ id: "one" }, { id: "two" }],
        },
      ],
    } as Workspace;
    const nodes = teamNodes(state);
    expect(nodes.map((n) => n.id)).toEqual([
      "head",
      "worker",
      "solo",
      "planned-two",
    ]);
    const layout = arrangeTeam(nodes);
    expect(layout.worker.x).toBeGreaterThan(layout.head.x);
    expect(layout.head.y).toBe((layout.worker.y + layout["planned-two"].y) / 2);
    expect(layout.solo.y).toBeGreaterThan(layout["planned-two"].y);
    state.terminals = state.terminals.filter((t) => t.id !== "head");
    expect(Object.keys(arrangeTeam(teamNodes(state)))).toHaveLength(2);
  });
  it("handles old cyclic metadata without recursion or losing cards", () => {
    const layout = arrangeTeam([
      { id: "one", parent: "two" },
      { id: "two", parent: "one" },
    ]);
    expect(Object.keys(layout)).toHaveLength(2);
    expect(Number.isFinite(layout.one.y)).toBe(true);
  });
});

it("opens canvas actions without capturing macOS Control-click as a drag", () => {
  localStorage.clear();
  const state = {
    terminals: [
      { id: "solo", program: "claude", name: "Solo", status: "running" },
    ],
    projects: [],
  } as unknown as Workspace;
  const menu = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const graph = new TeamGraph({
    state: () => state,
    color: () => "#aaaaaa",
    creature: () => "Grook",
    select: () => {},
    newHead: () => {},
    newAgent: () => {},
    review: () => {},
    task: () => {},
    menu,
  });
  graph.update("");
  const surface = graph.element.querySelector<HTMLElement>(".team-surface")!;
  const capture = vi.fn();
  surface.setPointerCapture = capture;
  const card = graph.element.querySelector<HTMLElement>(".team-node-open")!;
  card.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: true }),
  );
  expect(capture).not.toHaveBeenCalled();
  card.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 24,
    }),
  );
  expect(menu).toHaveBeenCalledWith("solo", 12, 24, expect.any(Function));
});

it("does not recreate removed workers from their task or canceled assignment", () => {
  const state = {
    projects: [],
    terminals: [{ id: "head", role: "head", program: "claude" }],
    tasks: [
      { id: "task", agentId: "removed", planId: "plan", planItemId: "one" },
    ],
    plans: [
      {
        id: "plan",
        headId: "head",
        status: "partial",
        items: [
          { id: "one" },
          { id: "two", canceled: true },
          { id: "three", taskId: "old-task" },
        ],
      },
    ],
  } as unknown as Workspace;
  expect(teamNodes(state).map((n) => n.id)).toEqual(["head"]);
});

it("signals a reply request three times without restarting on unrelated canvas updates", () => {
  localStorage.clear();
  let now = 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const state = {
    projects: [],
    tasks: [],
    plans: [],
    terminals: [
      {
        id: "solo",
        name: "Companion",
        program: "claude",
        status: "running",
        liveStatus: "idle",
      },
    ],
  } as unknown as Workspace;
  const graph = new TeamGraph({
    state: () => state,
    color: () => "#ac8fff",
    creature: () => "Grook",
    select: () => {},
    newHead: () => {},
    newAgent: () => {},
    review: () => {},
    task: () => {},
    menu: () => {},
  });
  const card = () => graph.element.querySelector<HTMLElement>(".team-node")!;
  try {
    graph.update("");
    expect(card().classList.contains("attention-pulse")).toBe(false);
    state.terminals[0].liveStatus = "waiting";
    graph.update("");
    expect(card().textContent).toContain("Needs your reply");
    expect(card().classList.contains("attention-pulse")).toBe(true);
    expect(
      graph.element.querySelector(".team-overview")?.textContent,
    ).toContain("1 need an answer");
    now += 1000;
    state.terminals[0].name = "Renamed";
    graph.update("");
    expect(card().style.getPropertyValue("--attention-delay")).toBe("-1000ms");
    now += 6000;
    state.terminals[0].name = "Renamed again";
    graph.update("");
    expect(card().classList.contains("attention-pulse")).toBe(false);
    expect(card().classList.contains("needs-reply")).toBe(true);
    state.terminals[0].liveStatus = "working";
    graph.update("");
    expect(card().classList.contains("needs-reply")).toBe(false);
    state.terminals[0].liveStatus = "waiting";
    graph.update("");
    expect(card().classList.contains("attention-pulse")).toBe(true);
    expect(card().style.getPropertyValue("--attention-delay")).toBe("0ms");
    state.terminals[0].status = "stopped";
    graph.update("");
    expect(card().classList.contains("needs-reply")).toBe(false);
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("keeps unrelated cards and moving connections mounted across updates", () => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const state = {
    projects: [],
    tasks: [],
    plans: [],
    terminals: [
      {
        id: "head",
        role: "head",
        program: "claude",
        name: "Head",
        status: "running",
      },
      {
        id: "child",
        headId: "head",
        program: "codex",
        name: "Child",
        status: "running",
        liveStatus: "working",
      },
    ],
  } as unknown as Workspace;
  const graph = new TeamGraph({
    state: () => state,
    color: () => "#aaaaaa",
    creature: () => "Grook",
    select: () => {},
    review: () => {},
    task: () => {},
    menu: () => {},
    newHead: () => {},
    newAgent: () => {},
  });
  graph.update("");
  const child = graph.element.querySelector('[data-node-id="child"]');
  const wire = graph.element.querySelector(".team-wires path");
  state.terminals[0].name = "Renamed head";
  graph.update("child");
  expect(graph.element.querySelector('[data-node-id="child"]')).toBe(child);
  expect(graph.element.querySelector(".team-wires path")).toBe(wire);
  state.terminals = state.terminals.filter((t) => t.id !== "child");
  graph.update("");
  expect(graph.element.querySelector(".team-wires path")).toBeNull();
  vi.unstubAllGlobals();
});
