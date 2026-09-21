import { button, el } from "./dom";
import { nativeHandler } from "./setup";

type AwakeState = {
  enabled: boolean;
  active: boolean;
  error: string;
  revision: number;
};

export function keepAwakeControl(): HTMLElement {
  const root = el("div", "keep-awake-control");
  const bridge = nativeHandler<AwakeState>("keepAwake");
  root.hidden = !bridge;
  if (!bridge) return root;
  let state: AwakeState | undefined;
  let busy = false;
  const hint = el("span", "keep-awake-error");
  hint.setAttribute("role", "status");
  const toggle = button("Keep awake", () => void request(!state?.active), "subtle keep-awake-toggle");
  toggle.setAttribute("role", "switch");
  toggle.disabled = true;
  const render = () => {
    toggle.disabled = busy;
    toggle.textContent = `Keep awake · ${state ? (state.active ? "On" : "Off") : "Retry"}`;
    toggle.setAttribute("aria-checked", String(state?.active ?? false));
    toggle.title = "Keeps this Mac running while the screen is locked or off. Ends when you quit. Closing the lid or choosing Sleep can still suspend the Mac.";
    hint.textContent = state?.error ?? "";
  };
  const accept = (next: AwakeState) => {
    // Native menu changes can arrive before an older bridge reply.
    if (!state || next.revision >= state.revision) state = next;
    render();
  };
  const request = async (enabled?: boolean) => {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try {
      accept(await bridge.postMessage(enabled === undefined ? { action: "get" } : { action: "set", enabled }));
    } catch {
      render();
      hint.textContent = "Could not update Keep awake. Click to retry.";
    } finally {
      busy = false;
      toggle.disabled = false;
    }
  };
  window.addEventListener("workspace-keep-awake", (event) => {
    accept((event as CustomEvent<AwakeState>).detail);
  });
  root.append(toggle, hint);
  void request();
  return root;
}
