// Layout contains terminal IDs only: project selection never changes the canvas.
export type Tree =
  | { id: string; terminal: string }
  | { id: string; axis: "row" | "column"; ratio: number; a: Tree; b: Tree };
export type Axis = "row" | "column";
export function leaf(terminal: string): Tree {
  return { id: crypto.randomUUID(), terminal };
}
export function ids(tree: Tree | null): string[] {
  return !tree
    ? []
    : "terminal" in tree
      ? [tree.terminal]
      : [...ids(tree.a), ...ids(tree.b)];
}
export function remove(tree: Tree | null, terminal: string): Tree | null {
  if (!tree) return null;
  if ("terminal" in tree) return tree.terminal === terminal ? null : tree;
  const a = remove(tree.a, terminal),
    b = remove(tree.b, terminal);
  return a && b ? { ...tree, a, b } : a || b;
}
export function insert(
  tree: Tree | null,
  terminal: string,
  target: string | null,
  axis: Axis,
): Tree {
  if (ids(tree).includes(terminal)) return tree!;
  if (!tree) return leaf(terminal);
  if ("terminal" in tree)
    return {
      id: crypto.randomUUID(),
      axis,
      ratio: 0.5,
      a: tree,
      b: leaf(terminal),
    };
  if (target && ids(tree.a).includes(target))
    return { ...tree, a: insert(tree.a, terminal, target, axis) };
  if (target && ids(tree.b).includes(target))
    return { ...tree, b: insert(tree.b, terminal, target, axis) };
  return {
    id: crypto.randomUUID(),
    axis,
    ratio: 0.5,
    a: tree,
    b: leaf(terminal),
  };
}
export function arrange(
  terminals: string[],
  mode: "columns" | "rows" | "grid",
): Tree | null {
  if (!terminals.length) return null;
  if (terminals.length === 1) return leaf(terminals[0]);
  const pivot = mode === "grid" ? Math.ceil(terminals.length / 2) : 1;
  return {
    id: crypto.randomUUID(),
    axis: mode === "rows" ? "column" : "row",
    ratio: mode === "grid" ? 0.5 : 1 / terminals.length,
    a: arrange(terminals.slice(0, pivot), mode === "grid" ? "rows" : mode)!,
    b: arrange(terminals.slice(pivot), mode === "grid" ? "rows" : mode)!,
  };
}
export function parseLayout(value: unknown, allowed: Set<string>): Tree | null {
  const seen = new Set<string>();
  function parse(v: unknown, depth: number): Tree | null {
    if (!v || typeof v !== "object" || depth > 40) return null;
    const n = v as Record<string, unknown>;
    if (typeof n.terminal === "string") {
      if (!allowed.has(n.terminal) || seen.has(n.terminal)) return null;
      seen.add(n.terminal);
      return leaf(n.terminal);
    }
    if (n.axis !== "row" && n.axis !== "column") return null;
    const a = parse(n.a, depth + 1),
      b = parse(n.b, depth + 1);
    if (!a || !b) return a || b;
    return {
      id: crypto.randomUUID(),
      axis: n.axis,
      ratio:
        typeof n.ratio === "number" && Number.isFinite(n.ratio)
          ? Math.max(0.1, Math.min(0.9, n.ratio))
          : 0.5,
      a,
      b,
    };
  }
  return parse(value, 0);
}
export function swap(tree: Tree, a: string, b: string): Tree {
  if ("terminal" in tree)
    return {
      ...tree,
      terminal:
        tree.terminal === a ? b : tree.terminal === b ? a : tree.terminal,
    };
  return { ...tree, a: swap(tree.a, a, b), b: swap(tree.b, a, b) };
}
