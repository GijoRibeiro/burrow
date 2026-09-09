import { describe, it, expect, beforeEach } from 'vitest';
import {
  emptyTree,
  insertSection,
  removeSection,
  splitAt,
  addTab,
  setSplitFraction,
  setActiveTab,
  moveSection,
  pruneUnknownSections,
  findContainerOf,
  findNode,
  hasSection,
  allSections,
  normalizeTree,
  leaf,
  tabs,
  split,
  _resetIdsForTest,
  type LayoutTree,
  type LayoutNode,
} from './tree';

beforeEach(() => _resetIdsForTest());

// Helper: build a tree with explicit ids so tests can assert against them.
function tree(root: LayoutNode | null): LayoutTree {
  return { root };
}

describe('insertSection', () => {
  it('makes a leaf root when tree is empty', () => {
    const t = insertSection(emptyTree(), 'chat');
    expect(t.root).toEqual({ kind: 'leaf', id: expect.any(String), section: 'chat' });
  });

  it('appends as a horizontal split when tree has a root', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    expect(t.root?.kind).toBe('split');
    expect(allSections(t)).toEqual(['chat', 'agent-grid']);
  });

  it('is a no-op if section already present', () => {
    const a = insertSection(emptyTree(), 'chat');
    const b = insertSection(a, 'chat');
    expect(b).toBe(a);
  });
});

describe('splitAt', () => {
  it('wraps a leaf with source on the right', () => {
    let t = insertSection(emptyTree(), 'chat');
    const target = t.root!.id;
    t = splitAt(t, target, 'agent-grid', 'right');
    expect(t.root?.kind).toBe('split');
    if (t.root?.kind !== 'split') throw new Error('unreachable');
    expect(t.root.orientation).toBe('horizontal');
    expect((t.root.children[0] as any).section).toBe('chat');
    expect((t.root.children[1] as any).section).toBe('agent-grid');
  });

  it('wraps with source on the left', () => {
    let t = insertSection(emptyTree(), 'chat');
    const target = t.root!.id;
    t = splitAt(t, target, 'agent-grid', 'left');
    if (t.root?.kind !== 'split') throw new Error('unreachable');
    expect((t.root.children[0] as any).section).toBe('agent-grid');
    expect((t.root.children[1] as any).section).toBe('chat');
  });

  it('produces a vertical split for top/bottom sides', () => {
    let t = insertSection(emptyTree(), 'chat');
    const target = t.root!.id;
    t = splitAt(t, target, 'agent-grid', 'bottom');
    if (t.root?.kind !== 'split') throw new Error('unreachable');
    expect(t.root.orientation).toBe('vertical');
  });

  it('detaches source from its previous location', () => {
    // Start: split [chat | agent-grid]. Then drop agent-grid to right of
    // chat — should still have only one agent-grid in the tree.
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const chatLeaf = [...allSectionsAndNodes(t)].find((n) => n.kind === 'leaf' && n.section === 'chat')!;
    t = splitAt(t, chatLeaf.id, 'agent-grid', 'right');
    expect(allSections(t).filter((s) => s === 'agent-grid')).toHaveLength(1);
  });
});

describe('addTab', () => {
  it('promotes a leaf into a tabs node', () => {
    let t = insertSection(emptyTree(), 'chat');
    const target = t.root!.id;
    t = addTab(t, target, 'agent-grid');
    expect(t.root?.kind).toBe('tabs');
    if (t.root?.kind !== 'tabs') throw new Error('unreachable');
    expect(t.root.tabs).toEqual(['chat', 'agent-grid']);
    expect(t.root.activeIndex).toBe(1);
  });

  it('appends to an existing tabs node', () => {
    let t = insertSection(emptyTree(), 'chat');
    const target = t.root!.id;
    t = addTab(t, target, 'agent-grid');
    t = addTab(t, target, 'music-bar');
    if (t.root?.kind !== 'tabs') throw new Error('unreachable');
    expect(t.root.tabs).toEqual(['chat', 'agent-grid', 'music-bar']);
    expect(t.root.activeIndex).toBe(2);
  });

  it('inserts at a given index', () => {
    let t = insertSection(emptyTree(), 'chat');
    const target = t.root!.id;
    t = addTab(t, target, 'agent-grid');
    t = addTab(t, target, 'music-bar', 0);
    if (t.root?.kind !== 'tabs') throw new Error('unreachable');
    expect(t.root.tabs).toEqual(['music-bar', 'chat', 'agent-grid']);
  });

  it('detaches source from its previous tabs slot', () => {
    let t = tree(tabs(['chat', 'agent-grid', 'music-bar'], 0, 'tabs-1'));
    t = addTab(t, 'tabs-1', 'agent-grid', 2); // Should be a no-op-ish (already there)
    expect(allSections(t).filter((s) => s === 'agent-grid')).toHaveLength(1);
  });
});

describe('removeSection', () => {
  it('drops the only leaf and leaves an empty tree', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = removeSection(t, 'chat');
    expect(t.root).toBeNull();
  });

  it('collapses a split when one child is removed', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    t = removeSection(t, 'agent-grid');
    expect(t.root?.kind).toBe('leaf');
    expect((t.root as any).section).toBe('chat');
  });

  it('unwraps a tabs node down to a leaf when one tab remains', () => {
    let t = tree(tabs(['chat', 'agent-grid'], 0, 'tabs-1'));
    t = removeSection(t, 'agent-grid');
    expect(t.root?.kind).toBe('leaf');
    expect((t.root as any).section).toBe('chat');
  });

  it('removes from a deeply nested split correctly', () => {
    const inner = split('horizontal', [leaf('a'), leaf('b')]);
    const root = split('vertical', [inner, leaf('c')]);
    let t = tree(root);
    t = removeSection(t, 'b');
    // inner collapses to leaf('a'); outer becomes vertical split [a | c]
    if (t.root?.kind !== 'split') throw new Error('expected split, got: ' + JSON.stringify(t.root));
    expect((t.root.children[0] as any).section).toBe('a');
    expect((t.root.children[1] as any).section).toBe('c');
  });
});

describe('setSplitFraction / setActiveTab', () => {
  it('updates split fraction in place', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const splitId = t.root!.id;
    t = setSplitFraction(t, splitId, 0.3);
    if (t.root?.kind !== 'split') throw new Error('unreachable');
    expect(t.root.split).toBeCloseTo(0.3);
  });

  it('clamps split fraction to [0.05, 0.95]', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const splitId = t.root!.id;
    t = setSplitFraction(t, splitId, 5);
    if (t.root?.kind !== 'split') throw new Error('unreachable');
    expect(t.root.split).toBeCloseTo(0.95);
  });

  it('updates active tab', () => {
    let t = tree(tabs(['a', 'b', 'c'], 0, 'tabs-1'));
    t = setActiveTab(t, 'tabs-1', 2);
    if (t.root?.kind !== 'tabs') throw new Error('unreachable');
    expect(t.root.activeIndex).toBe(2);
  });
});

describe('moveSection', () => {
  it('handles edge drops', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const chatLeaf = findContainerOf(t, 'chat')!;
    t = moveSection(t, 'agent-grid', { kind: 'edge', nodeId: chatLeaf.id, side: 'right' });
    expect(allSections(t).filter((s) => s === 'agent-grid')).toHaveLength(1);
  });

  it('handles tab drops', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const chatLeaf = findContainerOf(t, 'chat')!;
    t = moveSection(t, 'agent-grid', { kind: 'tab', nodeId: chatLeaf.id });
    if (t.root?.kind !== 'tabs') throw new Error('expected tabs root, got: ' + t.root?.kind);
    expect(t.root.tabs).toEqual(['chat', 'agent-grid']);
  });
});

describe('pruneUnknownSections', () => {
  it('drops leaves with sections outside the allowed set', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'top-controls');
    t = insertSection(t, 'agent-grid');
    t = pruneUnknownSections(t, new Set(['chat', 'agent-grid']));
    expect(allSections(t).sort()).toEqual(['agent-grid', 'chat']);
  });

  it('drops unknown ids inside tabs', () => {
    let t: LayoutTree = { root: tabs(['chat', 'chat-lanes', 'agent-grid'], 0, 'tabs-1') };
    t = pruneUnknownSections(t, new Set(['chat', 'agent-grid']));
    expect(allSections(t).sort()).toEqual(['agent-grid', 'chat']);
  });

  it('returns the same tree when nothing is unknown', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const next = pruneUnknownSections(t, new Set(['chat', 'agent-grid']));
    expect(allSections(next).sort()).toEqual(allSections(t).sort());
  });

  it('handles deeply nested junk', () => {
    const t = {
      root: split('horizontal', [
        leaf('chat'),
        split('vertical', [leaf('debug-panel'), leaf('agent-grid')]),
      ]),
    };
    const next = pruneUnknownSections(t, new Set(['chat', 'agent-grid']));
    expect(allSections(next).sort()).toEqual(['agent-grid', 'chat']);
  });
});

describe('normalize idempotence', () => {
  it('repeated normalize is a fixed point', () => {
    const t1 = tree(
      split(
        'horizontal',
        [
          tabs(['a'], 0, 'tabs-1'),
          split('vertical', [leaf('b'), leaf('c')], 5.0, 'split-2'),
        ],
        0.5,
      ),
    );
    const n1 = normalizeTree(t1);
    const n2 = normalizeTree(n1);
    expect(n2).toBe(n1); // identity, structural sharing
  });
});

describe('invariants under random ops', () => {
  it('every op preserves: each section appears exactly once', () => {
    const sections = ['chat', 'agent-grid', 'music-bar', 'linear-panel', 'active-agents-bar'];
    let t = emptyTree();
    for (const s of sections) t = insertSection(t, s);

    const assertEachOnce = () => {
      const list = allSections(t);
      const set = new Set(list);
      expect(list).toHaveLength(set.size);
      // None of the original sections should be missing either
      for (const s of sections) expect(hasSection(t, s)).toBe(true);
    };
    assertEachOnce();

    // Apply a series of random-ish moves
    const sides = ['left', 'right', 'top', 'bottom'] as const;
    for (let i = 0; i < 50; i++) {
      const src = sections[i % sections.length];
      const others = sections.filter((s) => s !== src);
      const targetSection = others[i % others.length];
      const targetNode = findContainerOf(t, targetSection);
      if (!targetNode) continue;
      if (i % 5 === 0) {
        t = moveSection(t, src, { kind: 'tab', nodeId: targetNode.id });
      } else {
        const side = sides[i % sides.length];
        t = moveSection(t, src, { kind: 'edge', nodeId: targetNode.id, side });
      }
      assertEachOnce();
    }
  });
});

// --- helpers ---

function* allSectionsAndNodes(t: LayoutTree): Generator<LayoutNode> {
  function* walk(n: LayoutNode | null): Generator<LayoutNode> {
    if (!n) return;
    yield n;
    if (n.kind === 'split') {
      yield* walk(n.children[0]);
      yield* walk(n.children[1]);
    }
  }
  yield* walk(t.root);
}
