"use client";

import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";

/**
 * React node-view for the `toggle` block — a Notion-style disclosure. A
 * filled triangle (▶ collapsed, rotating to ▼ when open) sits in the left
 * gutter — matching Notion and the read-only/public render (which already uses
 * a CSS border-triangle, see globals.css `.doc-public-body details`) — with
 * the summary line beside it and the nested child blocks indented below. The
 * triangle is `fill`-only, so it scales with the summary's `font-size` (set per
 * heading level in globals.css) and reads solid at every size. The toggle's
 * first child is
 * the always-visible summary; every block after it is a collapsible child
 * (added by pressing Enter inside the toggle — ProseMirror keeps the new block
 * inside this `defining` node; Enter on an empty trailing child exits it).
 *
 * `open` is read straight off the node attr so a collaborator's expand/collapse
 * reflects live, and flipped via `updateAttributes` so the change syncs through
 * the CRDT. Collapsed-vs-expanded visibility is CSS-driven off the wrapper's
 * `data-open` (see globals.css `.doc-toggle`): when closed, the child blocks
 * hide while the summary stays. The chevron's pointer events are intercepted by
 * the node-view's `stopEvent` (see `doc-schema.ts`) so the click reliably
 * toggles instead of being swallowed by ProseMirror as a node selection.
 *
 * Typing `> ` creates one (see `TOGGLE_INPUT_REGEX` in
 * `@use-brian/doc-model`); the quote markdown trigger is `| `. An OPEN toggle
 * with no body renders Notion's muted "Empty toggle" row (click-to-create
 * first child); the editable content + that row sit in a `.doc-toggle-col`
 * column so both stay one indent right of the chevron. Mod-Enter flips
 * `open` from the keyboard (`modEnterDisclosure` in `block-indent.ts`).
 */
export function ToggleView(props: NodeViewProps) {
  const t = useT().docPage;
  const open = Boolean(props.node.attrs.open);
  // Tag the summary's block kind (`p` / `h1`…`h4`) so the chevron can be
  // vertically centred on that line's height (see globals.css `.doc-toggle`).
  const summary = props.node.firstChild;
  const summaryKind =
    summary?.type.name === "heading" ? `h${Number(summary.attrs.level) || 1}` : "p";
  // An OPEN toggle with no body (just the summary) shows Notion's empty-state
  // row; clicking it creates the first child and puts the caret there.
  const showEmptyPrompt = open && props.node.childCount === 1 && props.editor.isEditable;
  return (
    <NodeViewWrapper
      className="doc-toggle my-1"
      data-open={open ? "true" : "false"}
      data-summary={summaryKind}
    >
      <button
        type="button"
        contentEditable={false}
        // Keep the chevron out of the Tab order — Tab is the block-indent key
        // in the editor, not a focus-traversal stop onto this button.
        tabIndex={-1}
        className="doc-toggle-chevron"
        aria-label={open ? t.blocks.toggleCollapseAria : t.blocks.toggleExpandAria}
        aria-expanded={open}
        // Keep the editor selection put when the chevron is pressed; the
        // click then flips `open` without ProseMirror stealing focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.updateAttributes({ open: !open })}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M3.5 2.5L9.5 6L3.5 9.5Z" fill="currentColor" />
        </svg>
      </button>
      <div className="doc-toggle-col">
        <NodeViewContent className="doc-toggle-content" />
        {showEmptyPrompt ? (
          <button
            type="button"
            contentEditable={false}
            tabIndex={-1}
            className="doc-toggle-empty"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const pos = props.getPos();
              if (typeof pos !== "number") return;
              const insertAt = pos + props.node.nodeSize - 1; // end of the toggle's content
              props.editor
                .chain()
                .insertContentAt(insertAt, { type: "paragraph" })
                .focus(insertAt + 1)
                .run();
            }}
          >
            {t.blocks.toggleEmptyChildren}
          </button>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
