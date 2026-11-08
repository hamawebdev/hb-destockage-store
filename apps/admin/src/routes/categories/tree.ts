/**
 * Category tree helpers (ACAT-1, plan §5). Pure; the input is the whole `categories` table
 * (small: tens of rows). The SQL write is still cycle-proof on its own (recursive CTE guard);
 * these helpers drive the form (parent choices, depth limit, display order) and the
 * archive/delete messages.
 */

export const MAX_DEPTH = 3;

export interface TreeNode {
  readonly id: number;
  readonly parentId: number | null;
  readonly sort: number;
}

export interface Ordered<T extends TreeNode> {
  readonly node: T;
  /** 0 for a root. */
  readonly depth: number;
}

const bySortThenId = (a: TreeNode, b: TreeNode): number => a.sort - b.sort || a.id - b.id;

function childrenIndex<T extends TreeNode>(nodes: readonly T[]): Map<number | null, T[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const byParent = new Map<number | null, T[]>();
  for (const n of nodes) {
    // A dangling parent (should not happen: FK) is shown as a root rather than hidden.
    const key = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort(bySortThenId);
  return byParent;
}

/** Depth-first display order (siblings by `sort`, then `id`). Nodes caught in a cycle are skipped. */
export function orderTree<T extends TreeNode>(nodes: readonly T[]): Ordered<T>[] {
  const byParent = childrenIndex(nodes);
  const out: Ordered<T>[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number): void => {
    for (const n of byParent.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** `id` and every descendant id. */
export function descendantIds(nodes: readonly TreeNode[], id: number): Set<number> {
  const byParent = childrenIndex(nodes);
  const out = new Set<number>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (const child of byParent.get(cur) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

/** Depth of `id` (root = 0); `Infinity` on a cycle or an unknown id. */
export function depthOf(nodes: readonly TreeNode[], id: number): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let depth = 0;
  let cur = byId.get(id);
  if (cur === undefined) return Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  while (cur.parentId !== null) {
    if (seen.has(cur.id)) return Number.POSITIVE_INFINITY;
    seen.add(cur.id);
    const parent = byId.get(cur.parentId);
    if (parent === undefined) return depth;
    depth++;
    cur = parent;
  }
  return depth;
}

/** Height of the subtree under `id` (a leaf = 0). */
function subtreeHeight(nodes: readonly TreeNode[], id: number): number {
  const byParent = childrenIndex(nodes);
  const height = (cur: number, guard: Set<number>): number => {
    let h = 0;
    for (const child of byParent.get(cur) ?? []) {
      if (guard.has(child.id)) continue;
      guard.add(child.id);
      h = Math.max(h, 1 + height(child.id, guard));
    }
    return h;
  };
  return height(id, new Set([id]));
}

export type ParentError = 'self_or_descendant' | 'unknown_parent' | 'depth_limit';

/**
 * Can `id` (null = a new category) be placed under `parentId` (null = root)? Refuses self or a
 * descendant (cycle) and a result deeper than MAX_DEPTH levels, counting the moved subtree.
 */
export function checkParent(nodes: readonly TreeNode[], id: number | null, parentId: number | null): ParentError | null {
  if (parentId === null) {
    return id !== null && subtreeHeight(nodes, id) + 1 > MAX_DEPTH ? 'depth_limit' : null;
  }
  if (!nodes.some((n) => n.id === parentId)) return 'unknown_parent';
  if (id !== null && descendantIds(nodes, id).has(parentId)) return 'self_or_descendant';
  const parentDepth = depthOf(nodes, parentId);
  const height = id === null ? 0 : subtreeHeight(nodes, id);
  // Levels used = parent's depth + 1 (the node) + its subtree height, counted from 1.
  return parentDepth + 1 + height + 1 > MAX_DEPTH ? 'depth_limit' : null;
}

/** Parent choices for the form: every node that `checkParent` accepts, in display order. */
export function parentChoices<T extends TreeNode>(nodes: readonly T[], id: number | null): Ordered<T>[] {
  return orderTree(nodes).filter((o) => checkParent(nodes, id, o.node.id) === null);
}
