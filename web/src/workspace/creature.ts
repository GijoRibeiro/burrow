import { AGENT_COLORS, agentColor } from "../ui/colors";
import { button, el } from "./dom";

const sprites = import.meta.glob<string>("../../assets/sprites/*-*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
export const terminalColor = (id: string): string =>
  agentColor(`terminal:${id}`);
export const validColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
export const creatures = [
  "Grook",
  "ghost",
  "Gijo",
  "crab",
  "Nuraglin",
  "monkey",
  "imp",
  "king",
  "skull",
  "skeleton",
  "blob",
  "mouse",
];
export function defaultCreature(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return creatures[hash % creatures.length];
}
export function creature(name: string, className = ""): HTMLElement {
  const node = el("span", `creature ${className}`);
  node.setAttribute("aria-hidden", "true");
  node.dataset.creature = name;
  for (const frame of [1, 2]) {
    const img = el("span", `creature-frame frame-${frame}`);
    const mask = `url("${sprites[`../../assets/sprites/${name}-${frame}.png`]}" )`;
    img.style.maskImage = mask;
    img.style.setProperty("-webkit-mask-image", mask);
    node.append(img);
  }
  return node;
}
export function chooseCreature(
  current: string,
  select: (name: string) => void,
  color: string,
  selectColor: (color: string) => void,
): void {
  const dialog = el("dialog", "dialog creature-dialog");
  dialog.style.setProperty("--terminal-color", color);
  const palette = el("div", "color-palette");
  palette.setAttribute("role", "group");
  palette.setAttribute("aria-label", "Terminal color");
  const names = [
    "Coral",
    "Cyan",
    "Orange",
    "Blue",
    "Amber",
    "Indigo",
    "Yellow",
    "Violet",
    "Lime",
    "Magenta",
    "Green",
    "Pink",
    "Teal",
    "Rose",
    "Sky",
    "Tangerine",
    "Aqua",
    "Lilac",
    "Cream",
    "Purple",
  ];
  for (const [index, value] of AGENT_COLORS.entries()) {
    const swatch = button(
      `Use ${names[index]} color`,
      () => {
        selectColor(value);
        dialog.style.setProperty("--terminal-color", value);
        for (const option of palette.querySelectorAll("button"))
          option.setAttribute("aria-pressed", String(option === swatch));
      },
      "color-swatch",
      "",
    );
    swatch.style.setProperty("--swatch", value);
    swatch.setAttribute("aria-pressed", String(value === color));
    palette.append(swatch);
  }
  const grid = el("div", "creature-grid");
  for (const name of creatures) {
    const pick = button(
      `Choose ${name}`,
      () => {
        select(name);
        dialog.close();
      },
      "creature-choice",
      "",
    );
    pick.setAttribute("aria-pressed", String(current === name));
    pick.append(creature(name), el("span", "", name));
    grid.append(pick);
  }
  dialog.append(
    el("h2", "", "Make it yours"),
    el(
      "p",
      "dialog-description",
      "A color and a companion to find this terminal at a glance.",
    ),
    el("h3", "appearance-label", "Terminal color"),
    palette,
    el("h3", "appearance-label", "Creature"),
    grid,
    button("Done", () => dialog.close(), "secondary"),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
