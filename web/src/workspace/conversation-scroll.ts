// Following is user intent, not a fresh guess after every layout change.
export class ConversationScroll {
  private following = true;
  private position = 0;
  private writtenTop = 0;
  private frame = 0;
  private visible = false;
  private userUntil = 0;
  private observer?: ResizeObserver;
  private anchor?: { element: HTMLElement; top: number };
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
        this.capture();
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
  get isFollowing() {
    return this.following;
  }
  capture() {
    if (!this.viewport.isConnected || !this.viewport.clientHeight) return;
    this.position = this.viewport.scrollTop;
    const top = this.viewport.getBoundingClientRect().top;
    const element = [
      ...this.viewport.querySelectorAll<HTMLElement>(".conversation-message"),
    ].find((element) => element.getBoundingClientRect().bottom > top + 1);
    this.anchor = element
      ? { element, top: element.getBoundingClientRect().top - top }
      : undefined;
  }
  reflow() {
    this.restore(true);
  }
  latest() {
    this.stop();
    this.setFollowing(true);
    this.restore(true, true);
  }
  showPage(edge: "start" | "end", following = false) {
    this.stop();
    this.setFollowing(following);
    this.write(edge === "end" ? this.bottom() : 0);
    this.capture();
  }
  restore(smooth = false, catchUp = false) {
    if (!this.viewport.isConnected || !this.viewport.clientHeight) return;
    if (!this.following) {
      // Pixel offsets are unstable when messages above the reader change size.
      // Keep the same message at the same place on screen instead.
      const anchor = this.anchor;
      const top = anchor?.element.isConnected
        ? this.viewport.scrollTop +
          anchor.element.getBoundingClientRect().top -
          this.viewport.getBoundingClientRect().top -
          anchor.top
        : this.position;
      this.write(top);
      return;
    }
    const gap = this.bottom() - this.viewport.scrollTop;
    const reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A backlog is a catch-up, not a tour through days of history. Only nearby
    // arrivals animate. Contraction/reordering must never animate backwards.
    if (
      !smooth ||
      !this.visible ||
      reduced ||
      gap <= 0 ||
      (!catchUp && gap > Math.max(480, this.viewport.clientHeight * 0.75))
    ) {
      this.stop();
      this.write(this.bottom());
      return;
    }
    if (this.frame) return;
    const started = performance.now();
    const origin = this.viewport.scrollTop;
    const duration = catchUp ? 180 : 220;
    const step = (now: number) => {
      const target = this.bottom();
      if (
        !this.visible ||
        (!catchUp &&
          target - this.viewport.scrollTop >
            Math.max(480, this.viewport.clientHeight * 0.75))
      ) {
        this.write(target);
        this.frame = 0;
        return;
      }
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      // Never rewind to an obsolete origin when resize/acknowledgement changes
      // the target in the middle of a follow animation.
      this.write(
        Math.min(
          target,
          Math.max(this.viewport.scrollTop, origin + (target - origin) * eased),
        ),
      );
      this.frame = progress < 1 ? requestAnimationFrame(step) : 0;
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
