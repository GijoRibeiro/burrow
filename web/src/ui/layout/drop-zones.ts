// Pure drop-zone classification. Given a target rect + the cursor
// position, decide whether the drop is an edge (split), tab-strip slot,
// center (tab), or outside. Pure function — fully unit-testable.

import type { Side } from './tree';

export type DropZone =
  | { kind: 'edge'; side: Side }
  | { kind: 'tab' }
  | { kind: 'tab-strip'; index: number }
  | { kind: 'gap' };

// Edge band thickness as a fraction of the smaller dimension. The
// remaining center is the "tab" zone.
const EDGE_BAND_FRACTION = 0.25;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function classifyDrop(rect: Rect, x: number, y: number): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return { kind: 'gap' };
  const insideX = x >= rect.left && x <= rect.left + rect.width;
  const insideY = y >= rect.top  && y <= rect.top  + rect.height;
  if (!insideX || !insideY) return { kind: 'gap' };

  const xn = (x - rect.left) / rect.width;   // 0..1 across width
  const yn = (y - rect.top) / rect.height;   // 0..1 down height

  const band = EDGE_BAND_FRACTION;
  // Distance to each edge in normalized coords on its own axis.
  const dLeft = xn;
  const dRight = 1 - xn;
  const dTop = yn;
  const dBottom = 1 - yn;

  // If we're outside the inner "center" rectangle, classify as the
  // closest edge.
  const inCenterX = xn >= band && xn <= 1 - band;
  const inCenterY = yn >= band && yn <= 1 - band;
  if (inCenterX && inCenterY) {
    return { kind: 'tab' };
  }
  // Find the closest edge by axis-distance to that edge.
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  let side: Side;
  if (min === dLeft)        side = 'left';
  else if (min === dRight)  side = 'right';
  else if (min === dTop)    side = 'top';
  else                      side = 'bottom';
  return { kind: 'edge', side };
}

// Classify a drop on a tab strip into an insertion index. Targets the
// gap between/after tabs based on horizontal cursor position. `tabRects`
// is the list of tab element rects in left-to-right order.
export function classifyTabStripDrop(tabRects: Rect[], x: number): number {
  for (let i = 0; i < tabRects.length; i++) {
    const r = tabRects[i];
    if (x < r.left + r.width / 2) return i;
  }
  return tabRects.length;
}
