import { describe, it, expect, beforeEach } from 'vitest';
import {
  serializeTree,
  parseTree,
  buildTreeFromLegacy,
  reconcileWithKnownSections,
} from './persist';
import {
  emptyTree,
  insertSection,
  splitAt,
  addTab,
  findContainerOf,
  allSections,
  hasSection,
  _resetIdsForTest,
} from './tree';

beforeEach(() => _resetIdsForTest());

describe('serialize/parse', () => {
  it('round-trips an empty tree', () => {
    const t = emptyTree();
    const round = parseTree(serializeTree(t));
    expect(round).toEqual({ root: null });
  });

  it('round-trips a complex tree', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = insertSection(t, 'agent-grid');
    const chatLeaf = findContainerOf(t, 'chat')!;
    t = splitAt(t, chatLeaf.id, 'music-bar', 'right');
    const agentLeaf = findContainerOf(t, 'agent-grid')!;
    t = addTab(t, agentLeaf.id, 'linear-panel');

    const round = parseTree(serializeTree(t))!;
    expect(allSections(round).sort()).toEqual(allSections(t).sort());
    expect(hasSection(round, 'chat')).toBe(true);
    expect(hasSection(round, 'music-bar')).toBe(true);
    expect(hasSection(round, 'linear-panel')).toBe(true);
  });

  it('returns null for unknown version', () => {
    const r = parseTree(JSON.stringify({ version: 99, tree: null }));
    expect(r).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseTree('not json')).toBeNull();
  });
});

describe('migration from legacy state', () => {
  it('flat ids → vertical stack with chat at the bottom', () => {
    const t = buildTreeFromLegacy({
      sectionOrder: JSON.stringify(['agent-grid', 'music-bar']),
      sectionLanes: null,
      linearDocked: null,
      linearDockedWidth: null,
    });
    expect(allSections(t)).toContain('agent-grid');
    expect(allSections(t)).toContain('music-bar');
    expect(allSections(t)).toContain('chat');
  });

  it('legacy pair → split node', () => {
    const legacyPair = {
      pair: ['agent-grid', 'linear-panel'],
      split: 0.6,
      orientation: 'horizontal',
    };
    const t = buildTreeFromLegacy({
      sectionOrder: JSON.stringify([legacyPair, 'music-bar']),
      sectionLanes: null,
      linearDocked: null,
      linearDockedWidth: null,
    });
    expect(hasSection(t, 'agent-grid')).toBe(true);
    expect(hasSection(t, 'linear-panel')).toBe(true);
    expect(hasSection(t, 'music-bar')).toBe(true);
  });

  it('lanes membership → tabs(chat, …laned)', () => {
    const t = buildTreeFromLegacy({
      sectionOrder: JSON.stringify(['agent-grid', 'music-bar']),
      sectionLanes: JSON.stringify(['music-bar']),
      linearDocked: null,
      linearDockedWidth: null,
    });
    // music-bar should appear exactly once, paired as a tab with chat
    const all = allSections(t);
    expect(all.filter((s) => s === 'music-bar')).toHaveLength(1);
    expect(all.filter((s) => s === 'chat')).toHaveLength(1);
    expect(all).toContain('agent-grid');
  });

  it('strips agent-dock-row legacy id', () => {
    const t = buildTreeFromLegacy({
      sectionOrder: JSON.stringify(['agent-dock-row', 'agent-grid']),
      sectionLanes: null,
      linearDocked: null,
      linearDockedWidth: null,
    });
    expect(allSections(t)).not.toContain('agent-dock-row');
    expect(hasSection(t, 'agent-grid')).toBe(true);
  });
});

describe('reconcileWithKnownSections', () => {
  it('appends missing known sections', () => {
    const t = emptyTree();
    const next = reconcileWithKnownSections(t, ['chat', 'agent-grid']);
    expect(hasSection(next, 'chat')).toBe(true);
    expect(hasSection(next, 'agent-grid')).toBe(true);
  });

  it('does not duplicate already-present sections', () => {
    let t = insertSection(emptyTree(), 'chat');
    t = reconcileWithKnownSections(t, ['chat']);
    expect(allSections(t).filter((s) => s === 'chat')).toHaveLength(1);
  });
});
