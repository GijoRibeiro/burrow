// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { arrangeTeam, teamNodes } from "./team-graph";
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
