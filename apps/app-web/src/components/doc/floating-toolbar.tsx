"use client";

/**
 * Phase 2 — Floating selection toolbar (bubble menu).
 *
 * Wraps Tiptap's `BubbleMenu` to surface the four v1 marks
 * (bold / italic / inline-code / link) above a non-empty text selection.
 * Lock #15 caps v1 at exactly these four marks — no underline, no
 * strike, no color, no "Turn into" submenu. Phase 2.5+ adds block-level
 * transforms; Phase 4+ adds color marks.
 *
 * Mount pattern: the consumer (block-text, block-callout, ...) passes its
 * `useEditor()` instance via the `editor` prop. The component renders
 * nothing in SSR markup beyond the bubble container; tippy.js positions
 * it absolutely once selection exists.
 *
 * DOM-desync guard: `<BubbleMenu>` renders a real `<div>`, and the
 * bubble-menu ProseMirror plugin *detaches that div from its DOM parent*
 * the moment it registers (`this.element.remove()`, then hands it to
 * tippy.js). The node React still tracks at this position is therefore no
 * longer a child of the editor container. If it sits as a DIRECT sibling
 * of the editor's churning content — the sync skeleton, the landing
 * `buildSlot`, the comment band/rail that mount as a page loads — React's
 * next sibling insert/remove anchors on that moved node and throws
 * "Failed to execute 'insertBefore' on 'Node': … not a child of this node"
 * (the crash seen when opening a draft). We wrap the menu in a stable,
 * layout-transparent (`display:contents`) host so the relocated div lives
 * one level down: the editor's siblings only ever reconcile against this
 * always-attached wrapper, never the node tippy moved. Same fix philosophy
 * as the drag-handle grip (see `drag-handle.tsx`), which hit the identical
 * desync when the comment rail's `CommentThreadList` re-rendered.
 *
 * Tool-awareness: no keybinding is bound here for link — Cmd-B/I/E come
 * for free from StarterKit, Cmd-K is deferred to Phase 4 polish. Until
 * then the user clicks the link button.
 *
 * [COMP:app-web/floating-toolbar]
 */

import { useEffect, useState } from "react";
import { BubbleMenu } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { isNodeRangeSelection } from "@tiptap/extension-node-range";
import { Bold, Italic, Code, Link as LinkIcon, MessageSquarePlus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { TurnIntoMenu } from "./turn-into-menu";

type Props = {
  editor: Editor | null;
  /** Optional class extra appended to the bubble container. */
  className?: string;
  /** When provided, shows a "Comment" button that anchors a comment thread
   *  to the current selection (doc comments). Omitted → no comment button
   *  (e.g. read-only, or no doc assistant bound). */
  onComment?: () => void;
};

/**
 * Predicate handed to `BubbleMenu.shouldShow`. Pure + exported so the
 * test suite can exercise the show/hide matrix without booting a real
 * editor instance.
 *
 * Rules:
 *  - collapsed selection (`from === to`) → hide
 *  - selection inside a code block (`isActive('codeBlock')`) → hide
 *    (code blocks intentionally suppress inline formatting affordances;
 *    Notion does the same — the toolbar reads as visual noise in mono
 *    blocks where bold/italic don't apply anyway)
 *  - **multi-block range** (`NodeRangeSelection`, the area-select gesture) →
 *    hide: the inline mark toolbar applies to a text run, not a stack of whole
 *    blocks. Notion shows a block menu there, not the text bar; suppressing it
 *    keeps the area-select clean (the bar would otherwise flash over the bands).
 *  - otherwise → show
 */
export function shouldShowToolbar({
  from,
  to,
  isInCodeBlock,
  isNodeRange,
}: {
  from: number;
  to: number;
  isInCodeBlock: boolean;
  isNodeRange?: boolean;
}): boolean {
  if (from === to) return false;
  if (isInCodeBlock) return false;
  if (isNodeRange) return false;
  return true;
}

/**
 * The button strip — extracted so tests can render it without
 * instantiating `<BubbleMenu>` (which side-effects into tippy.js +
 * registers a ProseMirror plugin). The wrapper below threads the same
 * `editor` prop into both surfaces.
 */
export function ToolbarButtons({
  editor,
  onComment,
}: {
  editor: Editor;
  onComment?: () => void;
}) {
  const t = useT().docPage.floatingToolbar;
  const tc = useT().comments;
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const handleLinkClick = () => {
    const current = editor.getAttributes("link").href as string | undefined;
    setLinkUrl(current ?? "");
    setLinkPopoverOpen(true);
  };

  // Cmd/Ctrl-K opens the link popover over the active selection — the
  // Notion shortcut. Bound at the document level (the bubble menu only
  // mounts while a selection exists, so the handler is naturally scoped to
  // "there is something selected"). StarterKit owns Cmd-B/I/E for the marks.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        if (editor.state.selection.empty) return;
        e.preventDefault();
        handleLinkClick();
      }
    }
    if (typeof document === "undefined") return undefined;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // handleLinkClick closes over `editor` only; safe to depend on editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const handleLinkSubmit = () => {
    if (linkUrl) {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: linkUrl })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setLinkPopoverOpen(false);
  };

  return (
    <>
      <TurnIntoMenu editor={editor} />
      <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
      <ToolbarButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label={t.bold}
      >
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label={t.italic}
      >
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label={t.code}
      >
        <Code size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("link") || linkPopoverOpen}
        onClick={handleLinkClick}
        label={t.link}
      >
        <LinkIcon size={14} />
      </ToolbarButton>
      {linkPopoverOpen ? (
        <LinkInput
          value={linkUrl}
          placeholder={t.linkPlaceholder}
          onChange={setLinkUrl}
          onSubmit={handleLinkSubmit}
          onCancel={() => setLinkPopoverOpen(false)}
        />
      ) : null}
      {onComment ? (
        <>
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
          <button
            type="button"
            aria-label={tc.toolbarButtonAria}
            aria-pressed={editor.isActive("comment")}
            onClick={onComment}
            className={[
              "h-7 inline-flex items-center gap-1.5 rounded px-2 text-sm transition-colors",
              editor.isActive("comment")
                ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                : "hover:bg-[var(--muted)]",
            ].join(" ")}
          >
            <MessageSquarePlus size={14} />
            <span className="whitespace-nowrap">{tc.toolbarButton}</span>
          </button>
        </>
      ) : null}
    </>
  );
}

export function FloatingToolbar({ editor, className, onComment }: Props) {
  if (!editor) return null;

  // The `display:contents` host is load-bearing — see the module note's
  // "DOM-desync guard". It contributes no box but keeps the tippy-relocated
  // bubble `<div>` off the editor container's direct-sibling list, so a draft
  // load's sibling churn can't anchor an `insertBefore` on the moved node.
  return (
    <div className="contents">
      <BubbleMenu
        editor={editor}
        tippyOptions={{ duration: 100, placement: "top" }}
        shouldShow={({ editor: ed, from, to }) =>
          shouldShowToolbar({
            from,
            to,
            isInCodeBlock: ed.isActive("codeBlock"),
            isNodeRange: isNodeRangeSelection(ed.state.selection),
          })
        }
        className={[
          "inline-flex items-center gap-0.5 rounded-md border border-border",
          "bg-background shadow-md p-1",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <ToolbarButtons editor={editor} onComment={onComment} />
      </BubbleMenu>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={[
        "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
        active
          ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
          : "hover:bg-[var(--muted)]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function LinkInput({
  value,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  placeholder: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ml-1 flex items-center gap-1">
      <input
        type="url"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        className="h-7 px-2 text-sm border border-border rounded bg-transparent w-48 outline-none focus:ring-1 focus:ring-border"
      />
    </div>
  );
}
