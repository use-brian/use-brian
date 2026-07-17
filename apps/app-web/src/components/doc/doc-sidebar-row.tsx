"use client";

/**
 * Single row in the Saved + Drafts sidebar list.
 *
 * Layout (per docs/research/notion/page-construction.md § 5 / § 8.4):
 *  - h-8 row, px-2, rounded-md
 *  - hover background tint via Tailwind hover:bg-accent
 *  - Active row: bg-accent + foreground colour + font-medium
 *  - Title truncates with ellipsis
 *  - Hover-revealed "..." menu opens a small inline popover with
 *    save/unsave/delete actions
 *  - A draft row reveals a muted "Nd until auto-delete" caption on hover
 *    (or while it's the active page); it height-animates open/closed. The
 *    caption is a button — it swaps to a "Save page" CTA on hover and
 *    promotes the draft into Favorites (`<DraftPruneButton>`).
 *
 * The "..." menu is rolled inline since apps/web doesn't ship a
 * shadcn DropdownMenu primitive yet. Click-outside collapses it.
 *
 * [COMP:app-web/views-sidebar]
 */

import { useEffect, useRef, useState } from "react";
import {
  daysUntilPrune,
  derivePageIcon,
  type ViewListRow,
} from "@/lib/api/views";
import { useT } from "@/lib/i18n/client";
import { DraftPruneButton } from "./draft-prune-button";
import { PageIcon } from "./page-icon";

type Props = {
  row: ViewListRow;
  active: boolean;
  /** Draft rows include an autoPruneAt; saved rows don't. */
  autoPruneAt?: string | null;
  /**
   * True when this draft lives inside a saved (Favorites) subtree — kept by
   * its parent's save (`savedAncestorIds`). Suppresses the "Save page" CTA +
   * prune caption since the page is already protected from pruning.
   */
  inSavedSubtree?: boolean;
  onSelect: (id: string) => void;
  onSave?: (id: string) => void;
  onUnsave?: (id: string) => void;
  onDelete: (id: string) => void;
};

function MoreIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="13" cy="8" r="1.3" />
    </svg>
  );
}

export function DocSidebarRow({
  row,
  active,
  autoPruneAt,
  inSavedSubtree = false,
  onSelect,
  onSave,
  onUnsave,
  onDelete,
}: Props) {
  const t = useT().docPage;
  const Icon = derivePageIcon({
    entity: row.entity,
    viewType: row.viewType,
    nameOrigin: row.nameOrigin,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const pruneDays = daysUntilPrune(autoPruneAt ?? null);
  // Reveal the prune caption on hover OR while this is the active page; the
  // caption itself sits inside this container's hover region, so dropping the
  // pointer onto the "Save page" button keeps it open.
  const revealPrune = active || hovered;
  // An unsaved draft that isn't kept by a saved ancestor will be auto-pruned —
  // ghost its leading icon so it reads as temporary at a glance (the always-on
  // counterpart to the hover-revealed "Nd until auto-delete" caption). Gated on
  // `state`, not `pruneDays`, so it shows even before the prune ETA is fetched.
  const isTemporary = row.state === "draft" && !inSavedSubtree;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={
        active
          ? "doc-nav-active group/row relative flex flex-col rounded-md px-2 py-1"
          : "group/row relative flex flex-col rounded-md px-2 py-1 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      }
    >
      <div className="flex items-center gap-1.5">
        {/* Static leading glyph — the page emoji, else the type-derived
            fallback. No picker here (icons are set from the page header);
            `relative z-10` keeps it above the title's full-row hit overlay. */}
        <span
          className={`relative z-10 flex size-5 shrink-0 items-center justify-center${
            isTemporary ? " doc-icon-temporary" : ""
          }`}
        >
          <PageIcon
            icon={row.icon}
            fallback={Icon}
            emojiClassName="text-[15px] leading-none"
            glyphClassName="size-4 text-sidebar-foreground/55"
            imgClassName="size-4 rounded-[3px] object-cover"
          />
        </span>
        {/* Title is the row's navigation target. The `after:inset-0`
            overlay stretches its hit area across the whole card (the
            container is `relative`), so a click anywhere — including the
            empty gutter and the "auto-prunes" caption below — navigates.
            The icon + `…` buttons are siblings raised to `z-10`, so they
            stay above the overlay and keep their own click behavior. */}
        <button
          type="button"
          onClick={() => onSelect(row.id)}
          className={`doc-nav-title min-w-0 flex-1 cursor-pointer truncate text-left text-sm after:absolute after:inset-0 after:content-[''] ${active ? "font-medium" : ""}`}
          title={row.name}
        >
          {row.name}
        </button>
        <div className="relative z-10" ref={menuRef}>
          <button
            type="button"
            aria-label={t.sidebarRowMenu}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            aria-expanded={menuOpen}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-7 z-20 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover py-1 text-sm shadow-md"
              role="menu"
            >
              {row.state === "draft" && !inSavedSubtree && onSave && (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    setMenuOpen(false);
                    onSave(row.id);
                  }}
                  role="menuitem"
                >
                  {t.sidebarRowSave}
                </button>
              )}
              {row.state === "saved" && onUnsave && (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    setMenuOpen(false);
                    onUnsave(row.id);
                  }}
                  role="menuitem"
                >
                  {t.sidebarRowUnsave}
                </button>
              )}
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-accent"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(row.id);
                }}
                role="menuitem"
              >
                {t.sidebarRowDelete}
              </button>
            </div>
          )}
        </div>
      </div>
      {/* Prune countdown — revealed on hover or while this draft is the active
          page (see doc.md → Drafts). The grid `0fr → 1fr` track animates the
          row's height open/closed; the inner `overflow-hidden` wrapper is what
          lets it collapse to zero (vertical padding lives inside it so it
          collapses too). The caption is a "Save page" button. */}
      {row.state === "draft" && !inSavedSubtree && pruneDays !== null && onSave && (
        <div
          aria-hidden={!revealPrune}
          className={`grid pl-1 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
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
  );
}
