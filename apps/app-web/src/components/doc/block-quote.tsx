"use client";

// [COMP:app-web/block-quote]
/**
 * Phase 2 — Quote block.
 *
 * A left-bordered passage with inline-editable rich text. Tiptap mini-instance
 * configured against StarterKit; matches the baseline tiptap-text-block pattern.
 *
 * Shape matches the Phase-2 extension to the doc Block union:
 *   { kind: 'quote'; id; richText: JSONContent }
 */

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type QuoteBlock = {
  kind: "quote";
  id: string;
  richText?: JSONContent;
};

type BlockProps = {
  block: QuoteBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (next: Partial<QuoteBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
};

export function BlockQuote({ block, blockId, readOnly, onChange }: BlockProps) {
  const t = useT().docPage;

  const editor = useEditor({
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
    <blockquote
      data-block-id={blockId}
      className="border-l-[3px] border-[var(--accent)] pl-3 italic text-foreground/90"
    >
      {editor ? (
        <EditorContent
          editor={editor}
          data-placeholder={t.blocks.quoteTextPlaceholder}
          className="tiptap-block text-[15px] leading-7"
        />
      ) : null}
    </blockquote>
  );
}
