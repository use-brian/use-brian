"use client";

import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { useT } from "@/lib/i18n/client";

/**
 * React node-view for the `callout` block — tinted panel + emoji + editable body.
 *
 * BLOCK-5: the emoji is a CLICKABLE picker trigger (Notion parity), not a static
 * span — clicking it opens the shared `EmojiPicker` and writes the chosen glyph
 * back via `updateAttributes` (syncing through the CRDT). A callout always
 * carries an icon, so the picker's "Remove" (null) falls back to the default
 * 💡 rather than clearing it. Read-only renders the static glyph.
 */
export function CalloutView(props: NodeViewProps) {
  const t = useT().docPage.emojiPicker;
  const icon = (props.node.attrs.icon as string) || "💡";
  const editable = props.editor.isEditable;
  return (
    <NodeViewWrapper className="doc-callout my-1 flex gap-2 rounded-md border border-border bg-muted/40 p-3">
      {editable ? (
        <EmojiPicker
          onPick={(emoji) => props.updateAttributes({ icon: emoji ?? "💡" })}
          trigger={
            <button
              type="button"
              contentEditable={false}
              tabIndex={-1}
              aria-label={t.iconButtonAria}
              // Keep the editor selection put when the trigger is pressed.
              onMouseDown={(e) => e.preventDefault()}
              className="select-none rounded leading-6 hover:bg-muted"
            >
              {icon}
            </button>
          }
        />
      ) : (
        <span contentEditable={false} className="select-none leading-6">
          {icon}
        </span>
      )}
      <NodeViewContent className="flex-1" />
    </NodeViewWrapper>
  );
}
