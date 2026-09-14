import { expect, test } from "vitest";
import { worktreeHierarchy } from "./hierarchy";
const tree = (path: string, parentPath?: string) => ({
  path,
  parentPath,
  name: path,
  branch: path,
  main: false,
});
test("existing checkouts stay flat and children follow their parent", () => {
  expect(
    worktreeHierarchy([
      tree("child", "parent"),
      tree("flat"),
      tree("parent"),
      tree("grandchild", "child"),
    ]).map(({ tree, depth }) => [tree.path, depth]),
  ).toEqual([
    ["flat", 0],
    ["parent", 0],
    ["child", 1],
    ["grandchild", 2],
  ]);
});
test("missing and cyclic parents cannot hide checkouts", () => {
  const rows = worktreeHierarchy([
    tree("orphan", "missing"),
    tree("a", "b"),
    tree("b", "a"),
  ]);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.tree.path)).size).toBe(3);
  expect(rows[0].depth).toBe(0);
});
