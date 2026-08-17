"use client";

/**
 * One plan slot, rendered identically by the month grid and the List view
 * (feed-revamp-depth D25/D29).
 *
 * Extracted so the two views cannot drift: a chip that shows a media
 * thumbnail in the calendar and not in the list would read as a data bug the
 * first time an operator switched views. Both call this; there is one chip.
 *
 * What it carries, and why each earns its pixels:
 *   - platform glyph : "what is going out Thursday" is unreadable without it
 *   - title          : the operator's own words
 *   - `HH:MM`        : only when a time is set. A slot with no time is a real
 *                      and common state, so no time renders nothing rather
 *                      than a placeholder that would look like midnight.
 *   - thumbnail      : proof the post has an image, at a glance
 *   - status dot     : where it is in the pipeline
 *   - kebab          : Duplicate / Delete
 *
 * Deliberately NOT here: a "Post now" action. Publishing is a deliberate act
 * (operator-app.md non-goals), and one-click publish from a calendar chip is
 * exactly how a wrong post ships.
 *
 * [COMP:app-web/plan-slot-chip]
 */

import { Check, MoreHorizontal, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusDot } from "@/components/feed/feed-status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatSlotMinute, type PlanSlot } from "@/lib/feed-plan";
import type { ProposedSlot } from "@/lib/feed-plan-proposal";

/** The drag payload types, so a slot drag and an idea drag never collide. */
export const SLOT_DRAG_TYPE = "application/x-feed-slot";
export const IDEA_DRAG_TYPE = "application/x-feed-idea";

export function PlanSlotChip({
  slot,
  selected,
  canEdit,
  dragging,
  variant = "grid",
  onSelect,
  onDragStart,
  onDragEnd,
  onDuplicate,
  onDelete,
}: {
  slot: PlanSlot;
  selected: boolean;
  canEdit: boolean;
  dragging: boolean;
  /** `grid` is the dense month cell; `row` is the roomier List view line. */
  variant?: "grid" | "row";
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const tp = useT().feedPage.plan;
  const time = formatSlotMinute(slot.scheduledMinute);
  const thumb = slot.media[0];
  const showMenu = canEdit && (onDuplicate || onDelete);

  return (
    <div
      className={cn(
        "group/chip relative flex items-center gap-1.5 rounded-md border transition-colors",
        variant === "grid"
          ? "px-1.5 py-1 text-[11px]"
          : "px-2 py-1.5 text-[12.5px]",
        selected
          ? "border-transparent bg-foreground text-background"
          : "border-border/60 bg-background hover:bg-accent",
        dragging && "opacity-40",
        slot.status === "skipped" && "opacity-60",
      )}
    >
      <button
        type="button"
        draggable={canEdit}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        title={slot.title}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <PlatformIcon
          platform={slot.platform}
          className={cn("shrink-0", variant === "grid" ? "size-3" : "size-3.5")}
        />
        {time ? (
          <span className="shrink-0 tabular-nums opacity-70">{time}</span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            slot.status === "skipped" && "line-through",
          )}
        >
          {slot.title}
        </span>
        {thumb ? (
          <span
            aria-label={tp.hasMedia}
            title={tp.hasMedia}
            className={cn(
              "shrink-0 rounded-[3px] border border-border/60 bg-muted",
              variant === "grid" ? "size-3" : "size-3.5",
            )}
          />
        ) : null}
        {selected ? null : <StatusDot status={slot.status} />}
      </button>

      {showMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={tp.slotActions}
                className={cn(
                  "inline-flex shrink-0 items-center justify-center rounded opacity-0 transition-opacity focus-visible:opacity-100 group-hover/chip:opacity-100",
                  variant === "grid" ? "size-4" : "size-5",
                )}
              >
                <MoreHorizontal className="size-3.5" aria-hidden />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            {onDuplicate ? (
              <DropdownMenuItem onClick={onDuplicate}>
                {tp.duplicateSlot}
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                {tp.deleteSlot}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/**
 * A side-effect-free assistant proposal. It intentionally cannot be dragged
 * and never borrows the solid/status-dot treatment of a persisted plan slot.
 * The two compact actions repeat the rail's explicit write boundary.
 */
export function PlanProposalChip({
  proposal,
  canEdit,
  accepting,
  variant = "grid",
  onAccept,
  onDismiss,
}: {
  proposal: ProposedSlot;
  canEdit: boolean;
  accepting: boolean;
  variant?: "grid" | "row";
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const tp = useT().feedPage.plan;

  return (
    <div
      data-plan-proposal-chip={proposal.index}
      title={tp.proposedDescription}
      className={cn(
        "group/proposal flex min-w-0 items-center gap-1 rounded-md border border-dashed border-foreground/30 bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
        variant === "grid"
          ? "px-1.5 py-1 text-[11px]"
          : "px-2 py-1.5 text-[12.5px]",
        accepting && "opacity-60",
      )}
    >
      <Sparkles
        className={cn("shrink-0", variant === "grid" ? "size-3" : "size-3.5")}
        aria-label={tp.proposedHeading}
      />
      <PlatformIcon
        platform={proposal.platform}
        className={cn("shrink-0", variant === "grid" ? "size-3" : "size-3.5")}
      />
      <span className="min-w-0 flex-1 truncate" title={proposal.title}>
        {proposal.title}
      </span>

      {canEdit ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onAccept}
            disabled={accepting}
            aria-label={`${tp.acceptSlot}: ${proposal.title}`}
            title={tp.acceptSlot}
            className="inline-flex size-4 items-center justify-center rounded transition-colors hover:bg-background disabled:opacity-50"
          >
            <Check className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={accepting}
            aria-label={`${tp.dismissSlot}: ${proposal.title}`}
            title={tp.dismissSlot}
            className="inline-flex size-4 items-center justify-center rounded transition-colors hover:bg-background disabled:opacity-50"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ) : null}
    </div>
  );
}
