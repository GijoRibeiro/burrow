// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ConversationScroll } from "./conversation-scroll";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
function fixture() {
  vi.useFakeTimers();
  const viewport = document.createElement("div"),
    stack = document.createElement("div");
  viewport.append(stack);
  document.body.append(viewport);
  let heights = [900, 400, 700],
    top = 0;
  Object.defineProperty(viewport, "clientHeight", { get: () => 500 });
  Object.defineProperty(viewport, "scrollHeight", {
    get: () => heights.reduce((a, b) => a + b, 0),
  });
  Object.defineProperty(viewport, "scrollTop", {
    get: () => top,
    set: (value) => {
      top = Math.max(0, Math.min(viewport.scrollHeight - 500, value));
    },
  });
  viewport.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  for (let i = 0; i < 3; i++) {
    const article = document.createElement("article");
    article.className = "conversation-message";
    article.getBoundingClientRect = () => {
      const y = 100 + heights.slice(0, i).reduce((a, b) => a + b, 0) - top;
      return { top: y, bottom: y + heights[i] } as DOMRect;
    };
    stack.append(article);
  }
  const scroller = new ConversationScroll(viewport, stack, () => {});
  scroller.setVisible(true);
  return { viewport, stack, scroller, heights };
}
it("catches up immediately on a large burst and bounds nearby follow duration", () => {
  const { viewport, scroller, heights } = fixture();
  expect(viewport.scrollTop).toBe(1500);
  heights[2] += 12000;
  scroller.capture();
  scroller.reflow();
  expect(viewport.scrollTop).toBe(13500);
  heights[2] += 120;
  scroller.capture();
  scroller.reflow();
  let previous = viewport.scrollTop;
  for (let i = 0; i < 16; i++) {
    vi.advanceTimersByTime(16);
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(previous);
    previous = viewport.scrollTop;
  }
  expect(viewport.scrollTop).toBe(13620);
  expect(vi.getTimerCount()).toBe(0);
  scroller.dispose();
});
it("holds the visible message in place when earlier content changes height", () => {
  const { viewport, stack, scroller, heights } = fixture();
  viewport.scrollTop = 950;
  viewport.dispatchEvent(new Event("scroll"));
  expect(scroller.isFollowing).toBe(false);
  const anchor = stack.children[1];
  const before = anchor.getBoundingClientRect().top;
  heights[0] += 600;
  scroller.reflow();
  expect(anchor.getBoundingClientRect().top).toBe(before);
  expect(viewport.scrollTop).toBe(1550);
  heights[2] += 12000;
  scroller.reflow();
  expect(viewport.scrollTop).toBe(1550);
  expect(vi.getTimerCount()).toBe(0);
  scroller.dispose();
});
