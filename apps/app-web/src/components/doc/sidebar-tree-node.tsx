"use client";

/**
 * One recursive node in the nested sub-page sidebar tree (Favorites
 * section). Renders a Notion-style row:
 *
 *  - an **always-available disclosure toggle** in the leading slot: it
 *    shows the page icon (the user/AI emoji, else the `derivePageIcon`
 *    glyph) at rest and swaps to a chevron on hover / while expanded
 *    (Notion's icon↔chevron). Clicking it expands or collapses the row
 *    *even when the page has no children yet* — an empty expanded page
 *    reveals a muted "No pages inside" caption. There is **no emoji
 *    picker here**; the page icon is set from the page header.
 *  - title (full-width at rest; truncates with an ellipsis on hover /
 *    keyboard focus to make room for the row actions, which are out of
 *    flow so they cost no width when hidden)
 *  - active highlight (`bg-accent`)
 *  - hover-revealed `+` → create a child draft under this page
 *  - hover-revealed `…` → DropdownMenu (Rename / Duplicate / Delete /
 *    Move to root). Delete confirms via `confirmDialog`.
 *
 * Drag-and-drop is wired by the parent `<DocSidebar>`'s single
 * `<DndContext>` (separate from the page-renderer's). Each node is a
 * draggable *and* exposes two droppable zones:
 *  - the row body → "drop ONTO" → reparent the dragged page *under*
 *    this one (intent `"onto"`).
 *  - a thin gap strip below the row → "drop BETWEEN" → reorder the
 *    dragged page as a *sibling* directly after this one (intent
 *    `"after"`).
 * The droppable id encodes `nodeId::intent` so the context's
 * `onDragEnd` can decode the target without prop drilling.
 *
 * Indentation is driven by `depth` (12px per level) so deep chains read
 * as a tree without a wall of nested `<ul>`s.
 *
 * [COMP:app-web/sidebar-tree-node]
 */

import { useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { daysUntilPrune, derivePageIcon } from "@/lib/api/views";
import type { TreeNode } from "@/lib/sidebar-tree";
import { useT } from "@/lib/i18n/client";
import { DraftPruneButton } from "./draft-prune-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Encodes a drop target as `nodeId::intent`. */
export type DropIntent = "onto" | "after";
export function dropId(nodeId: string, intent: DropIntent): string {
  return `${nodeId}::${intent}`;
}
export function parseDropId(
  raw: string,
): { nodeId: string; intent: DropIntent } | null {
  const idx = raw.lastIndexOf("::");
  if (idx < 0) return null;
  const nodeId = raw.slice(0, idx);
  const intent = raw.slice(idx + 2) as DropIntent;
  if (intent !== "onto" && intent !== "after") return null;
  return { nodeId, intent };
}

type SidebarTreeNodeProps = {
  node: TreeNode;
  activeId: string | null;
  /** Per-workspace persisted expand state: id → expanded. */
  expanded: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** Promote a draft to the saved tree (only shown on `state: 'draft'` rows). */
  onSave: (id: string) => void;
  onUnsave: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveToRoot: (id: string) => void;
  /** viewId → autoPruneAt, for the draft prune caption (the list omits it). */
  draftPruneByid: Record<string, string | null>;
  /**
   * Ids of pages kept by ancestry — a draft filed inside a saved (Favorites)
   * subtree. Its parent's save covers it, so it shows no "Save page" CTA and
   * is never pruned (see `savedAncestorIds`). Passed straight through the
   * recursion (spread), so every descendant reads the same set.
   */
  keptByAncestry: Set<string>;
  /** Id of the row currently being dragged (for drop-target highlight). */
  draggingId: string | null;
};

export function SidebarTreeNode(props: SidebarTreeNodeProps) {
  const {
    node,
    activeId,
    expanded,
    onToggleExpand,
    onSelect,
    onAddChild,
    onRename,
    onDuplicate,
    onSave,
    onUnsave,
    onDelete,
    onMoveToRoot,
    draftPruneByid,
    keptByAncestry,
    draggingId,
  } = props;
  const t = useT().docPage;
  const { row, children, depth } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expanded[row.id] ?? false;
  const isActive = row.id === activeId;
  // A draft filed inside a saved (Favorites) subtree is kept by its parent's
  // save — it shows no "Save page" CTA / prune countdown and is never pruned.
  const keptByParent = keptByAncestry.has(row.id);
  // Draft prune countdown — revealed on row hover OR when this is the active
  // draft, so any draft surfaces its auto-delete ETA on pointer-over (not just
  // the open page). `rowHovered` covers both the row and the caption below it
  // (the wrapper spans both), so moving the pointer down onto the clickable
  // "Save page" affordance doesn't collapse it out from under the cursor.
  const [rowHovered, setRowHovered] = useState(false);
  const pruneDays =
    row.state === "draft" && !keptByParent
      ? daysUntilPrune(draftPruneByid[row.id] ?? null)
      : null;
  const revealPrune = isActive || rowHovered;
  const Icon = derivePageIcon({
    entity: row.entity,
    viewType: row.viewType,
    nameOrigin: row.nameOrigin,
  });
  const title = row.name?.trim() ? row.name : t.breadcrumbUntitled;

  // Draggable handle for the whole row.
  const drag = useDraggable({ id: row.id });
  // Drop ONTO the row body → reparent under this node.
  const dropOnto = useDroppable({ id: dropId(row.id, "onto") });
  // Drop AFTER (gap strip) → reorder as a sibling after this node.
  const dropAfter = useDroppable({ id: dropId(row.id, "after") });

  // Don't let a node be a drop target for itself while dragging.
  const isSelfDragging = draggingId === row.id;
  const ontoActive = !isSelfDragging && dropOnto.isOver;
  const afterActive = !isSelfDragging && dropAfter.isOver;

  const indentStyle = { paddingLeft: `${depth * 12 + 4}px` };
  const dragStyle = drag.transform
    ? { transform: CSS.Translate.toString(drag.transform), opacity: 0.6 }
    : undefined;

  return (
    <li>
      {/* Hover region spanning the row AND its prune caption, so moving the
          pointer down onto the clickable "Save page" affordance keeps the
          caption open instead of collapsing it (the `group/row` hover lives on
          the inner row div and wouldn't reach the caption below it). */}
      <div
        onMouseEnter={() => setRowHovered(true)}
        onMouseLeave={() => setRowHovered(false)}
      >
      <div
        ref={(el) => {
          drag.setNodeRef(el);
          dropOnto.setNodeRef(el);
        }}
        style={dragStyle}
        className={[
          "group/row relative flex items-center gap-0.5 rounded-md pr-1 text-sm",
          isActive
            ? "doc-nav-active"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          ontoActive ? "ring-1 ring-primary" : "",
        ].join(" ")}
      >
        {/* Leading slot — an always-available disclosure toggle. It shows
            the page icon at rest and swaps to a chevron on hover / while
            expanded (Notion's icon↔chevron); the two overlap in a fixed box
            so nothing shifts. Clicking it toggles expand on EVERY row, even
            one with no children yet (which then reveals "No pages inside").
            Depth indent lives here so titles stay aligned. */}
        <div
          style={indentStyle}
          className="flex h-7 shrink-0 items-center self-stretch"
        >
          <button
            type="button"
            aria-label={
              isExpanded ? t.sidebarCollapseAria : t.sidebarExpandAria
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(row.id);
            }}
            className="relative flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {/* Page icon — visible by default, faded out once the chevron
                takes over (on hover, or while expanded). */}
            <span
              className={[
                "flex items-center justify-center transition-opacity",
                isExpanded
                  ? "opacity-0"
                  : "opacity-100 group-hover/row:opacity-0",
              ].join(" ")}
            >
              {row.icon ? (
                <span className="text-[15px] leading-none">{row.icon}</span>
              ) : (
                <Icon className="size-4 text-sidebar-foreground/55" />
              )}
            </span>
            {/* Disclosure chevron — fades in on hover, stays while expanded. */}
            <ChevronRight
              className={[
                "absolute inset-0 m-auto size-3.5 transition-[transform,opacity]",
                isExpanded
                  ? "rotate-90 opacity-100"
                  : "opacity-0 group-hover/row:opacity-100",
              ].join(" ")}
            />
          </button>
        </div>

        {/* Title — the clickable navigation target. Also the drag handle
            (listeners attach here so the chevron/icon/menu buttons stay
            clickable). Runs full-width at rest; on hover / keyboard focus
            within the row it pads right so the title truncates with an
            ellipsis and clears the out-of-flow … / + actions. */}
        <button
          type="button"
          onClick={() => onSelect(row.id)}
          title={title}
          className="doc-nav-title flex min-w-0 flex-1 items-center py-1 pr-0 text-left group-hover/row:pr-14 group-focus-within/row:pr-14"
          {...drag.attributes}
          {...drag.listeners}
        >
          <span
            className={[
              "min-w-0 flex-1 truncate",
              isActive ? "font-medium" : "",
            ].join(" ")}
          >
            {title}
          </span>
        </button>

        {/* Hover affordances — overflow menu (…) then add-child (+),
            matching Notion's row order. Absolutely positioned so they cost
            no width at rest (the title runs full-width); revealed on hover /
            focus-within / while the … menu is open (the last via `has-[…]`,
            so moving the mouse off the row doesn't hide an open menu). */}
        <div className="absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-within/row:opacity-100 group-focus-within/row:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t.sidebarRowMenu}
                  onClick={(e) => e.stopPropagation()}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => onRename(row.id)}>
                {t.sidebarRowRename}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(row.id)}>
                {t.sidebarRowDuplicate}
              </DropdownMenuItem>
              {row.nestParentId !== null && (
                <DropdownMenuItem onClick={() => onMoveToRoot(row.id)}>
                  {t.sidebarRowMoveToRoot}
                </DropdownMenuItem>
              )}
              {row.state === "draft" && !keptByParent && (
                <DropdownMenuItem onClick={() => onSave(row.id)}>
                  {t.sidebarRowSave}
                </DropdownMenuItem>
              )}
              {row.state === "saved" && (
                <DropdownMenuItem onClick={() => onUnsave(row.id)}>
                  {t.sidebarRowUnsave}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(row.id)}
              >
                {t.sidebarRowDelete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            aria-label={t.sidebarAddChildAria}
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(row.id);
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Draft prune countdown — a nested draft keeps its auto-delete ETA. The
          `0fr → 1fr` grid track animates it open on row hover (or while the
          draft is the active page) and collapsed away otherwise. The caption is
          a button: it swaps to a "Save page" CTA on hover and promotes the
          draft into Favorites. Indented to sit under the title (depth indent +
          the leading-icon slot). */}
      {pruneDays !== null && (
        <div
          aria-hidden={!revealPrune}
          style={{ paddingLeft: `${depth * 12 + 30}px` }}
          className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
            revealPrune ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="pt-0.5 leading-none">
              <DraftPruneButton
                days={pruneDays}
                interactive={revealPrune}
                onSave={() => onSave(row.id)}
              />
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Between-siblings drop strip — a thin zone under the row that,
          when hovered during a drag, shows an insertion line. */}
      <div
        ref={dropAfter.setNodeRef}
        className="relative h-1"
        aria-hidden
      >
        {afterActive && (
          <div
            className="absolute left-0 right-1 top-0 h-0.5 rounded-full bg-primary"
            style={indentStyle}
          />
        )}
      </div>

      {/* Empty-but-expanded — Notion's muted "No pages inside" caption. The
          always-on toggle means any page can be opened; one with no children
          says so rather than collapsing silently. Indented to sit under the
          title (depth indent + the leading-toggle slot). */}
      {isExpanded && !hasChildren && (
        <div
          style={{ paddingLeft: `${depth * 12 + 30}px` }}
          className="select-none py-1 text-[13px] text-sidebar-foreground/40"
        >
          {t.sidebarNoPagesInside}
        </div>
      )}

      {/* Children — only mounted when expanded (conditional render, not
          CSS hide, so deep trees don't pay for collapsed subtrees). */}
      {hasChildren && isExpanded && (
        <ul>
          {children.map((child) => (
            <SidebarTreeNode
              key={child.row.id}
              {...props}
              node={child}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
