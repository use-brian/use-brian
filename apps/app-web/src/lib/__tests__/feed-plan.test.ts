import { describe, expect, it } from "vitest";
import {
  WEEK_PX_PER_HOUR,
  addMonths,
  agendaGroups,
  cadenceShortfall,
  compareSlotsInDay,
  deriveSlotStatus,
  emptySlots,
  formatSlotMinute,
  ghostDays,
  minuteFromOffset,
  offsetFromMinute,
  parseSlotMinute,
  timedSlotsOn,
  untimedSlotsOn,
  weekDays,
  weekStart,
  isoDay,
  monthGridDays,
  monthKey,
  PLAN_RAIL_DOCK_CLEARANCE_CLASS,
  parseIsoDay,
  parseMonthKey,
  planCounts,
  slotsByDay,
  type PlanSlot,
} from "@/lib/feed-plan";

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: "slot-1",
    assistantId: "assistant-1",
    platform: "threads",
    scheduledFor: "2026-08-04",
    scheduledMinute: null,
    title: "Launch recap",
    brief: null,
    media: [],
    status: "planned",
    draftId: null,
    sessionId: null,
    createdBy: "user-1",
    createdAt: "2026-07-29T01:00:00Z",
    updatedAt: "2026-07-29T01:00:00Z",
    ...overrides,
  };
}

// Also the unit half of the two Plan surfaces built over these helpers —
// [COMP:app-web/feed-plan-surface] (pure slot/status helpers; the board
// interaction itself is web-QA) and [COMP:app-web/plan-calendar] (the
// month-grid math; drag is web-QA). Their component-map rows point here.
describe("[COMP:app-web/feed-plan] marketing plan helpers", () => {
  it("reserves a bottom lane for the collapsed Feed dock", () => {
    expect(PLAN_RAIL_DOCK_CLEARANCE_CLASS).toBe("pb-20");
  });

  it("formats local calendar days, never UTC", () => {
    // Late-evening local time is the next day in UTC. A slot is a day, so
    // `toISOString()` would move the chip for anyone west of UTC.
    const lateEvening = new Date(2026, 7, 4, 23, 30);
    expect(isoDay(lateEvening)).toBe("2026-08-04");
    expect(monthKey(lateEvening)).toBe("2026-08");
  });

  it("parses month keys and rejects impossible ones", () => {
    expect(parseMonthKey("2026-08")?.getMonth()).toBe(7);
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(parseMonthKey("2026-00")).toBeNull();
    expect(parseMonthKey("nope")).toBeNull();
  });

  it("parses calendar days and rejects days that do not exist", () => {
    expect(parseIsoDay("2026-08-04")?.getDate()).toBe(4);
    expect(parseIsoDay("2028-02-29")?.getDate()).toBe(29);
    expect(parseIsoDay("2026-02-30")).toBeNull();
    expect(parseIsoDay("2026-8-4")).toBeNull();
  });

  it("shifts months across the year boundary in both directions", () => {
    expect(addMonths("2026-08", 1)).toBe("2026-09");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("garbage", 1)).toBe("garbage");
  });

  it("builds a Monday-first grid padded to whole weeks", () => {
    // 2026-08-01 is a Saturday, so the grid starts on Monday 2026-07-27.
    const days = monthGridDays("2026-08", new Date(2026, 7, 4));
    expect(days.length % 7).toBe(0);
    expect(days[0].iso).toBe("2026-07-27");
    expect(days[0].inMonth).toBe(false);
    expect(days.find((d) => d.iso === "2026-08-01")?.inMonth).toBe(true);
    expect(days.find((d) => d.iso === "2026-08-04")?.isToday).toBe(true);
    // Sat/Sun carry the weekend flag so the grid can mute those columns.
    expect(days.find((d) => d.iso === "2026-08-01")?.isWeekend).toBe(true);
    expect(days.find((d) => d.iso === "2026-08-03")?.isWeekend).toBe(false);
  });

  it("trims a trailing week that lies entirely outside the month", () => {
    // 2026-02 starts on a Sunday and has 28 days; a 6th row would be dead.
    const days = monthGridDays("2026-02", new Date(2026, 1, 10));
    expect(days.length).toBe(35);
    expect(days.some((d) => d.inMonth)).toBe(true);
  });

  it("returns an empty grid for a malformed month rather than throwing", () => {
    expect(monthGridDays("2026-13", new Date(2026, 7, 4))).toEqual([]);
  });

  it("groups slots by day preserving each day's order", () => {
    const grouped = slotsByDay([
      slot({ id: "a", scheduledFor: "2026-08-04", title: "First" }),
      slot({ id: "b", scheduledFor: "2026-08-06" }),
      slot({ id: "c", scheduledFor: "2026-08-04", title: "Second" }),
    ]);
    expect(grouped.get("2026-08-04")?.map((s) => s.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(grouped.get("2026-08-06")).toHaveLength(1);
    expect(grouped.get("2026-08-05")).toBeUndefined();
  });

  it("counts slots per status for the rail summary", () => {
    const counts = planCounts([
      slot({ id: "a", status: "planned" }),
      slot({ id: "b", status: "planned" }),
      slot({ id: "c", status: "ready" }),
      slot({ id: "d", status: "skipped" }),
    ]);
    expect(counts).toEqual({
      planned: 2,
      drafting: 0,
      ready: 1,
      posted: 0,
      skipped: 1,
    });
  });

  // The server twin of this table lives in content-plan-store.ts and has its
  // own test. Both are pinned so an optimistic chip never disagrees with the
  // status the refetch brings back.
  it("mirrors the server's status derivation exactly", () => {
    expect(
      deriveSlotStatus({ mark: "planned", draftStatus: "pending", hasSession: true }),
    ).toBe("drafting");
    expect(
      deriveSlotStatus({ mark: "planned", draftStatus: "ready", hasSession: true }),
    ).toBe("ready");
    expect(
      deriveSlotStatus({ mark: "planned", draftStatus: "posted", hasSession: true }),
    ).toBe("posted");
    // A rejected draft leaves the day still needing content.
    expect(
      deriveSlotStatus({ mark: "planned", draftStatus: "rejected", hasSession: true }),
    ).toBe("planned");
    expect(
      deriveSlotStatus({ mark: "planned", draftStatus: null, hasSession: true }),
    ).toBe("drafting");
    expect(
      deriveSlotStatus({ mark: "skipped", draftStatus: null, hasSession: false }),
    ).toBe("skipped");
    // A binding always outranks a stale skip mark.
    expect(
      deriveSlotStatus({ mark: "skipped", draftStatus: "ready", hasSession: true }),
    ).toBe("ready");
  });
});

const TODAY = new Date(2026, 7, 15); // 15 Aug 2026, local

describe("[COMP:app-web/feed-plan] Wall-clock minutes", () => {
  it("formats a minute and renders nothing for no time", () => {
    expect(formatSlotMinute(540)).toBe("09:00");
    expect(formatSlotMinute(570)).toBe("09:30");
    expect(formatSlotMinute(0)).toBe("00:00");
    expect(formatSlotMinute(1439)).toBe("23:59");
    // A slot with no time is a real state; "00:00" would invent one.
    expect(formatSlotMinute(null)).toBeNull();
    expect(formatSlotMinute(1440)).toBeNull();
    expect(formatSlotMinute(-1)).toBeNull();
  });

  it("parses a typed time and treats empty as cleared", () => {
    expect(parseSlotMinute("09:00")).toBe(540);
    expect(parseSlotMinute("9:05")).toBe(545);
    expect(parseSlotMinute("23:59")).toBe(1439);
    expect(parseSlotMinute("  ")).toBeNull();
    expect(parseSlotMinute("24:00")).toBeNull();
    expect(parseSlotMinute("09:60")).toBeNull();
    expect(parseSlotMinute("morning")).toBeNull();
  });

  it("sorts timed slots before untimed ones", () => {
    const a = slot({ id: "a", scheduledMinute: 540 });
    const b = slot({ id: "b", scheduledMinute: null });
    const c = slot({ id: "c", scheduledMinute: 120 });
    expect([a, b, c].sort(compareSlotsInDay).map((s) => s.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("[COMP:app-web/feed-plan] Cadence gap ghosts", () => {
  it("suggests nothing when no cadence is set", () => {
    // The ghost is opt-in: a month with no stated cadence has no gaps.
    expect(ghostDays("2026-08", [], null, TODAY)).toEqual([]);
    expect(ghostDays("2026-08", [], 0, TODAY)).toEqual([]);
  });

  it("suggests days inside the month only", () => {
    const ghosts = ghostDays("2026-08", [], 3, TODAY);
    expect(ghosts.length).toBeGreaterThan(0);
    for (const iso of ghosts) expect(iso.startsWith("2026-08-")).toBe(true);
  });

  it("never suggests a day that already has a slot", () => {
    const first = ghostDays("2026-08", [], 3, TODAY);
    const occupied = first.slice(0, 2).map((iso) => slot({ scheduledFor: iso }));
    const after = ghostDays("2026-08", occupied, 3, TODAY);
    for (const iso of first.slice(0, 2)) expect(after).not.toContain(iso);
  });

  it("shrinks toward zero as the month fills, so a full month shows no gaps", () => {
    const empty = cadenceShortfall("2026-08", [], 3, TODAY);
    const filled = ghostDays("2026-08", [], 3, TODAY).map((iso) =>
      slot({ scheduledFor: iso }),
    );
    expect(cadenceShortfall("2026-08", filled, 3, TODAY)).toBe(0);
    expect(empty).toBeGreaterThan(0);
  });
});

describe("[COMP:app-web/feed-plan] Agenda groups", () => {
  it("lists only days that carry a slot or a gap, in order, time-sorted", () => {
    const slots = [
      slot({ id: "late", scheduledFor: "2026-08-04", scheduledMinute: 870 }),
      slot({ id: "early", scheduledFor: "2026-08-04", scheduledMinute: 540 }),
      slot({ id: "other", scheduledFor: "2026-08-20" }),
    ];
    const groups = agendaGroups("2026-08", slots, null, TODAY);
    expect(groups.map((g) => g.iso)).toEqual(["2026-08-04", "2026-08-20"]);
    expect(groups[0].slots.map((s) => s.id)).toEqual(["early", "late"]);
    expect(groups[0].isGap).toBe(false);
  });

  it("includes a cadence gap as its own empty day", () => {
    const groups = agendaGroups("2026-08", [], 2, TODAY);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.isGap && g.slots.length === 0)).toBe(true);
  });
});

describe("[COMP:app-web/feed-plan] Empty slots for the opt-in fill", () => {
  it("takes only planned, unbound, brief-less slots", () => {
    const candidates = [
      slot({ id: "empty" }),
      slot({ id: "has-brief", brief: "Say the thing" }),
      slot({ id: "drafting", status: "drafting", sessionId: "s-1" }),
      slot({ id: "bound", draftId: "d-1" }),
      // A deliberate skip is a decision the operator already made; refilling
      // it would be the surface overruling them.
      slot({ id: "skipped", status: "skipped" }),
      slot({ id: "posted", status: "posted" }),
    ];
    expect(emptySlots(candidates).map((s) => s.id)).toEqual(["empty"]);
  });
});

describe("[COMP:app-web/plan-week] Week geometry", () => {
  it("anchors the week to its Monday from any day inside it", () => {
    // 2026-08-05 is a Wednesday.
    expect(weekStart("2026-08-05")).toBe("2026-08-03");
    expect(weekStart("2026-08-03")).toBe("2026-08-03");
    expect(weekStart("2026-08-09")).toBe("2026-08-03"); // Sunday
    expect(weekStart("garbage")).toBeNull();
  });

  it("lays out seven Monday-first days and marks the weekend", () => {
    const days = weekDays("2026-08-05", TODAY);
    expect(days).toHaveLength(7);
    expect(days[0].iso).toBe("2026-08-03");
    expect(days[6].iso).toBe("2026-08-09");
    expect(days.filter((d) => d.isWeekend).map((d) => d.iso)).toEqual([
      "2026-08-08",
      "2026-08-09",
    ]);
  });

  it("round-trips a minute through the pixel scale", () => {
    expect(offsetFromMinute(0)).toBe(0);
    expect(offsetFromMinute(60)).toBe(WEEK_PX_PER_HOUR);
    expect(minuteFromOffset(offsetFromMinute(540))).toBe(540);
  });

  it("snaps a drop to a quarter hour", () => {
    // Minute-precision drag is a fight, not a feature.
    const nearlyNine = offsetFromMinute(538);
    expect(minuteFromOffset(nearlyNine)).toBe(540);
    expect(minuteFromOffset(offsetFromMinute(550))).toBe(555);
    expect(minuteFromOffset(offsetFromMinute(547))).toBe(540); // 547.5 is the midpoint
  });

  it("CLAMPS to the day instead of wrapping past midnight", () => {
    // A vertical drag must never change the DATE -- that belongs to
    // scheduledFor. Wrapping here would silently reschedule to tomorrow.
    expect(minuteFromOffset(-500)).toBe(0);
    expect(minuteFromOffset(offsetFromMinute(2000))).toBe(1425); // 23:45
    expect(minuteFromOffset(offsetFromMinute(1440))).toBe(1425);
  });

  it("splits a day's slots into timed and untimed", () => {
    const all = [
      slot({ id: "late", scheduledFor: "2026-08-04", scheduledMinute: 870 }),
      slot({ id: "early", scheduledFor: "2026-08-04", scheduledMinute: 540 }),
      slot({ id: "anytime", scheduledFor: "2026-08-04", scheduledMinute: null }),
      slot({ id: "elsewhere", scheduledFor: "2026-08-05", scheduledMinute: 540 }),
    ];
    expect(timedSlotsOn(all, "2026-08-04").map((s) => s.id)).toEqual([
      "early",
      "late",
    ]);
    // Untimed is a real state, so it gets its own band rather than a fake midnight.
    expect(untimedSlotsOn(all, "2026-08-04").map((s) => s.id)).toEqual(["anytime"]);
  });
});
