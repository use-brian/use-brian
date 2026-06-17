"use client";

// [COMP:app-web/block-toggle]
/**
 * Phase 2 — Toggle block (disclosure widget).
 *
 * A chevron + summary row + collapsible body. The summary is an inline
 * Tiptap rich-text editor; children handling is simplified in Phase 2 —
 * the body is an empty placeholder container that Phase 2.5 wires up
 * once the children-block model lands.
 *
 * Local `expanded` state is initialized from `block.expanded ?? false`
 * (Notion's default — toggles start collapsed). State is local to the
 * component; persistence of "is this open" is not part of v1.
 *
 * Shape matches the Phase-2 extension to the doc Block union:
 *   { kind: 'toggle'; id; richText: JSONContent; expanded?: boolean }
 */

import { useState, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type ToggleBlock = {
  kind: "toggle";
  id: string;
  richText?: JSONContent;
  /** Default-collapsed if undefined; Phase 2.5 may persist this. */
  expanded?: boolean;
};

type BlockProps = {
  block: ToggleBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (next: Partial<ToggleBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
  /**
   * Optional children renderer — page-renderer (P2G) will pass the
   * resolved child blocks once the children-block model lands. Phase 2
   * defaults to an inline empty-state inside the disclosure body.
   */
  children?: ReactNode;
};

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
      }}
    >
      <path d="M4 2.5L8 6L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BlockToggle({ block, blockId, readOnly, onChange, children }: BlockProps) {
  const t = useT().docPage;
  const [expanded, setExpanded] = useState<boolean>(block.expanded ?? false);

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
    <div data-block-id={blockId} className="text-[15px] leading-7 text-foreground">
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label={expanded ? t.blocks.toggleCollapseAria : t.blocks.toggleExpandAria}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border"
        >
          <ChevronIcon open={expanded} />
        </button>
        <div className="min-w-0 flex-1">
          {editor ? (
            <EditorContent
              editor={editor}
              data-placeholder={t.blocks.toggleTextPlaceholder}
              className="tiptap-block"
            />
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border/60 pl-3">
          {children ? (
            children
          ) : (
            <p className="text-sm text-muted-foreground">{t.blocks.toggleEmptyChildren}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
