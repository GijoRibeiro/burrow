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

describe("immediate outgoing messages", () => {
  const activity = (messages: Activity["messages"]): Activity => ({
    kind: "claude",
    canMessage: true,
    status: "ready",
    tools: 0,
    truncated: false,
    messages,
  });
  const view = () =>
    new AgentView(
      "Grook",
      "fixture",
      () => {},
      async () => {},
      () => {},
    );
  it("shows pending text immediately and replaces it with the transcript exactly once", () => {
    const v = view();
    v.setConnection("Live");
    v.setActivity(activity([{ id: "old", role: "user", text: "hello" }]));
    const id = v.beginMessage("hello");
    expect(v.element.querySelector(".pending-message")?.textContent).toContain(
      "Sending…",
    );
    v.finishMessage(id, true);
    v.setActivity(
      activity([
        { id: "old", role: "user", text: "hello" },
        { id: "new", role: "user", text: "hello" },
      ]),
    );
    expect(v.element.querySelectorAll(".pending-message")).toHaveLength(0);
    expect(
      v.element.querySelectorAll(".conversation-message.user"),
    ).toHaveLength(2);
  });
  it("does not merge separate identical sends and preserves failures for retry", () => {
    const v = view();
    v.setActivity(activity([]));
    v.beginMessage("repeat");
    const second = v.beginMessage("repeat");
    v.setActivity(activity([{ id: "one", role: "user", text: "repeat" }]));
    expect(v.element.querySelectorAll(".pending-message")).toHaveLength(1);
    v.setActivity(activity([{ id: "one", role: "user", text: "repeat" }]));
    expect(v.element.querySelectorAll(".pending-message")).toHaveLength(1);
    v.finishMessage(second, false);
    expect(v.element.querySelector(".failed")?.textContent).toContain(
      "Not sent",
    );
    v.beginMessage("repeat");
    expect(v.element.querySelectorAll(".pending-message")).toHaveLength(1);
  });
  it("keeps previous conversation visible through a refresh failure", () => {
    const v = view();
    v.setConnection("Live");
    v.setActivity(
      activity([{ id: "a", role: "assistant", text: "Existing conversation" }]),
    );
    v.unavailable();
    expect(v.element.textContent).toContain("Existing conversation");
    expect(v.heading.textContent).toContain("Reconnecting to agent");
  });
});

it("varies busy captions near the composer and stops when idle", () => {
  vi.useFakeTimers();
  const view = new AgentView(
    "Grook",
    "busy",
    () => {},
    async () => {},
    () => {},
  );
  const a: Activity = {
    kind: "claude",
    canMessage: true,
    status: "working",
    tools: 0,
    truncated: false,
    messages: [],
  };
  view.setConnection("Live");
  view.setActivity(a);
  view.setVisible(true);
  const label = view.heading.querySelector(".agent-status-label")!;
  const first = label.textContent;
  vi.advanceTimersByTime(8100);
  expect(label.textContent).not.toBe(first);
  expect(view.heading.classList.contains("is-thinking")).toBe(true);
  view.setActivity({ ...a, status: "ready", processStatus: "idle" });
  expect(label.textContent).toBe("Ready when you are");
  view.setVisible(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps existing message DOM and reconciles outgoing arrivals without replaying them", () => {
  const view = new AgentView(
    "Grook",
    "stable",
    () => {},
    async () => {},
    () => {},
  );
  const a: Activity = {
    kind: "claude",
    status: "ready",
    canMessage: true,
    tools: 0,
    truncated: false,
    messages: [{ id: "old", role: "assistant", text: "Existing history" }],
  };
  view.setActivity(a);
  const original = view.element.querySelector("article")!;
  expect(original.classList.contains("message-arrival")).toBe(false);
  const id = view.beginMessage("New question");
  const pending = view.element.querySelector(".pending-message")!;
  expect(pending.classList.contains("message-arrival")).toBe(true);
  view.finishMessage(id, true);
  expect(view.element.querySelector(".pending-message")).toBe(pending);
  view.setActivity({
    ...a,
    messages: [
      ...a.messages,
      { id: "confirmed", role: "user", text: "New question" },
      {
        id: "reply",
        role: "assistant",
        text: "New answer\n\nSecond paragraph",
      },
    ],
  });
  const articles = [...view.element.querySelectorAll("article")];
  expect(articles[0]).toBe(original);
  expect(articles[1]).toBe(pending);
  expect(articles[1].querySelector(".message-delivery")).toBeNull();
  expect(articles[2].classList.contains("message-arrival")).toBe(false);
  const lines = articles[2].querySelectorAll<HTMLElement>(
    ".reply-chunk-arrival",
  );
  expect(lines).toHaveLength(4);
  expect(
    [...lines].map((line) => line.style.getPropertyValue("--reveal-delay")),
  ).toEqual(["0ms", "45ms", "90ms", "135ms"]);
  view.dispose();
});

it("keeps pending prompts before later live replies and reconciles busy receipts", () => {
  const view = new AgentView(
    "Grook",
    "test",
    () => {},
    async () => {},
    () => {},
  );
  const state: Activity = {
    kind: "claude",
    canMessage: true,
    status: "working",
    tools: 0,
    truncated: false,
    messages: [{ id: "old", role: "assistant", text: "Working already" }],
  };
  view.setActivity(state);
  const first = view.beginMessage("First follow-up");
  view.finishMessage(first, true);
  const second = view.beginMessage("Second follow-up");
  view.finishMessage(second, true);
  const progress = {
    id: "progress",
    role: "assistant",
    text: "New progress after the sends",
  };
  view.setActivity({ ...state, messages: [...state.messages, progress] });
  const articles = () => [
    ...view.element.querySelectorAll<HTMLElement>("article"),
  ];
  expect(articles().map((node) => node.dataset.messageId)).toEqual([
    "old",
    first,
    second,
    "progress",
  ]);
  expect(view.element.textContent).not.toContain("waiting for agent");
  const firstNode = articles()[1],
    secondNode = articles()[2];
  view.setActivity({
    ...state,
    messages: [
      ...state.messages,
      progress,
      { id: "receipt-1", role: "user", text: "First follow-up" },
      { id: "receipt-2", role: "user", text: "Second follow-up" },
      { id: "reply", role: "assistant", text: "Both follow-ups received" },
    ],
  });
  expect(view.element.querySelectorAll(".pending-message")).toHaveLength(0);
  expect(articles()[2]).toBe(firstNode);
  expect(articles()[3]).toBe(secondNode);
  expect(articles().at(-1)?.textContent).toContain("Both follow-ups received");
});
