// localStorage schema + migration. Single source of truth for the
// layout tree, survives reloads, takes over the old `sectionOrder`,
// `linearDocked`, and section-lane keys.

import {
  emptyTree,
  leaf,
  split,
  tabs,
  normalizeTree,
  insertSection,
  type LayoutTree,
  type LayoutNode,
  type Orientation,
  type SectionId,
} from './tree';

const STORAGE_KEY = 'layoutTree';
const CURRENT_VERSION = 1;

interface Envelope {
  version: number;
  tree: SerializedNode | null;
}

type SerializedNode =
  | { kind: 'leaf'; section: SectionId }
  | { kind: 'tabs'; tabs: SectionId[]; activeIndex: number }
  | {
      kind: 'split';
      orientation: Orientation;
      split: number;
      children: [SerializedNode, SerializedNode];
    };

function serializeNode(n: LayoutNode | null): SerializedNode | null {
  if (!n) return null;
  if (n.kind === 'leaf') return { kind: 'leaf', section: n.section };
  if (n.kind === 'tabs') return { kind: 'tabs', tabs: n.tabs.slice(), activeIndex: n.activeIndex };
  return {
    kind: 'split',
    orientation: n.orientation,
    split: n.split,
    children: [serializeNode(n.children[0])!, serializeNode(n.children[1])!],
  };
}

function deserializeNode(node: unknown): LayoutNode | null {
  if (!node || typeof node !== 'object') return null;
  const kind = (node as { kind?: unknown }).kind;
  if (kind === 'leaf') {
    const section = (node as { section?: unknown }).section;
    if (typeof section !== 'string') return null;
    return leaf(section);
  }
  if (kind === 'tabs') {
    const list = (node as { tabs?: unknown }).tabs;
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) return null;
    if (list.length === 0) return null;
    const idxRaw = (node as { activeIndex?: unknown }).activeIndex;
    const idx = typeof idxRaw === 'number' && isFinite(idxRaw) ? idxRaw : 0;
    return tabs(list as string[], idx);
  }
  if (kind === 'split') {
    const orient = (node as { orientation?: unknown }).orientation;
    if (orient !== 'horizontal' && orient !== 'vertical') return null;
    const fracRaw = (node as { split?: unknown }).split;
    const frac = typeof fracRaw === 'number' && isFinite(fracRaw) ? fracRaw : 0.5;
    const children = (node as { children?: unknown }).children;
    if (!Array.isArray(children) || children.length !== 2) return null;
    const a = deserializeNode(children[0]);
    const b = deserializeNode(children[1]);
    if (!a || !b) return null;
    return split(orient, [a, b], frac);
  }
  return null;
}

export function serializeTree(tree: LayoutTree): string {
  const env: Envelope = { version: CURRENT_VERSION, tree: serializeNode(tree.root) };
  return JSON.stringify(env);
}

export function parseTree(raw: string | null): LayoutTree | null {
  if (!raw) return null;
  let env: unknown;
  try { env = JSON.parse(raw); } catch { return null; }
  if (!env || typeof env !== 'object') return null;
  const v = (env as { version?: unknown }).version;
  if (v !== CURRENT_VERSION) return null;
  const treeRaw = (env as { tree?: unknown }).tree;
  if (treeRaw === null) return emptyTree();
  return normalizeTree({ root: deserializeNode(treeRaw) });
}

// --- save / load with debounce ----------------------------------------

let saveTimer: number | null = null;
const SAVE_DEBOUNCE_MS = 200;

export function saveTree(tree: LayoutTree): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeTree(tree));
  } catch (err) {
    console.error('[layout/persist] save threw:', err);
  }
}

export function saveTreeDebounced(tree: LayoutTree): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveTree(tree);
  }, SAVE_DEBOUNCE_MS);
}

export function loadTree(): LayoutTree | null {
  return parseTree(localStorage.getItem(STORAGE_KEY));
}

// --- migration from the old multi-key world ---------------------------

const MIGRATION_FLAG = 'layoutTreeV1Migrated';
const LEGACY_SECTION_ORDER_KEY = 'sectionOrder';
const LEGACY_LANES_KEY = 'sectionLanes';
const LEGACY_LINEAR_DOCKED_KEY = 'linearDocked';
const LEGACY_LINEAR_DOCKED_WIDTH_KEY = 'linearDockedWidth';

// The chat is a single virtual section in the new world. The old code
// had it implicit (#chat-lanes was its container).
const CHAT_SECTION: SectionId = 'chat';

// Legacy OrderEntry shape. Mirrors web/src/ui/section-pair.ts.
type LegacyOrderEntry =
  | string
  | {
      pair: [LegacyOrderEntry, LegacyOrderEntry];
      split: number;
      orientation: Orientation;
    };

function legacyEntryToNode(e: LegacyOrderEntry): LayoutNode | null {
  if (typeof e === 'string') return leaf(e);
  const a = legacyEntryToNode(e.pair[0]);
  const b = legacyEntryToNode(e.pair[1]);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return split(e.orientation, [a, b], typeof e.split === 'number' ? e.split : 0.5);
}

function parseLegacyOrderEntries(raw: string | null): LegacyOrderEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed as LegacyOrderEntry[];
}

interface LegacyState {
  sectionOrder: string | null;
  sectionLanes: string | null;
  linearDocked: string | null;
  linearDockedWidth: string | null;
}

export function readLegacyState(): LegacyState {
  return {
    sectionOrder: localStorage.getItem(LEGACY_SECTION_ORDER_KEY),
    sectionLanes: localStorage.getItem(LEGACY_LANES_KEY),
    linearDocked: localStorage.getItem(LEGACY_LINEAR_DOCKED_KEY),
    linearDockedWidth: localStorage.getItem(LEGACY_LINEAR_DOCKED_WIDTH_KEY),
  };
}

// Build a fresh tree from legacy storage. Strategy:
//   1. Convert each legacy OrderEntry to a LayoutNode (sections as leaves,
//      pairs as splits).
//   2. Stack them top-to-bottom under a vertical split chain.
//   3. Insert chat at the bottom (it lived in #chat-lanes, distinct from #app).
//   4. Honour `sectionLanes` by folding those sections into a tabs node
//      with chat (they were tabs in the old chat-lanes strip).
//   5. If `linearDocked` was set and not already migrated into the
//      sectionOrder pair, force a chat | linear horizontal split.
export function buildTreeFromLegacy(legacy: LegacyState): LayoutTree {
  const entries = parseLegacyOrderEntries(legacy.sectionOrder)
    .filter((e) => !(typeof e === 'string' && e === 'agent-dock-row'));

  const nodes: LayoutNode[] = [];
  for (const e of entries) {
    const n = legacyEntryToNode(e);
    if (n) nodes.push(n);
  }

  // Sections that lived in the chat-lanes strip last session.
  let lanedSections: SectionId[] = [];
  try {
    const parsed = JSON.parse(legacy.sectionLanes ?? '[]');
    if (Array.isArray(parsed)) lanedSections = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // ignore
  }

  // Drop laned sections from the top-level stack — they're moving into a
  // tabs node with chat instead. (We collect them recursively because they
  // could be nested inside a legacy pair.)
  const lanedSet = new Set(lanedSections);
  const filteredNodes = nodes.map((n) => stripSections(n, lanedSet)).filter((n): n is LayoutNode => n !== null);

  // Build the chat region: chat alone, or tabs(chat + laned sections).
  const chatRegion: LayoutNode =
    lanedSections.length === 0
      ? leaf(CHAT_SECTION)
      : tabs([CHAT_SECTION, ...lanedSections], 0);

  // Stack sections vertically with chat at the bottom.
  let root: LayoutNode = chatRegion;
  for (let i = filteredNodes.length - 1; i >= 0; i--) {
    root = split('vertical', [filteredNodes[i], root], 0.6);
  }

  return normalizeTree({ root });
}

// Recursively drop any leaf whose section is in `drop`. Returns null if
// the entire subtree gets dropped. Used during legacy migration to lift
// laned sections out of the spatial tree before they're folded into
// tabs(chat + …).
function stripSections(node: LayoutNode, drop: Set<SectionId>): LayoutNode | null {
  if (node.kind === 'leaf') return drop.has(node.section) ? null : node;
  if (node.kind === 'tabs') {
    const remaining = node.tabs.filter((s) => !drop.has(s));
    if (remaining.length === 0) return null;
    if (remaining.length === 1) return leaf(remaining[0], node.id);
    return { ...node, tabs: remaining, activeIndex: Math.min(node.activeIndex, remaining.length - 1) };
  }
  // split
  const a = stripSections(node.children[0], drop);
  const b = stripSections(node.children[1], drop);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return { ...node, children: [a, b] };
}

// Run once on first boot of the new system. Idempotent.
export function migrateIfNeeded(): LayoutTree | null {
  if (localStorage.getItem(MIGRATION_FLAG) === '1') return null;
  const legacy = readLegacyState();
  // Treat as needing migration only if at least one legacy key was set.
  const hasLegacy =
    !!legacy.sectionOrder ||
    !!legacy.sectionLanes ||
    legacy.linearDocked === '1';
  if (!hasLegacy) {
    localStorage.setItem(MIGRATION_FLAG, '1');
    return null;
  }
  const tree = buildTreeFromLegacy(legacy);
  saveTree(tree);
  // Drop the legacy keys.
  localStorage.removeItem(LEGACY_SECTION_ORDER_KEY);
  localStorage.removeItem(LEGACY_LANES_KEY);
  localStorage.removeItem(LEGACY_LINEAR_DOCKED_KEY);
  localStorage.removeItem(LEGACY_LINEAR_DOCKED_WIDTH_KEY);
  localStorage.setItem(MIGRATION_FLAG, '1');
  return tree;
}

// On first boot: ensure tree contains every section the page actually
// renders (sections appended to `#app` after init etc.). Sections in the
// tree but not on the page are kept (they may come online later — e.g.
// the music bar appears asynchronously).
//
// `hidden` lists sections the user explicitly closed via the × button.
// Those are NOT re-added by reconcile — otherwise a hidden agent-grid
// would silently reappear on every reload, defeating the whole point
// of the hidden-sections shelf. The hidden set is the user's intent
// and must take precedence over the "this section is known and should
// auto-appear" default.
export function reconcileWithKnownSections(
  tree: LayoutTree,
  known: SectionId[],
  hidden?: ReadonlySet<SectionId>,
): LayoutTree {
  let next = tree;
  for (const s of known) {
    if (hidden?.has(s)) continue;
    next = insertSection(next, s);
  }
  return next;
}
