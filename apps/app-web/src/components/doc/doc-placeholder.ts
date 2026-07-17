/**
 * Empty-line placeholder for the collaborative editor.
 *
 * Renders Notion's "Press 'space' for AI or '/' for commands" hint on the
 * current EMPTY paragraph (the line the cursor is on), and a quieter
 * type-specific hint on empty headings. Pairs with `ai-space-trigger.ts`
 * (Space → AI) and the slash menu (`/` → commands).
 *
 * This is a BROWSER-ONLY decoration plugin (Tiptap's `@tiptap/extension-
 * placeholder` paints a `::before` pseudo-element via the `is-empty` class +
 * `data-placeholder` attr — see `globals.css`). It contributes no nodes or
 * marks, so it never touches the byte-for-byte Yjs schema parity the shared
 * `@use-brian/doc-model` schema guards — which is exactly why it lives here
 * and not in the shared package.
 *
 * `placeholderTextFor` is exported for unit testing (app-web's vitest is
 * node-only, no DOM).
 *
 * [COMP:app-web/doc-placeholder]
 */

import Placeholder from "@tiptap/extension-placeholder";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export type DocPlaceholderText = {
  /** The empty-paragraph hint, e.g. "Press 'space' for AI or '/' for commands". */
  aiHint: string;
  /** The empty-heading hint, e.g. "Heading". */
  heading: string;
};

/**
 * Resolve the placeholder string for a node type. The AI hint shows on empty
 * paragraphs; empty headings get a short "Heading" cue; everything else
 * (lists, quotes, callouts, code) shows nothing — Notion keeps those blank.
 */
export function placeholderTextFor(
  nodeTypeName: string,
  text: DocPlaceholderText,
): string {
  if (nodeTypeName === "paragraph") return text.aiHint;
  if (nodeTypeName === "heading") return text.heading;
  return "";
}

/**
 * Build the placeholder extension. `showOnlyCurrent` (the default) means the
 * hint paints only on the node the cursor is in — so an empty doc shows one
 * hint on the active line, not on every blank block.
 */
export function createDocPlaceholderExtension(text: DocPlaceholderText) {
  return Placeholder.configure({
    includeChildren: false,
    showOnlyCurrent: true,
    placeholder: ({ node }) => placeholderTextFor(node.type.name, text),
  });
}

/**
 * Empty toggle summaries that should carry a persistent placeholder.
 *
 * A toggle's first child is its summary line. When that line is an empty
 * textblock the toggle renders as a bare chevron floating in space (see
 * `node-views/toggle-view.tsx`) — and the global `Placeholder` above never
 * fixes it, because `includeChildren: false` means it never descends into the
 * toggle to decorate the nested summary. This scanner finds those summaries so
 * a dedicated, always-on decoration can label them; pure (takes a doc, returns
 * ranges) so the node-only vitest can pin it without a DOM.
 *
 * Only the *first* child counts (a toggle whose summary is itself a nested
 * toggle has no empty text line to hint), and only when it's an empty
 * textblock — a summary with real content needs no placeholder.
 */
export function emptyToggleSummaryRanges(doc: PMNode): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  doc.descendants((node, pos, parent) => {
    if (
      parent?.type.name === "toggle" &&
      parent.firstChild === node &&
      node.isTextblock &&
      node.content.size === 0
    ) {
      ranges.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  return ranges;
}

const toggleSummaryPlaceholderKey = new PluginKey("docToggleSummaryPlaceholder");

/**
 * Always-on placeholder for empty toggle summaries. Unlike the global
 * `Placeholder` (focus-gated via `showOnlyCurrent`, top-level only via
 * `includeChildren: false`), this paints the hint on EVERY empty toggle summary
 * regardless of focus — so a content-less toggle never reads as an orphaned
 * chevron. Reuses the same `.is-empty::before { content: attr(data-placeholder) }`
 * CSS as the global placeholder (`globals.css`). Browser-only (a decoration
 * plugin, no node/mark) — the shared Yjs schema is untouched.
 */
export function createToggleSummaryPlaceholderExtension(text: string) {
  return Extension.create({
    name: "docToggleSummaryPlaceholder",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: toggleSummaryPlaceholderKey,
          props: {
            decorations: ({ doc }) =>
              DecorationSet.create(
                doc,
                emptyToggleSummaryRanges(doc).map(({ from, to }) =>
                  Decoration.node(from, to, {
                    class: "is-empty",
                    "data-placeholder": text,
                  }),
                ),
              ),
          },
        }),
      ];
    },
  });
}
