import { describe, it, expect } from "vitest";
import { workflowNextRun, compareByNextRun } from "@/lib/workflow-next-run";
import type { WorkflowTrigger } from "@/lib/api/workflow";

/**
 * [COMP:app-web/workflow-next-run] next-run computation for the Workflow
 * sidebar quick-switcher.
 *
 * `workflowNextRun` derives a sortable next fire time from a `WorkflowTrigger`,
 * or `null` when there's no upcoming run. The behaviour worth pinning: non-
 * schedule triggers and finished one-time runs yield `null`; unsupported cron
 * never throws (it returns `null` so it's safe inside a `.sort()`); daily
 * schedules roll to the next day once today's slot has passed.
 *
 * All assertions pass an explicit `after` so they're deterministic (the module
 * itself defaults `after` to `new Date()`). Times are checked in UTC.
 */
describe("[COMP:app-web/workflow-next-run] workflowNextRun", () => {
  const after = new Date("2026-06-09T12:00:00Z");

  it("returns null for non-schedule triggers", () => {
    expect(workflowNextRun({ kind: "manual" }, after)).toBeNull();
    expect(workflowNextRun({ kind: "webhook" }, after)).toBeNull();
    expect(
      workflowNextRun({ kind: "event", event: { sources: [] } }, after),
    ).toBeNull();
  });

  it("returns null for a schedule trigger missing its schedule payload", () => {
    // Legacy rows can carry kind 'schedule' with no schedule object.
    const trigger = { kind: "schedule" } as unknown as WorkflowTrigger;
    expect(workflowNextRun(trigger, after)).toBeNull();
  });

  it("computes today's daily slot when it's still ahead (UTC)", () => {
    const next = workflowNextRun(
      { kind: "schedule", schedule: { type: "daily", time: "18:00" }, timezone: "UTC" },
      after,
    );
    expect(next?.toISOString()).toBe("2026-06-09T18:00:00.000Z");
  });

  it("rolls a daily schedule to the next day once today's slot has passed", () => {
    const next = workflowNextRun(
      { kind: "schedule", schedule: { type: "daily", time: "09:00" }, timezone: "UTC" },
      after,
    );
    expect(next?.toISOString()).toBe("2026-06-10T09:00:00.000Z");
  });

  it("picks the soonest matching weekday for a weekly schedule", () => {
    // 2026-06-09 is a Tuesday; next Wednesday 10:00 UTC is the 10th.
    const next = workflowNextRun(
      {
        kind: "schedule",
        schedule: { type: "weekly", days: ["wednesday"], time: "10:00" },
        timezone: "UTC",
      },
      after,
    );
    expect(next?.toISOString()).toBe("2026-06-10T10:00:00.000Z");
  });

  it("returns a future moment for a one-time schedule, null once it's passed", () => {
    const future = workflowNextRun(
      { kind: "schedule", schedule: { type: "once", datetime: "2026-06-09T18:00:00" }, timezone: "UTC" },
      after,
    );
    expect(future?.toISOString()).toBe("2026-06-09T18:00:00.000Z");

    const past = workflowNextRun(
      { kind: "schedule", schedule: { type: "once", datetime: "2026-06-09T06:00:00" }, timezone: "UTC" },
      after,
    );
    expect(past).toBeNull();
  });

  it("computes a supported cron expression and returns null for an unsupported one", () => {
    const supported = workflowNextRun(
      { kind: "schedule", schedule: { type: "cron", expression: "0 15 * * *" }, timezone: "UTC" },
      after,
    );
    expect(supported?.toISOString()).toBe("2026-06-09T15:00:00.000Z");

    // A range expression is outside the supported subset → null, not a throw.
    const unsupported = workflowNextRun(
      { kind: "schedule", schedule: { type: "cron", expression: "0 9-17 * * 1-5" }, timezone: "UTC" },
      after,
    );
    expect(unsupported).toBeNull();
  });
});

describe("[COMP:app-web/workflow-next-run] compareByNextRun", () => {
  it("orders soonest first and sinks null to the end", () => {
    const a = new Date("2026-06-09T13:00:00Z");
    const b = new Date("2026-06-09T18:00:00Z");
    expect(compareByNextRun(a, b)).toBeLessThan(0);
    expect(compareByNextRun(b, a)).toBeGreaterThan(0);
    expect(compareByNextRun(a, null)).toBeLessThan(0);
    expect(compareByNextRun(null, b)).toBeGreaterThan(0);
    expect(compareByNextRun(null, null)).toBe(0);
  });
});
