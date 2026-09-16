import { button, el } from "./dom";

export type MenuAction = { label: string; run(): void; danger?: boolean };
let dismiss: (() => void) | undefined;

export function contextMenu(
  name: string,
  x: number,
  y: number,
  actions: MenuAction[],
  restoreFocus: () => void,
  color: string,
): void {
  dismiss?.();
  const anchor = document.elementFromPoint(x, y);
  const scrollPositions = new Map<Element, [number, number]>();
  for (let node = anchor; node; node = node.parentElement)
    scrollPositions.set(node, [node.scrollLeft, node.scrollTop]);
  const menu = el("div", "context-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${name}`);
  menu.style.setProperty("--terminal-color", color);
  const title = el("div", "context-menu-title", name);
  title.setAttribute("role", "presentation");
  menu.append(title);
  const listeners = new AbortController();
  const close = (focus = false) => {
    listeners.abort();
    menu.remove();
    if (dismiss === close) dismiss = undefined;
    if (focus) restoreFocus();
  };
  dismiss = close;
  const items = actions.map((action) => {
    const item = button(
      action.label,
      () => {
        close(true);
        action.run();
      },
      `context-menu-item${action.danger ? " destructive" : ""}`,
    );
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    menu.append(item);
    return item;
  });
  menu.addEventListener("keydown", (event) => {
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "Escape":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case "ArrowDown":
        next = (current + 1) % items.length;
        break;
      case "ArrowUp":
        next = (current - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    items[next].focus();
  });
  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!menu.contains(event.target as Node)) close();
    },
    { capture: true, signal: listeners.signal },
  );
  window.addEventListener("resize", () => close(true), {
    signal: listeners.signal,
  });
  document.addEventListener(
    "scroll",
    (event) => {
      // Terminal output can scroll independently; only movement of the menu's
      // source should dismiss its actions.
      const target =
        event.target === document ? document.scrollingElement : event.target;
      if (!(target instanceof Element)) return;
      const position = scrollPositions.get(target);
      if (
        position &&
        (target.scrollLeft !== position[0] || target.scrollTop !== position[1])
      )
        close();
    },
    { capture: true, signal: listeners.signal },
  );
  items[0]?.focus({ preventScroll: true });
}
