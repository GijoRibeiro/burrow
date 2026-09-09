const moving = new Map<HTMLElement, Animation>();
const ghosts = new Set<HTMLElement>();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const timing = { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" };

function animate(
  element: HTMLElement,
  frames: Keyframe[],
  duration = timing.duration,
): void {
  moving.get(element)?.cancel();
  if (reduced()) return;
  const animation = element.animate(frames, { ...timing, duration });
  moving.set(element, animation);
  const clean = () => {
    if (moving.get(element) === animation) moving.delete(element);
  };
  animation.finished.then(clean, clean);
}

export function reveal(element: HTMLElement): void {
  animate(
    element,
    [
      { opacity: 0, transform: "translateY(4px)" },
      { opacity: 1, transform: "none" },
    ],
    160,
  );
}

// Capture once per layout change, never during status polling or divider drags.
// Transforms animate presentation; the actual terminal fits its new geometry.
export function captureLayout(
  canvas: HTMLElement,
  next: Set<string>,
): () => void {
  for (const ghost of ghosts) ghost.remove();
  ghosts.clear();
  if (reduced()) {
    for (const animation of moving.values()) animation.cancel();
    moving.clear();
    return () => {};
  }
  const before = new Map<string, DOMRect>();
  const leaving: HTMLElement[] = [];
  for (const pane of canvas.querySelectorAll<HTMLElement>(".terminal-pane")) {
    const id = pane.dataset.terminalId!;
    const rect = pane.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    before.set(id, rect);
    moving.get(pane)?.cancel();
    if (next.has(id)) continue;
    const ghost = pane.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-terminal-id");
    ghost.removeAttribute("aria-label");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.classList.add("motion-ghost");
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      minWidth: "0",
      minHeight: "0",
      zIndex: "20",
      pointerEvents: "none",
    });
    // cloneNode does not copy canvas pixels, which xterm uses for its text.
    const originals = pane.querySelectorAll("canvas");
    ghost.querySelectorAll("canvas").forEach((copy, index) => {
      if (originals[index]?.width && originals[index]?.height)
        copy.getContext("2d")?.drawImage(originals[index], 0, 0);
    });
    leaving.push(ghost);
  }
  return () => {
    for (const ghost of leaving) {
      document.body.append(ghost);
      ghosts.add(ghost);
      const animation = ghost.animate(
        [{ opacity: 1 }, { opacity: 0, transform: "scale(.97)" }],
        { ...timing, duration: 150 },
      );
      const clean = () => {
        ghost.remove();
        ghosts.delete(ghost);
      };
      animation.finished.then(clean, clean);
    }
    for (const pane of canvas.querySelectorAll<HTMLElement>(".terminal-pane")) {
      const old = before.get(pane.dataset.terminalId!);
      const rect = pane.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      pane.style.transformOrigin = "top left";
      if (old) {
        const dx = old.left - rect.left,
          dy = old.top - rect.top;
        const sx = old.width / rect.width,
          sy = old.height / rect.height;
        if (
          Math.abs(dx) + Math.abs(dy) + Math.abs(sx - 1) + Math.abs(sy - 1) <
          0.01
        )
          continue;
        animate(pane, [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transform: "none" },
        ]);
      } else reveal(pane);
    }
  };
}
