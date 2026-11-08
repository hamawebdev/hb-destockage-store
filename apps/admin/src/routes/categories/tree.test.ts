import { describe, expect, it } from 'vitest';
import { checkParent, depthOf, descendantIds, MAX_DEPTH, orderTree, parentChoices, type TreeNode } from './tree.ts';

// 1 Maison
//   2 Cuisine
//     4 Poêles
//   3 Salle de bain
// 5 Jardin
const n = (id: number, parentId: number | null, sort = 0): TreeNode => ({ id, parentId, sort });
const tree: TreeNode[] = [n(4, 2), n(3, 1, 2), n(2, 1, 1), n(1, null, 0), n(5, null, 1)];

describe('orderTree', () => {
  it('depth-first, siblings by sort then id', () => {
    expect(orderTree(tree).map((o) => [o.node.id, o.depth])).toEqual([
      [1, 0], [2, 1], [4, 2], [3, 1], [5, 0],
    ]);
  });
  it('ties on sort fall back to id', () => {
    expect(orderTree([n(9, null), n(7, null)]).map((o) => o.node.id)).toEqual([7, 9]);
  });
  it('skips nodes caught in a cycle instead of looping', () => {
    const cyclic = [n(1, 2), n(2, 1), n(3, null)];
    expect(orderTree(cyclic).map((o) => o.node.id)).toEqual([3]);
  });
});

describe('descendantIds / depthOf', () => {
  it('collects the subtree including self', () => {
    expect([...descendantIds(tree, 1)].sort()).toEqual([1, 2, 3, 4]);
    expect([...descendantIds(tree, 4)]).toEqual([4]);
  });
  it('depth from the root', () => {
    expect(depthOf(tree, 1)).toBe(0);
    expect(depthOf(tree, 4)).toBe(2);
    expect(depthOf(tree, 99)).toBe(Number.POSITIVE_INFINITY);
    expect(depthOf([n(1, 2), n(2, 1)], 1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('checkParent', () => {
  it('refuses self and descendants (no cycles)', () => {
    expect(checkParent(tree, 1, 1)).toBe('self_or_descendant');
    expect(checkParent(tree, 1, 4)).toBe('self_or_descendant');
    expect(checkParent(tree, 2, 4)).toBe('self_or_descendant');
  });
  it('refuses an unknown parent', () => {
    expect(checkParent(tree, null, 99)).toBe('unknown_parent');
  });
  it(`enforces ${MAX_DEPTH} levels, counting the moved subtree`, () => {
    expect(checkParent(tree, null, 2)).toBeNull(); // new node at level 3
    expect(checkParent(tree, null, 4)).toBe('depth_limit'); // level 4
    expect(checkParent(tree, 2, 5)).toBeNull(); // 5 > 2 > 4 = exactly 3 levels
    expect(checkParent(tree, 1, 5)).toBe('depth_limit'); // 5 > 1 > 2 > 4 = 4 levels
    expect(checkParent(tree, 3, 2)).toBeNull(); // 1 > 2 > 3
    expect(checkParent(tree, 2, 3)).toBe('depth_limit'); // 1 > 3 > 2 > 4
    expect(checkParent(tree, 3, 5)).toBeNull();
    expect(checkParent(tree, 4, null)).toBeNull(); // becomes a root
  });
  it('root placement is fine for any subtree within the limit', () => {
    expect(checkParent(tree, 1, null)).toBeNull();
  });
});

describe('parentChoices', () => {
  it('lists only valid parents for an existing node', () => {
    expect(parentChoices(tree, 2).map((o) => o.node.id)).toEqual([1, 5]);
    expect(parentChoices(tree, 1).map((o) => o.node.id)).toEqual([]);
    expect(parentChoices(tree, 3).map((o) => o.node.id)).toEqual([1, 2, 5]);
  });
  it('for a new node excludes nodes already at the maximum depth', () => {
    expect(parentChoices(tree, null).map((o) => o.node.id)).toEqual([1, 2, 3, 5]);
  });
});
