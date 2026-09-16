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
    expect(Object.keys(arrangeTeam(teamNodes(state)))).toHaveLength(3);
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
  const graph = new TeamGraph({
    state: () => state,
    color: () => "#aaaaaa",
    creature: () => "Grook",
    select: () => {},
    newHead: () => {},
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
