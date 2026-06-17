"use client";

// [COMP:app-web/list-normalizer]
/**
 * Keep consecutive same-kind list items in ONE list — the structural backbone
 * that makes native list editing behave, instead of per-case CSS/keymap patches.
 *
 * The block model (and `blocksToPMDoc`) treat consecutive same-kind list items
 * as a single list, but several edit paths leave the live doc with a list split
 * into adjacent one-item sibling wrappers:
 *   - the AI write path before the apply-ops grouping fix (legacy docs persist
 *     that shape in their CRDT),
 *   - `liftListItem` (Shift-Tab) on a nested row, which splits the parent list
 *     around the lifted row → `[ul[a]] [ul[b, c]]`,
 *   - a drag-drop that lands a row beside — not inside — a list.
 * Fragmented wrappers each carry the list's OUTER margin (rows drift apart) and
 * break the native list commands (`sinkListItem` finds no in-wrapper sibling),
 * so the symptoms are "Tab won't make a sub-bullet" and "Shift-Tab leaves the row
 * spaced like it's still indented".
 *
 * This normalizer joins every adjacent same-kind list-wrapper pair in ONE
 * transaction (recomputing the next join on the in-progress `tr.doc` until none
 * remain — convergent on finite lists). So a single local edit settles the doc
 * back to one-list-per-run, and native Tab/Shift-Tab/drag then produce correct
 * nesting and spacing with no special-casing downstream.
 *
 * **Local edits only** (`!isChangeOrigin`): a remote / AI change was already
 * normalized by its origin client; re-normalizing it here would let two clients
 * concurrently move the same item across wrappers and the CRDT could duplicate it
 * (the doc re-seed-duplication failure mode). Edit-gated too — a read-only
 * viewer must never mutate the shared doc. The join is `addToHistory: false` (an
 * automatic cleanup, never its own undo step). It does NOT fire on the initial
 * remote sync, so a legacy doc's wrappers stay separate until the first local
 * edit; the `globals.css` adjacent-wrapper margin collapse keeps that pre-edit
 * state rendering at one-list pitch so there's no visible snap when it merges.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { isChangeOrigin } from "@tiptap/extension-collaboration";

/** List wrappers that group consecutive same-kind items (mirrors `block-mapping`). */
const MERGEABLE_LISTS = new Set(["bulletList", "orderedList", "taskList"]);

/**
 * The position of the FIRST boundary between two adjacent same-kind list wrappers
 * (the argument to `tr.join`), or -1 when the doc has none. Searches every level
 * (top-level blocks + lists nested inside list items / containers). Pure, so it
 * unit-tests on a constructed doc.
 */
export function firstAdjacentListJoinPos(doc: PMNode): number {
  // `start` is the position just before `node`'s content; a non-leaf node's
  // content begins one past the node, and the doc's content begins at 0 (start = -1).
  const walk = (node: PMNode, start: number): number => {
    let childPos = start + 1;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (i < node.childCount - 1) {
        const next = node.child(i + 1);
        if (MERGEABLE_LISTS.has(child.type.name) && child.type === next.type) {
          return childPos + child.nodeSize; // the boundary between child & next
        }
      }
      const deep = walk(child, childPos);
      if (deep >= 0) return deep;
      childPos += child.nodeSize;
    }
    return -1;
  };
  return walk(doc, -1);
}

export const listNormalizerKey = new PluginKey("docListNormalizer");

export const ListNormalizer = Extension.create({
  name: "listNormalizer",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: listNormalizerKey,
        appendTransaction(transactions, _oldState, newState) {
          if (!editor?.isEditable) return null;
          // Only after a LOCAL doc change (see the module note on the CRDT race).
          if (!transactions.some((tr) => tr.docChanged && !isChangeOrigin(tr))) {
            return null;
          }
          let joinPos = firstAdjacentListJoinPos(newState.doc);
          if (joinPos < 0) return null;
          const tr = newState.tr;
          // Join every adjacent same-kind pair in this one transaction,
          // recomputing against the in-progress doc. The guard is a belt-and-
          // suspenders cap against an unexpected non-converging join.
          for (let guard = 0; joinPos >= 0 && guard < 500; guard += 1) {
            try {
              tr.join(joinPos);
            } catch {
              // A boundary the schema won't actually join (shouldn't happen for
              // same-type lists) — stop rather than throw out of appendTransaction.
              break;
            }
            joinPos = firstAdjacentListJoinPos(tr.doc);
          }
          if (!tr.docChanged) return null;
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});
