import { AGENT_COLORS, agentColor } from "../ui/colors";
import { button, el } from "./dom";

const sprites = import.meta.glob<string>("../../assets/sprites/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
// Bitwise holds each original pixel-art pose for 800ms. Discover numbered
// frames at build time, so adding a third pose needs no animation-code change.
export const SPRITE_FRAME_MS = 800;
export function spriteCatalog(
  files: Record<string, string>,
): Map<string, string[]> {
  const groups = new Map<string, Map<number, string>>();
  for (const [path, url] of Object.entries(files)) {
    const match = path.match(/\/([^/]+)[-_]([1-9]\d*)\.png$/);
    if (!match) continue;
    const [, name, frame] = match;
    if (!groups.has(name)) groups.set(name, new Map());
    groups.get(name)!.set(Number(frame), url);
  }
  const catalog = new Map<string, string[]>();
  for (const [name, frames] of groups) {
    const sorted = [...frames].sort(([a], [b]) => a - b);
    if (sorted.every(([frame], index) => frame === index + 1))
      catalog.set(
        name,
        sorted.map(([, url]) => url),
      );
  }
  return catalog;
}
const catalog = spriteCatalog(sprites);
const sequences = new Set<number>();
function prepareSequence(count: number) {
  if (count < 2 || sequences.has(count)) return;
  sequences.add(count);
  const style = document.createElement("style");
  style.dataset.spriteSequence = String(count);
  style.textContent = `@keyframes creature-poses-${count} { 0% { opacity: 1; } ${100 / count}% { opacity: 0; } 100% { opacity: 0; } }`;
  document.head.append(style);
}
export const terminalColor = (id: string): string =>
  agentColor(`terminal:${id}`);
export const validColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const preferredCreatures = [
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
export const creatures = [
  ...preferredCreatures.filter((name) => catalog.has(name)),
  ...[...catalog.keys()]
    .filter((name) => !preferredCreatures.includes(name))
    .sort(),
];
export function defaultCreature(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return creatures[hash % creatures.length];
}
export function creature(name: string, className = ""): HTMLElement {
  const node = el("span", `creature ${className}`);
  node.setAttribute("aria-hidden", "true");
  const chosen = catalog.has(name) ? name : "Grook";
  const frames = catalog.get(chosen)!;
  prepareSequence(frames.length);
  node.dataset.creature = chosen;
  node.dataset.frameCount = String(frames.length);
  node.style.setProperty(
    "--sprite-sequence",
    `creature-poses-${frames.length}`,
  );
  const duration = frames.length * SPRITE_FRAME_MS;
  node.style.setProperty("--sprite-duration", `${duration}ms`);
  const phase = Date.now() % duration;
  frames.forEach((url, index) => {
    const img = el("span", `creature-frame frame-${index + 1}`);
    const mask = `url("${url}")`;
    img.style.maskImage = mask;
    img.style.setProperty("-webkit-mask-image", mask);
    img.style.animationDelay = `-${(phase + duration - index * SPRITE_FRAME_MS) % duration}ms`;
    node.append(img);
  });
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
