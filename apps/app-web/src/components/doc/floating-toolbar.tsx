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
 * of the editor's churning content — the sync skeleton, the comment
 * band/rail that mount as a page loads — React's
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
 * Phone (responsive contract M3 / M5 / M9): the strip wraps below `md` with
 * the link field as its own full-width row, buttons grow to 36px, and a
 * coarse-pointer "Comment" chip (`SelectionCommentChip`) renders BELOW the
 * selection, driven by `pointerup` / `selectionchange` and holding the
 * selection through the tap (`preventDefault` on mousedown / pointerdown).
 * The tippy bubble sits above the selection, exactly where iOS / Android
 * draw the native selection callout, so on touch it may be covered; the
 * chip is the reliable path to an anchored comment there.
 *
 * [COMP:app-web/floating-toolbar]
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BubbleMenu } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { isNodeRangeSelection } from "@tiptap/extension-node-range";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection } from "@tiptap/pm/state";
import { Bold, Italic, Code, Link as LinkIcon, MessageSquarePlus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { isPhoneViewport, useCoarsePointer } from "@/lib/viewport";
import { clampPopupRect, measureViewport, type PopupAnchor } from "@/lib/popup-clamp";
import { TurnIntoMenu } from "./turn-into-menu";

export const DrawingToolbarContext = createContext<{
  active: number;
  setActive: React.Dispatch<React.SetStateAction<number>>;
} | null>(null);

export function DrawingToolbarProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(0);
  return <DrawingToolbarContext.Provider value={{ active, setActive }}>{children}</DrawingToolbarContext.Provider>;
}

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
 *  - **table-axis range** (`CellSelection`) → hide: a row/column grip owns that
 *    structural selection and its menu. Inline text commands are not valid for
 *    the axis as a whole and otherwise overlap the table action menu.
 *  - **single node** (`NodeSelection`) → hide: a drawing/embed frame is not
 *    an inline text range, even though its selection is non-empty.
 *  - otherwise → show
 */
export function shouldShowToolbar({
  from,
  to,
  isInCodeBlock,
  isNodeRange,
  isCellSelection,
  isNodeSelection,
}: {
  from: number;
  to: number;
  isInCodeBlock: boolean;
  isNodeRange?: boolean;
  isCellSelection?: boolean;
  isNodeSelection?: boolean;
}): boolean {
  if (from === to) return false;
  if (isInCodeBlock) return false;
  if (isNodeRange) return false;
  if (isCellSelection) return false;
  if (isNodeSelection) return false;
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
              "h-9 md:h-7 inline-flex items-center gap-1.5 rounded px-2 text-sm transition-colors",
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

/** The chip's box for placement (its padding + `h-11`). */
const SELECTION_CHIP_SIZE = { width: 128, height: 44 };

/**
 * The rect a coarse-pointer Comment chip anchors to: the current selection's
 * span (start line top → end line bottom, left of the start), or `null` when
 * the toolbar itself would not show (collapsed selection, code block, an
 * area / table-axis range). Pure over the editor's read surface so the
 * trigger rule is unit-testable without booting an editor.
 */
export function selectionChipAnchor(
  ed: Pick<Editor, "state" | "isActive"> & {
    view: Pick<Editor["view"], "coordsAtPos">;
  },
): PopupAnchor | null {
  const { from, to } = ed.state.selection;
  const show = shouldShowToolbar({
    from,
    to,
    isInCodeBlock: ed.isActive("codeBlock"),
    isNodeRange: isNodeRangeSelection(ed.state.selection),
    isCellSelection: ed.state.selection instanceof CellSelection,
    isNodeSelection: ed.state.selection instanceof NodeSelection,
  });
  if (!show) return null;
  const start = ed.view.coordsAtPos(Math.min(from, to));
  const end = ed.view.coordsAtPos(Math.max(from, to));
  return {
    top: Math.min(start.top, end.top),
    bottom: Math.max(start.bottom, end.bottom),
    left: start.left,
  };
}

/**
 * Coarse-pointer "Comment" chip (responsive contract M3 / M9). Renders only
 * when the primary pointer cannot hover; shows after a selection gesture
 * ends (`pointerup` / `keyup`, coalesced to one frame), hides the instant the
 * selection collapses, and keeps the selection alive through the tap by
 * cancelling the default of mousedown / pointerdown (a focus change would
 * otherwise collapse it before `onComment` can read the range). Placed
 * BELOW the selection through `clampPopupRect`, clear of the native
 * callout the OS draws above it.
 */
export function SelectionCommentChip({
  editor,
  onComment,
}: {
  editor: Editor;
  onComment: () => void;
}) {
  const tc = useT().comments;
  const coarse = useCoarsePointer();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!coarse || typeof document === "undefined") {
      setPos(null);
      return;
    }
    let raf = 0;
    const show = () => {
      raf = 0;
      const anchor = selectionChipAnchor(editor);
      if (!anchor) {
        setPos(null);
        return;
      }
      const placed = clampPopupRect(anchor, SELECTION_CHIP_SIZE, measureViewport());
      setPos({ top: placed.top, left: placed.left });
    };
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(show);
    };
    // Collapsing hides at once; a new selection shows only when the gesture
    // ends, so the chip never chases a drag in progress.
    const onSelectionChange = () => {
      if (editor.state.selection.empty) setPos(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("keyup", schedule);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("keyup", schedule);
    };
  }, [coarse, editor]);

  if (!pos) return null;
  const keepSelection = (e: { preventDefault: () => void }) => e.preventDefault();
  return (
    <button
      type="button"
      data-selection-comment-chip
      aria-label={tc.toolbarButtonAria}
      onMouseDown={keepSelection}
      onPointerDown={keepSelection}
      onClick={() => {
        setPos(null);
        onComment();
      }}
      style={{ position: "fixed", top: pos.top, left: pos.left }}
      className="z-40 inline-flex h-11 items-center gap-1.5 rounded-lg border border-border bg-popover px-3 text-sm font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent"
    >
      <MessageSquarePlus className="size-4 text-muted-foreground" aria-hidden />
      <span className="whitespace-nowrap">{tc.toolbarButton}</span>
    </button>
  );
}

export function FloatingToolbar({ editor, className, onComment }: Props) {
  const drawing = useContext(DrawingToolbarContext);
  // Unmount, rather than only changing shouldShow: tippy can already be visible,
  // and the touch chip and link shortcut have independent document listeners.
  if (!editor || drawing?.active) return null;

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
            isCellSelection: ed.state.selection instanceof CellSelection,
            isNodeSelection: ed.state.selection instanceof NodeSelection,
          })
        }
        className={[
          // Below `md` the strip wraps (the link field becomes a second row)
          // and never exceeds the viewport (responsive contract M5).
          "inline-flex items-center gap-0.5 rounded-md border border-border",
          "bg-background shadow-md p-1 max-md:flex-wrap max-md:max-w-[calc(100vw-1rem)]",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <ToolbarButtons editor={editor} onComment={onComment} />
      </BubbleMenu>
      {onComment ? <SelectionCommentChip editor={editor} onComment={onComment} /> : null}
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
        // 36px on a phone, the 28px desktop button from `md` (M3).
        "size-9 md:size-7 inline-flex items-center justify-center rounded transition-colors",
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
    // Its own full-width row below `md` (the strip wraps), inline from `md`.
    <div className="ml-1 flex items-center gap-1 max-md:ml-0 max-md:mt-1 max-md:w-full max-md:basis-full">
      <input
        type="url"
        autoFocus={!isPhoneViewport()}
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
        className="h-9 md:h-7 px-2 text-[16px] md:text-sm border border-border rounded bg-transparent w-[min(12rem,calc(100vw-5rem))] max-md:w-full outline-none focus:ring-1 focus:ring-border"
      />
    </div>
  );
}
