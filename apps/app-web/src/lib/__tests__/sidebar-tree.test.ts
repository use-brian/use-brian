/**
 * [COMP:app-web/sidebar-tree] Sidebar nested sub-page tree builder.
 *
 * Pure-logic tests for `buildTree` + `buildBreadcrumb` — the flat
 * `ViewListRow[]` → nested tree fold that drives the Notion-style
 * sub-page sidebar. Exercises nesting depth, sibling ordering by
 * `position`, orphan promotion, self/cycle safety, and the breadcrumb
 * ancestor chain.
 *
 * Spec: docs/architecture/features/doc.md (nested sub-pages) +
 * src/lib/sidebar-tree.ts header.
 */

import { describe, expect, it } from "vitest";
import {
  buildBreadcrumb,
  buildTree,
  savedAncestorIds,
  type TreeNode,
} from "../sidebar-tree";
import type { ViewListRow } from "../api/views";

/** Minimal row factory — only the fields the tree cares about matter. */
function row(
  id: string,
  opts: {
    nestParentId?: string | null;
    position?: number;
    name?: string;
    updatedAt?: string;
    state?: "draft" | "saved";
  } = {},
): ViewListRow {
  return {
    id,
    workspaceId: "ws1",
    name: opts.name ?? id,
    nameOrigin: "user",
    description: null,
    entity: "tasks",
    viewType: "table",
    state: opts.state ?? "saved",
    updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00.000Z",
    nestParentId: opts.nestParentId ?? null,
    position: opts.position ?? 0,
    icon: null,
  };
}

/** Flatten a tree to `id` strings in DFS pre-order — easy to assert on. */
function flatten(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.row.id);
    out.push(...flatten(n.children));
  }
  return out;
}

describe("[COMP:app-web/sidebar-tree] buildTree", () => {
  it("returns roots for a flat list with no nesting", () => {
    const tree = buildTree([
      row("a", { position: 0 }),
      row("b", { position: 1 }),
      row("c", { position: 2 }),
    ]);
    expect(tree.map((n) => n.row.id)).toEqual(["a", "b", "c"]);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
    expect(tree.every((n) => n.depth === 0)).toBe(true);
  });

  it("nests children under their parent and stamps depth", () => {
    const tree = buildTree([
      row("root"),
      row("child", { nestParentId: "root" }),
      row("grandchild", { nestParentId: "child" }),
    ]);
    expect(tree).toHaveLength(1);
    const rootNode = tree[0];
    expect(rootNode.row.id).toBe("root");
    expect(rootNode.depth).toBe(0);
    expect(rootNode.children).toHaveLength(1);

    const childNode = rootNode.children[0];
    expect(childNode.row.id).toBe("child");
    expect(childNode.depth).toBe(1);
    expect(childNode.children).toHaveLength(1);

    const grandchild = childNode.children[0];
    expect(grandchild.row.id).toBe("grandchild");
    expect(grandchild.depth).toBe(2);
  });

  it("orders siblings by ascending position", () => {
    const tree = buildTree([
      row("p"),
      row("third", { nestParentId: "p", position: 2 }),
      row("first", { nestParentId: "p", position: 0 }),
      row("second", { nestParentId: "p", position: 1 }),
    ]);
    const children = tree[0].children.map((n) => n.row.id);
    expect(children).toEqual(["first", "second", "third"]);
  });

  it("breaks ties on equal position by updatedAt desc then id", () => {
    const tree = buildTree([
      row("older", { position: 0, updatedAt: "2026-01-01T00:00:00.000Z" }),
      row("newer", { position: 0, updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    // Same position → newer first.
    expect(tree.map((n) => n.row.id)).toEqual(["newer", "older"]);
  });

  it("promotes an orphan (parent id absent from the list) to root", () => {
    const tree = buildTree([
      row("a"),
      row("orphan", { nestParentId: "ghost-id-not-present" }),
    ]);
    const ids = tree.map((n) => n.row.id).sort();
    expect(ids).toEqual(["a", "orphan"]);
    // Orphan is a root, not dropped.
    expect(flatten(tree)).toContain("orphan");
  });

  it("treats a self-referential parent as a root (no infinite loop)", () => {
    const tree = buildTree([row("self", { nestParentId: "self" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].row.id).toBe("self");
    expect(tree[0].children).toHaveLength(0);
  });

  it("breaks a two-node cycle and keeps every row exactly once", () => {
    // a → b → a. The builder must terminate and surface both rows.
    const tree = buildTree([
      row("a", { nestParentId: "b" }),
      row("b", { nestParentId: "a" }),
    ]);
    const flat = flatten(tree).sort();
    expect(flat).toEqual(["a", "b"]);
    // Each appears exactly once across the whole tree.
    expect(flatten(tree)).toHaveLength(2);
  });

  it("keeps a valid deep chain even when it sits above an orphan", () => {
    // grandchild → child → root(orphan parent). root is promoted; the
    // deep chain below it stays intact.
    const tree = buildTree([
      row("root", { nestParentId: "ghost" }),
      row("child", { nestParentId: "root" }),
      row("grandchild", { nestParentId: "child" }),
    ]);
    expect(flatten(tree)).toEqual(["root", "child", "grandchild"]);
  });

  it("handles an empty list", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("[COMP:app-web/sidebar-tree] buildBreadcrumb", () => {
  const rows = [
    row("root", { name: "Root" }),
    row("mid", { nestParentId: "root", name: "Mid" }),
    row("leaf", { nestParentId: "mid", name: "Leaf" }),
    row("other", { name: "Other" }),
  ];

  it("returns the full root → active chain", () => {
    const crumbs = buildBreadcrumb(rows, "leaf");
    expect(crumbs.map((c) => c.id)).toEqual(["root", "mid", "leaf"]);
    expect(crumbs.map((c) => c.name)).toEqual(["Root", "Mid", "Leaf"]);
  });

  it("returns a single crumb for a root-level active page", () => {
    const crumbs = buildBreadcrumb(rows, "other");
    expect(crumbs.map((c) => c.id)).toEqual(["other"]);
  });

  it("returns [] for a null active id", () => {
    expect(buildBreadcrumb(rows, null)).toEqual([]);
  });

  it("returns [] when the active id is not in the list", () => {
    expect(buildBreadcrumb(rows, "nope")).toEqual([]);
  });

  it("is cycle-safe — a corrupt parent loop does not hang", () => {
    const cyclic = [
      row("x", { nestParentId: "y" }),
      row("y", { nestParentId: "x" }),
    ];
    const crumbs = buildBreadcrumb(cyclic, "x");
    // Stops at the first repeat; every id appears at most once.
    const ids = crumbs.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("x");
  });
});

describe("[COMP:app-web/sidebar-tree] savedAncestorIds", () => {
  it("flags a draft child of a saved parent (kept by ancestry)", () => {
    const kept = savedAncestorIds([
      row("parent", { state: "saved" }),
      row("child", { state: "draft", nestParentId: "parent" }),
    ]);
    expect(kept.has("child")).toBe(true);
    // The saved root itself has no saved *ancestor* — it is not in the set.
    expect(kept.has("parent")).toBe(false);
  });

  it("flags a deep descendant through a draft link (any saved ancestor)", () => {
    // saved grandparent → draft parent → draft grandchild. The grandchild's
    // chain still reaches a saved ancestor, so both descendants are kept.
    const kept = savedAncestorIds([
      row("gp", { state: "saved" }),
      row("p", { state: "draft", nestParentId: "gp" }),
      row("gc", { state: "draft", nestParentId: "p" }),
    ]);
    expect(kept.has("p")).toBe(true);
    expect(kept.has("gc")).toBe(true);
  });

  it("does not flag drafts under a draft root (no saved ancestor)", () => {
    const kept = savedAncestorIds([
      row("draftRoot", { state: "draft" }),
      row("draftChild", { state: "draft", nestParentId: "draftRoot" }),
    ]);
    expect(kept.size).toBe(0);
  });

  it("does not flag a root-level draft (no parent at all)", () => {
    const kept = savedAncestorIds([row("lonely", { state: "draft" })]);
    expect(kept.has("lonely")).toBe(false);
  });

  it("does not flag a draft whose parent is missing (orphan chain ends)", () => {
    const kept = savedAncestorIds([
      row("orphan", { state: "draft", nestParentId: "ghost" }),
    ]);
    expect(kept.has("orphan")).toBe(false);
  });

  it("is cycle-safe — a corrupt parent loop terminates", () => {
    // Neither node is saved; the walk must stop at the first repeat.
    const kept = savedAncestorIds([
      row("x", { state: "draft", nestParentId: "y" }),
      row("y", { state: "draft", nestParentId: "x" }),
    ]);
    expect(kept.size).toBe(0);
  });
});
