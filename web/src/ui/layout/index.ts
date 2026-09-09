// Public entry for the layout system. Single function `initLayout` wires
// up the data → render → drag pipeline, replacing the old section-drag /
// section-pair / lanes / lane-drag stack.

import {
  emptyTree,
  setSplitFraction,
  setActiveTab,
  moveSection,
  removeSection,
  insertSection,
  pruneUnknownSections,
  type LayoutTree,
  type SectionId,
  type NodeId,
  type DropTarget,
} from './tree';
import {
  loadTree,
  saveTree,
  saveTreeDebounced,
  migrateIfNeeded,
  reconcileWithKnownSections,
} from './persist';
import { ensureRoot, parkSections, render, type RenderHandlers } from './render';
import { makeDragController } from './drag';
import { SECTION_REGISTRY, isAlwaysOn, sectionTitle, isKnownSection } from './sections';

interface InitOptions {
  // Element to host the layout-root inside. Sections and chat all live
  // under this. Today: #app.
  host: HTMLElement;
  // Sections that should always exist in the tree (chat etc.). They'll
  // be inserted on first boot if missing.
  knownSections: SectionId[];
}

interface LayoutAPI {
  getTree(): LayoutTree;
  // Re-find sections in the DOM (for sections appended after init,
  // e.g. music-bar) and re-render.
  refresh(): void;
  // True when `section` lives inside a horizontal split — i.e. it's
  // sharing the row with another section and therefore has a
  // constrained width. linear-panel uses this to switch between
  // "compact" (paired) and "wide" (full-width) layouts.
  isHorizontallyConstrained(section: SectionId): boolean;
  // Subscribe to any tree change. Returns an unsubscribe function.
  onChanged(fn: () => void): () => void;
  // Hide a section: remove from the tree, remember it on a "shelf" so
  // it can be re-added later via `unhideSection` or the chrome's
  // re-add menu. always-on sections (chat, agent-grid) are refused.
  hideSection(section: SectionId): void;
  // Restore a previously-hidden section by appending it to the tree.
  unhideSection(section: SectionId): void;
  // List of sections that exist in the registry but are currently
  // not in the tree (good candidates for the "+ add" menu).
  hiddenSections(): SectionId[];
}

const HIDDEN_KEY = 'layoutHiddenSections';

export function initLayout(opts: InitOptions): LayoutAPI {
  const { host, knownSections } = opts;
  const allowed = new Set(SECTION_REGISTRY.map((s) => s.id));

  // Park existing section elements off-screen so we can mount them into
  // the new wrapper tree without recreating any.
  const parking = document.createElement('div');
  parking.style.display = 'none';
  parking.dataset.layoutParking = '';
  host.appendChild(parking);
  let sectionEls = parkSections(host, parking);

  // Layout root (sibling of #top-controls under #app).
  const root = ensureRoot(host);

  // Decide initial tree: migrated, or loaded, or empty.
  const migrated = migrateIfNeeded();
  let tree: LayoutTree = migrated ?? loadTree() ?? emptyTree();
  // Scrub anything not in the registry. Catches legacy junk
  // (top-controls, debug-panel, the legacy chat-lanes id) regardless of
  // how it got into storage. Self-healing on every load.
  tree = pruneUnknownSections(tree, allowed);
  // Hidden-sections shelf: which registered sections the user explicitly
  // closed. Stored in a separate localStorage key so it survives
  // tree-rebuilds and isn't entangled with the tree shape. Loaded BEFORE
  // reconcile so the user's hide intent overrides the "this section
  // should auto-appear" default.
  const hidden = new Set<SectionId>(loadHidden());
  // Make sure every must-exist section is present (handles upgrades
  // that added a new section after legacy data was written) — except
  // for sections the user has explicitly closed.
  tree = reconcileWithKnownSections(tree, knownSections, hidden);
  // Persist if we changed it during reconcile.
  saveTree(tree);

  const changeListeners = new Set<() => void>();
  function emitChanged(): void {
    for (const fn of changeListeners) {
      try { fn(); } catch (e) { console.error('[layout] listener threw', e); }
    }
  }

  function rerender(): void {
    render(root, tree, sectionEls, handlers);
  }

  function commit(next: LayoutTree, debounce: boolean = false): void {
    if (next === tree) return;
    tree = next;
    rerender();
    if (debounce) saveTreeDebounced(tree);
    else saveTree(tree);
    emitChanged();
  }

  const handlers: RenderHandlers = {
    onSplitDividerDown: (splitId, ev) => drag.startDividerDrag(splitId, ev),
    onTabClick: (tabsId, index) => commit(setActiveTab(tree, tabsId, index)),
    onSectionDragStart: (section, ev) => drag.startSectionDrag(section, ev),
    onTabDragStart: (section, ev) => drag.startTabDrag(section, ev),
    onLeafCloseClick: (section) => hideSectionInternal(section),
    canCloseLeaf: (section) => !isAlwaysOn(section),
    sectionTitle: (section) => sectionTitle(section),
    hiddenSections: () => sortedHidden(),
    onUnhideClick: (section) => unhideSectionInternal(section),
  };

  const drag = makeDragController({
    root,
    getTree: () => tree,
    onMove: (source: SectionId, target: DropTarget) => {
      commit(moveSection(tree, source, target));
    },
    onSplitFraction: (splitId: NodeId, fraction: number) => {
      // During-drag: cheap, no debounce, no persistence. Crucially we do
      // NOT mutate the canonical `tree` here — if we did, the final commit
      // below would see `next === tree` (the fraction already applied) and
      // skip the save, so resizes never reached localStorage. Live feedback
      // is purely visual: update the inline flex of the two children.
      const wrap = root.querySelector<HTMLElement>(`[data-layout-node="${cssEscape(splitId)}"]`);
      if (!wrap) return;
      const kids = wrap.children;
      // Layout: child[0], divider, child[1]
      const a = kids[0] as HTMLElement | undefined;
      const b = kids[2] as HTMLElement | undefined;
      if (a) a.style.flex = `${fraction} 1 0`;
      if (b) b.style.flex = `${1 - fraction} 1 0`;
    },
    onSplitFractionFinal: (splitId: NodeId, fraction: number) => {
      commit(setSplitFraction(tree, splitId, fraction), true);
    },
  });

  rerender();

  // Watch for new sections appearing (music-bar appended after init).
  const obs = new MutationObserver((records) => {
    let changed = false;
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        const id = n.dataset.layoutSection;
        if (!id) return;
        // Only re-park if it's outside our root (i.e., appended fresh
        // by some other module). Inside root means render already
        // mounted it.
        if (!root.contains(n)) {
          sectionEls.set(id, n);
          parking.appendChild(n);
          changed = true;
          // If the user explicitly hid this section, respect that and
          // leave it parked off-screen — don't auto-add to the tree.
          if (hidden.has(id)) return;
          if (!hasSection(tree, id)) {
            tree = reconcileWithKnownSections(tree, [id]);
            saveTree(tree);
          }
        }
      });
    }
    if (changed) rerender();
  });
  obs.observe(host, { childList: true, subtree: false });

  function hideSectionInternal(section: SectionId): void {
    if (isAlwaysOn(section)) return;
    if (!isKnownSection(section)) return;
    hidden.add(section);
    saveHidden(hidden);
    commit(removeSection(tree, section));
  }
  function unhideSectionInternal(section: SectionId): void {
    if (!isKnownSection(section)) return;
    hidden.delete(section);
    saveHidden(hidden);
    commit(insertSection(tree, section));
  }
  function sortedHidden(): SectionId[] {
    // Only show sections the user explicitly closed via the × button.
    // Sections that simply aren't in the tree (e.g., music-bar before
    // music is enabled) shouldn't appear in the shelf — they'll arrive
    // automatically via the MutationObserver when their feature toggles.
    // Order follows the registry for stability.
    return SECTION_REGISTRY
      .map((s) => s.id)
      .filter((id) => hidden.has(id) && !hasSection(tree, id));
  }

  return {
    getTree: () => tree,
    refresh: () => {
      // Re-park any new sections that landed in `host` directly.
      sectionEls = new Map([...sectionEls, ...parkSections(host, parking)]);
      rerender();
      emitChanged();
    },
    isHorizontallyConstrained: (section) => {
      return findSectionInHorizontalSplit(tree, section);
    },
    onChanged: (fn) => {
      changeListeners.add(fn);
      return () => { changeListeners.delete(fn); };
    },
    hideSection: hideSectionInternal,
    unhideSection: unhideSectionInternal,
    hiddenSections: sortedHidden,
  };
}

function loadHidden(): SectionId[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

function saveHidden(hidden: ReadonlySet<SectionId>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  } catch (err) {
    console.error('[layout] saveHidden threw:', err);
  }
}

function findSectionInHorizontalSplit(tree: LayoutTree, section: SectionId): boolean {
  function walk(node: any, parentHorizontalSplit: boolean): boolean {
    if (!node) return false;
    if (node.kind === 'leaf') {
      return parentHorizontalSplit && node.section === section;
    }
    if (node.kind === 'tabs') {
      // Tabs share a region but are stacked; the visible tab gets the
      // full host width, so tabs don't count as horizontally constrained.
      return false;
    }
    const isH = node.orientation === 'horizontal';
    return walk(node.children[0], isH) || walk(node.children[1], isH);
  }
  return walk(tree.root, false);
}

function hasSection(tree: LayoutTree, section: SectionId): boolean {
  function check(n: any): boolean {
    if (!n) return false;
    if (n.kind === 'leaf') return n.section === section;
    if (n.kind === 'tabs') return n.tabs.includes(section);
    return check(n.children[0]) || check(n.children[1]);
  }
  return check(tree.root);
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}
