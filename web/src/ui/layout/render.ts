// Render a LayoutTree into the DOM. Section elements (the `<section
// id="agent-grid">` etc.) are NEVER cloned or recreated — they're moved
// into wrapper containers. Wrappers are rebuilt freely, but sections
// preserve their identity (canvases, listeners, dynamic content all
// survive any layout change).
//
// The whole render is a "rebuild the wrapper tree" operation. It's not
// keyed-reconciliation — that's overkill since layout changes happen
// on user-driven drag events, not at 60fps. The cost is one DOM
// rebuild per drag/resize, which is well below human perception.

import type { LayoutNode, LayoutTree, NodeId, SectionId } from './tree';

const ROOT_CLASS = 'layout-root';
const WRAPPER_CLASS = 'layout-node';
const LEAF_CLASS = 'layout-leaf';
const TABS_CLASS = 'layout-tabs';
const SPLIT_CLASS = 'layout-split';
const DIVIDER_CLASS = 'layout-divider';
const TAB_STRIP_CLASS = 'layout-tab-strip';
const TAB_CLASS = 'layout-tab';
const TAB_ACTIVE_CLASS = 'layout-tab-active';
const HOST_CLASS = 'layout-host';
const PLACEHOLDER_CLASS = 'layout-placeholder';

export interface RenderHandlers {
  onSplitDividerDown: (splitId: NodeId, ev: PointerEvent) => void;
  onTabClick: (tabsId: NodeId, index: number) => void;
  onSectionDragStart: (section: SectionId, ev: PointerEvent) => void;
  onTabDragStart: (section: SectionId, ev: PointerEvent) => void;
  // Optional close button per leaf. If absent, no close button is shown.
  onLeafCloseClick?: (section: SectionId) => void;
  // Decides whether to show the close button on a given leaf. Returning
  // false suppresses it (used for chat + agent-grid which must always
  // be present).
  canCloseLeaf?: (section: SectionId) => boolean;
  // Optional human-readable title for tab labels and shelf entries.
  sectionTitle?: (section: SectionId) => string;
  // List of hidden section ids the user can re-add via the chrome.
  hiddenSections?: () => SectionId[];
  // Click handler for the re-add button.
  onUnhideClick?: (section: SectionId) => void;
}

// Build (or reuse) the layout-root element under `parent`. The function
// is idempotent — calling it again with the same parent reuses the
// existing root.
export function ensureRoot(parent: HTMLElement): HTMLElement {
  let root = parent.querySelector<HTMLElement>(`.${ROOT_CLASS}`);
  if (!root) {
    root = document.createElement('div');
    root.className = ROOT_CLASS;
    parent.appendChild(root);
  }
  return root;
}

export function clearRoot(root: HTMLElement): void {
  root.innerHTML = '';
}

// Find every `<section data-layout-section="…">` (or any element with
// that data attribute) and stash them off-screen in `parking` so we
// can move them back into the new wrapper tree without recreating them.
export function parkSections(parent: HTMLElement, parking: HTMLElement): Map<SectionId, HTMLElement> {
  const found = new Map<SectionId, HTMLElement>();
  const nodes = parent.querySelectorAll<HTMLElement>('[data-layout-section]');
  nodes.forEach((el) => {
    const id = el.dataset.layoutSection;
    if (!id) return;
    found.set(id, el);
    parking.appendChild(el);
  });
  return found;
}

// Render a tree to the root element. `sectionEls` maps SectionId → real
// section element to mount. Sections in the tree but not in the map are
// rendered as placeholders ("waiting for music-bar…") so the layout
// shape stays stable while async sections load.
export function render(
  root: HTMLElement,
  tree: LayoutTree,
  sectionEls: Map<SectionId, HTMLElement>,
  handlers: RenderHandlers,
): void {
  clearRoot(root);
  if (!tree.root) {
    const empty = document.createElement('div');
    empty.className = `${WRAPPER_CLASS} ${PLACEHOLDER_CLASS}`;
    empty.textContent = 'no sections yet';
    root.appendChild(empty);
  } else {
    const built = buildNode(tree.root, sectionEls, handlers);
    root.appendChild(built);
  }
  // Re-add shelf (only renders when something is hidden).
  const hidden = handlers.hiddenSections?.() ?? [];
  if (hidden.length > 0 && handlers.onUnhideClick) {
    const shelf = buildShelf(hidden, handlers);
    root.appendChild(shelf);
  }
}

function buildShelf(hidden: SectionId[], handlers: RenderHandlers): HTMLElement {
  const shelf = document.createElement('div');
  shelf.className = 'layout-shelf';
  shelf.title = 'hidden sections — click to add back';
  for (const section of hidden) {
    const chip = document.createElement('button');
    chip.className = 'layout-shelf-chip';
    chip.type = 'button';
    chip.textContent = '+ ' + (handlers.sectionTitle?.(section) ?? section);
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handlers.onUnhideClick?.(section);
    });
    shelf.appendChild(chip);
  }
  return shelf;
}

function buildNode(
  node: LayoutNode,
  sectionEls: Map<SectionId, HTMLElement>,
  handlers: RenderHandlers,
): HTMLElement {
  if (node.kind === 'leaf') return buildLeaf(node, sectionEls, handlers);
  if (node.kind === 'tabs') return buildTabs(node, sectionEls, handlers);
  return buildSplit(node, sectionEls, handlers);
}

function buildLeaf(
  node: Extract<LayoutNode, { kind: 'leaf' }>,
  sectionEls: Map<SectionId, HTMLElement>,
  handlers: RenderHandlers,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `${WRAPPER_CLASS} ${LEAF_CLASS}`;
  wrap.dataset.layoutNode = node.id;
  wrap.dataset.layoutKind = 'leaf';
  wrap.dataset.layoutSectionId = node.section;

  const handle = makeDragHandle(() => {
    return (ev: PointerEvent) => handlers.onSectionDragStart(node.section, ev);
  });
  wrap.appendChild(handle);

  // × close button. Suppressed when canCloseLeaf returns false (chat,
  // agent-grid). Lives next to the drag handle in the top-right; only
  // visible on hover (matches the drag handle's visibility rule).
  if (handlers.onLeafCloseClick && (handlers.canCloseLeaf?.(node.section) ?? true)) {
    const close = document.createElement('div');
    close.className = 'layout-leaf-close';
    close.title = 'hide this section';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handlers.onLeafCloseClick?.(node.section);
    });
    wrap.appendChild(close);
  }

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  const sectionEl = sectionEls.get(node.section);
  if (sectionEl) {
    host.appendChild(sectionEl);
  } else {
    const ph = document.createElement('div');
    ph.className = PLACEHOLDER_CLASS;
    ph.textContent = handlers.sectionTitle?.(node.section) ?? node.section;
    host.appendChild(ph);
  }
  wrap.appendChild(host);
  return wrap;
}

function buildTabs(
  node: Extract<LayoutNode, { kind: 'tabs' }>,
  sectionEls: Map<SectionId, HTMLElement>,
  handlers: RenderHandlers,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `${WRAPPER_CLASS} ${TABS_CLASS}`;
  wrap.dataset.layoutNode = node.id;
  wrap.dataset.layoutKind = 'tabs';

  const strip = document.createElement('div');
  strip.className = TAB_STRIP_CLASS;
  node.tabs.forEach((section, i) => {
    const tab = document.createElement('div');
    tab.className = TAB_CLASS + (i === node.activeIndex ? ' ' + TAB_ACTIVE_CLASS : '');
    tab.textContent = handlers.sectionTitle?.(section) ?? section;
    tab.dataset.layoutTabIndex = String(i);
    tab.dataset.layoutSectionId = section;
    tab.addEventListener('click', () => handlers.onTabClick(node.id, i));
    tab.addEventListener('pointerdown', (ev) => {
      // Tab drag — only on the tab itself, not via the click handler
      if ((ev as PointerEvent).button !== 0) return;
      handlers.onTabDragStart(section, ev as PointerEvent);
    });
    strip.appendChild(tab);
  });
  wrap.appendChild(strip);

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  const active = node.tabs[node.activeIndex];
  const sectionEl = active ? sectionEls.get(active) : null;
  if (sectionEl) {
    host.appendChild(sectionEl);
  } else if (active) {
    const ph = document.createElement('div');
    ph.className = PLACEHOLDER_CLASS;
    ph.textContent = active;
    host.appendChild(ph);
  }
  wrap.appendChild(host);
  return wrap;
}

function buildSplit(
  node: Extract<LayoutNode, { kind: 'split' }>,
  sectionEls: Map<SectionId, HTMLElement>,
  handlers: RenderHandlers,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `${WRAPPER_CLASS} ${SPLIT_CLASS}`;
  wrap.dataset.layoutNode = node.id;
  wrap.dataset.layoutKind = 'split';
  wrap.dataset.layoutOrientation = node.orientation;
  wrap.style.flexDirection = node.orientation === 'horizontal' ? 'row' : 'column';

  const a = buildNode(node.children[0], sectionEls, handlers);
  const b = buildNode(node.children[1], sectionEls, handlers);
  a.style.flex = `${node.split} 1 0`;
  b.style.flex = `${1 - node.split} 1 0`;
  a.style.minWidth = '0';
  a.style.minHeight = '0';
  b.style.minWidth = '0';
  b.style.minHeight = '0';

  const div = document.createElement('div');
  div.className = DIVIDER_CLASS;
  div.dataset.layoutDivider = node.id;
  div.dataset.layoutOrientation = node.orientation;
  div.addEventListener('pointerdown', (ev) => handlers.onSplitDividerDown(node.id, ev as PointerEvent));

  wrap.appendChild(a);
  wrap.appendChild(div);
  wrap.appendChild(b);
  return wrap;
}

function makeDragHandle(makeOnDown: () => (ev: PointerEvent) => void): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'layout-drag-handle';
  handle.title = 'drag to reorder · drop on edge to split · drop on center to tab';
  handle.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';
  const onDown = makeOnDown();
  handle.addEventListener('pointerdown', (ev) => {
    if ((ev as PointerEvent).button !== 0) return;
    onDown(ev as PointerEvent);
  });
  return handle;
}

// Walk the rendered DOM and find the wrapper element for nodeId. Used by
// the drag layer for hit-testing.
export function wrapperFor(root: HTMLElement, nodeId: NodeId): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-layout-node="${cssEscape(nodeId)}"]`);
}

// CSS.escape polyfill — old browsers may not have it, and our test env
// (jsdom) doesn't always.
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}
