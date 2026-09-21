// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { UsageMeters, remainingUsage, type ModelUsage } from "./usage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
const astra: ModelUsage = {
  provider: "openai",
  model: "Astra",
  status: "ready",
  shared: true,
  windows: [{ label: "Weekly", used: 9 }],
};
it("shows the limiting allowance, not an average, and keeps unavailable distinct from zero", () => {
  expect(remainingUsage(astra)).toBe(91);
  expect(
    remainingUsage({
      ...astra,
      windows: [
        { label: "Session", used: 9 },
        { label: "Fable", used: 100 },
      ],
    }),
  ).toBe(0);
  expect(remainingUsage({ ...astra, status: "unavailable" })).toBeNull();
  expect(remainingUsage({ ...astra, windows: [] })).toBeNull();
});
it("renders two accessible meters and stops polling after disposal", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  const fetcher = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          astra,
          {
            ...astra,
            provider: "anthropic",
            model: "Fable",
            shared: false,
            windows: [{ label: "Fable · weekly", used: 100 }],
          },
        ],
        checkedAt: "2026-09-21T12:00:00Z",
      }),
    });
  vi.stubGlobal("fetch", fetcher);
  const meters = new UsageMeters();
  document.body.append(meters.element);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    [...meters.element.querySelectorAll(".usage-value")].map(
      (n) => n.textContent,
    ),
  ).toEqual(["91% left", "0% left"]);
  const bars = meters.element.querySelectorAll('[role="meter"]');
  expect(bars[0].getAttribute("aria-valuenow")).toBe("91");
  expect(bars[1].getAttribute("aria-valuenow")).toBe("0");
  expect(meters.element.textContent).toContain("Shared Codex allowance");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  meters.dispose();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
