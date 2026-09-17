import { button, el } from "./dom";

export interface HostedApp {
  port: number;
  url: string;
  process: string;
  source: "terminal" | "checkout";
}
type Snapshot = {
  apps: Record<string, HostedApp[]>;
  error?: string;
  checked: boolean;
};
const subscribers = new Set<(value: Snapshot) => void>();
let snapshot: Snapshot = { apps: {}, checked: false };
let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;
let lastCheck = 0;
async function poll() {
  clearTimeout(timer);
  if (pending || !subscribers.size) return;
  if (!document.hidden && Date.now() - lastCheck > 4000) {
    pending = true;
    try {
      const response = await fetch("/api/workspace/servers", {
        signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not check running apps.");
      snapshot = { apps: data, checked: true };
    } catch (error) {
      // Do not keep advertising a stopped app when discovery is unavailable.
      snapshot = {
        apps: {},
        checked: true,
        error:
          error instanceof Error
            ? error.message
            : "Could not check running apps.",
      };
    } finally {
      pending = false;
      lastCheck = Date.now();
    }
    for (const listener of subscribers) listener(snapshot);
  }
  if (subscribers.size) timer = setTimeout(poll, 5000);
}
function subscribe(listener: (value: Snapshot) => void) {
  subscribers.add(listener);
  listener(snapshot);
  void poll();
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) clearTimeout(timer);
  };
}

/** Shared polling keeps opening a terminal instant, even during port discovery. */
export class HostedApps {
  readonly element = el("div", "hosted-apps");
  readonly toggle: HTMLButtonElement;
  private expanded = false;
  private collapsed = false;
  private unsubscribe?: () => void;
  private key = "";
  constructor(private id: string) {
    this.element.hidden = true;
    this.element.setAttribute("aria-label", "Running apps");
    this.toggle = button(
      "Running apps",
      () => {
        if (snapshot.apps[this.id]?.length) this.collapsed = !this.collapsed;
        else this.expanded = !this.expanded;
        this.render(snapshot);
      },
      "icon-button hosted-apps-toggle",
      "",
    );
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M3 8h18"/>';
    this.toggle.append(icon);
    this.render(snapshot);
  }
  setVisible(visible: boolean) {
    this.unsubscribe?.();
    this.unsubscribe = visible
      ? subscribe((value) => this.render(value))
      : undefined;
  }
  dispose() {
    this.unsubscribe?.();
  }
  private render(value: Snapshot) {
    const apps = value.apps[this.id] || [];
    const key = JSON.stringify([
      apps,
      value.checked,
      value.error,
      this.expanded,
      this.collapsed,
    ]);
    if (key === this.key) return;
    this.key = key;
    this.element.hidden = apps.length ? this.collapsed : !this.expanded;
    this.toggle.classList.toggle("has-apps", apps.length > 0);
    this.toggle.title = apps.length
      ? `${apps.length} running app${apps.length === 1 ? "" : "s"}`
      : "Running apps";
    this.toggle.setAttribute("aria-expanded", String(!this.element.hidden));
    this.element.replaceChildren();
    if (!apps.length) {
      this.element.append(
        el(
          "span",
          "hosted-apps-empty",
          value.error
            ? "Couldn’t check ports. Retrying shortly."
            : value.checked
              ? "No web app running in this terminal or checkout yet."
              : "Looking for running apps…",
        ),
      );
      if (value.error) this.element.title = value.error;
      return;
    }
    this.element.removeAttribute("title");
    this.element.append(el("span", "hosted-apps-label", "Open app"));
    for (const app of apps) {
      let url: URL;
      try {
        url = new URL(app.url);
      } catch {
        continue;
      }
      if (!["http:", "https:"].includes(url.protocol)) continue;
      const link = el("a", "hosted-app-link", `${url.host} ↗`);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = `${app.process} · port ${app.port} · ${app.source === "terminal" ? "Started by this terminal" : "Running in this checkout"}`;
      this.element.append(link);
    }
  }
}
