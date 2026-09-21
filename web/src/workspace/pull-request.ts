import { el } from "./dom";

type PullRequest = {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
};

/** A read-only branch link. Its polling never blocks chat or terminal startup. */
export class PullRequestLink {
  readonly element = el("a", "pane-pr-link");
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private visible = false;
  private checked = 0;
  constructor(private id: string) {
    this.element.hidden = true;
    this.element.target = "_blank";
    this.element.rel = "noopener noreferrer";
    this.element.draggable = false;
    this.element.addEventListener("click", (event) => event.stopPropagation());
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    clearTimeout(this.timer);
    if (!visible) {
      this.request?.abort();
      return;
    }
    void this.poll();
  }
  private async poll(): Promise<void> {
    if (!this.visible || this.request) return;
    if (!document.hidden && Date.now() - this.checked > 30_000) {
      const controller = new AbortController();
      this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(
          `/api/workspace/terminals/${this.id}/pull-request`,
          { signal: controller.signal },
        );
        const pr: PullRequest | null = response.ok
          ? await response.json()
          : null;
        if (!controller.signal.aborted) this.render(pr);
      } catch {
        if (this.visible) this.render(null);
      } finally {
        clearTimeout(timeout);
        this.request = undefined;
        this.checked = Date.now();
      }
    }
    if (this.visible) this.timer = setTimeout(() => void this.poll(), 5000);
  }
  private render(pr: PullRequest | null): void {
    const safe =
      pr &&
      Number.isInteger(pr.number) &&
      pr.number > 0 &&
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr.url);
    this.element.hidden = !safe;
    if (!safe || !pr) {
      this.element.removeAttribute("href");
      return;
    }
    const label = `${pr.isDraft ? "Draft " : ""}PR #${pr.number} ↗`;
    if (this.element.textContent !== label) this.element.textContent = label;
    this.element.href = pr.url;
    this.element.title = pr.title;
    this.element.setAttribute(
      "aria-label",
      `Open ${pr.isDraft ? "draft " : ""}pull request #${pr.number}: ${pr.title}`,
    );
  }
  dispose(): void {
    this.visible = false;
    clearTimeout(this.timer);
    this.request?.abort();
  }
}
