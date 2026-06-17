import { describe, it, expect } from "vitest";
import { describeCadence } from "@/lib/schedule-cadence";
import type { ScheduleSpec } from "@/lib/api/views";

/**
 * [COMP:app-web/schedule-cadence] cadence normaliser for the page-header
 * schedule badge (migration 229).
 *
 * `describeCadence` turns a `ScheduleSpec` into a locale-agnostic descriptor.
 * The behaviour worth pinning: weekly day-name parsing (→ ordered, de-duped
 * `Date.getDay()` indexes), monthly day-of-month clamping, and a defensive
 * `unknown` for malformed input.
 */
describe("[COMP:app-web/schedule-cadence] describeCadence", () => {
  it("maps daily to its time verbatim", () => {
    expect(describeCadence({ type: "daily", time: "07:00" })).toEqual({
      kind: "daily",
      time: "07:00",
    });
  });

  it("parses weekly day names into ordered weekday indexes (0=Sun)", () => {
    expect(
      describeCadence({ type: "weekly", days: ["friday", "monday"], time: "09:00" }),
    ).toEqual({ kind: "weekly", dayIndexes: [1, 5], time: "09:00" });
  });

  it("de-dupes and ignores unknown / non-string day entries", () => {
    const schedule = {
      type: "weekly",
      // duplicate, mixed-case, whitespace, and a garbage entry
      days: ["Monday", "monday", " tuesday ", "funday", 3],
      time: "08:30",
    } as unknown as ScheduleSpec;
    expect(describeCadence(schedule)).toEqual({
      kind: "weekly",
      dayIndexes: [1, 2],
      time: "08:30",
    });
  });

  it("clamps an out-of-range monthly day-of-month", () => {
    expect(describeCadence({ type: "monthly", dayOfMonth: 99, time: "08:00" })).toEqual({
      kind: "monthly",
      dayOfMonth: 31,
      time: "08:00",
    });
    expect(describeCadence({ type: "monthly", dayOfMonth: 0, time: "08:00" })).toEqual({
      kind: "monthly",
      dayOfMonth: 1,
      time: "08:00",
    });
  });

  it("passes a cron expression through and collapses once to a bare kind", () => {
    expect(describeCadence({ type: "cron", expression: "0 9 */3 * *" })).toEqual({
      kind: "cron",
      expression: "0 9 */3 * *",
    });
    expect(
      describeCadence({ type: "once", datetime: "2026-06-10T15:30:00" }),
    ).toEqual({ kind: "once" });
  });

  it("returns unknown for a malformed schedule rather than throwing", () => {
    expect(describeCadence({ type: "fortnightly" } as unknown as ScheduleSpec)).toEqual({
      kind: "unknown",
    });
  });
});
