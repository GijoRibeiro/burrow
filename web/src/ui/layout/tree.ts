// Pure data + ops for the layout split-tree. No DOM. Every op returns a
// new tree (structural sharing where possible) so the render layer can
// diff against the previous tree, and so tests are dead-simple.
//
// Invariants enforced by `normalize`:
//   1. each SectionId appears in exactly one leaf or one tabs node
//   2. split always has 2 children; tabs always has ≥1 tab
//   3. split.split ∈ [SPLIT_MIN, SPLIT_MAX]
//   4. tabs with 1 tab unwrap to a leaf
//   5. split with one missing/empty child collapses to its survivor
//   6. activeIndex ∈ [0, tabs.length - 1]

export type SectionId = string;
export type NodeId = string;

export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Orientation = 'horizontal' | 'vertical';

export type LayoutNode =
  | { kind: 'leaf';  id: NodeId; section: SectionId }
  | { kind: 'tabs';  id: NodeId; tabs: SectionId[]; activeIndex: number }
  | {
      kind: 'split';
      id: NodeId;
      orientation: Orientation;
      split: number;
      children: [LayoutNode, LayoutNode];
    };

export interface LayoutTree {
  root: LayoutNode | null;
}

export const SPLIT_MIN = 0.05;
export const SPLIT_MAX = 0.95;

// --- node-id allocator -------------------------------------------------

let nextId = 1;
export function newNodeId(prefix: string = 'n'): NodeId {
  return `${prefix}-${nextId++}`;
}

// Used by tests to make ids deterministic across runs.
export function _resetIdsForTest(): void {
  nextId = 1;
}

// --- constructors ------------------------------------------------------

export function leaf(section: SectionId, id: NodeId = newNodeId('leaf')): LayoutNode {
  return { kind: 'leaf', id, section };
}

export function tabs(
  members: SectionId[],
  activeIndex: number = 0,
  id: NodeId = newNodeId('tabs'),
): LayoutNode {
  return {
    kind: 'tabs',
    id,
    tabs: members.slice(),
    activeIndex: clampIndex(activeIndex, members.length),
  };
}

export function split(
  orientation: Orientation,
  children: [LayoutNode, LayoutNode],
  fraction: number = 0.5,
  id: NodeId = newNodeId('split'),
): LayoutNode {
  return {
    kind: 'split',
    id,
    orientation,
    split: clampSplit(fraction),
    children,
  };
}

export function emptyTree(): LayoutTree {
  return { root: null };
}

// --- helpers -----------------------------------------------------------

function clampSplit(v: number): number {
  if (!isFinite(v)) return 0.5;
  if (v < SPLIT_MIN) return SPLIT_MIN;
  if (v > SPLIT_MAX) return SPLIT_MAX;
  return v;
}

function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  if (i < 0) return 0;
  if (i > len - 1) return len - 1;
  return i;
}

function orientationOfSide(side: Side): Orientation {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
}

function sourceFirst(side: Side): boolean {
  return side === 'left' || side === 'top';
}

// --- traversal ---------------------------------------------------------

export function* walk(node: LayoutNode | null): Generator<LayoutNode> {
  if (!node) return;
  yield node;
  if (node.kind === 'split') {
    yield* walk(node.children[0]);
    yield* walk(node.children[1]);
  }
}

export function findNode(tree: LayoutTree, nodeId: NodeId): LayoutNode | null {
  for (const n of walk(tree.root)) if (n.id === nodeId) return n;
  return null;
}

export function allSections(tree: LayoutTree): SectionId[] {
  const out: SectionId[] = [];
  for (const n of walk(tree.root)) {
    if (n.kind === 'leaf') out.push(n.section);
    else if (n.kind === 'tabs') out.push(...n.tabs);
  }
  return out;
}

export function hasSection(tree: LayoutTree, section: SectionId): boolean {
  for (const n of walk(tree.root)) {
    if (n.kind === 'leaf' && n.section === section) return true;
    if (n.kind === 'tabs' && n.tabs.includes(section)) return true;
  }
  return false;
}

// Find the node that *contains* a section as a leaf or as a tab.
export function findContainerOf(
  tree: LayoutTree,
  section: SectionId,
): LayoutNode | null {
  for (const n of walk(tree.root)) {
    if (n.kind === 'leaf' && n.section === section) return n;
    if (n.kind === 'tabs' && n.tabs.includes(section)) return n;
  }
  return null;
}

// --- transformation primitives ----------------------------------------

// Return a new tree with `node` replaced by `replacement` (or removed
// if replacement === null). Recursively walks the tree; structural
// sharing for siblings that don't change.
function replaceNode(
  current: LayoutNode | null,
  targetId: NodeId,
  replacement: LayoutNode | null,
): LayoutNode | null {
  if (!current) return current;
  if (current.id === targetId) return replacement;
  if (current.kind !== 'split') return current;
  const [a, b] = current.children;
  const a2 = replaceNode(a, targetId, replacement);
  const b2 = replaceNode(b, targetId, replacement);
  if (a2 === a && b2 === b) return current;
  // If replacement removed a child entirely we'll still produce a
  // half-split here — `normalize` will collapse it on the way out.
  if (a2 === null && b2 === null) return null;
  if (a2 === null) return b2;
  if (b2 === null) return a2;
  return { ...current, children: [a2, b2] };
}

// Remove `section` from wherever it lives. Leaf → drop; tabs → drop one
// entry (and unwrap if length becomes 1; remove if 0). Caller should
// normalize after.
function dropSection(
  current: LayoutNode | null,
  section: SectionId,
): LayoutNode | null {
  if (!current) return null;
  if (current.kind === 'leaf') {
    return current.section === section ? null : current;
  }
  if (current.kind === 'tabs') {
    if (!current.tabs.includes(section)) return current;
    const next = current.tabs.filter((s) => s !== section);
    if (next.length === 0) return null;
    return {
      ...current,
      tabs: next,
      activeIndex: clampIndex(current.activeIndex, next.length),
    };
  }
  // split
  const [a, b] = current.children;
  const a2 = dropSection(a, section);
  const b2 = dropSection(b, section);
  if (a2 === a && b2 === b) return current;
  if (a2 === null && b2 === null) return null;
  if (a2 === null) return b2!;
  if (b2 === null) return a2!;
  return { ...current, children: [a2, b2] };
}

// --- normalize ---------------------------------------------------------

// Fix up a node tree to satisfy invariants. Idempotent.
export function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') return node;
  if (node.kind === 'tabs') {
    if (node.tabs.length === 0) return null;
    if (node.tabs.length === 1) {
      // Unwrap single-tab into a plain leaf.
      return leaf(node.tabs[0], node.id);
    }
    const idx = clampIndex(node.activeIndex, node.tabs.length);
    if (idx === node.activeIndex) return node;
    return { ...node, activeIndex: idx };
  }
  // split
  const a = normalize(node.children[0]);
  const b = normalize(node.children[1]);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  const fraction = clampSplit(node.split);
  if (a === node.children[0] && b === node.children[1] && fraction === node.split) {
    return node;
  }
  return { ...node, children: [a, b], split: fraction };
}

export function normalizeTree(tree: LayoutTree): LayoutTree {
  const next = normalize(tree.root);
  if (next === tree.root) return tree;
  return { root: next };
}

// --- public ops --------------------------------------------------------

// Insert a section into the tree at the root level. If the tree is
// empty it becomes the root leaf; otherwise it gets appended on the
// right (horizontal split) so it shows up immediately. Used when a
// section first comes online and isn't already in the tree.
export function insertSection(tree: LayoutTree, section: SectionId): LayoutTree {
  if (hasSection(tree, section)) return tree;
  if (!tree.root) {
    return { root: leaf(section) };
  }
  const next: LayoutNode = split('horizontal', [tree.root, leaf(section)], 0.7);
  return normalizeTree({ root: next });
}

export function removeSection(tree: LayoutTree, section: SectionId): LayoutTree {
  if (!hasSection(tree, section)) return tree;
  const next = dropSection(tree.root, section);
  return normalizeTree({ root: next });
}

// Wrap the node identified by `targetId` in a new split, with `source`
// taking the side indicated by `dropSide`. Source is removed from
// wherever else it lived in the tree. If source === target's only
// occupant this is a no-op.
export function splitAt(
  tree: LayoutTree,
  targetId: NodeId,
  source: SectionId,
  dropSide: Side,
  fraction: number = 0.5,
): LayoutTree {
  const target = findNode(tree, targetId);
  if (!target) return tree;
  // Detach source first so we don't end up with duplicates.
  const detached = removeSection(tree, source);
  const targetAfterDetach = findNode(detached, targetId);
  // If detaching collapsed the target away, just append the source to
  // whatever's left.
  if (!targetAfterDetach) {
    return insertSection(detached, source);
  }
  const orientation = orientationOfSide(dropSide);
  const sourceLeaf = leaf(source);
  const children: [LayoutNode, LayoutNode] = sourceFirst(dropSide)
    ? [sourceLeaf, targetAfterDetach]
    : [targetAfterDetach, sourceLeaf];
  // Source-on-left/top wants the source to occupy `fraction` of the new
  // split; source-on-right/bottom inverts so the visible "drop side" is
  // always the smaller one when fraction < 0.5.
  const splitFrac = sourceFirst(dropSide) ? fraction : 1 - fraction;
  const wrapper = split(orientation, children, splitFrac);
  const next = replaceNode(detached.root, targetId, wrapper);
  return normalizeTree({ root: next });
}

// Add `source` as a tab inside the node identified by `targetId`. If
// target is already a tabs node, append (or insert at `index`). If
// target is a leaf, promote it into a tabs node containing
// [target.section, source].
export function addTab(
  tree: LayoutTree,
  targetId: NodeId,
  source: SectionId,
  index?: number,
): LayoutTree {
  const target = findNode(tree, targetId);
  if (!target) return tree;
  if (target.kind === 'split') return tree;
  // Detach source from its current location first.
  const detached = removeSection(tree, source);
  const targetAfterDetach = findNode(detached, targetId);
  if (!targetAfterDetach) {
    // Target collapsed during detach — fall back to inserting source.
    return insertSection(detached, source);
  }
  let replacement: LayoutNode;
  if (targetAfterDetach.kind === 'leaf') {
    const list = [targetAfterDetach.section, source];
    const ix = typeof index === 'number' ? clampIndex(index, list.length) : list.length - 1;
    replacement = tabs(list, ix, targetAfterDetach.id);
  } else if (targetAfterDetach.kind === 'tabs') {
    const list = targetAfterDetach.tabs.slice();
    const at = typeof index === 'number' ? clampIndex(index, list.length + 1) : list.length;
    list.splice(at, 0, source);
    replacement = {
      kind: 'tabs',
      id: targetAfterDetach.id,
      tabs: list,
      activeIndex: at,
    };
  } else {
    // split — already short-circuited above; here for exhaustiveness
    return tree;
  }
  const next = replaceNode(detached.root, targetId, replacement);
  return normalizeTree({ root: next });
}

export function setSplitFraction(
  tree: LayoutTree,
  splitId: NodeId,
  fraction: number,
): LayoutTree {
  const node = findNode(tree, splitId);
  if (!node || node.kind !== 'split') return tree;
  const clamped = clampSplit(fraction);
  if (clamped === node.split) return tree;
  const replacement: LayoutNode = { ...node, split: clamped };
  const next = replaceNode(tree.root, splitId, replacement);
  return { root: next };
}

export function setActiveTab(
  tree: LayoutTree,
  tabsId: NodeId,
  index: number,
): LayoutTree {
  const node = findNode(tree, tabsId);
  if (!node || node.kind !== 'tabs') return tree;
  const idx = clampIndex(index, node.tabs.length);
  if (idx === node.activeIndex) return tree;
  const replacement: LayoutNode = { ...node, activeIndex: idx };
  const next = replaceNode(tree.root, tabsId, replacement);
  return { root: next };
}

// Drop every leaf/tab whose section isn't in `allowed`. Used to scrub
// junk that crept in via legacy migration (top-controls, debug-panel,
// the legacy chat-lanes id, etc.) without nuking the whole layout.
// Self-healing: runs on every load, so any future malformed entry
// disappears too.
export function pruneUnknownSections(
  tree: LayoutTree,
  allowed: ReadonlySet<SectionId>,
): LayoutTree {
  let next = tree;
  for (const id of allSections(tree)) {
    if (!allowed.has(id)) next = removeSection(next, id);
  }
  return next;
}

// One-shot move: detach + place. `target` describes the destination.
export type DropTarget =
  | { kind: 'edge'; nodeId: NodeId; side: Side; fraction?: number }
  | { kind: 'tab'; nodeId: NodeId; index?: number }
  | { kind: 'root-append' };

export function moveSection(
  tree: LayoutTree,
  source: SectionId,
  target: DropTarget,
): LayoutTree {
  switch (target.kind) {
    case 'edge':
      return splitAt(tree, target.nodeId, source, target.side, target.fraction ?? 0.5);
    case 'tab':
      return addTab(tree, target.nodeId, source, target.index);
    case 'root-append': {
      const detached = removeSection(tree, source);
      return insertSection(detached, source);
    }
  }
}
