// @vitest-environment jsdom
//
// Regression test for the splitter-resize persistence bug: dragging a
// divider updated the in-memory tree (and the DOM) but never wrote the new
// fraction to localStorage, so sizes reset on reload. Root cause: the live
// onSplitFraction handler pre-mutated the canonical tree, so the final
// commit saw `next === tree` and skipped the save.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initLayout } from './index';
import { loadTree } from './persist';
import { _resetIdsForTest, type LayoutTree, type LayoutNode } from './tree';

function findSplit(tree: LayoutTree | null): Extract<LayoutNode, { kind: 'split' }> | null {
  function walk(n: LayoutNode | null): Extract<LayoutNode, { kind: 'split' }> | null {
    if (!n) return null;
    if (n.kind === 'split') return n;
    if (n.kind === 'tabs' || n.kind === 'leaf') return null;
    return null;
  }
  // The chat|agent-grid layout is a single split at the root.
  return tree && tree.root && tree.root.kind === 'split' ? tree.root : walk(tree?.root ?? null);
}

function buildHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'app';
  for (const id of ['chat', 'agent-grid']) {
    const el = document.createElement('div');
    el.dataset.layoutSection = id;
    host.appendChild(el);
  }
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  _resetIdsForTest();
  vi.useFakeTimers();
});

describe('divider resize persistence', () => {
  it('persists the new split fraction after a divider drag', () => {
    const host = buildHost();
    const api = initLayout({ host, knownSections: ['chat', 'agent-grid'] });

    const split = findSplit(api.getTree());
    expect(split, 'expected a root split for chat|agent-grid').toBeTruthy();
    const splitId = split!.id;
    const initialFraction = split!.split;

    const wrapper = host.querySelector<HTMLElement>(`[data-layout-node="${splitId}"]`);
    const divider = host.querySelector<HTMLElement>(`[data-layout-divider="${splitId}"]`);
    expect(wrapper, 'split wrapper element').toBeTruthy();
    expect(divider, 'divider element').toBeTruthy();

    // jsdom has no layout engine, so feed the drag a real-sized rect.
    wrapper!.getBoundingClientRect = () =>
      ({ width: 1000, height: 1000, left: 0, top: 0, right: 1000, bottom: 1000, x: 0, y: 0, toJSON() {} }) as DOMRect;

    // Grab the divider at coord 500, drag to 700 → +200/1000 = +0.2 in
    // whichever axis the split uses. Same value on both axes so the test is
    // orientation-agnostic.
    divider!.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, clientY: 500, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 700 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 700, clientY: 700 }));

    // Flush the save debounce.
    vi.runAllTimers();

    const memFraction = findSplit(api.getTree())!.split;
    const persisted = findSplit(loadTree())!;

    // The drag must have actually changed the in-memory fraction.
    expect(memFraction).not.toBe(initialFraction);
    // And the persisted fraction must match it — the bug left this stale.
    expect(persisted.split).toBe(memFraction);
  });
});
