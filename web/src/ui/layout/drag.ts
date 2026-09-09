// Pointer-event drag for layout. Replaces the HTML5 drag API, which is
// a) brittle (race conditions on dragend, ghost image is browser-default,
// hard to script in tests) and b) incomplete (no native way to render a
// custom drag preview in Chrome without a tricky setDragImage hack).
//
// Flow:
//   pointerdown on a drag handle → start session, source has 30% opacity,
//                                  ghost element appears at cursor
//   pointermove                  → hit-test wrapper under cursor,
//                                  classify zone, paint overlay
//   pointerup over zone          → dispatch tree op via callback
//   pointerup outside / Escape   → abort, no tree change
//
// The TREE is never mutated mid-drag — that's the whole reason this is
// reliable. State only changes when the user commits via pointerup.

import type { LayoutTree, NodeId, SectionId, DropTarget } from './tree';
import { findNode } from './tree';
import { classifyDrop, classifyTabStripDrop, type DropZone } from './drop-zones';

export interface DragController {
  startSectionDrag: (section: SectionId, ev: PointerEvent) => void;
  startTabDrag: (section: SectionId, ev: PointerEvent) => void;
  startDividerDrag: (splitId: NodeId, ev: PointerEvent) => void;
  abort: () => void;
}

export interface DragDeps {
  root: HTMLElement;                 // the .layout-root
  getTree: () => LayoutTree;
  onMove: (source: SectionId, target: DropTarget) => void;
  onSplitFraction: (splitId: NodeId, fraction: number) => void;
  onSplitFractionFinal: (splitId: NodeId, fraction: number) => void;
}

interface SectionDragSession {
  kind: 'section';
  source: SectionId;
  ghost: HTMLElement;
  overlay: HTMLElement;
  pointerId: number;
  // Track the LAST resolved zone so pointerup uses it directly even if
  // the cursor briefly leaves the layout-root (e.g., user crosses the
  // window's chrome before releasing).
  lastTarget: DropTarget | null;
}

interface DividerDragSession {
  kind: 'divider';
  splitId: NodeId;
  pointerId: number;
  wrapperRect: DOMRect;
  orientation: 'horizontal' | 'vertical';
  // Captured at mousedown so the divider tracks pointer MOVEMENT
  // (delta from the click point) rather than the cursor's absolute
  // position in the wrapper. Without this the divider snapped to the
  // cursor on first move — visible as a jump of up to the divider's
  // hit-area width (8px), and worse when min-size constraints had
  // pushed the rendered divider away from `split * total`.
  startCoord: number;
  startSplit: number;
}

type Session = SectionDragSession | DividerDragSession;

const ZONE_OVERLAY_CLASS = 'layout-drop-overlay';
const SOURCE_DRAGGING_CLASS = 'layout-source-dragging';
const GHOST_CLASS = 'layout-drag-ghost';

export function makeDragController(deps: DragDeps): DragController {
  let session: Session | null = null;

  function startSectionDrag(source: SectionId, ev: PointerEvent): void {
    if (session) return;
    ev.preventDefault();
    const ghost = document.createElement('div');
    ghost.className = GHOST_CLASS;
    ghost.textContent = source;
    document.body.appendChild(ghost);
    placeGhost(ghost, ev.clientX, ev.clientY);

    const overlay = document.createElement('div');
    overlay.className = ZONE_OVERLAY_CLASS;
    overlay.style.display = 'none';
    deps.root.appendChild(overlay);

    // Mark all wrappers hosting this section so they fade.
    deps.root
      .querySelectorAll<HTMLElement>(`[data-layout-section-id="${cssEscape(source)}"]`)
      .forEach((el) => el.classList.add(SOURCE_DRAGGING_CLASS));

    session = {
      kind: 'section',
      source,
      ghost,
      overlay,
      pointerId: ev.pointerId,
      lastTarget: null,
    };
    document.body.classList.add('layout-dragging');
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: false });
    window.addEventListener('pointercancel', onPointerCancel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
  }

  function startTabDrag(source: SectionId, ev: PointerEvent): void {
    // Functionally identical to a section drag — same ghost, same drop
    // logic. Source is just the tab's section id.
    startSectionDrag(source, ev);
  }

  function startDividerDrag(splitId: NodeId, ev: PointerEvent): void {
    if (session) return;
    const node = findNode(deps.getTree(), splitId);
    if (!node || node.kind !== 'split') return;
    const wrapper = deps.root.querySelector<HTMLElement>(`[data-layout-node="${cssEscape(splitId)}"]`);
    if (!wrapper) return;
    ev.preventDefault();
    session = {
      kind: 'divider',
      splitId,
      pointerId: ev.pointerId,
      wrapperRect: wrapper.getBoundingClientRect(),
      orientation: node.orientation,
      startCoord: node.orientation === 'horizontal' ? ev.clientX : ev.clientY,
      startSplit: node.split,
    };
    document.body.classList.add('layout-resizing');
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: false });
    window.addEventListener('pointercancel', onPointerCancel, { passive: false });
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    if (session.kind === 'divider') {
      const r = session.wrapperRect;
      const total = session.orientation === 'horizontal' ? r.width : r.height;
      if (total <= 0) return;
      // Delta from mousedown — keeps the divider planted under the
      // cursor at the offset the user grabbed it at, instead of
      // snapping the divider to the absolute cursor position on the
      // first move.
      const coord = session.orientation === 'horizontal' ? ev.clientX : ev.clientY;
      const fraction = clamp01(session.startSplit + (coord - session.startCoord) / total);
      deps.onSplitFraction(session.splitId, fraction);
      return;
    }

    // Section drag: move ghost, hit-test, paint overlay
    placeGhost(session.ghost, ev.clientX, ev.clientY);

    const target = hitTest(deps.root, ev.clientX, ev.clientY, session.source, deps.getTree());
    session.lastTarget = target.dropTarget;
    paintOverlay(session.overlay, target.zone, target.targetRect);
  }

  function onPointerUp(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    if (session.kind === 'divider') {
      const r = session.wrapperRect;
      const total = session.orientation === 'horizontal' ? r.width : r.height;
      if (total > 0) {
        const coord = session.orientation === 'horizontal' ? ev.clientX : ev.clientY;
        const fraction = clamp01(session.startSplit + (coord - session.startCoord) / total);
        deps.onSplitFractionFinal(session.splitId, fraction);
      }
      cleanupDivider();
      return;
    }
    // Section drag commit — capture before cleanup nulls the session.
    const source = session.source;
    const target = session.lastTarget;
    cleanupSection();
    if (target) deps.onMove(source, target);
  }

  function onPointerCancel(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    if (session.kind === 'divider') cleanupDivider();
    else cleanupSection();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (!session) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (session.kind === 'section') cleanupSection();
      else cleanupDivider();
    }
  }

  function cleanupSection(): void {
    if (!session || session.kind !== 'section') return;
    session.ghost.remove();
    session.overlay.remove();
    deps.root
      .querySelectorAll<HTMLElement>('.' + SOURCE_DRAGGING_CLASS)
      .forEach((el) => el.classList.remove(SOURCE_DRAGGING_CLASS));
    document.body.classList.remove('layout-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    session = null;
  }

  function cleanupDivider(): void {
    document.body.classList.remove('layout-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    session = null;
  }

  function abort(): void {
    if (!session) return;
    if (session.kind === 'section') cleanupSection();
    else cleanupDivider();
  }

  return { startSectionDrag, startTabDrag, startDividerDrag, abort };
}

// Walk the layout-root and find the deepest leaf/tabs wrapper at the
// cursor that the source can target (i.e., not the source's own host).
// Returns the resolved DropTarget plus geometry for the overlay.
interface HitResult {
  dropTarget: DropTarget | null;
  zone: DropZone | null;
  targetRect: DOMRect | null;
}

function hitTest(
  root: HTMLElement,
  x: number,
  y: number,
  source: SectionId,
  tree: LayoutTree,
): HitResult {
  // Use elementFromPoint to find what's directly under the cursor, then
  // walk up to the nearest layout-node that's a leaf or tabs.
  const el = document.elementFromPoint(x, y);
  if (!el) return { dropTarget: null, zone: null, targetRect: null };

  // Tab strip: if we landed inside a tab strip, classify the index.
  const stripEl = (el as HTMLElement).closest<HTMLElement>('.layout-tab-strip');
  if (stripEl) {
    const tabsWrap = stripEl.closest<HTMLElement>('[data-layout-kind="tabs"]');
    if (tabsWrap && tabsWrap.dataset.layoutNode) {
      const tabRects = Array.from(stripEl.querySelectorAll<HTMLElement>('.layout-tab')).map((t) => t.getBoundingClientRect());
      const index = classifyTabStripDrop(tabRects, x);
      return {
        dropTarget: { kind: 'tab', nodeId: tabsWrap.dataset.layoutNode, index },
        zone: { kind: 'tab-strip', index },
        targetRect: stripEl.getBoundingClientRect(),
      };
    }
  }

  // Find nearest leaf/tabs wrapper at cursor.
  let cursor: HTMLElement | null = el as HTMLElement;
  while (cursor && cursor !== root) {
    if (cursor.dataset && cursor.dataset.layoutKind === 'leaf') break;
    if (cursor.dataset && cursor.dataset.layoutKind === 'tabs') break;
    cursor = cursor.parentElement;
  }
  if (!cursor || cursor === root || !cursor.dataset.layoutNode) {
    return { dropTarget: null, zone: null, targetRect: null };
  }
  const nodeId = cursor.dataset.layoutNode;
  // Skip if the source IS the only thing in this wrapper (can't drop on
  // yourself meaningfully).
  const node = findNode(tree, nodeId);
  if (!node) return { dropTarget: null, zone: null, targetRect: null };
  if (node.kind === 'leaf' && node.section === source) {
    return { dropTarget: null, zone: null, targetRect: null };
  }
  if (node.kind === 'tabs' && node.tabs.length === 1 && node.tabs[0] === source) {
    return { dropTarget: null, zone: null, targetRect: null };
  }
  const rect = cursor.getBoundingClientRect();
  const zone = classifyDrop(rect, x, y);
  if (zone.kind === 'gap') return { dropTarget: null, zone: null, targetRect: rect };
  if (zone.kind === 'edge') {
    return { dropTarget: { kind: 'edge', nodeId, side: zone.side }, zone, targetRect: rect };
  }
  if (zone.kind === 'tab') {
    return { dropTarget: { kind: 'tab', nodeId }, zone, targetRect: rect };
  }
  // tab-strip handled above
  return { dropTarget: null, zone: null, targetRect: null };
}

function paintOverlay(
  overlay: HTMLElement,
  zone: DropZone | null,
  targetRect: DOMRect | null,
): void {
  if (!zone || !targetRect) {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = '';
  // Position relative to layout-root: the parent already has the rect
  // we want. We reposition with fixed positioning so the overlay floats
  // over arbitrary nested layout.
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '9999';
  if (zone.kind === 'edge') {
    const { left, top, width, height } = targetRect;
    if (zone.side === 'left') {
      Object.assign(overlay.style, { left: `${left}px`, top: `${top}px`, width: `${width / 2}px`, height: `${height}px` });
    } else if (zone.side === 'right') {
      Object.assign(overlay.style, { left: `${left + width / 2}px`, top: `${top}px`, width: `${width / 2}px`, height: `${height}px` });
    } else if (zone.side === 'top') {
      Object.assign(overlay.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height / 2}px` });
    } else {
      Object.assign(overlay.style, { left: `${left}px`, top: `${top + height / 2}px`, width: `${width}px`, height: `${height / 2}px` });
    }
  } else if (zone.kind === 'tab' || zone.kind === 'tab-strip') {
    Object.assign(overlay.style, {
      left: `${targetRect.left}px`,
      top: `${targetRect.top}px`,
      width: `${targetRect.width}px`,
      height: `${targetRect.height}px`,
    });
  }
}

function placeGhost(ghost: HTMLElement, x: number, y: number): void {
  ghost.style.position = 'fixed';
  ghost.style.left = `${x + 12}px`;
  ghost.style.top = `${y + 12}px`;
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '10000';
}

function clamp01(v: number): number {
  if (!isFinite(v)) return 0.5;
  if (v < 0.05) return 0.05;
  if (v > 0.95) return 0.95;
  return v;
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}
