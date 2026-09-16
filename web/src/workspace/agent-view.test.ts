// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentView, type Activity } from "./agent-view";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
describe("agent progress", () => {
  it("offers the real terminal and interruption after a minute without progress", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const interrupt = vi.fn(),
      open = vi.fn();
    const view = new AgentView(
      "Grook",
      "test",
      open,
      async () => {},
      interrupt,
    );
    const state: Activity = {
      kind: "claude",
      canMessage: true,
      status: "working",
      messages: [],
      tools: 0,
      truncated: false,
    };
    view.setConnection("Live");
    view.setActivity(state);
    const notices =
      view.element.querySelectorAll<HTMLButtonElement>(".terminal-notice");
    expect(notices[0].hidden).toBe(true);
    vi.advanceTimersByTime(61_000);
    view.setActivity(state);
    expect(notices[0].hidden).toBe(false);
    expect(notices[0].textContent).toContain("No new progress");
    notices[1].click();
    expect(interrupt).toHaveBeenCalledOnce();
    view.setActivity({ ...state, processStatus: "idle", status: "ready" });
    view.setScreen("esc to interrupt", "esc to interrupt");
    expect(view.heading.classList.contains("is-thinking")).toBe(false);
    expect(notices[0].hidden).toBe(true);
  });
  it("surfaces provider errors even when quiet conversation is available", () => {
    const view = new AgentView(
      "Grook",
      "test",
      () => {},
      async () => {},
      () => {},
    );
    view.setConnection("Live");
    view.setActivity({
      kind: "claude",
      canMessage: true,
      status: "working",
      messages: [{ id: "one", role: "user", text: "Create agents" }],
      tools: 0,
      truncated: false,
    });
    view.setScreen(
      "API Error: overloaded. Retrying…",
      "API Error: overloaded. Retrying…",
    );
    const notice =
      view.element.querySelector<HTMLButtonElement>(".terminal-notice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("Provider needs attention");
  });
});
