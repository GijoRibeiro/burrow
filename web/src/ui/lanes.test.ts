// Pure-function tests for the lane reorder logic. The drag+drop UX
// itself isn't covered (it needs a browser), but the underlying
// array mutations that drive every swap / move-to / split decision
// are exercised here so a regression in ordering — the kind of bug
// the user hit when "I can't seem to change places with linear /
// agents frames" — surfaces with a single failing assertion.

import { describe, it, expect } from 'vitest';
import { reorderById, swapById, reorderToMatchSavedOrder } from './lanes';

type L = { id: string };
const lanes = (...ids: string[]): L[] => ids.map((id) => ({ id }));
const ids = (arr: L[]): string[] => arr.map((l) => l.id);

describe('reorderById (move-before, browser-tab style)', () => {
  it('moves source forward over the target', () => {
    const out = reorderById(lanes('A', 'B', 'C', 'D'), 'A', 'C');
    expect(ids(out)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('moves source backward onto an earlier target', () => {
    const out = reorderById(lanes('A', 'B', 'C', 'D'), 'D', 'B');
    expect(ids(out)).toEqual(['A', 'D', 'B', 'C']);
  });

  it('moves the leftmost lane to the right end', () => {
    const out = reorderById(lanes('A', 'B', 'C'), 'A', 'C');
    expect(ids(out)).toEqual(['B', 'A', 'C']);
  });

  it('moves the rightmost lane to the left end', () => {
    const out = reorderById(lanes('A', 'B', 'C'), 'C', 'A');
    expect(ids(out)).toEqual(['C', 'A', 'B']);
  });

  it('treats general / linear / agent-cwd ids uniformly', () => {
    // Lane 0 must be drag-reorderable alongside section + agent
    // lanes — the bug the user hit when boss / linear felt frozen.
    const out = reorderById(
      lanes('general', '/code/x', 'linear', '/code/y'),
      'linear',
      'general',
    );
    expect(ids(out)).toEqual(['linear', 'general', '/code/x', '/code/y']);
  });

  it('is a no-op when from === to', () => {
    const arr = lanes('A', 'B', 'C');
    const out = reorderById(arr, 'B', 'B');
    expect(ids(out)).toEqual(['A', 'B', 'C']);
  });

  it('returns a copy when from is unknown', () => {
    const arr = lanes('A', 'B', 'C');
    const out = reorderById(arr, 'NOPE', 'B');
    expect(ids(out)).toEqual(['A', 'B', 'C']);
    expect(out).not.toBe(arr);
  });

  it('returns a copy when to is unknown', () => {
    const arr = lanes('A', 'B', 'C');
    const out = reorderById(arr, 'A', 'NOPE');
    expect(ids(out)).toEqual(['A', 'B', 'C']);
    expect(out).not.toBe(arr);
  });

  it('does not mutate the input array', () => {
    const arr = lanes('A', 'B', 'C', 'D');
    const before = ids(arr);
    reorderById(arr, 'A', 'D');
    expect(ids(arr)).toEqual(before);
  });
});

describe('swapById (position swap)', () => {
  it('swaps two non-adjacent lanes', () => {
    const out = swapById(lanes('A', 'B', 'C', 'D'), 'A', 'C');
    expect(ids(out)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('swaps two adjacent lanes', () => {
    const out = swapById(lanes('A', 'B', 'C'), 'B', 'C');
    expect(ids(out)).toEqual(['A', 'C', 'B']);
  });

  it('is a no-op when ids match', () => {
    const out = swapById(lanes('A', 'B'), 'A', 'A');
    expect(ids(out)).toEqual(['A', 'B']);
  });

  it('is a no-op for unknown ids', () => {
    const out = swapById(lanes('A', 'B'), 'A', 'NOPE');
    expect(ids(out)).toEqual(['A', 'B']);
  });

  it('does not mutate the input array', () => {
    const arr = lanes('A', 'B', 'C');
    const before = ids(arr);
    swapById(arr, 'A', 'C');
    expect(ids(arr)).toEqual(before);
  });
});

describe('reorderToMatchSavedOrder (cross-reload restore)', () => {
  it('reorders to match the saved order when every id is known', () => {
    const out = reorderToMatchSavedOrder(
      lanes('general', '/code/x', 'linear'),
      ['linear', 'general', '/code/x'],
    );
    expect(ids(out)).toEqual(['linear', 'general', '/code/x']);
  });

  it('appends unknown ids after the saved-order block, preserving relative order', () => {
    // 'general' and 'linear' are saved; '/code/y' and '/code/z' are
    // new this session and should land after the saved block in their
    // current relative order.
    const out = reorderToMatchSavedOrder(
      lanes('general', '/code/y', 'linear', '/code/z'),
      ['linear', 'general'],
    );
    expect(ids(out)).toEqual(['linear', 'general', '/code/y', '/code/z']);
  });

  it('ignores saved ids that no longer exist in the array', () => {
    // 'agents' was in the saved order but the user closed it before
    // this session — its slot should just be skipped, not held open.
    const out = reorderToMatchSavedOrder(
      lanes('general', 'linear'),
      ['agents', 'linear', 'music-bar', 'general'],
    );
    expect(ids(out)).toEqual(['linear', 'general']);
  });

  it('returns a copy of the input when savedOrder is empty', () => {
    const arr = lanes('A', 'B', 'C');
    const out = reorderToMatchSavedOrder(arr, []);
    expect(ids(out)).toEqual(['A', 'B', 'C']);
    expect(out).not.toBe(arr);
  });

  it('is idempotent — applying twice gives the same result', () => {
    const saved = ['C', 'A', 'B'];
    const once = reorderToMatchSavedOrder(lanes('A', 'B', 'C'), saved);
    const twice = reorderToMatchSavedOrder(once, saved);
    expect(ids(twice)).toEqual(ids(once));
  });

  it('does not mutate the input array', () => {
    const arr = lanes('A', 'B', 'C');
    const before = ids(arr);
    reorderToMatchSavedOrder(arr, ['C', 'A', 'B']);
    expect(ids(arr)).toEqual(before);
  });
});
