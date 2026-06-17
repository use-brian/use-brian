"use client";

/**
 * Pure block-level operations for the block-action menu, each keyed on a
 * ProseMirror `pos` (the drag handle's target). Every mutation is a ProseMirror
 * transaction so y-prosemirror syncs it to every collaborator — never a REST
 * write-back (a parallel write path would fight the CRDT).
 *
 * Split out from the menu UI (`block-action-menu.tsx`) so the id-rewrite and the
 * chain dispatch can be unit-tested in app-web's node-only vitest.
 *
 * Each op re-reads the live node at `pos` rather than trusting a cached one: the
 * drag handle reports the target on hover, but a collaborator may have edited or
 * moved the block between hover and click — `getTarget()` is re-read at action
 * time and these ops bound-check `pos` against the live doc.
 *
 * [COMP:app-web/block-actions]
 */

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { isNodeRangeSelection } from "@tiptap/extension-node-range";
import { applyTurnInto, type TurnIntoKind } from "./turn-into-menu";
import { newBlockId } from "@/lib/api/views";

/** The drag-handle's current target: a top-level node + its doc position. */
export type BlockTarget = { node: PMNode; pos: number };

/** Re-read the live node that STARTS at `pos`, or null if `pos` no longer
 *  addresses one (a collaborator deleted/moved the block). */
function nodeAt(editor: Editor, pos: number): PMNode | null {
  if (pos < 0 || pos >= editor.state.doc.content.size) return null;
  return editor.state.doc.nodeAt(pos);
}

/** Resolve the live position of the block carrying `blockId`, or null if it's
 *  gone. Used to re-target an action after an `await` (e.g. Delete's confirm),
 *  where a concurrent edit may have shifted positions. */
export function findBlockPos(editor: Editor, blockId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.attrs.blockId === blockId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** Whether a block can host an inline caret/selection (Turn into / Comment).
 *  Atoms — `data`/`chart`/`image`/`file`/`bookmark` embeds and the divider —
 *  cannot, so those actions are hidden for them. */
export function canHoldCaret(node: PMNode): boolean {
  return !node.isAtom;
}

/**
 * TURN INTO — convert the block at `pos` to `kind`.
 *
 * Two paths, by what the source block is:
 *   - **Textblock** (paragraph / heading / code): drop the caret in and reuse
 *     the selection-based `applyTurnInto` — its built-in commands convert the
 *     block at the caret in place, preserving the text. (`pos + 1` must land in
 *     a textblock, not a container's first child, which is why the menu only
 *     offers Turn-into for textblocks + embeds, never bare containers.)
 *   - **Embed atom** (chart / diagram / data / image / file / …): an atom has
 *     no inner text to convert, so this is a structural swap. The two CONTAINER
 *     targets WRAP the embed (non-destructive — the embed survives inside a new
 *     callout/toggle); every TEXTBLOCK target REPLACES the embed with an empty
 *     block of that kind (Notion's own media→text behaviour — the embed is
 *     dropped). There is no undo manager in the collab editor, so a replace is
 *     permanent; this is an explicit, user-chosen menu action.
 *
 * Containers (callout / toggle / list wrappers) aren't offered Turn-into and
 * return false rather than risk converting a child.
 */
export function applyTurnIntoAt(
  editor: Editor,
  pos: number,
  kind: TurnIntoKind,
): boolean {
  const node = nodeAt(editor, pos);
  if (!node) return false;

  if (node.isTextblock) {
    editor.chain().setTextSelection(pos + 1).run();
    return applyTurnInto(editor, kind);
  }

  if (node.type.name === "embed") {
    // Non-destructive: wrap the embed in the container target.
    if (kind === "callout" || kind === "toggle") {
      return editor.chain().setNodeSelection(pos).wrapIn(kind).run();
    }
    // Destructive: replace the atom with an empty paragraph, drop the caret in,
    // then reuse the in-place conversion for the non-paragraph targets.
    const replaced = editor
      .chain()
      .insertContentAt({ from: pos, to: pos + node.nodeSize }, { type: "paragraph" })
      .setTextSelection(pos + 1)
      .run();
    if (!replaced) return false;
    return kind === "paragraph" ? true : applyTurnInto(editor, kind);
  }

  return false;
}

/** DELETE — remove the whole node at `pos` (children included). */
export function deleteBlockAt(editor: Editor, pos: number): boolean {
  const node = nodeAt(editor, pos);
  if (!node) return false;
  const tr = editor.state.tr.delete(pos, pos + node.nodeSize);
  editor.view.dispatch(tr);
  return true;
}

/**
 * DELETE for the drag-handle's menu (and any handle-driven delete): when a
 * multi-block AREA selection (`NodeRangeSelection`) is active and the handle's
 * target block sits inside it, remove the WHOLE selection — Notion's rule that
 * deleting any one of a set of selected blocks deletes all of them. Otherwise
 * fall back to deleting just the single block at `pos`.
 *
 * Without this, opening the handle on one of several area-selected blocks and
 * hitting Delete removed only that block, leaving the rest of the selection
 * behind ("the delete button doesn't delete everything"). The keyboard path
 * already deletes the whole `NodeRangeSelection` through the editor's default
 * keymap; this brings the menu action to parity.
 */
export function deleteBlockSelectionOrAt(editor: Editor, pos: number): boolean {
  const sel = editor.state.selection;
  if (isNodeRangeSelection(sel) && sel.from <= pos && pos < sel.to) {
    editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView());
    return true;
  }
  return deleteBlockAt(editor, pos);
}

type NodeJSON = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: NodeJSON[];
  [k: string]: unknown;
};

/**
 * Recursively re-mint every `blockId` in a node-JSON tree so a duplicate can't
 * collide ids with the original. `embed` atoms carry the SAME id twice — the
 * global `blockId` attr AND an `id` inside the `block` JSON-string attr (set
 * equal at creation) — so both move in lockstep, else the clone's data binding
 * / comment anchor resolves to the original. List/task/callout/toggle children
 * carry their own `blockId` too, hence the recursion over `content`.
 *
 * Pure (JSON → JSON) so it's directly unit-testable.
 */
export function remintBlockIds(json: NodeJSON): NodeJSON {
  const next: NodeJSON = { ...json };
  if (json.attrs) {
    const attrs = { ...json.attrs };
    if (typeof attrs.blockId === "string") {
      const fresh = newBlockId();
      attrs.blockId = fresh;
      if (json.type === "embed" && typeof attrs.block === "string") {
        try {
          const parsed = JSON.parse(attrs.block) as { id?: string };
          parsed.id = fresh;
          attrs.block = JSON.stringify(parsed);
        } catch {
          /* malformed block attr — leave it as-is rather than throw */
        }
      }
    }
    next.attrs = attrs;
  }
  if (Array.isArray(json.content)) {
    next.content = json.content.map(remintBlockIds);
  }
  return next;
}

/** DUPLICATE — clone the block at `pos` with fresh ids, insert immediately
 *  after it at the same (top) level. */
export function duplicateBlockAt(editor: Editor, pos: number): boolean {
  const node = nodeAt(editor, pos);
  if (!node) return false;
  const clone = remintBlockIds(node.toJSON() as NodeJSON);
  return editor
    .chain()
    .insertContentAt(pos + node.nodeSize, clone as Record<string, unknown>, {
      updateSelection: false,
    })
    .run();
}

/**
 * Ensure the block at `pos` carries a stable `blockId`, minting + stamping one
 * via a PM transaction when absent (plain text blocks default to `null`). The
 * stamp rides y-prosemirror to peers so the deep link resolves everywhere.
 * Returns the id, or null if `pos` is invalid.
 */
export function ensureBlockId(editor: Editor, pos: number): string | null {
  const node = nodeAt(editor, pos);
  if (!node) return null;
  const existing = node.attrs.blockId as string | null;
  if (existing) return existing;
  const id = newBlockId();
  const tr = editor.state.tr.setNodeAttribute(pos, "blockId", id);
  // No undo manager in the collab editor; keep the stamp out of any history.
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  // `computeAttrs` silently drops an attr a node type doesn't declare — verify
  // the stamp actually stuck rather than hand back a dead id (so Copy-link can
  // bail instead of producing a deep link that resolves to nothing).
  return (nodeAt(editor, pos)?.attrs.blockId as string | null) ?? null;
}

/**
 * COLOR — set or clear the whole-block text color / background tint. Merges
 * onto existing attrs (preserving blockId / variant / level / language) via
 * `setNodeMarkup` at the exact `pos`. A `null` value clears that field.
 */
export function setBlockColor(
  editor: Editor,
  pos: number,
  field: "color" | "bgColor",
  value: string | null,
): boolean {
  const node = nodeAt(editor, pos);
  if (!node) return false;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    [field]: value,
  });
  editor.view.dispatch(tr);
  return true;
}

/** Clear both text + background color on the block at `pos`. */
export function clearBlockColor(editor: Editor, pos: number): boolean {
  const node = nodeAt(editor, pos);
  if (!node) return false;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    color: null,
    bgColor: null,
  });
  editor.view.dispatch(tr);
  return true;
}

/**
 * Select the block's inner text range so the selection-based comment flow
 * (`collab-page-editor`'s `onComment`) anchors a thread to it. Returns false for
 * an empty or atom block (nothing to quote or mark).
 */
export function selectBlockText(editor: Editor, pos: number): boolean {
  const node = nodeAt(editor, pos);
  if (!node || !canHoldCaret(node)) return false;
  const from = pos + 1;
  const to = pos + node.nodeSize - 1;
  if (to <= from) return false;
  editor.chain().setTextSelection({ from, to }).run();
  return true;
}
