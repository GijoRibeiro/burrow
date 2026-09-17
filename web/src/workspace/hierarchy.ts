import type { Worktree } from "./types";

// Keep the checkout owning each running agent, plus its ancestors for context.
// Agents may run in a subfolder of a checkout rather than at its root.
export function activeWorktrees(
  trees: Worktree[],
  agentPaths: string[],
): Worktree[] {
  const byPath = new Map(trees.map((tree) => [tree.path, tree]));
  const keep = new Set<string>();
  for (const path of agentPaths) {
    let tree: Worktree | undefined = trees
      .filter(
        (tree) =>
          path === tree.path ||
          path.startsWith(tree.path.replace(/\/$/, "") + "/"),
      )
      .sort((a, b) => b.path.length - a.path.length)[0];
    while (tree && !keep.has(tree.path)) {
      keep.add(tree.path);
      tree = byPath.get(tree.parentPath || "");
    }
  }
  return trees.filter((tree) => keep.has(tree.path));
}

// Existing and external checkouts stay flat. Missing parents and malformed cycles
// never hide a checkout; Git remains the source of truth for which folders exist.
export function worktreeHierarchy(
  trees: Worktree[],
): { tree: Worktree; depth: number }[] {
  const paths = new Set(trees.map((tree) => tree.path));
  const seen = new Set<string>();
  const result: { tree: Worktree; depth: number }[] = [];
  const visit = (tree: Worktree, depth: number) => {
    if (seen.has(tree.path)) return;
    seen.add(tree.path);
    result.push({ tree, depth });
    for (const child of trees)
      if (child.parentPath === tree.path) visit(child, depth + 1);
  };
  for (const tree of trees)
    if (!tree.parentPath || !paths.has(tree.parentPath)) visit(tree, 0);
  for (const tree of trees) visit(tree, 0);
  return result;
}
