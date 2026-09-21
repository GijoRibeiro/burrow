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
        // Never stretch glyphs/canvas pixels to fake a size change. Geometry
        // settles once; only position and opacity animate on the compositor.
        const resized = Math.abs(sx - 1) + Math.abs(sy - 1) > 0.02;
        animate(pane, [
          {
            transform: `translate(${dx}px, ${dy}px)`,
            opacity: resized ? 0.35 : 1,
          },
          { transform: "none", opacity: 1 },
        ]);
      } else reveal(pane);
    }
  };
}

let sidebarTransition = 0;
let sidebarTarget: boolean | undefined;
let sidebarAnimations: Animation[] = [];

// Reflow expensive terminal canvases once, behind a brief fade. Animating width
// or margin sends a new PTY resize every frame and makes native TUIs flicker.
export async function toggleSidebar(canvas: HTMLElement): Promise<void> {
  const version = ++sidebarTransition;
  const hidden = !(
    sidebarTarget ?? document.body.classList.contains("sidebar-hidden")
  );
  sidebarTarget = hidden;
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const surfaces = [canvas, sidebar].filter(
    (node): node is HTMLElement => !!node,
  );
  const opacities = surfaces.map((node) => getComputedStyle(node).opacity);
  for (const animation of sidebarAnimations) animation.cancel();
  sidebarAnimations = [];
  if (reduced()) {
    document.body.classList.toggle("sidebar-hidden", hidden);
    document.body.classList.remove("layout-transitioning");
    sidebarTarget = undefined;
    return;
  }
  document.body.classList.add("layout-transitioning");
  try {
    sidebarAnimations = surfaces.map((node, index) =>
      node.animate([{ opacity: opacities[index] }, { opacity: 0 }], {
        duration: 90,
        easing: "ease-out",
        fill: "forwards",
      }),
    );
    await Promise.all(sidebarAnimations.map((animation) => animation.finished));
    if (version !== sidebarTransition) return;
    document.body.classList.toggle("sidebar-hidden", hidden);
    // Resize observers fit xterm at final geometry before we reveal it.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (version !== sidebarTransition) return;
    for (const animation of sidebarAnimations) animation.cancel();
    sidebarAnimations = surfaces
      .filter((node) => getComputedStyle(node).visibility !== "hidden")
      .map((node) =>
        node.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 150,
          easing: "ease-out",
        }),
      );
    await Promise.all(sidebarAnimations.map((animation) => animation.finished));
  } catch {
    /* A repeated click takes ownership of the transition. */
  } finally {
    if (version === sidebarTransition) {
      sidebarAnimations = [];
      sidebarTarget = undefined;
      document.body.classList.remove("layout-transitioning");
    }
  }
}
