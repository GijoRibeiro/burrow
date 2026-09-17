import { describe, expect, it } from "vitest";
import { graphConnection } from "./graph-connection";
const head = { x: 100, y: 100, width: 288, height: 172 };
describe("canvas connections", () => {
  it.each([
    [600, 100, { x: 388, y: 186 }, { x: 600, y: 204 }],
    [-400, 100, { x: 100, y: 186 }, { x: -112, y: 204 }],
    [100, 600, { x: 244, y: 272 }, { x: 244, y: 600 }],
    [100, -400, { x: 244, y: 100 }, { x: 244, y: -192 }],
  ])("attaches to facing edges for worker at %s,%s", (x, y, start, end) => {
    const c = graphConnection(head, { x, y, width: 288, height: 208 });
    expect(c.start).toEqual(start);
    expect(c.end).toEqual(end);
    expect(c.path).not.toMatch(/NaN|Infinity/);
  });
  it("chooses vertical edges for a diagonally placed child below the head", () => {
    const c = graphConnection(head, {
      x: 160,
      y: 650,
      width: 288,
      height: 208,
    });
    expect(c.start).toEqual({ x: 244, y: 272 });
    expect(c.end).toEqual({ x: 304, y: 650 });
  });
  it("keeps overlapping node geometry finite", () => {
    expect(graphConnection(head, head).path).not.toMatch(/NaN|Infinity/);
  });
});
