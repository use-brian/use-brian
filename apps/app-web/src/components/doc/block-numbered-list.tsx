"use client";

// [COMP:app-web/block-numbered-list]
/**
 * Phase 2 — Numbered list item block.
 *
 * Mirrors `block-bulleted-list.tsx`. The leading "1." marker is rendered as
 * page chrome — page-renderer assigns the visible index when laying out a
 * run of numbered-list items (Phase 2 / P2G). Each Block carries only its
 * own rich-text; the renderer's flat enumeration is the source of truth for
 * numbering, matching how Notion handles re-numbering on reorder.
 *
 * Shape matches the Phase-2 extension to the doc Block union:
 *   { kind: 'numbered_list_item'; id; richText: JSONContent }
 */

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type NumberedListItemBlock = {
  kind: "numbered_list_item";
  id: string;
  richText?: JSONContent;
};

type BlockProps = {
  block: NumberedListItemBlock;
  blockId: string;
  /**
   * The 1-based ordinal computed by page-renderer when laying out a run
   * of numbered-list items. Defaults to 1 so the component is renderable
   * in isolation (typecheck / smoke tests).
   */
  ordinal?: number;
  readOnly?: boolean;
  onChange?: (next: Partial<NumberedListItemBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
};

export function BlockNumberedList({
  block,
  blockId,
  ordinal,
  readOnly,
  onChange,
}: BlockProps) {
  const t = useT().docPage;

  const editor = useEditor({
    // StarterKit ships OrderedList + ListItem so the Tab-indent + Enter
    // semantics work inside a single-item editor. Continuation across
    // sibling blocks is rebuilt at render time via `ordinal`.
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: "doc-link" } }),
    ],
    content: block.richText,
    editable: !readOnly,
    onUpdate: ({ editor: ed }) => {
      onChange?.({ richText: ed.getJSON() });
    },
    immediatelyRender: false,
  });

  return (
    <div
      data-block-id={blockId}
      className="flex items-start gap-2 text-[15px] leading-7 text-foreground"
    >
      <span
        aria-hidden
        className="min-w-[1.5em] select-none pt-0 text-right tabular-nums text-foreground/70"
      >
        {ordinal ?? 1}.
      </span>
      <div className="min-w-0 flex-1">
        {editor ? (
          <EditorContent
            editor={editor}
            data-placeholder={t.blocks.numberedListPlaceholder}
            className="tiptap-block"
          />
        ) : null}
      </div>
    </div>
  );
}
