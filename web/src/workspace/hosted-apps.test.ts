// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { HostedApps } from "./hosted-apps";

it("shares discovery across panes, opens secure apps and clears stopped listeners", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      first: [
        {
          port: 3090,
          url: "https://app.local.cloover.com:3090",
          source: "checkout",
          process: "node",
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  const first = new HostedApps("first");
  const second = new HostedApps("second");
  try {
    first.setVisible(true);
    second.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const link = first.element.querySelector("a")!;
    expect(link.href).toBe("https://app.local.cloover.com:3090/");
    expect(link.target).toBe("_blank");
    expect(link.title).toContain("Running in this checkout");
    expect(first.element.hidden).toBe(false);
    first.toggle.click();
    expect(first.element.hidden).toBe(true);
    first.toggle.click();
    expect(first.element.hidden).toBe(false);
    expect(second.element.hidden).toBe(true);
    second.toggle.click();
    expect(second.element.textContent).toContain("No web app running");
    fetcher.mockResolvedValue({ ok: true, json: async () => ({}) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.element.querySelector("a")).toBeNull();
    expect(first.element.hidden).toBe(true);
    first.setVisible(false);
    second.setVisible(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    first.dispose();
    second.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
