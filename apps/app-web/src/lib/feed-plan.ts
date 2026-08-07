/**
 * Marketing-plan pure helpers: month math for the calendar grid and the
 * slot-status vocabulary the chips render.
 *
 * Every function here is pure and unit-tested. `plan-calendar.tsx` holds only
 * rendering and drag state, so the date arithmetic is testable without a DOM
 * (the `[COMP:views/calendar]` convention).
 *
 * Spec: docs/plans/feed-revamp.md §3.1/§5.
 * [COMP:app-web/feed-plan]
 */

import type { FeedPlatform } from "@/lib/feed-nav";

/** The status a slot chip renders. Mirrors `PlanSlotStatus` on the server. */
export type PlanSlotStatus =
  | "planned"
  | "drafting"
  | "ready"
  | "posted"
  | "skipped";

/** The subset the operator can write by hand; everything else is derived. */
export type PlanSlotMark = "planned" | "skipped";

export const PLAN_SLOT_STATUSES: readonly PlanSlotStatus[] = [
  "planned",
  "drafting",
  "ready",
  "posted",
  "skipped",
];

/**
 * The collapsed Feed dock is fixed 1rem from the viewport bottom and can be
 * roughly 3rem tall. Plan's right-rail footers reserve one 5rem lane so their
 * primary action always remains fully visible above it.
 */
export const PLAN_RAIL_DOCK_CLEARANCE_CLASS = "pb-20";

export type PlanSlot = {
  id: string;
  assistantId: string;
  platform: FeedPlatform;
  /** `YYYY-MM-DD`. */
  scheduledFor: string;
  /**
   * Minutes past LOCAL midnight, or null for "that day, no time"
   * (feed-revamp-depth D26). `scheduledFor` still owns which day; this is a
   * label a human reads before posting by hand. Nothing schedules from it.
   */
  scheduledMinute: number | null;
  title: string;
  brief: string | null;
  /** Media on the bound draft, for the chip thumbnail. */
  media: PostMedia[];
  status: PlanSlotStatus;
  draftId: string | null;
  sessionId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlanBrief = {
  assistantId: string;
  monthStart: string;
  brief: string;
  themes: string[];
  /** Posts per week this month intends, or null. Drives the gap ghosts only. */
  cadencePerWeek: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** One image bound to a draft. `fileId` is a `workspace_files` row id. */
export type PostMedia = {
  fileId: string;
  mimeType: string;
  alt?: string;
};

/** Derived server-side from the links and `discarded_at`, never stored. */
export type FeedIdeaStatus = "open" | "promoted" | "discarded";

/**
 * A raw, undated jot in the idea backlog - captured the moment it occurs,
 * developed into a plan slot later. Mirrors `ContentIdea` on the server.
 */
export type FeedIdea = {
  id: string;
  assistantId: string;
  text: string;
  note: string | null;
  platformHint: FeedPlatform | null;
  source: "manual" | "chat" | "inspiration" | "voice";
  status: FeedIdeaStatus;
  slotId: string | null;
  sessionId: string | null;
  discardedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The §5 derivation, client-side. This is a MIRROR of `deriveSlotStatus` in
 * `use-brian/packages/api/src/db/content-plan-store.ts`, not an import:
 * app-web cannot import the server package. The server value is always
 * authoritative — this exists so an optimistic update (bind a session, drop a
 * chip on another day) paints the right state before the refetch lands.
 * Both sides are pinned by their own test against the same table.
 */
export function deriveSlotStatus(input: {
  mark: PlanSlotMark;
  draftStatus: "pending" | "ready" | "posted" | "rejected" | null;
  hasSession: boolean;
}): PlanSlotStatus {
  if (input.draftStatus) {
    switch (input.draftStatus) {
      case "pending":
        return "drafting";
      case "ready":
        return "ready";
      case "posted":
        return "posted";
      case "rejected":
        return "planned";
    }
  }
  if (input.hasSession) return "drafting";
  return input.mark;
}

// ── Month math ────────────────────────────────────────────────────────────
//
// All of it runs on LOCAL calendar days. A slot is a day, not an instant
// (feed-revamp.md §4), so `Date.toISOString()` is never used to format one —
// it would shift the day for anyone west of UTC.

/** Local `YYYY-MM-DD` for a Date. */
export function isoDay(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local `YYYY-MM` for a Date. */
export function monthKey(d: Date): string {
  return isoDay(d).slice(0, 7);
}

/** `YYYY-MM` → the local Date at that month's first day, or null. */
export function parseMonthKey(month: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const monthIndex = Number(m[2]);
  if (monthIndex < 1 || monthIndex > 12) return null;
  return new Date(Number(m[1]), monthIndex - 1, 1);
}

/** `YYYY-MM-DD` → the local Date at that day, or null for impossible days. */
export function parseIsoDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(y, mo - 1, d);
  if (
    probe.getFullYear() !== y ||
    probe.getMonth() !== mo - 1 ||
    probe.getDate() !== d
  ) {
    return null;
  }
  return probe;
}

/** Shift a `YYYY-MM` key by `n` months. */
export function addMonths(month: string, n: number): string {
  const start = parseMonthKey(month);
  if (!start) return month;
  return monthKey(new Date(start.getFullYear(), start.getMonth() + n, 1));
}

/** 0-6 where 0=Mon, 6=Sun. The grid is Monday-first. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export type PlanCalendarDay = {
  /** `YYYY-MM-DD`. */
  iso: string;
  /** Day-of-month numeral. */
  day: number;
  /** False for the leading/trailing days padding the grid corners. */
  inMonth: boolean;
  isToday: boolean;
  /** True for Sat/Sun, so the grid can mute the weekend columns. */
  isWeekend: boolean;
};

/**
 * The Monday-first 7 x (5 or 6) grid covering `month`, padded with the
 * neighbouring days needed to fill the corners. `today` is injectable so the
 * tests are deterministic.
 */
export function monthGridDays(month: string, today: Date): PlanCalendarDay[] {
  const first = parseMonthKey(month);
  if (!first) return [];
  const todayIso = isoDay(today);
  const gridStart = new Date(
    first.getFullYear(),
    first.getMonth(),
    1 - mondayIndex(first),
  );
  // 6 weeks covers every month layout; trim the trailing week when it is
  // entirely outside the month, so a short month does not render a dead row.
  const days: PlanCalendarDay[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    const weekday = d.getDay();
    days.push({
      iso: isoDay(d),
      day: d.getDate(),
      inMonth: d.getMonth() === first.getMonth(),
      isToday: isoDay(d) === todayIso,
      isWeekend: weekday === 0 || weekday === 6,
    });
  }
  const lastWeek = days.slice(35);
  return lastWeek.every((d) => !d.inMonth) ? days.slice(0, 35) : days;
}

/** Group slots by their day, preserving each day's server order. */
export function slotsByDay(
  slots: readonly PlanSlot[],
): Map<string, PlanSlot[]> {
  const map = new Map<string, PlanSlot[]>();
  for (const slot of slots) {
    const bucket = map.get(slot.scheduledFor);
    if (bucket) bucket.push(slot);
    else map.set(slot.scheduledFor, [slot]);
  }
  return map;
}

/** Slot counts per status, for the plan rail's pipeline summary. */
export function planCounts(
  slots: readonly PlanSlot[],
): Record<PlanSlotStatus, number> {
  const counts: Record<PlanSlotStatus, number> = {
    planned: 0,
    drafting: 0,
    ready: 0,
    posted: 0,
    skipped: 0,
  };
  for (const slot of slots) counts[slot.status] += 1;
  return counts;
}

// ── Wall-clock minutes (D26) ────────────────────────────────────────────────

/**
 * `570` -> `"09:00"`. Null renders as nothing, not as midnight: a slot with no
 * time is a real and common state, and showing "00:00" would invent one.
 */
export function formatSlotMinute(minute: number | null): string | null {
  if (minute === null || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 1439) return null;
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * `"09:00"` / `"9:00"` -> `570`. Returns null for empty (the operator clearing
 * the field) and for anything outside a single day. The caller distinguishes
 * "cleared" from "typed nonsense" by checking the raw string itself.
 */
export function parseSlotMinute(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Slots sort by time within a day; untimed slots sit after timed ones. */
export function compareSlotsInDay(a: PlanSlot, b: PlanSlot): number {
  const am = a.scheduledMinute;
  const bm = b.scheduledMinute;
  if (am === null && bm === null) return 0;
  if (am === null) return 1;
  if (bm === null) return -1;
  return am - bm;
}

// ── Cadence gap ghosts (D28) ────────────────────────────────────────────────

/**
 * Days inside `month` the cadence wants and nothing occupies.
 *
 * Deliberately dumb and deliberately client-side: it spreads
 * `cadencePerWeek` evenly across each calendar week, then drops any day that
 * already carries a slot. It suggests and never writes - a ghost is a `+`
 * with a dashed border, not a scheduled post, so being approximately right is
 * the whole requirement. Weekends are skipped unless the cadence is high
 * enough to need them.
 */
export function ghostDays(
  month: string,
  slots: readonly PlanSlot[],
  cadencePerWeek: number | null,
  today: Date,
): string[] {
  if (!cadencePerWeek || cadencePerWeek < 1) return [];
  const grid = monthGridDays(month, today).filter((d) => d.inMonth);
  if (grid.length === 0) return [];
  const taken = new Set(slots.map((s) => s.scheduledFor));

  // Weekday-first candidates, so a 3/week cadence lands Mon/Wed/Fri rather
  // than proposing a Sunday nobody will post on.
  const weekdays = grid.filter((d) => !d.isWeekend);
  const pool = cadencePerWeek > weekdays.length / grid.length * 7 ? grid : weekdays;

  const byWeek = new Map<number, typeof grid>();
  pool.forEach((d, i) => {
    const week = Math.floor(i / Math.max(1, Math.round(pool.length / 4.35)));
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(d);
    else byWeek.set(week, [d]);
  });

  const ghosts: string[] = [];
  for (const week of byWeek.values()) {
    if (week.length === 0) continue;
    const step = week.length / cadencePerWeek;
    for (let i = 0; i < cadencePerWeek; i += 1) {
      const day = week[Math.min(week.length - 1, Math.floor(i * step))];
      if (day && !taken.has(day.iso) && !ghosts.includes(day.iso)) {
        ghosts.push(day.iso);
      }
    }
  }
  return ghosts.sort();
}

/** How many more posts this month would need to hit its cadence. */
export function cadenceShortfall(
  month: string,
  slots: readonly PlanSlot[],
  cadencePerWeek: number | null,
  today: Date,
): number {
  return ghostDays(month, slots, cadencePerWeek, today).length;
}

// ── List view (D25) ─────────────────────────────────────────────────────────

export type PlanAgendaGroup = {
  /** `YYYY-MM-DD`. */
  iso: string;
  day: number;
  isToday: boolean;
  isWeekend: boolean;
  slots: PlanSlot[];
  /** True when the cadence wanted a post here and none exists. */
  isGap: boolean;
};

/**
 * The List view's day groups: every day of the month that carries a slot or a
 * cadence gap, in order, with each day's slots sorted by time. Empty days are
 * omitted - an agenda that lists 31 rows to show 6 posts is a calendar with
 * extra steps.
 */
export function agendaGroups(
  month: string,
  slots: readonly PlanSlot[],
  cadencePerWeek: number | null,
  today: Date,
): PlanAgendaGroup[] {
  const byDay = slotsByDay(slots);
  const gaps = new Set(ghostDays(month, slots, cadencePerWeek, today));
  return monthGridDays(month, today)
    .filter((d) => d.inMonth && (byDay.has(d.iso) || gaps.has(d.iso)))
    .map((d) => ({
      iso: d.iso,
      day: d.day,
      isToday: d.isToday,
      isWeekend: d.isWeekend,
      slots: [...(byDay.get(d.iso) ?? [])].sort(compareSlotsInDay),
      isGap: gaps.has(d.iso),
    }));
}

// ── Fill empty slots (D30) ──────────────────────────────────────────────────

/**
 * Slots the opt-in fill action may propose briefs for: planned, unbound, and
 * not skipped. A slot the operator already drafted or deliberately skipped is
 * not "empty", and rewriting either would be the surface making a decision the
 * operator already made.
 */
export function emptySlots(slots: readonly PlanSlot[]): PlanSlot[] {
  return slots.filter(
    (s) =>
      s.status === "planned" &&
      !s.draftId &&
      !s.sessionId &&
      !(s.brief && s.brief.trim()),
  );
}
