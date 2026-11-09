"use client";

// [COMP:app-web/block-selection-clipboard]
/**
 * Copy and cut for a multi-block area selection (`NodeRangeSelection`).
 *
 * The area-select gesture clears the DOM selection on purpose: a
 * `NodeRangeSelection` is `visible: false`, and leaving a native range up lets
 * the browser re-extend it and clobber the block band. Delete and Backspace
 * still work because they read ProseMirror state. Copy and cut do not: the
 * browser only fires those clipboard events when a DOM range exists, so
 * Command+X on a selected stack of blocks did nothing.
 *
 * `Mod-c` / `Mod-x` (Cmd on macOS, Ctrl elsewhere) serialize the selection with
 * the editor's own clipboard serializer, the same `data-pm-slice` HTML a text
 * copy produces, and write it from the keydown. Paste is the editor's existing
 * paste path, so the blocks land at whatever caret the user puts down next.
 * Cut deletes the range only after the clipboard write has succeeded.
 *
 * A text selection returns false and stays with the browser. The shortcut never
 * calls `view.focus()` and never writes a DOM range back over the editor, so it
 * cannot re-seed the selection the gesture suppressed.
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { isNodeRangeSelection, NodeRangeSelection } from "@tiptap/extension-node-range";
import { remintBlockIds } from "./block-actions";

export type BlockClipboardPayload = { html: string; text: string };

export type BlockClipboardWriter = (payload: BlockClipboardPayload) => boolean;

/** Rebuild a slice with fresh `blockId`s so a copy can be pasted beside the
 *  original. Drawings are left to `transformCopied`, which projects live
 *  geometry and rewrites their id in lockstep. */
function remintSlice(view: EditorView, slice: Slice): Slice {
  const nodes: PMNode[] = [];
  slice.content.forEach((node) => {
    const json = remintBlockIds(node.toJSON());
    nodes.push(view.state.schema.nodeFromJSON(json));
  });
  return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd);
}

/** The clipboard slice for this selection. Copy re-mints block ids after the
 *  drawing clipboard projection. Cut keeps ids so the paste is a move. */
function clipboardSlice(view: EditorView, cut: boolean): Slice {
  let slice = view.state.selection.content();
  if (cut) return slice;
  view.someProp("transformCopied", (transform) => {
    slice = transform(slice, view);
  });
  return remintSlice(view, slice);
}

/**
 * Put HTML + plain text on the clipboard from a keydown, where no copy/cut
 * event will fire. A selected textarea is what makes `execCommand("copy")`
 * emit the event; the listener replaces its plain text with the ProseMirror
 * slice. The textarea is not the editor, so this does not restore a DOM range
 * inside `.ProseMirror`.
 */
export function writeBlockClipboard(
  payload: BlockClipboardPayload,
  doc: Document = document,
): boolean {
  let wrote = false;
  const onCopy = (event: Event) => {
    const data = (event as ClipboardEvent).clipboardData;
    if (!data) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    data.setData("text/html", payload.html);
    data.setData("text/plain", payload.text);
    wrote = true;
  };
  doc.addEventListener("copy", onCopy, true);
  const sink = doc.createElement("textarea");
  sink.value = payload.text || " ";
  sink.setAttribute("readonly", "");
  sink.setAttribute("aria-hidden", "true");
  sink.tabIndex = -1;
  sink.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  const previous = doc.activeElement;
  try {
    doc.body.appendChild(sink);
    sink.focus({ preventScroll: true });
    sink.select();
    const commanded = doc.execCommand("copy");
    return Boolean(commanded && wrote);
  } catch {
    return false;
  } finally {
    sink.remove();
    doc.removeEventListener("copy", onCopy, true);
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus({ preventScroll: true });
    }
  }
}

function scheduleAsyncClipboardWrite(
  payload: BlockClipboardPayload,
  after: () => void,
): boolean {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip?.write || typeof ClipboardItem === "undefined") return false;
  const item = new ClipboardItem({
    "text/html": new Blob([payload.html], { type: "text/html" }),
    "text/plain": new Blob([payload.text], { type: "text/plain" }),
  });
  void clip.write([item]).then(after).catch(() => {
    /* permission denied or a vanished document: leave the blocks in place */
  });
  return true;
}

function removeNodeRange(view: EditorView, from: number, to: number): void {
  const { state } = view;
  let tr = state.tr;
  const sel = state.selection;
  if (!isNodeRangeSelection(sel) || sel.from !== from || sel.to !== to) {
    tr = tr.setSelection(NodeRangeSelection.create(state.doc, from, to));
  }
  view.dispatch(tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
}

/**
 * Copy or cut the active block selection. Returns false when there is nothing
 * for this shortcut to claim (a caret or a text selection, or a cut while the
 * editor is read-only) so the browser's own shortcut still runs.
 *
 * `write` is the clipboard port. Tests pass a stub. The default writes
 * synchronously, and falls back to the async Clipboard API only when that
 * fails. A cut deletes the range only after a write succeeds.
 */
export function copyBlockSelection(
  editor: Editor,
  cut: boolean,
  write: BlockClipboardWriter = writeBlockClipboard,
): boolean {
  const { view } = editor;
  const sel = view.state.selection;
  if (!isNodeRangeSelection(sel) || sel.empty) return false;
  if (cut && !view.editable) return false;

  const from = sel.from;
  const to = sel.to;
  const fingerprint = view.state.doc.textBetween(from, to, "\n");
  // serializeForClipboard applies `transformCopied` (live drawing geometry).
  // On a copy the slice is already projected and re-minted, so the second
  // pass keeps that snapshot. On a cut the original ids stay, except a
  // drawing, which the projection gives a new id and its live scene.
  const serialized = view.serializeForClipboard(clipboardSlice(view, cut));
  const payload: BlockClipboardPayload = {
    html: serialized.dom.innerHTML,
    text: serialized.text,
  };

  const remove = () => {
    const doc = view.state.doc;
    if (to > doc.content.size) return;
    if (doc.textBetween(from, to, "\n") !== fingerprint) return;
    removeNodeRange(view, from, to);
    view.dom.focus({ preventScroll: true });
  };

  if (write(payload)) {
    if (cut) remove();
    else view.dom.focus({ preventScroll: true });
    return true;
  }
  if (scheduleAsyncClipboardWrite(payload, () => {
    if (cut) remove();
  })) {
    return true;
  }
  return false;
}

export const BlockSelectionClipboard = Extension.create({
  name: "blockSelectionClipboard",
  addKeyboardShortcuts() {
    return {
      "Mod-c": ({ editor }) => copyBlockSelection(editor, false),
      "Mod-x": ({ editor }) => copyBlockSelection(editor, true),
    };
  },
});
