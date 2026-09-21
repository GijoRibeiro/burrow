import { el } from "./dom";

const paths = {
  tasks: "M4 5h12v14H4z M8 5V3h8v12 M7 9h6 M7 12h6 M7 15h3",
  inbox: "M4 4h16v16H4z M4 13h5l2 3h2l2-3h5",
  link: "M10 14l4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  tools: "M5 4v6 M5 14v6 M12 4v10 M12 18v2 M19 4v2 M19 10v10 M2 10h6 M9 14h6 M16 6h6",
  keyboard: "M3 6h18v12H3z M6 9h1 M10 9h1 M14 9h1 M18 9h0 M6 12h1 M10 12h1 M14 12h1 M18 12h0 M7 15h10",
};

export function sidebarAction(button: HTMLButtonElement, icon: keyof typeof paths, label: string, trailing?: HTMLElement): HTMLButtonElement {
  button.className = "sidebar-action";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[icon]);
  svg.append(path);
  button.replaceChildren(svg, el("span", "sidebar-action-label", label));
  if (trailing) button.append(trailing);
  return button;
}
