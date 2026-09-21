// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { keepAwakeControl } from "./keep-awake";

const state = (active: boolean, revision = 1, error = "") => ({ enabled: active, active, revision, error });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function native(postMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("webkit", { messageHandlers: { keepAwake: { postMessage } } });
}
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it("only offers keep awake in the native app", () => {
  expect(keepAwakeControl().hidden).toBe(true);
});
it("reads native preference and waits for acknowledgement when toggled", async () => {
  const post = vi.fn().mockResolvedValueOnce(state(true)).mockResolvedValueOnce(state(false, 2));
  native(post);
  const root = keepAwakeControl(), toggle = root.querySelector("button")!;
  await settle();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  toggle.click();
  expect(toggle.disabled).toBe(true);
  expect(post).toHaveBeenLastCalledWith({ action: "set", enabled: false });
  await settle();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);
});
it("keeps a native menu update when an older query finishes later", async () => {
  let resolve!: (value: ReturnType<typeof state>) => void;
  native(vi.fn().mockReturnValue(new Promise(r => { resolve = r; })));
  const root = keepAwakeControl();
  window.dispatchEvent(new CustomEvent("workspace-keep-awake", { detail: state(false, 3) }));
  resolve(state(true, 1));
  await settle();
  expect(root.querySelector("button")!.getAttribute("aria-checked")).toBe("false");
});
it("shows macOS failures without claiming the assertion is on, and supports retry", async () => {
  const post = vi.fn().mockResolvedValueOnce({ ...state(false), enabled: true, error: "Could not enable" }).mockResolvedValueOnce(state(true, 2));
  native(post);
  const root = keepAwakeControl();
  await settle();
  expect(root.textContent).toContain("Could not enable");
  expect(root.querySelector("button")!.getAttribute("aria-checked")).toBe("false");
  root.querySelector("button")!.click();
  await settle();
  expect(root.textContent).not.toContain("Could not enable");
  expect(root.querySelector("button")!.getAttribute("aria-checked")).toBe("true");
});
it("allows retry after bridge failure", async () => {
  native(vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValueOnce(state(true)));
  const root = keepAwakeControl();
  await settle();
  expect(root.textContent).toContain("Click to retry");
  const toggle = root.querySelector("button")!;
  expect(toggle.disabled).toBe(false);
  toggle.click();
  await settle();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
