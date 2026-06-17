/**
 * Pure tree builder for the nested sidebar sub-page feature.
 *
 * The server returns a flat `ViewListRow[]` where each row carries a
 * `nestParentId` (parent page id, or `null` for a root) and a
 * `position` (order among siblings). This module folds that flat list
 * into a nested tree the sidebar renders recursively, and computes the
 * ancestor chain (breadcrumb) for any active page.
 *
 * Everything here is pure + DOM-free so it can be unit-tested without
 * React (`src/lib/__tests__/sidebar-tree.test.ts`). The sidebar UI is a
 * thin renderer over these structures.
 *
 * Robustness contract (the sidebar must never crash on bad data):
 *  - Orphan rows — a `nestParentId` pointing at an id not present in
 *    the list — are surfaced as roots, never dropped.
 *  - Cycles — a row that is its own ancestor (A→B→A) — are broken: the
 *    cycle edge is dropped and the node attaches at root, so `buildTree`
 *    always terminates and every row appears exactly once.
 *  - `buildBreadcrumb` walks parent links with a visited-set guard so a
 *    corrupt cycle can't spin forever.
 *
 * [COMP:app-web/sidebar-tree]
 */

import type { NameOrigin, ViewEntity, ViewListRow, ViewType } from "@/lib/api/views";

/**
 * A node in the rendered tree. Carries the original row plus its
 * ordered `children`. `depth` is the 0-based nesting level (roots are
 * 0) — handy for the recursive renderer's indent without re-deriving it
 * per frame.
 */
export type TreeNode = {
  row: ViewListRow;
  children: TreeNode[];
  depth: number;
};

/**
 * One crumb in the breadcrumb ancestor chain. Carries enough to render the
 * Notion-style per-crumb icon: the user-chosen `icon` emoji, or `entity` +
 * `viewType` for the type-derived glyph fallback (`derivePageIcon`).
 */
export type Crumb = {
  id: string;
  name: string;
  icon: string | null;
  entity: ViewEntity;
  viewType: ViewType;
  /** Title provenance — a `'placeholder'` crumb shows the generic draft glyph. */
  nameOrigin: NameOrigin;
};

/**
 * Sort comparator for siblings: ascending `position`, then `updatedAt`
 * descending as a stable tiebreak (two rows colliding on the same
 * position is a server hiccup; newest-first keeps it deterministic),
 * then by id so the order is fully total.
 */
function compareSiblings(a: ViewListRow, b: ViewListRow): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.updatedAt !== b.updatedAt) {
    // Descending updatedAt — newer first.
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold a flat row list into an ordered nested tree.
 *
 * Returns the root nodes (rows whose `nestParentId` is `null`, plus any
 * orphan / cycle-broken rows promoted to root), each with recursively
 * ordered `children`.
 */
export function buildTree(rows: ViewListRow[]): TreeNode[] {
  const byId = new Map<string, ViewListRow>();
  for (const row of rows) byId.set(row.id, row);

  /**
   * Resolve the *effective* parent of a row, treating a missing parent
   * (orphan) or a self/cycle reference as "no parent" (root). The
   * cycle check walks up the chain from the candidate parent; if it
   * reaches `row.id` the edge would close a loop, so we cut it.
   */
  function effectiveParentId(row: ViewListRow): string | null {
    const parentId = row.nestParentId;
    if (parentId === null) return null;
    if (parentId === row.id) return null; // self-loop
    if (!byId.has(parentId)) return null; // orphan — parent not in list
    // Walk up from parentId looking for row.id (would form a cycle).
    const seen = new Set<string>([row.id]);
    let cursor: string | null = parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) return null; // cycle detected — cut this edge
      seen.add(cursor);
      const next: ViewListRow | undefined = byId.get(cursor);
      if (!next) break; // chain hit an orphan above — parent is still valid
      cursor = next.nestParentId;
    }
    return parentId;
  }

  // Pre-create a node per row so we can wire children by reference.
  const nodeById = new Map<string, TreeNode>();
  for (const row of rows) {
    nodeById.set(row.id, { row, children: [], depth: 0 });
  }

  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodeById.get(row.id)!;
    const parentId = effectiveParentId(row);
    if (parentId === null) {
      roots.push(node);
    } else {
      nodeById.get(parentId)!.children.push(node);
    }
  }

  // Sort each sibling group + stamp depth via a single DFS.
  function order(nodes: TreeNode[], depth: number) {
    nodes.sort((a, b) => compareSiblings(a.row, b.row));
    for (const n of nodes) {
      n.depth = depth;
      order(n.children, depth + 1);
    }
  }
  order(roots, 0);

  return roots;
}

/**
 * Ids of pages that live **inside a saved (Favorites) subtree** — some
 * ancestor up the `nest_parent_id` chain has `state === 'saved'`. Such a
 * page is *kept by ancestry*: being filed under a saved page **is** its
 * save, so the sidebar suppresses its draft "Save page" CTA / auto-prune
 * caption, and the server's `pruneExpiredDraftsSystem` worker spares it.
 *
 * The page's own state is irrelevant — only its ancestry. A saved page with
 * no saved ancestor (a Favorites root) is *not* in this set; it's already
 * saved and shows no draft affordances anyway.
 *
 * Keep this rule in lockstep with the prune worker's recursive-CTE
 * exclusion (`saved-views-store.ts` → `pruneExpiredDraftsSystem`): the
 * sidebar hiding a draft's Save CTA while the worker still prunes it would
 * be silent data loss. Cycle-safe via a per-walk visited guard (matches
 * `buildTree`).
 */
export function savedAncestorIds(rows: ViewListRow[]): Set<string> {
  const byId = new Map<string, ViewListRow>();
  for (const row of rows) byId.set(row.id, row);

  const kept = new Set<string>();
  for (const row of rows) {
    const seen = new Set<string>([row.id]);
    let cursor: string | null = row.nestParentId;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break; // orphan — chain ends without a saved ancestor
      if (parent.state === "saved") {
        kept.add(row.id);
        break;
      }
      cursor = parent.nestParentId;
    }
  }
  return kept;
}

/**
 * Compute the ancestor chain for `activeId`, ordered root → … → active
 * (the active page is the last crumb). Returns `[]` when `activeId` is
 * `null`, absent from `rows`, or itself a root with no parent that the
 * caller wants rendered — callers decide whether to show a single-crumb
 * trail (we include the active page itself so the breadcrumb always
 * ends on the current page name).
 *
 * Cycle-safe via a visited set: a corrupt parent loop stops at the
 * first repeat rather than spinning.
 */
export function buildBreadcrumb(
  rows: ViewListRow[],
  activeId: string | null,
): Crumb[] {
  if (!activeId) return [];
  const byId = new Map<string, ViewListRow>();
  for (const row of rows) byId.set(row.id, row);

  const start = byId.get(activeId);
  if (!start) return [];

  const chain: Crumb[] = [];
  const seen = new Set<string>();
  let cursor: ViewListRow | undefined = start;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    // Prepend so the final order is root → … → active.
    chain.unshift({
      id: cursor.id,
      name: cursor.name,
      icon: cursor.icon,
      entity: cursor.entity,
      viewType: cursor.viewType,
      nameOrigin: cursor.nameOrigin,
    });
    const parentId: string | null = cursor.nestParentId;
    if (parentId === null) break;
    cursor = byId.get(parentId);
  }
  return chain;
}
