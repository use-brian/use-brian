"use client";

/**
 * Notion-style left-gutter drag handle for the collaborative page editor.
 *
 * Two affordances on one grip (Notion convention):
 *   - **Drag** to reorder a block. The move is a ProseMirror transaction
 *     `y-prosemirror` syncs to every collaborator — the collab-safe replacement
 *     for the deleted dnd-kit path. It rides `createBlockDragHandlePlugin`
 *     (`block-drag-handle.ts`), which — unlike the upstream
 *     `@tiptap/extension-drag-handle` — targets the **actual hovered block at
 *     its real depth**, so a block nested inside a toggle/callout keeps its own
 *     handle (the upstream only grabbed the outermost block, so nesting made the
 *     grip vanish).
 *   - **Click** (a mousedown→mouseup with no movement; HTML5 `draggable` doesn't
 *     swallow it) opens the **`BlockActionMenu`** — Turn into, Color, Copy link,
 *     Duplicate, Delete, Comment for AI.
 *
 * The grip is a **vanilla DOM element** the plugin owns, NOT a React-rendered
 * node. The plugin relocates the grip into its tippy popup (parented under the
 * editor's DOM); a React-rendered grip would then be a child React still thinks
 * it owns, so when a sibling (e.g. the comment rail's `CommentThreadList`)
 * re-rendered, React's `insertBefore` hit a node that was no longer its child
 * and threw. Keeping the grip outside React's tree removes that whole class of
 * DOM-desync crash. React here renders only the `BlockActionMenu`, anchored to
 * the grip element.
 *
 * Target tracking flows through the plugin's `onNodeChange({ node, pos })` into a
 * ref the menu reads. While the menu is open the handle is **pinned**: dropping
 * the `lockDragHandle` tr-meta (which the plugin reads) makes its `mouseleave`
 * early-return and disables `draggable`, so the grip stays put and the target
 * stays frozen. Every menu close path unlocks. Mounted only when `canEdit`.
 *
 * [COMP:app-web/drag-handle]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useT } from "@/lib/i18n/client";
import { BlockActionMenu } from "./block-action-menu";
import type { BlockTarget } from "./block-actions";
import { createBlockDragHandlePlugin, blockDragHandleKey } from "./block-drag-handle";

/** lucide `GripVertical` as inline SVG — the grip is built in vanilla DOM (see
 *  the module note on why it can't be a React node), so the icon is a string. */
const GRIP_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle>' +
  '<circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle>' +
  '<circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>';

export type DocDragHandleProps = {
  editor: Editor | null;
  /** Comment on a TEXT block — the selection-based `onComment`; the menu
   *  selects the block's text first (a `human_range` thread). Absent when
   *  comments are unavailable. */
  onComment?: () => void;
  /** Comment on an ATOM block (chart / image / data / …) — opens a whole-block
   *  (`human_block`) comment keyed on the block's id. Absent when comments are
   *  unavailable. */
  onBlockComment?: (blockId: string) => void;
  workspaceId: string;
  /** Active page id — backs Copy-link-to-block. */
  pageId: string;
};

export function DocDragHandle({
  editor,
  onComment,
  onBlockComment,
  workspaceId,
  pageId,
}: DocDragHandleProps) {
  const t = useT().docPage;
  // The block under the handle, kept fresh by the plugin's onNodeChange — which
  // keeps firing across remote Yjs edits via the plugin's view-update path even
  // while the handle is pinned. The menu reads this ref LIVE at action time
  // (not a frozen snapshot) so an action always hits the remapped position.
  const targetRef = useRef<BlockTarget | null>(null);
  const gripRef = useRef<HTMLDivElement | null>(null);
  // The block element highlighted while its action menu is open (CHROME-10).
  const highlightedRef = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ anchorEl: HTMLElement | null } | null>(null);

  const clearHighlight = useCallback(() => {
    highlightedRef.current?.classList.remove("doc-block-selected");
    highlightedRef.current = null;
  }, []);

  const handleNodeChange = useCallback(
    ({ node, pos }: { node: PMNode | null; pos: number }) => {
      // node:null / pos:-1 arrives on mouseleave/hideDragHandle — ignore those
      // so the target only ever points at a real block.
      if (node && pos >= 0) targetRef.current = { node, pos };
    },
    [],
  );

  /** Pin/unpin the grip by setting the meta the plugin reads. */
  const setLocked = useCallback(
    (locked: boolean) => {
      if (!editor) return;
      editor.view.dispatch(editor.state.tr.setMeta("lockDragHandle", locked));
    },
    [editor],
  );

  const openMenu = useCallback(() => {
    if (!editor || !targetRef.current || !gripRef.current) return;
    setLocked(true);
    // CHROME-10: paint a full-width highlight on the target block while its
    // action menu is open (Notion's block selection). A view-only DOM class —
    // NOT a ProseMirror selection/transaction, so it never syncs through Yjs.
    clearHighlight();
    const dom = editor.view.nodeDOM(targetRef.current.pos);
    if (dom instanceof HTMLElement) {
      dom.classList.add("doc-block-selected");
      highlightedRef.current = dom;
    }
    setMenu({ anchorEl: gripRef.current });
  }, [editor, setLocked, clearHighlight]);

  const closeMenu = useCallback(() => {
    clearHighlight();
    setMenu(null);
    setLocked(false);
  }, [setLocked, clearHighlight]);

  // The vanilla grip's click fires through a ref so it always calls the latest
  // `openMenu` without re-creating the element (and re-registering the plugin).
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;

  const menuLabel = t.blockActions.menuLabel;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const grip = document.createElement("div");
    grip.className =
      "doc-drag-handle flex h-6 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
    grip.setAttribute("role", "button");
    grip.setAttribute("aria-label", menuLabel);
    grip.setAttribute("title", menuLabel);
    grip.innerHTML = GRIP_SVG;
    const onClick = () => openMenuRef.current();
    grip.addEventListener("click", onClick);
    gripRef.current = grip;

    const plugin = createBlockDragHandlePlugin({
      editor,
      element: grip,
      onNodeChange: ({ node, pos }) => handleNodeChange({ node, pos }),
    });
    editor.registerPlugin(plugin);
    return () => {
      grip.removeEventListener("click", onClick);
      if (!editor.isDestroyed) editor.unregisterPlugin(blockDragHandleKey);
      gripRef.current = null;
      clearHighlight();
    };
  }, [editor, menuLabel, handleNodeChange, clearHighlight]);

  if (!editor) return null;
  return menu ? (
    <BlockActionMenu
      editor={editor}
      getTarget={() => targetRef.current}
      anchorEl={menu.anchorEl}
      onClose={closeMenu}
      onComment={onComment}
      onBlockComment={onBlockComment}
      workspaceId={workspaceId}
      pageId={pageId}
    />
  ) : null;
}
