import { button, el } from "./dom";
import openaiIcon from "../../assets/brands/openai.svg";
import claudeIcon from "../../assets/brands/claude.svg";
import "./usage.css";

export type ModelUsage = {
  provider: string;
  model: string;
  status: string;
  shared: boolean;
  windows: { label: string; used: number; resetsAt?: string }[];
};

export function remainingUsage(model: ModelUsage): number | null {
  const windows = model.windows.filter(
    (w) => Number.isFinite(w.used) && w.used >= 0,
  );
  if (model.status !== "ready" || !windows.length) return null;
  return Math.max(0, Math.floor(100 - Math.max(...windows.map((w) => w.used))));
}

class UsageMeter {
  readonly element = el("div", "usage-meter");
  private trigger = button(
    "",
    () => {
      const open = this.element.classList.toggle("is-open");
      this.element.classList.toggle("is-dismissed", !open);
      this.trigger.setAttribute("aria-expanded", String(open));
    },
    "usage-trigger",
  );
  private track = el("span", "usage-track");
  private fill = el("span", "usage-fill");
  private value = el("span", "usage-value", "—");
  private detail = el("div", "usage-detail");
  constructor(
    readonly provider: string,
    readonly model: string,
    icon: string,
  ) {
    const logo = el("img", "usage-logo");
    logo.src = icon;
    logo.alt = provider === "openai" ? "GPT" : "Claude";
    this.element.dataset.provider = provider;
    this.track.setAttribute("role", "meter");
    this.track.setAttribute("aria-valuemin", "0");
    this.track.setAttribute("aria-valuemax", "100");
    this.track.setAttribute("aria-label", `${model} remaining allowance`);
    this.track.append(this.fill);
    this.detail.id = `usage-${provider}-detail`;
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("aria-controls", this.detail.id);
    this.trigger.append(logo, this.track, this.value);
    this.element.append(this.trigger, this.detail);
    this.element.addEventListener("pointerenter", () =>
      this.element.classList.remove("is-dismissed"),
    );
    this.render({
      provider,
      model,
      status: "loading",
      windows: [],
      shared: false,
    });
  }
  close(): void {
    this.element.classList.remove("is-open");
    this.element.classList.add("is-dismissed");
    this.trigger.setAttribute("aria-expanded", "false");
  }
  render(model: ModelUsage, checkedAt?: string): void {
    const left = remainingUsage(model);
    this.element.dataset.level =
      left === null ? "unknown" : left <= 10 ? "low" : "normal";
    this.fill.style.width = `${left ?? 0}%`;
    this.value.textContent = left === null ? "—" : `${left}% left`;
    if (left === null) this.track.removeAttribute("aria-valuenow");
    else this.track.setAttribute("aria-valuenow", String(left));
    const state =
      left === null
        ? model.status === "loading"
          ? "Checking allowance"
          : "Usage unavailable"
        : `${left}% remaining`;
    this.track.setAttribute("aria-valuetext", state);
    this.trigger.setAttribute("aria-label", `${this.model} usage: ${state}`);
    this.trigger.removeAttribute("title");
    const heading = el("div", "usage-detail-heading");
    heading.append(el("strong", "", this.model), el("span", "", state));
    this.detail.replaceChildren(heading);
    if (left === null) {
      this.detail.append(
        el(
          "p",
          "",
          model.status === "loading"
            ? "Reading your signed-in account…"
            : `Sign in through ${this.provider === "openai" ? "Codex" : "Claude Code"} to see your allowance. If already signed in, usage will refresh when the service is available.`,
        ),
      );
      return;
    }
    for (const window of model.windows) {
      const row = el("div", "usage-window");
      row.append(
        el("span", "", window.label),
        el("span", "", `${Math.round(window.used)}% used`),
      );
      this.detail.append(row);
      if (window.resetsAt) {
        const reset = new Date(window.resetsAt);
        if (Number.isFinite(reset.getTime())) {
          this.detail.append(
            el(
              "div",
              "usage-reset",
              `Resets ${reset.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`,
            ),
          );
        }
      }
    }
    this.detail.append(
      el(
        "p",
        "usage-explanation",
        model.shared
          ? `Shared ${this.provider === "openai" ? "Codex" : "Claude"} allowance. No separate ${this.model} limit is reported.`
          : "The bar shows what remains before the first applicable limit is reached.",
      ),
    );
    if (checkedAt) {
      const checked = new Date(checkedAt);
      if (Number.isFinite(checked.getTime()))
        this.detail.append(
          el(
            "div",
            "usage-updated",
            `Updated ${checked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · refreshes every minute`,
          ),
        );
    }
  }
}

/** Account polling is separate from terminal frames, chat and workspace snapshots. */
export class UsageMeters {
  readonly element = el("div", "usage-meters");
  private meters = [
    new UsageMeter("openai", "Astra", openaiIcon),
    new UsageMeter("anthropic", "Fable", claudeIcon),
  ];
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private checked = 0;
  private disposed = false;
  private outside = (event: PointerEvent) => {
    this.meters.forEach((meter) => {
      if (!meter.element.contains(event.target as Node)) meter.close();
    });
  };
  private escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.meters.forEach((m) => m.close());
  };
  constructor() {
    this.element.setAttribute("aria-label", "Model allowances");
    this.element.append(...this.meters.map((m) => m.element));
    document.addEventListener("pointerdown", this.outside);
    document.addEventListener("keydown", this.escape);
    void this.poll();
  }
  private async poll(): Promise<void> {
    if (this.disposed) return;
    if (!document.hidden && Date.now() - this.checked > 60_000) {
      const controller = new AbortController();
      this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch("/api/workspace/usage", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unavailable");
        const data: { models: ModelUsage[]; checkedAt: string } =
          await response.json();
        if (!this.disposed)
          for (const meter of this.meters) {
            const model = data.models.find(
              (m) => m.provider === meter.provider && m.model === meter.model,
            );
            meter.render(
              model ?? {
                provider: meter.provider,
                model: meter.model,
                status: "unavailable",
                windows: [],
                shared: false,
              },
              data.checkedAt,
            );
          }
      } catch {
        if (!this.disposed)
          this.meters.forEach((meter) =>
            meter.render({
              provider: meter.provider,
              model: meter.model,
              status: "unavailable",
              windows: [],
              shared: false,
            }),
          );
      } finally {
        clearTimeout(timeout);
        this.request = undefined;
        this.checked = Date.now();
      }
    }
    if (!this.disposed) this.timer = setTimeout(() => void this.poll(), 5000);
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.request?.abort();
    document.removeEventListener("pointerdown", this.outside);
    document.removeEventListener("keydown", this.escape);
  }
}
