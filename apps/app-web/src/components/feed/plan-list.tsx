"use client";

/**
 * The Plan surface's List view (feed-revamp-depth D25): a day-grouped agenda
 * over the same month, the same chips, and the same actions as the grid.
 *
 * It exists because the month grid answers "what does August look like" and
 * cannot answer "what is next" - a 7x5 grid of three-line cells makes the
 * reader do the scanning. This is that second question, and it is the whole
 * reason the view switcher is worth two options rather than seven: Grid,
 * Table and Compact would be these same rows in different chrome.
 *
 * Empty days are omitted. An agenda that lists 31 rows to show 6 posts is a
 * calendar with extra steps. Cadence gaps DO get a row, because a missing post
 * is the thing the operator most needs to see in a list.
 *
 * [COMP:app-web/plan-list]
 */

import { useMemo } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { PlanSlotChip, SLOT_DRAG_TYPE } from "@/components/feed/plan-slot-chip";
import { agendaGroups, parseIsoDay, type PlanSlot } from "@/lib/feed-plan";

export function PlanList({
  month,
  slots,
  cadencePerWeek,
  today,
  selectedSlotId,
  canEdit,
  onAddOnDay,
  onSelectSlot,
  onDuplicateSlot,
  onDeleteSlot,
}: {
  month: string;
  slots: readonly PlanSlot[];
  cadencePerWeek: number | null;
  today: Date;
  selectedSlotId: string | null;
  canEdit: boolean;
  onAddOnDay: (iso: string) => void;
  onSelectSlot: (slot: PlanSlot) => void;
  onDuplicateSlot: (slot: PlanSlot) => void;
  onDeleteSlot: (slot: PlanSlot) => void;
}) {
  const tp = useT().feedPage.plan;
  const groups = useMemo(
    () => agendaGroups(month, slots, cadencePerWeek, today),
    [month, slots, cadencePerWeek, today],
  );

  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }),
    [],
  );

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-border/60 p-6 text-center text-[12.5px] text-muted-foreground shadow-xs">
        {tp.listEmpty}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 shadow-xs">
      {groups.map((group, i) => {
        const date = parseIsoDay(group.iso);
        return (
          <div
            key={group.iso}
            className={cn(
              "flex gap-3 px-3 py-2.5",
              i > 0 && "border-t border-border/60",
              group.isWeekend && "bg-muted/10",
            )}
          >
            <div className="w-28 shrink-0 pt-1">
              <span
                className={cn(
                  "text-[12.5px] tabular-nums",
                  group.isToday
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {date ? dayFormat.format(date) : group.iso}
              </span>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {group.slots.map((slot) => (
                <PlanSlotChip
                  key={slot.id}
                  slot={slot}
                  variant="row"
                  selected={selectedSlotId === slot.id}
                  canEdit={canEdit}
                  dragging={false}
                  onSelect={() => onSelectSlot(slot)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SLOT_DRAG_TYPE, slot.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {}}
                  onDuplicate={() => onDuplicateSlot(slot)}
                  onDelete={() => onDeleteSlot(slot)}
                />
              ))}

              {group.isGap ? (
                // A suggestion, never a post. Dashed, muted, and it writes
                // nothing until the operator clicks it.
                <button
                  type="button"
                  onClick={() => canEdit && onAddOnDay(group.iso)}
                  disabled={!canEdit}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
                >
                  <Plus className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{tp.gapSuggestion}</span>
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
