import { describe, it, expect } from 'vitest';
import { classifyDrop, classifyTabStripDrop } from './drop-zones';

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, width: w, height: h });

describe('classifyDrop', () => {
  const r = rect(0, 0, 100, 100);

  it('center → tab', () => {
    expect(classifyDrop(r, 50, 50)).toEqual({ kind: 'tab' });
  });

  it('left edge → split left', () => {
    expect(classifyDrop(r, 5, 50)).toEqual({ kind: 'edge', side: 'left' });
  });

  it('right edge → split right', () => {
    expect(classifyDrop(r, 95, 50)).toEqual({ kind: 'edge', side: 'right' });
  });

  it('top edge → split top', () => {
    expect(classifyDrop(r, 50, 5)).toEqual({ kind: 'edge', side: 'top' });
  });

  it('bottom edge → split bottom', () => {
    expect(classifyDrop(r, 50, 95)).toEqual({ kind: 'edge', side: 'bottom' });
  });

  it('outside → gap', () => {
    expect(classifyDrop(r, -5, 50)).toEqual({ kind: 'gap' });
    expect(classifyDrop(r, 50, 105)).toEqual({ kind: 'gap' });
  });

  it('zero rect → gap', () => {
    expect(classifyDrop(rect(0, 0, 0, 0), 0, 0)).toEqual({ kind: 'gap' });
  });

  it('corner picks closest edge', () => {
    // top-left corner — top and left are equidistant on a square; we
    // tie-break to left (first in min-check order).
    expect(classifyDrop(r, 1, 1)).toEqual({ kind: 'edge', side: 'left' });
  });
});

describe('classifyTabStripDrop', () => {
  it('inserts before first tab when cursor is far-left', () => {
    const tabs = [rect(0, 0, 80, 30), rect(80, 0, 80, 30)];
    expect(classifyTabStripDrop(tabs, 5)).toBe(0);
  });

  it('inserts between tabs when cursor is in the gap', () => {
    const tabs = [rect(0, 0, 80, 30), rect(80, 0, 80, 30)];
    expect(classifyTabStripDrop(tabs, 100)).toBe(1);
  });

  it('inserts at end when cursor is past last tab', () => {
    const tabs = [rect(0, 0, 80, 30), rect(80, 0, 80, 30)];
    expect(classifyTabStripDrop(tabs, 200)).toBe(2);
  });
});
