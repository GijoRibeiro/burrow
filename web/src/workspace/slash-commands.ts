import { button, el } from "./dom";
import "./slash-commands.css";

const commands = [
  ["/model", "Choose a model"],
  ["/mcp", "Manage connected tools"],
  ["/remote-control", "Continue this session from another device"],
  ["/status", "Session and account status"],
  ["/context", "Inspect context usage"],
  ["/compact", "Summarize the conversation"],
  ["/config", "Claude Code settings"],
  ["/help", "Explore available CLI commands"],
];

export function isSlashCommand(text: string): boolean {
  return /^\/[a-z][\w:-]*(?:\s|$)/i.test(text.trim());
}

export class SlashCommands {
  readonly element = el("div", "composer-commands");
  private enabled = false;
  private selected = 0;
  private matches: string[][] = [];
  private dismissed = "";
  constructor(private input: HTMLTextAreaElement) {
    this.element.id = `commands-${crypto.randomUUID()}`;
    this.element.hidden = true;
    this.element.setAttribute("role", "listbox");
    this.element.setAttribute("aria-label", "Claude commands");
    input.setAttribute("aria-controls", this.element.id);
    input.setAttribute("aria-autocomplete", "list");
    input.addEventListener("input", () => {
      this.dismissed = "";
      this.selected = 0;
      this.render();
    });
    input.addEventListener("focus", () => this.render());
    input.addEventListener("blur", () => this.hide());
    this.element.addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );
  }
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.render();
  }
  hide(): void {
    this.element.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }
  handleKey(event: KeyboardEvent): boolean {
    if (this.element.hidden || event.isComposing) return false;
    if (event.key === "Escape") {
      this.dismissed = this.input.value;
      this.hide();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      this.selected =
        (this.selected +
          (event.key === "ArrowDown" ? 1 : -1) +
          this.matches.length) %
        this.matches.length;
      this.highlight();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      this.input.value !== this.matches[this.selected]?.[0]
    ) {
      this.choose(this.matches[this.selected][0]);
    } else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  private choose(command: string): void {
    this.input.value = command;
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.dismissed = command;
    this.hide();
    this.input.focus();
  }
  private render(): void {
    const text = this.input.value;
    if (
      !this.enabled ||
      document.activeElement !== this.input ||
      !/^\/[\w:-]*$/.test(text) ||
      this.dismissed === text
    ) {
      this.hide();
      return;
    }
    const query = text.toLowerCase();
    this.matches = commands.filter(
      ([name]) =>
        name.includes(query.slice(1)) ||
        (name === "/remote-control" &&
          ["/rc", "/control-remote"].includes(query)),
    );
    if (!this.matches.length) {
      this.hide();
      return;
    }
    this.selected = Math.min(this.selected, this.matches.length - 1);
    this.element.replaceChildren();
    const hint = el(
      "div",
      "composer-commands-hint",
      "Claude commands · Choose, then Enter to run in Terminal",
    );
    hint.setAttribute("role", "presentation");
    this.element.append(hint);
    for (const [index, [name, description]] of this.matches.entries()) {
      const row = button(name, () => this.choose(name), "composer-command", "");
      row.id = `${this.element.id}-${index}`;
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      row.append(el("span", "", name), el("small", "", description));
      this.element.append(row);
    }
    this.element.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.highlight();
  }
  private highlight(): void {
    const rows = this.element.querySelectorAll<HTMLElement>('[role="option"]');
    rows.forEach((row, index) =>
      row.setAttribute("aria-selected", String(index === this.selected)),
    );
    const selected = rows[this.selected];
    this.input.setAttribute("aria-activedescendant", selected.id);
    const top = selected.offsetTop,
      bottom = top + selected.offsetHeight;
    if (top < this.element.scrollTop) this.element.scrollTop = top;
    else if (bottom > this.element.scrollTop + this.element.clientHeight)
      this.element.scrollTop = bottom - this.element.clientHeight;
  }
}
