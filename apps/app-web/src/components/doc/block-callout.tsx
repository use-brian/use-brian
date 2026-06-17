"use client";

// [COMP:app-web/block-callout]
/**
 * Phase 2 — Callout block.
 *
 * A tinted-background panel with a leading icon (emoji or short string) and
 * inline-editable rich text. The icon is editable inline as a single-line
 * textbox (matches Notion's callout-icon affordance — emoji or any short
 * glyph). Background tint comes from `var(--muted)` so it adapts to the
 * theme; the left accent bar uses `var(--accent)`.
 *
 * Rich text is edited through a Tiptap mini-instance configured against
 * StarterKit. `onChange({ richText, icon })` fires on every edit; the parent
 * page-renderer batches PATCH ops.
 *
 * Shape matches the Phase-2 callout extension to the doc Block union:
 *   { kind: 'callout'; id; icon: string; richText: JSONContent }
 *
 * Phase 2 lock #15 keeps the strikethrough mark out of v1 — `to_do` is the
 * one block that uses CSS strike instead. Strike is still allowed inside
 * callouts (it ships in StarterKit) but the active toolbar in Phase 2 is
 * intentionally minimal.
 */

import { useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type CalloutBlock = {
  kind: "callout";
  id: string;
  icon: string;
  richText?: JSONContent;
};

type BlockProps = {
  block: CalloutBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (next: Partial<CalloutBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
};

export function BlockCallout({ block, blockId, readOnly, onChange }: BlockProps) {
  const t = useT().docPage;
  const [icon, setIcon] = useState<string>(block.icon || "💡");

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
    <div
      data-block-id={blockId}
      className="flex gap-3 rounded-md border border-border bg-[var(--muted)]/40 px-3 py-2"
    >
      <div className="flex-shrink-0 pt-[2px]">
        <input
          type="text"
          aria-label={t.blocks.calloutIconAria}
          title={t.blocks.calloutIconAria}
          value={icon}
          maxLength={4}
          readOnly={readOnly}
          onChange={(e) => {
            const next = e.target.value;
            setIcon(next);
            onChange?.({ icon: next });
          }}
          className="w-7 bg-transparent text-center text-lg leading-none outline-none focus:bg-background/60 focus:rounded focus:ring-1 focus:ring-border"
        />
      </div>
      <div className="min-w-0 flex-1">
        {editor ? (
          <EditorContent
            editor={editor}
            data-placeholder={t.blocks.calloutTextPlaceholder}
            className="tiptap-block text-[15px] text-foreground leading-7"
          />
        ) : null}
      </div>
    </div>
  );
}
