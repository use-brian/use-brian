"use client";

/**
 * The browser editor's Tiptap extension list. Built from the SHARED schema in
 * `@sidanclaw/doc-model` (so the editor and the Yjs server agree byte-for-byte)
 * with React node-views layered onto the custom nodes via `.extend()` — which
 * adds rendering only, leaving the schema identical so collaboration stays in
 * sync.
 *
 * The `personMention` / `pageMention` nodes are intentionally **dropped** here:
 * the editor re-adds them via the behaviour-bearing mention extensions
 * (`createPersonMentionExtension` / `createPageMentionExtension`, which
 * `.extend()` the same shared nodes with the `@` Suggestion plugin). Leaving
 * the bare nodes in this list too would register `personMention` twice and
 * Tiptap throws on the duplicate. The node *spec* is identical either way, so
 * the derived schema the Yjs server builds stays byte-for-byte matched.
 *
 * [COMP:app-web/doc-schema]
 */

import { docExtensions } from "@sidanclaw/doc-model";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { AnyExtension } from "@tiptap/core";
import { NodeRange } from "@tiptap/extension-node-range";
import { EmbedView } from "./node-views/embed-view";
import { CalloutView } from "./node-views/callout-view";
import { ToggleView } from "./node-views/toggle-view";
import { TableView } from "./node-views/table-view";
import { BlockIndent } from "./block-indent";
import { ListNormalizer } from "./list-normalizer";
import { BlockAreaSelect } from "./block-area-select";
import { DocMediaPaste } from "./doc-media-paste";
import { SmartArrows } from "./smart-arrows";

/** Node names the editor owns via the mention extensions, not the base list. */
const MENTION_NODE_NAMES = new Set(["personMention", "pageMention"]);

/**
 * @param opts.workspaceId scopes paste/drag-drop media uploads to the durable
 *   `/api/doc-files` endpoint. Omitted by the node-only unit-test editors —
 *   the paste extension then no-ops, leaving normal text/HTML paste untouched.
 */
export function browserDocExtensions(opts?: { workspaceId?: string }): AnyExtension[] {
  const mapped = docExtensions()
    .filter((ext) => !MENTION_NODE_NAMES.has(ext.name))
    .map((ext) => {
      switch (ext.name) {
        case "embed":
          // The embed wraps a fully-interactive A2UI widget (inline cell
          // editors, filter/sort/group, add-row, board card DnD). Two
          // editor-behaviour overrides let that widget own its pointer events:
          //   - `stopEvent: () => true` — ProseMirror ignores every event
          //     inside the node-view, so a click lands on the cell editor
          //     instead of being captured as an atom NodeSelection (the
          //     "select the whole block" teal ring that made it un-editable).
          //   - `draggable: false` — no native HTML5 block-drag stealing
          //     mousedowns from the widget's own row controls.
          // Neither touches the synced node spec (type/attrs/content), so the
          // Yjs server's derived schema stays byte-for-byte identical.
          return ext.extend({
            draggable: false,
            addNodeView: () =>
              ReactNodeViewRenderer(EmbedView, { stopEvent: () => true }),
          });
        case "callout":
          return ext.extend({ addNodeView: () => ReactNodeViewRenderer(CalloutView) });
        case "table":
          // Rendering-only node-view (the hover row/column control bar). The
          // node spec is untouched, so the server-derived schema stays
          // byte-for-byte identical — table cells remain ProseMirror-managed
          // CRDT nodes; only the surrounding chrome is React.
          return ext.extend({ addNodeView: () => ReactNodeViewRenderer(TableView) });
        case "toggle":
          // `stopEvent` scoped to the chevron: ProseMirror ignores pointer
          // events that originate on the disclosure button, so its React
          // `onClick`/`onMouseDown` reliably flips `open` instead of PM
          // swallowing the mousedown as a node-selection (which left the
          // toggle un-collapsible). Events inside the editable summary/body
          // fall through to PM as normal — only the chevron is intercepted.
          return ext.extend({
            addNodeView: () =>
              ReactNodeViewRenderer(ToggleView, {
                stopEvent: ({ event }) =>
                  !!(event.target as HTMLElement | null)?.closest?.(
                    ".doc-toggle-chevron",
                  ),
              }),
          });
        default:
          return ext;
      }
    });
  // Tab / Shift-Tab block nesting rides on top of the schema (browser-only
  // keymap, no node/mark changes — the Yjs contract is untouched).
  //
  // Notion-style **multi-block area-select**. `BlockAreaSelect` drives the
  // gesture from pointer coords (drag from ANY area; the highlight updates LIVE
  // as it crosses blocks — see its module note on why the native-text-drag path
  // wasn't enough). `NodeRange` is kept as the supporting layer — the
  // `NodeRangeSelection` class, the full-width `.ProseMirror-selectednoderange`
  // decorations (globals.css), and the Shift-↑/↓ + Mod-A keyboard — but with
  // `key: 'Mod'` so ITS own plain-drag mousedown doesn't double-drive the
  // gesture (BlockAreaSelect owns plain drag; Cmd-drag falls through to it).
  // All three are interaction/selection only — no node/mark schema change, so
  // Yjs parity holds; the drag-move (via the grip) is gated by `editable`.
  return [
    ...mapped,
    BlockIndent,
    // Keep consecutive same-kind list items in ONE list after every local edit,
    // so native Tab/Shift-Tab/drag produce correct nesting + spacing instead of a
    // stack of one-item sibling wrappers (browser-only appendTransaction, no
    // schema change — Yjs parity holds).
    ListNormalizer,
    NodeRange.configure({ key: "Mod" }),
    BlockAreaSelect,
    // Paste / drag-drop of image + file media → durable `/api/doc-files`
    // upload + embed insert. No-ops without a workspaceId (test editors).
    DocMediaPaste.configure({ workspaceId: opts?.workspaceId }),
    // Notion-style smart arrows: typing `->`/`<-` becomes `→`/`←`. Pure text
    // input rule — no node/mark schema change, so Yjs parity holds.
    SmartArrows,
  ];
}
