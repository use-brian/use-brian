"use client";

/**
 * Paste / drag-drop of image + file media into the page editor.
 *
 * Notion's "drop a file / paste a screenshot" gesture. ProseMirror's
 * `handlePaste` / `handleDrop` are synchronous (they return a boolean to claim
 * the event), so when a paste/drop carries files we claim it and insert an
 * EMPTY media block (`image` for `image/*`, else `file`) at the cursor / drop
 * position IMMEDIATELY — the placeholder shows the instant the file lands. The
 * raw bytes are handed to that block through the in-memory `doc-media-uploads`
 * registry (keyed by the new block id); the mounted `BlockImage` / `BlockFile`
 * claims it and runs the SAME durable upload its picker uses, so the
 * "Uploading…" → filled (or inline-error) feedback renders ON THE BLOCK. One
 * upload code path, one error surface — the extension never uploads itself.
 *
 * While a file drag hovers the editor, a `.doc-drag-over` class is toggled on
 * the editor DOM (a soft drop-target ring; see `globals.css`). Only file drags
 * arm it — dragging blocks around (the editor's own reorder DnD) never does.
 *
 * The extension no-ops without a `workspaceId` (e.g. the node-only unit-test
 * editors that build `browserDocExtensions()` with no options) — a paste with
 * no files always falls through to ProseMirror's normal text/HTML handling.
 *
 * [COMP:app-web/media-paste]
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { FileRef } from "@/lib/api/views";
import { queueMediaUpload } from "./doc-media-uploads";

const mediaPasteKey = new PluginKey("docMediaPaste");

export type DocMediaPasteOptions = {
  /** Active workspace; scopes the durable upload + read. Undefined → no-op. */
  workspaceId?: string;
};

/** Map a MIME type to the block kind its bytes should render as. */
export function mediaKindForMime(mime: string): "image" | "file" {
  return mime.startsWith("image/") ? "image" : "file";
}

/** Mint a stable block id for an inserted node (mirrors slash-execute). */
function newBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * The schema-valid embed insertion JSON for a RESOLVED media file (`ref`
 * already uploaded). Pure + exported so the kind/ref encoding stays
 * unit-testable and matches `slash-execute.ts`'s `insertEmbed` — the shape the
 * `EmbedView` parses so it round-trips through Yjs and renders.
 */
export function buildMediaEmbedContent(
  ref: FileRef,
  id: string = newBlockId(),
): { type: "embed"; attrs: { blockId: string; block: string } } {
  const kind = mediaKindForMime(ref.mimeType);
  return {
    type: "embed",
    attrs: { blockId: id, block: JSON.stringify({ kind, id, ref }) },
  };
}

/**
 * The embed insertion JSON for an EMPTY media placeholder (`ref: null`) — the
 * drop/paste path inserts this immediately, then the mounted block uploads its
 * queued file and patches the `ref` in. Pure + exported for unit testing.
 */
export function buildEmptyMediaEmbedContent(
  kind: "image" | "file",
  id: string = newBlockId(),
): { type: "embed"; attrs: { blockId: string; block: string } } {
  return {
    type: "embed",
    attrs: { blockId: id, block: JSON.stringify({ kind, id, ref: null }) },
  };
}

/** Collect every File carried by a clipboard / drag DataTransfer. */
function filesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []);
}

/** True when a drag carries files (vs the editor's own block-reorder drag). */
function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes("Files");
}

/**
 * Insert an empty media block per file at `startPos` and queue the raw bytes
 * for that block to upload on mount, advancing past each inserted atom so
 * multiple files stack in order.
 */
function insertAndQueue(editor: Editor, files: File[], startPos: number): void {
  let pos = startPos;
  for (const file of files) {
    const id = newBlockId();
    queueMediaUpload(id, file);
    editor
      .chain()
      .insertContentAt(pos, buildEmptyMediaEmbedContent(mediaKindForMime(file.type), id))
      .run();
    // The embed is an atom (nodeSize 1); the selection lands just after it, so
    // the next file stacks below.
    pos = editor.state.selection.to;
  }
}

/**
 * Tiptap extension wiring `handlePaste` / `handleDrop` to the durable upload.
 * Add it to `browserDocExtensions({ workspaceId })`; configure with the active
 * workspace so the upload is correctly scoped.
 */
export const DocMediaPaste = Extension.create<DocMediaPasteOptions>({
  name: "docMediaPaste",

  addOptions() {
    return { workspaceId: undefined };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const getWorkspaceId = (): string | undefined => this.options.workspaceId;

    return [
      new Plugin({
        key: mediaPasteKey,
        props: {
          handlePaste: (_view, event) => {
            if (!getWorkspaceId()) return false;
            const files = filesFrom(event.clipboardData);
            // No files → let ProseMirror handle text/HTML paste normally.
            if (files.length === 0) return false;
            event.preventDefault();
            insertAndQueue(editor, files, editor.state.selection.from);
            return true;
          },
          handleDrop: (view, event) => {
            if (!getWorkspaceId()) return false;
            const files = filesFrom(event.dataTransfer);
            // No files → defer to the block-reorder drag handler.
            if (files.length === 0) return false;
            event.preventDefault();
            view.dom.classList.remove("doc-drag-over");
            const coords = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            });
            insertAndQueue(editor, files, coords?.pos ?? editor.state.selection.from);
            return true;
          },
          // Soft drop-target affordance — armed only for actual file drags so
          // dragging editor blocks around never lights it up.
          handleDOMEvents: {
            dragover: (view, event) => {
              if (!getWorkspaceId()) return false;
              if (!dragHasFiles((event as DragEvent).dataTransfer)) return false;
              view.dom.classList.add("doc-drag-over");
              return false;
            },
            dragleave: (view, event) => {
              // Ignore leaves into a descendant node (relatedTarget still inside
              // the editor) so the ring doesn't flicker block-to-block.
              const related = (event as DragEvent).relatedTarget as Node | null;
              if (related && view.dom.contains(related)) return false;
              view.dom.classList.remove("doc-drag-over");
              return false;
            },
            drop: (view) => {
              view.dom.classList.remove("doc-drag-over");
              return false;
            },
          },
        },
      }),
    ];
  },
});
