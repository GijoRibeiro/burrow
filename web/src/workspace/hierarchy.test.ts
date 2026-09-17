import { expect, test } from "vitest";
import { activeWorktrees, worktreeHierarchy } from "./hierarchy";
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

test("active checkouts keep only their ancestor chain, including agents in subfolders", () => {
  const trees = [
    tree("/main"),
    tree("/parent", "/main"),
    tree("/child", "/parent"),
    tree("/unused", "/main"),
    tree("/child-other"),
  ];
  expect(
    activeWorktrees(trees, ["/child/src", "/child"]).map((t) => t.path),
  ).toEqual(["/main", "/parent", "/child"]);
  expect(activeWorktrees(trees, [])).toEqual([]);
  expect(activeWorktrees(trees, ["/unknown"])).toEqual([]);
});
test("active checkout ancestry handles cycles, missing parents and nested checkouts", () => {
  const trees = [
    tree("/a", "/b"),
    tree("/b", "/a"),
    tree("/orphan", "/missing"),
    tree("/outer"),
    tree("/outer/inner"),
  ];
  expect(
    activeWorktrees(trees, ["/a", "/orphan", "/outer/inner/src"]).map(
      (t) => t.path,
    ),
  ).toEqual(["/a", "/b", "/orphan", "/outer/inner"]);
});
