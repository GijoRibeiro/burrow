import { describe, expect, it } from "vitest";
import {
  arrange,
  ids,
  insert,
  parseLayout,
  remove,
  swap,
  type Tree,
} from "./layout";
describe("workspace layout", () => {
  it("splits and hides independently of project selection", () => {
    let tree: Tree | null = insert(null, "checkout", null, "row");
    tree = insert(tree, "newbit", "checkout", "row");
    tree = insert(tree, "cloovies", "newbit", "column");
    expect(ids(tree)).toEqual(["checkout", "newbit", "cloovies"]);
    expect(tree).toMatchObject({ axis: "row", b: { axis: "column" } });
    expect(ids(remove(tree, "newbit"))).toEqual(["checkout", "cloovies"]);
    expect(ids(insert(tree, "newbit", "checkout", "row"))).toHaveLength(3);
  });
  it("restores ratios and prunes missing and duplicate terminals", () => {
    const restored = parseLayout(
      {
        axis: "row",
        ratio: 0.63,
        a: { terminal: "a" },
        b: {
          axis: "column",
          a: { terminal: "b" },
          b: { axis: "row", a: { terminal: "b" }, b: { terminal: "deleted" } },
        },
      },
      new Set(["a", "b"]),
    );
    expect(restored).toMatchObject({
      ratio: 0.63,
      a: { terminal: "a" },
      b: { terminal: "b" },
    });
    expect(parseLayout({ axis: "oops" }, new Set())).toBeNull();
  });
  it("presets, swaps, and round trips keep every terminal exactly once", () => {
    for (let count = 1; count <= 25; count++) {
      const sessions = Array.from({ length: count }, (_, i) => `t${i}`);
      for (const preset of ["columns", "rows", "grid"] as const) {
        const tree = arrange(sessions, preset)!;
        expect(ids(tree)).toEqual(sessions);
        expect(
          new Set(ids(swap(tree, sessions[0], sessions[count - 1]))),
        ).toEqual(new Set(sessions));
        expect(
          ids(parseLayout(JSON.parse(JSON.stringify(tree)), new Set(sessions))),
        ).toEqual(sessions);
      }
    }
  });
});
