"use client";

// [COMP:app-web/block-bulleted-list]
/**
 * Phase 2 — Bulleted list item block.
 *
 * One bullet-list item per Block — page-renderer renders these as a flat
 * sequence; nesting is one indent level in v1 (handled inside the Tiptap
 * editor's BulletList extension via Tab/Shift-Tab, which StarterKit ships
 * with). Block-level Markdown shorthand (`-` / `*` at line start) is
 * registered by the underlying BulletList extension.
 *
 * Shape matches the Phase-2 extension to the doc Block union:
 *   { kind: 'bulleted_list_item'; id; richText: JSONContent }
 *
 * Multi-block hierarchy (true nested children blocks) lands in Phase 2.5
 * with the children-block model.
 */

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type BulletedListItemBlock = {
  kind: "bulleted_list_item";
  id: string;
  richText?: JSONContent;
};

type BlockProps = {
  block: BulletedListItemBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (next: Partial<BulletedListItemBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
};

export function BlockBulletedList({ block, blockId, readOnly, onChange }: BlockProps) {
  const t = useT().docPage;

  const editor = useEditor({
    // StarterKit ships BulletList + ListItem so this is the full bulleted-
    // list editing surface (incl. Tab/Shift-Tab indent, Enter to add item).
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
      <span aria-hidden className="select-none pt-1 text-foreground/70">
        •
      </span>
      <div className="min-w-0 flex-1">
        {editor ? (
          <EditorContent
            editor={editor}
            data-placeholder={t.blocks.bulletedListPlaceholder}
            className="tiptap-block"
          />
        ) : null}
      </div>
    </div>
  );
}
