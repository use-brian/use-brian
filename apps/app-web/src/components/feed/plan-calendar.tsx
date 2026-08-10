"use client";

/**
 * The marketing calendar: a Monday-first month grid whose day cells hold plan
 * slots (feed-revamp.md §3.1).
 *
 * Purpose-built rather than the A2UI `Calendar` widget (D11/§7): that widget's
 * day chips render only the title column's text, and a marketing chip has to
 * carry the platform glyph and the status dot or "what is going out on
 * Thursday" is unreadable. All date arithmetic lives in `lib/feed-plan.ts` as
 * pure functions, so this file is rendering and drag state only.
 *
 * Interactions:
 *   - Hover a day  -> a `+` fades in (the Notion add-entry gesture)
 *   - Click a chip -> `onSelectSlot`
 *   - Drag a chip onto another day -> `onReschedule`; the parent moves the
 *     slot optimistically and snaps it back if the write fails
 *   - `< Today >`  -> `onMonthChange`
 *
 * [COMP:app-web/plan-calendar]
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  IDEA_DRAG_TYPE,
  PlanSlotChip,
  SLOT_DRAG_TYPE,
} from "@/components/feed/plan-slot-chip";
import {
  addMonths,
  compareSlotsInDay,
  ghostDays,
  monthGridDays,
  parseMonthKey,
  slotsByDay,
  type PlanSlot,
} from "@/lib/feed-plan";

/** Chips a day cell shows before collapsing the rest into a "+N" pill. */
const MAX_CHIPS_PER_DAY = 3;

export function PlanCalendar({
  month,
  slots,
  today,
  selectedSlotId,
  canEdit,
  onMonthChange,
  onAddOnDay,
  onSelectSlot,
  onReschedule,
  cadencePerWeek = null,
  onDuplicateSlot,
  onDeleteSlot,
  onDropIdea,
}: {
  /** `YYYY-MM`. */
  month: string;
  slots: readonly PlanSlot[];
  /** Drives the dashed gap ghosts (D28). Null means no cadence, no ghosts. */
  cadencePerWeek?: number | null;
  onDuplicateSlot?: (slot: PlanSlot) => void;
  onDeleteSlot?: (slot: PlanSlot) => void;
  /**
   * An idea chip was dropped on a day. The parent opens the prefilled slot
   * editor dated to that day rather than writing (D27) - a slipped mouse must
   * never schedule anything.
   */
  onDropIdea?: (ideaId: string, iso: string) => void;
  /** Injected so the grid is deterministic in tests. */
  today: Date;
  selectedSlotId: string | null;
  canEdit: boolean;
  onMonthChange: (month: string) => void;
  onAddOnDay: (iso: string) => void;
  onSelectSlot: (slot: PlanSlot) => void;
  onReschedule: (slot: PlanSlot, iso: string) => void;
}) {
  const t = useT().feedPage;
  const tp = t.plan;
  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);

  const days = useMemo(() => monthGridDays(month, today), [month, today]);
  const byDay = useMemo(() => slotsByDay(slots), [slots]);
  const ghosts = useMemo(
    () => new Set(ghostDays(month, slots, cadencePerWeek, today)),
    [month, slots, cadencePerWeek, today],
  );

  // Locale-aware month name and weekday headers, matching how the rest of the
  // app formats dates. Falls back to the raw key if the month is malformed.
  const monthDate = parseMonthKey(month);
  const monthLabel = monthDate
    ? new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(monthDate)
    : month;
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    // 2024-01-01 was a Monday, so this walks Mon..Sun in the user's locale.
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(2024, 0, 1 + i)),
    );
  }, []);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">{monthLabel}</h2>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onMonthChange(addMonths(month, -1))}
            aria-label={tp.previousMonth}
            title={tp.previousMonth}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() =>
              onMonthChange(
                `${String(today.getFullYear()).padStart(4, "0")}-${String(
                  today.getMonth() + 1,
                ).padStart(2, "0")}`,
              )
            }
            className="h-7 rounded-md px-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {tp.today}
          </button>
          <button
            type="button"
            onClick={() => onMonthChange(addMonths(month, 1))}
            aria-label={tp.nextMonth}
            title={tp.nextMonth}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 shadow-xs">
        <div className="grid grid-cols-7 border-b border-border/60 bg-muted/30">
          {weekdayLabels.map((label) => (
            <div
              key={label}
              className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {days.map((day) => {
            const daySlots = [...(byDay.get(day.iso) ?? [])].sort(
              compareSlotsInDay,
            );
            const shown = daySlots.slice(0, MAX_CHIPS_PER_DAY);
            const overflow = daySlots.length - shown.length;
            const isDropTarget = dragOverDay === day.iso;
            return (
              <div
                key={day.iso}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  // Two different things can land on a day, so the cell reads
                  // the payload TYPE rather than assuming a slot drag (D40).
                  const kinds = e.dataTransfer.types;
                  const carries =
                    kinds.includes(SLOT_DRAG_TYPE) ||
                    kinds.includes(IDEA_DRAG_TYPE);
                  if (!carries && !dragSlotId) return;
                  // Only preventDefault marks the cell as a valid drop target.
                  e.preventDefault();
                  setDragOverDay(day.iso);
                }}
                onDragLeave={() =>
                  setDragOverDay((d) => (d === day.iso ? null : d))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverDay(null);
                  const ideaId = e.dataTransfer.getData(IDEA_DRAG_TYPE);
                  if (ideaId) {
                    setDragSlotId(null);
                    onDropIdea?.(ideaId, day.iso);
                    return;
                  }
                  const draggedId =
                    e.dataTransfer.getData(SLOT_DRAG_TYPE) || dragSlotId;
                  const slot = slots.find((s) => s.id === draggedId);
                  setDragSlotId(null);
                  // A drop back on the same day is a no-op, not a write.
                  if (slot && slot.scheduledFor !== day.iso) {
                    onReschedule(slot, day.iso);
                  }
                }}
                className={cn(
                  "group/day relative flex min-h-[104px] flex-col gap-1 border-b border-r border-border/60 p-1.5 transition-colors",
                  !day.inMonth && "bg-muted/20",
                  day.isWeekend && day.inMonth && "bg-muted/10",
                  isDropTarget && "bg-accent",
                )}
              >
                <div className="flex items-center justify-between">
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => onAddOnDay(day.iso)}
                      aria-label={tp.addOnDay}
                      title={tp.addOnDay}
                      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/day:opacity-100"
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </button>
                  ) : (
                    <span className="size-5" aria-hidden />
                  )}
                  <span
                    className={cn(
                      "inline-flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums",
                      day.isToday
                        ? "bg-foreground font-semibold text-background"
                        : day.inMonth
                          ? "text-muted-foreground"
                          : "text-muted-foreground/50",
                    )}
                  >
                    {day.day}
                  </span>
                </div>

                <div className="flex min-h-0 flex-col gap-1">
                  {shown.map((slot) => (
                    <PlanSlotChip
                      key={slot.id}
                      slot={slot}
                      selected={selectedSlotId === slot.id}
                      canEdit={canEdit}
                      dragging={dragSlotId === slot.id}
                      onSelect={() => onSelectSlot(slot)}
                      onDragStart={(e) => {
                        setDragSlotId(slot.id);
                        e.dataTransfer.setData(SLOT_DRAG_TYPE, slot.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragSlotId(null);
                        setDragOverDay(null);
                      }}
                      onDuplicate={
                        onDuplicateSlot ? () => onDuplicateSlot(slot) : undefined
                      }
                      onDelete={
                        onDeleteSlot ? () => onDeleteSlot(slot) : undefined
                      }
                    />
                  ))}
                  {daySlots.length === 0 && ghosts.has(day.iso) && canEdit ? (
                    // A cadence suggestion, not a post: dashed, muted, and it
                    // writes nothing until clicked (D28).
                    <button
                      type="button"
                      onClick={() => onAddOnDay(day.iso)}
                      title={tp.gapSuggestion}
                      className="flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Plus className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{tp.gapShort}</span>
                    </button>
                  ) : null}
                  {overflow > 0 ? (
                    <button
                      type="button"
                      onClick={() => onSelectSlot(daySlots[MAX_CHIPS_PER_DAY])}
                      className="rounded-md px-1.5 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {tp.moreOnDay.replace("{count}", String(overflow))}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
