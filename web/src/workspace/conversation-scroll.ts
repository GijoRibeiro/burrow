// Following is user intent, not a fresh guess after every layout change.
export class ConversationScroll {
  private following = true;
  private position = 0;
  private writtenTop = 0;
  private frame = 0;
  private visible = false;
  private userUntil = 0;
  private observer?: ResizeObserver;
  constructor(
    private viewport: HTMLElement,
    stack: HTMLElement,
    private onFollow: (following: boolean) => void,
  ) {
    viewport.addEventListener(
      "scroll",
      (event) => {
        // Browser scroll events also fire after our writes and layout changes.
        if (
          !this.visible ||
          !viewport.clientHeight ||
          Math.abs(viewport.scrollTop - this.writtenTop) < 1
        )
          return;
        if (event.isTrusted && performance.now() > this.userUntil) return;
        this.stop();
        this.userUntil = performance.now() + 1500;
        this.position = this.writtenTop = viewport.scrollTop;
        this.setFollowing(this.bottom() - viewport.scrollTop < 60);
      },
      { passive: true },
    );
    viewport.addEventListener(
      "wheel",
      (event) => {
        this.userUntil = performance.now() + 1500;
        if (event.deltaY < 0) this.pause();
      },
      { passive: true },
    );
    viewport.addEventListener("pointerdown", () => {
      this.userUntil = performance.now() + 1500;
    });
    viewport.addEventListener(
      "touchmove",
      () => {
        this.userUntil = performance.now() + 1500;
      },
      { passive: true },
    );
    viewport.addEventListener(
      "touchstart",
      () => {
        this.userUntil = performance.now() + 1500;
        this.pause();
      },
      {
        passive: true,
      },
    );
    viewport.addEventListener("keydown", (event) => {
      this.userUntil = performance.now() + 1500;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) this.pause();
    });
    // Includes loaded images, font changes, wrapping and composer/panel resizing.
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.reflow());
      this.observer.observe(viewport);
      this.observer.observe(stack);
    }
  }
  private bottom() {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
  }
  private setFollowing(value: boolean) {
    this.following = value;
    this.onFollow(value);
  }
  private write(top: number) {
    this.viewport.scrollTop = top;
    this.writtenTop = this.viewport.scrollTop;
  }
  private stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
  private pause() {
    this.stop();
    this.capture();
    this.setFollowing(false);
  }
  capture() {
    if (!this.viewport.isConnected || !this.viewport.clientHeight) return;
    this.position = this.viewport.scrollTop;
  }
  reflow() {
    if (this.following) this.restore(true);
  }
  latest() {
    this.setFollowing(true);
    this.restore(true);
  }
  restore(smooth = false) {
    if (!this.viewport.isConnected || !this.viewport.clientHeight) return;
    if (!this.following) {
      this.write(this.position);
      return;
    }
    if (this.frame) return;
    const reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!smooth || !this.visible || reduced) {
      this.write(this.bottom());
      return;
    }
    let previous = performance.now();
    const step = (now: number) => {
      const gap = this.bottom() - this.viewport.scrollTop;
      if (Math.abs(gap) < 1.5 || !this.visible) {
        this.write(this.bottom());
        this.frame = 0;
        return;
      }
      const fraction = 1 - Math.exp(-Math.min(64, now - previous) / 45);
      const distance =
        Math.sign(gap) *
        Math.min(Math.abs(gap), Math.max(1, Math.abs(gap) * fraction));
      this.write(this.viewport.scrollTop + distance);
      previous = now;
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.stop();
    else this.restore();
  }
  dispose() {
    this.stop();
    this.observer?.disconnect();
  }
}
