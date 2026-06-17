"use client";

// [COMP:app-web/block-todo]
/**
 * Phase 2 — To-do block.
 *
 * Checkbox + Tiptap rich-text. When `checked: true` the text gets a CSS
 * `line-through` (NOT the Tiptap Strike mark — Lock #15 keeps strike out
 * of v1's mark surface, so the visual is css-only).
 *
 * Shape matches the Phase-2 extension to the doc Block union:
 *   { kind: 'to_do'; id; checked: boolean; richText: JSONContent }
 */

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type TodoBlock = {
  kind: "to_do";
  id: string;
  checked: boolean;
  richText?: JSONContent;
};

type BlockProps = {
  block: TodoBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (next: Partial<TodoBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
};

export function BlockTodo({ block, blockId, readOnly, onChange }: BlockProps) {
  const t = useT().docPage;

  const editor = useEditor({
    // StarterKit ships the Strike mark, but per Lock #15 we don't expose
    // it. The checked-state visual is a className strike-through below,
    // NOT a Tiptap mark — keeps the JSON content clean of strike marks.
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
      <input
        type="checkbox"
        aria-label={t.blocks.todoCheckboxAria}
        title={t.blocks.todoCheckboxAria}
        checked={!!block.checked}
        disabled={readOnly}
        onChange={(e) => onChange?.({ checked: e.target.checked })}
        className="mt-2 h-4 w-4 cursor-pointer accent-[var(--accent)]"
      />
      <div
        className={`min-w-0 flex-1 ${block.checked ? "text-muted-foreground line-through" : ""}`}
      >
        {editor ? (
          <EditorContent
            editor={editor}
            data-placeholder={t.blocks.todoTextPlaceholder}
            className="tiptap-block"
          />
        ) : null}
      </div>
    </div>
  );
}
