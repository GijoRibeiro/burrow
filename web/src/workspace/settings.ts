import { button, el } from "./dom";
import {
  applyBackground,
  background,
  BACKGROUNDS,
  DEFAULT_BACKGROUND,
  validBackground,
} from "./theme";
import { linearConnectionDialog } from "./linear-connection";
import { complaintsInbox } from "./complaints";
import { setupDialog } from "./setup";
import "./settings.css";

interface SettingsContext {
  fontSize(): number;
  setFontSize(size: number): void;
  awake: HTMLElement;
  shortcuts(): void;
}
export function settingsPage(context: SettingsContext): void {
  if (document.querySelector(".settings-page")) return;
  const d = el("dialog", "settings-page");
  d.setAttribute("aria-label", "Settings");
  const heading = el("header", "settings-heading");
  heading.append(
    el("h1", "", "Settings"),
    button("Close settings", () => d.close(), "settings-close", "×"),
  );
  const body = el("div", "settings-body");
  const nav = el("nav", "settings-nav");
  nav.setAttribute("aria-label", "Settings sections");
  const content = el("div", "settings-content");
  const sections: HTMLElement[] = [];
  const tabs: HTMLButtonElement[] = [];
  const section = (name: string, description: string) => {
    const panel = el("section", "settings-section");
    panel.setAttribute("aria-label", name);
    panel.append(el("h2", "", name), el("p", "settings-intro", description));
    const tab = button(
      name,
      () => {
        sections.forEach((item) => (item.hidden = item !== panel));
        tabs.forEach((item) =>
          item.setAttribute("aria-current", item === tab ? "page" : "false"),
        );
      },
      "settings-tab",
    );
    panel.hidden = sections.length > 0;
    tab.setAttribute("aria-current", sections.length ? "false" : "page");
    sections.push(panel);
    tabs.push(tab);
    nav.append(tab);
    content.append(panel);
    return panel;
  };
  const appearance = section(
    "Appearance",
    "Your workspace, in the shade you prefer.",
  );
  appearance.append(el("h3", "", "Background"));
  const swatches = el("div", "settings-swatches");
  const controls: HTMLButtonElement[] = [];
  const color = el("input");
  color.type = "color";
  color.setAttribute("aria-label", "Background color");
  const hex = el("input", "settings-hex");
  hex.setAttribute("aria-label", "Background hex color");
  hex.spellcheck = false;
  hex.maxLength = 7;
  const error = el("p", "settings-error");
  error.setAttribute("role", "status");
  const update = (value: string) => {
    if (!validBackground(value)) {
      error.textContent = "Enter a six-digit hex color, like #15171c.";
      hex.setAttribute("aria-invalid", "true");
      return;
    }
    error.textContent = "";
    hex.removeAttribute("aria-invalid");
    applyBackground(value);
    color.value = hex.value = value;
    controls.forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.color === value.toLowerCase()),
      ),
    );
  };
  for (const [name, value] of BACKGROUNDS) {
    const b = button(
      `${name} background`,
      () => update(value),
      "settings-swatch",
      "",
    );
    const sample = el("span", "settings-swatch-color");
    sample.style.background = value;
    b.append(sample, el("span", "", name));
    b.dataset.color = value;
    b.setAttribute("aria-pressed", String(background() === value));
    controls.push(b);
    swatches.append(b);
  }
  color.value = hex.value = background();
  color.oninput = () => update(color.value);
  hex.onchange = () => update(hex.value.trim());
  hex.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      update(hex.value.trim());
    }
  };
  const custom = el("div", "settings-custom-color");
  custom.append(
    el("span", "", "Custom color"),
    color,
    hex,
    button(
      "Reset background",
      () => update(DEFAULT_BACKGROUND),
      "settings-text-button",
      "Reset",
    ),
  );
  appearance.append(
    swatches,
    custom,
    error,
    el(
      "p",
      "settings-note",
      "Applies immediately to chat, canvas, and terminals. Saved on this device.",
    ),
  );
  const text = el("div", "settings-row");
  const font = el("input");
  font.type = "range";
  font.min = "10";
  font.max = "22";
  font.step = "1";
  font.value = String(context.fontSize());
  font.setAttribute("aria-label", "Text size");
  const size = el("output", "", `${font.value}px`);
  font.oninput = () => {
    context.setFontSize(Number(font.value));
    size.value = `${font.value}px`;
  };
  text.append(el("span", "", "Chat and terminal text"), font, size);
  appearance.append(text);
  const connections = section(
    "Connections",
    "Manage the services your agents use.",
  );
  const open = (fn: () => void) => () => {
    d.close();
    fn();
  };
  const action = (
    parent: HTMLElement,
    label: string,
    detail: string,
    fn: () => void,
  ) => {
    const b = button(label, open(fn), "settings-link", "");
    const copy = el("span");
    copy.append(el("strong", "", label), el("small", "", detail));
    b.append(copy, el("span", "", "↗"));
    parent.append(b);
  };
  action(
    connections,
    "Linear connection",
    "Account, API key, and ticket access",
    linearConnectionDialog,
  );
  action(
    connections,
    "Slack product inbox",
    "Channels, manual scans, and hourly scanning",
    complaintsInbox,
  );
  const general = section("General", "Tools and behavior for this Mac.");
  if (!context.awake.hidden) {
    general.append(
      context.awake,
      el(
        "p",
        "settings-note",
        "Keep agents running when the screen locks or turns off. Applies while the app is open; closing the lid or choosing Sleep can still suspend this Mac.",
      ),
    );
  }
  action(
    general,
    "Setup and tools",
    "Install or check Git, tmux, Claude Code, and Codex",
    setupDialog,
  );
  action(
    general,
    "Keyboard shortcuts",
    "Move between agents and arrange your workspace",
    context.shortcuts,
  );
  body.append(nav, content);
  d.append(heading, body);
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
}
