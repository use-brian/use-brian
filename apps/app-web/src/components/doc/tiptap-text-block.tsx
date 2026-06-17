"use client";

/**
 * Phase 0 feature-flagged Tiptap text block.
 * Mounted only when NEXT_PUBLIC_DOC_TIPTAP=true.
 * Does NOT replace block-text.tsx — coexists.
 * Phase 1+ will fully replace block-text.tsx with this component.
 *
 * [COMP:app-web/tiptap-text-block]
 */

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { JSONContent } from "@tiptap/react";

type Props = {
  blockId: string;
  initialContent?: JSONContent;
  onChange?: (content: JSONContent) => void;
  placeholder?: string;
  readOnly?: boolean;
};

/**
 * Read the Phase 0 Tiptap feature flag. Falls back to `false` when the
 * env var is unset so the component is a no-op outside of opt-in testing.
 */
export function isTiptapEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DOC_TIPTAP === "true";
}

export function TiptapTextBlock({
  blockId,
  initialContent,
  onChange,
  placeholder,
  readOnly,
}: Props) {
  const enabled = isTiptapEnabled();

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: "doc-link" } }),
    ],
    content: initialContent,
    editable: !readOnly,
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.getJSON());
    },
    // Avoid hydration mismatch in Next.js — defer initial render to client.
    immediatelyRender: false,
  });

  if (!enabled || !editor) return null;

  return (
    <EditorContent
      editor={editor}
      data-block-id={blockId}
      data-placeholder={placeholder}
      className="tiptap-block"
    />
  );
}
