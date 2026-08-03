import { describe, expect, it } from "vitest";
import {
  addMonths,
  deriveSlotStatus,
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
    title: "Launch recap",
    brief: null,
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
