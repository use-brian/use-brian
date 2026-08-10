"use client";

/**
 * The Week view (feed-revamp-depth D25, deferred at lock and built after).
 *
 * This is the view whose payload is drag-to-set-time: a vertical drag moves a
 * post within its day, a horizontal one moves it between days, and both can
 * happen in a single gesture. That is the only reason Week earns a slot the
 * Month and List views do not already fill.
 *
 * Two rules the geometry has to hold, both in `lib/feed-plan.ts` so they are
 * unit-tested rather than eyeballed:
 *   - a vertical drag CLAMPS to its day (23:45 max). Wrapping past midnight
 *     would silently reschedule to another date, and the date belongs to
 *     `scheduledFor`, not to how far the mouse travelled.
 *   - the drop snaps to a quarter hour. Minute-precision drag is a fight.
 *
 * Untimed slots are a first-class state, so they sit in an all-day band above
 * the grid rather than being forced to a fake midnight.
 *
 * [COMP:app-web/plan-week]
 */

import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { PlanSlotChip, SLOT_DRAG_TYPE } from "@/components/feed/plan-slot-chip";
import {
  WEEK_PX_PER_HOUR,
  formatSlotMinute,
  minuteFromOffset,
  offsetFromMinute,
  timedSlotsOn,
  untimedSlotsOn,
  weekDays,
  type PlanSlot,
} from "@/lib/feed-plan";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function PlanWeek({
  anchorIso,
  slots,
  today,
  selectedSlotId,
  canEdit,
  onAnchorChange,
  onSelectSlot,
  onMoveSlot,
  onDuplicateSlot,
  onDeleteSlot,
}: {
  /** Any day inside the week to show. */
  anchorIso: string;
  slots: readonly PlanSlot[];
  today: Date;
  selectedSlotId: string | null;
  canEdit: boolean;
  onAnchorChange: (iso: string) => void;
  onSelectSlot: (slot: PlanSlot) => void;
  /** One write for both axes: a drag can change the day AND the minute. */
  onMoveSlot: (slot: PlanSlot, iso: string, minute: number | null) => void;
  onDuplicateSlot: (slot: PlanSlot) => void;
  onDeleteSlot: (slot: PlanSlot) => void;
}) {
  const tp = useT().feedPage.plan;
  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const days = useMemo(() => weekDays(anchorIso, today), [anchorIso, today]);
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }),
    [],
  );

  function shiftWeek(deltaDays: number) {
    const first = days[0];
    if (!first) return;
    const d = new Date(`${first.iso}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    onAnchorChange(d.toISOString().slice(0, 10));
  }

  function dropOnColumn(e: React.DragEvent, iso: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData(SLOT_DRAG_TYPE) || dragSlotId;
    setDragSlotId(null);
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    const column = columnRefs.current[iso];
    if (!column) return;
    const rect = column.getBoundingClientRect();
    const minute = minuteFromOffset(e.clientY - rect.top);
    if (slot.scheduledFor === iso && slot.scheduledMinute === minute) return;
    onMoveSlot(slot, iso, minute);
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => shiftWeek(-7)}
          aria-label={tp.previousWeek}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onAnchorChange(today.toISOString().slice(0, 10))}
          className="h-7 rounded-md px-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {tp.today}
        </button>
        <button
          type="button"
          onClick={() => shiftWeek(7)}
          aria-label={tp.nextWeek}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 shadow-xs">
        <div className="grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border/60 bg-muted/30">
          <div />
          {days.map((day) => (
            <div
              key={day.iso}
              className={cn(
                "px-2 py-1.5 text-[11px] font-medium",
                day.isToday ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {dayFormat.format(new Date(`${day.iso}T00:00:00`))}
            </div>
          ))}
        </div>

        {/* All-day band: untimed slots are a real state, not a fake midnight. */}
        <div className="grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border/60">
          <div className="px-1 py-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {tp.allDay}
          </div>
          {days.map((day) => (
            <div
              key={day.iso}
              onDragOver={(e) => canEdit && e.preventDefault()}
              onDrop={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                const id = e.dataTransfer.getData(SLOT_DRAG_TYPE) || dragSlotId;
                setDragSlotId(null);
                const slot = slots.find((s) => s.id === id);
                if (slot) onMoveSlot(slot, day.iso, null);
              }}
              className="min-h-[28px] space-y-1 border-l border-border/60 p-1"
            >
              {untimedSlotsOn(slots, day.iso).map((slot) => (
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
                  }}
                  onDragEnd={() => setDragSlotId(null)}
                  onDuplicate={() => onDuplicateSlot(slot)}
                  onDelete={() => onDeleteSlot(slot)}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="max-h-[520px] overflow-y-auto">
          <div className="grid grid-cols-[3rem_repeat(7,1fr)]">
            <div>
              {HOURS.map((h) => (
                <div
                  key={h}
                  style={{ height: WEEK_PX_PER_HOUR }}
                  className="pr-1 text-right text-[10px] tabular-nums text-muted-foreground"
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {days.map((day) => (
              <div
                key={day.iso}
                ref={(el) => {
                  columnRefs.current[day.iso] = el;
                }}
                onDragOver={(e) => canEdit && e.preventDefault()}
                onDrop={(e) => canEdit && dropOnColumn(e, day.iso)}
                className={cn(
                  "relative border-l border-border/60",
                  day.isWeekend && "bg-muted/10",
                )}
                style={{ height: WEEK_PX_PER_HOUR * 24 }}
              >
                {HOURS.map((h) => (
                  <div
                    key={h}
                    style={{ height: WEEK_PX_PER_HOUR }}
                    className="border-b border-border/40"
                  />
                ))}

                {timedSlotsOn(slots, day.iso).map((slot) => (
                  <div
                    key={slot.id}
                    style={{
                      position: "absolute",
                      top: offsetFromMinute(slot.scheduledMinute ?? 0),
                      left: 2,
                      right: 2,
                    }}
                    title={`${formatSlotMinute(slot.scheduledMinute) ?? ""} ${slot.title}`}
                  >
                    <PlanSlotChip
                      slot={slot}
                      selected={selectedSlotId === slot.id}
                      canEdit={canEdit}
                      dragging={dragSlotId === slot.id}
                      onSelect={() => onSelectSlot(slot)}
                      onDragStart={(e) => {
                        setDragSlotId(slot.id);
                        e.dataTransfer.setData(SLOT_DRAG_TYPE, slot.id);
                      }}
                      onDragEnd={() => setDragSlotId(null)}
                      onDuplicate={() => onDuplicateSlot(slot)}
                      onDelete={() => onDeleteSlot(slot)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
