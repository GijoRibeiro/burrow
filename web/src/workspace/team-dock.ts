import { button, el } from "./dom";
import { renderSplitTree } from "./split-view";
import type { Tree } from "./layout";
import type { TerminalPane } from "./terminal";

interface DockOptions {
  selected: string;
  pinned: string;
  ratio: number;
  panesRatio: number;
  stacked: boolean;
  open(id: string): void;
  close(id: string): void;
  pin(id: string): void;
  resize(ratio: number, panesRatio: number): void;
}

// The canvas and its conversations use the same accessible resize handles as
// the terminal workspace, including keyboard sizing and double-tap balancing.
export function renderTeamDock(
  graph: HTMLElement,
  panes: Map<string, TerminalPane>,
  options: DockOptions,
): HTMLElement {
  const layout = el("div", "team-workspace");
  const open = [
    ...new Set(
      [options.pinned, options.selected].filter((id) => id && panes.has(id)),
    ),
  ];
  if (!open.length) {
    layout.append(graph);
    return layout;
  }
  const dock = el("aside", "team-dock");
  const cards = new Map<string, { element: HTMLElement }>();
  for (const id of open) {
    const pinned = id === options.pinned;
    const card = el("section", "team-dock-card");
    const bar = el("div", "team-dock-toolbar");
    const pin = button(
      pinned ? "Unpin agent from canvas" : "Keep agent open on canvas",
      () => options.pin(pinned ? "" : id),
      "subtle",
      pinned ? "Pinned" : "Pin",
    );
    pin.setAttribute("aria-pressed", String(pinned));
    bar.append(
      el("span", "", pinned ? "PINNED" : "IN CONVERSATION"),
      pin,
      button(
        id === options.selected
          ? "Open selected agent in terminals"
          : "Open pinned agent in terminals",
        () => options.open(id),
        "subtle",
        "Open in terminals ↗",
      ),
      button(
        id === options.selected
          ? "Close canvas terminal"
          : "Close pinned canvas terminal",
        () => options.close(id),
        "icon-button",
        "×",
      ),
    );
    const host = el("div", "team-dock-host");
    host.append(panes.get(id)!.element);
    card.append(bar, host);
    cards.set(id, { element: card });
  }
  const split: Tree = {
    id: "canvas-dock",
    axis: options.stacked ? "column" : "row",
    ratio: options.ratio,
    a: { id: "graph", terminal: "graph" },
    b: { id: "dock", terminal: "dock" },
  };
  let inner: Tree | undefined;
  const persist = () =>
    options.resize(
      split.ratio,
      inner && "ratio" in inner ? inner.ratio : options.panesRatio,
    );
  if (open.length === 2) {
    inner = {
      id: "dock-panes",
      axis: "column",
      ratio: options.panesRatio,
      a: { id: open[0], terminal: open[0] },
      b: { id: open[1], terminal: open[1] },
    };
    dock.append(renderSplitTree(inner, cards, persist));
  } else dock.append(cards.get(open[0])!.element);
  const outer = renderSplitTree(
    split,
    new Map([
      ["graph", { element: graph }],
      ["dock", { element: dock }],
    ]),
    persist,
  );
  outer.classList.add("team-dock-split");
  outer
    .querySelector(":scope > .resize-handle")
    ?.setAttribute("aria-label", "Resize canvas terminal panel");
  layout.append(outer);
  return layout;
}
