// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderProjectList, type SidebarContext } from "./sidebar";

it("keeps sidebar rows and sprite elements mounted through activity updates", () => {
  const projects = document.createElement("div");
  const ctx = {
    projects,
    search: document.createElement("input"),
    visible: new Set(["one"]),
    active: "one",
    selectedPath: "/test",
    collapsed: new Set(),
    state: {
      projects: [{ id: "p", name: "Test", path: "/test", worktrees: [] }],
      terminals: [
        {
          id: "one",
          projectId: "p",
          name: "One",
          path: "/test",
          program: "claude",
          status: "running",
        },
        {
          id: "two",
          projectId: "p",
          name: "Two",
          path: "/test",
          program: "codex",
          status: "running",
        },
      ],
      tasks: [],
    },
    creatureName: () => "Grook",
    terminalColor: () => "#aaaaaa",
    show: vi.fn(),
    hide: vi.fn(),
  } as unknown as SidebarContext;
  renderProjectList(ctx);
  const row = projects.querySelector('[data-session-id="one"]');
  const sprite = row!.querySelector(".session-creature");
  ctx.state.terminals[0].liveStatus = "working";
  renderProjectList(ctx);
  expect(projects.querySelector('[data-session-id="one"]')).toBe(row);
  expect(row!.querySelector(".session-creature")).toBe(sprite);
  expect(sprite!.classList.contains("working")).toBe(true);
  ctx.active = "two";
  renderProjectList(ctx);
  expect(row!.classList.contains("active")).toBe(false);
  expect(
    projects
      .querySelector('[data-session-id="two"]')!
      .classList.contains("active"),
  ).toBe(true);
  ctx.visible = new Set();
  renderProjectList(ctx);
  (
    projects.querySelector('[aria-label="Show One"]') as HTMLButtonElement
  ).click();
  expect(ctx.show).toHaveBeenCalledWith("one");
});
