import { el } from "./dom";
import type { Tree } from "./layout";
import type { TerminalPane } from "./terminal";

function minimumSize(tree: Tree): { width: number; height: number } {
  if ("terminal" in tree) return { width: 260, height: 230 };
  const a = minimumSize(tree.a),
    b = minimumSize(tree.b);
  return tree.axis === "row"
    ? { width: a.width + b.width + 10, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + 10 };
}
export function renderSplitTree(
  tree: Tree,
  panes: Map<string, Pick<TerminalPane, "element">>,
  persist: () => void,
): HTMLElement {
  if ("terminal" in tree) return panes.get(tree.terminal)?.element || el("div");
  const split = el("div", `split split-${tree.axis}`);
  const a = el("div", "split-child"),
    b = el("div", "split-child");
  const size = minimumSize(tree),
    sizeA = minimumSize(tree.a),
    sizeB = minimumSize(tree.b);
  split.style.minWidth = `${size.width}px`;
  split.style.minHeight = `${size.height}px`;
  a.style.minWidth = `${sizeA.width}px`;
  a.style.minHeight = `${sizeA.height}px`;
  b.style.minWidth = `${sizeB.width}px`;
  b.style.minHeight = `${sizeB.height}px`;
  const apply = () => {
    a.style.flex = `${tree.ratio} 1 0`;
    b.style.flex = `${1 - tree.ratio} 1 0`;
    handle.setAttribute("aria-valuenow", String(Math.round(tree.ratio * 100)));
  };
  a.append(renderSplitTree(tree.a, panes, persist));
  b.append(renderSplitTree(tree.b, panes, persist));
  const handle = el("div", "resize-handle");
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute(
    "aria-label",
    tree.axis === "row" ? "Resize columns" : "Resize rows",
  );
  handle.setAttribute(
    "aria-orientation",
    tree.axis === "row" ? "vertical" : "horizontal",
  );
  handle.setAttribute("aria-valuemin", "10");
  handle.setAttribute("aria-valuemax", "90");
  handle.title = "Drag to resize · Double-click or double-tap to balance";
  let balancing: ReturnType<typeof setTimeout> | undefined;
  const balance = () => {
    clearTimeout(balancing);
    split.classList.add("balancing");
    tree.ratio = 0.5;
    apply();
    persist();
    balancing = setTimeout(() => split.classList.remove("balancing"), 220);
  };
  handle.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === "Home") {
      e.preventDefault();
      balance();
      return;
    }
    const step = ["ArrowLeft", "ArrowUp"].includes(e.key)
      ? -0.025
      : ["ArrowRight", "ArrowDown"].includes(e.key)
        ? 0.025
        : 0;
    if (step) {
      e.preventDefault();
      tree.ratio = Math.min(0.9, Math.max(0.1, tree.ratio + step));
      apply();
      persist();
    }
  };
  let previousTap:
    { time: number; x: number; y: number; type: string } | undefined;
  let lastBalanced = -Infinity;
  // Keep the native event as a fallback, without balancing twice after pointerup.
  handle.ondblclick = (e) => {
    e.preventDefault();
    if (performance.now() - lastBalanced > 450) balance();
    previousTap = undefined;
  };
  handle.onpointerdown = (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    clearTimeout(balancing);
    split.classList.remove("balancing");
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const start = { x: e.clientX, y: e.clientY, time: performance.now() };
    let dragged = false;
    handle.onpointermove = (event) => {
      if (event.pointerId !== e.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)
        dragged = true;
      if (!dragged) return;
      previousTap = undefined;
      const rect = split.getBoundingClientRect();
      const value =
        tree.axis === "row"
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
      tree.ratio = Math.min(0.9, Math.max(0.1, value));
      apply();
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      handle.onpointermove =
        handle.onpointerup =
        handle.onpointercancel =
        handle.onlostpointercapture =
          null;
      handle.classList.remove("dragging");
      if (handle.hasPointerCapture(e.pointerId))
        handle.releasePointerCapture(e.pointerId);
      const now = performance.now();
      if (event.type === "pointerup" && !dragged && now - start.time < 350) {
        const tap = {
          time: now,
          x: event.clientX,
          y: event.clientY,
          type: event.pointerType,
        };
        if (
          previousTap &&
          tap.type === previousTap.type &&
          now - previousTap.time < 450 &&
          Math.hypot(tap.x - previousTap.x, tap.y - previousTap.y) < 12
        ) {
          balance();
          lastBalanced = now;
          previousTap = undefined;
          return;
        }
        previousTap = tap;
      } else previousTap = undefined;
      persist();
    };
    handle.onpointerup =
      handle.onpointercancel =
      handle.onlostpointercapture =
        finish;
  };
  apply();
  split.append(a, handle, b);
  return split;
}
