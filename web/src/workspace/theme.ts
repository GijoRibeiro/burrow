import type { ITheme } from "@xterm/xterm";

const STORAGE = "cloovies.workspace.background.v1";
export const DEFAULT_BACKGROUND = "#2e2f38";
export const BACKGROUNDS = [
  ["Slate", DEFAULT_BACKGROUND],
  ["Charcoal", "#202126"],
  ["Midnight", "#15171c"],
  ["Ink", "#0d0f12"],
  ["Black", "#000000"],
] as const;
export function validBackground(value: string): boolean {
  return /^#[\da-f]{6}$/i.test(value);
}
export function background(): string {
  try {
    const value = localStorage.getItem(STORAGE) || "";
    if (validBackground(value)) return value;
  } catch {
    /* Private storage still supports a live preview. */
  }
  return (
    document.documentElement.style.getPropertyValue("--bg") ||
    DEFAULT_BACKGROUND
  );
}
function isLight(value: string): boolean {
  const channels = [1, 3, 5]
    .map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return (
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.35
  );
}
export function applyBackground(value: string, persist = true): void {
  if (!validBackground(value)) return;
  const light = isLight(value);
  const style = document.documentElement.style;
  style.setProperty("--bg", value);
  style.setProperty("--ink", light ? "#24252b" : "#eae5ce");
  style.setProperty("--muted", light ? "#53555e" : "#b3b2ad");
  style.setProperty("--line", `color-mix(in srgb, var(--ink) 18%, var(--bg))`);
  style.setProperty(
    "--faint",
    "color-mix(in srgb, var(--ink) 4%, transparent)",
  );
  style.setProperty(
    "--surface",
    "color-mix(in srgb, var(--ink) 3%, var(--bg))",
  );
  style.colorScheme = light ? "light" : "dark";
  if (persist) {
    try {
      localStorage.setItem(STORAGE, value);
    } catch {
      /* Live theme remains usable. */
    }
  }
  window.dispatchEvent(new Event("workspace-theme"));
}
export function terminalTheme(): ITheme {
  const value =
    document.documentElement.style.getPropertyValue("--bg") ||
    DEFAULT_BACKGROUND;
  // Leave all ANSI palette entries untouched. Programs own their colors.
  return {
    background: value,
    foreground: isLight(value) ? "#202126" : "#ffffff",
    cursor: isLight(value) ? "#202126" : "#ffffff",
  };
}
