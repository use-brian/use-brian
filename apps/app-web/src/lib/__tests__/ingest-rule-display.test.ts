/**
 * Ingest-rule display helpers (app-web).
 * Component tag: [COMP:app-web/ingest-rule-display].
 *
 * Pure unit tests — `ingest-rule-display.ts` has no runtime imports. Covers
 * filter-params flattening (placeholder mapping, keywords, empty, unknown
 * shapes → JSON fallback) and the cron vocabulary (daily / weekdays /
 * weekends / day lists incl. cron's 7=Sunday / monthly / every-N intervals),
 * plus the null fallback for shapes beyond it.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Agent-mediated rule
 * management" (Studio UI).
 */

import { describe, expect, it } from "vitest";
import {
  describeCronSchedule,
  humanizeFilterParams,
  type SchedulePhrases,
} from "../ingest-rule-display";

const PLACEHOLDERS = {
  ":workspace_members": "Workspace members",
  ":crm_contacts": "CRM contacts",
};

const PHRASES: SchedulePhrases = {
  dailyAt: "Daily at {time}",
  weekdaysAt: "Weekdays at {time}",
  weekendsAt: "Weekends at {time}",
  daysAt: "{days} at {time}",
  monthlyAt: "Monthly on day {day} at {time}",
  everyNMinutes: "Every {n} min",
  everyNHours: "Every {n} hours",
  dayJoiner: ", ",
  weekdayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

describe("[COMP:app-web/ingest-rule-display] Ingest rule display helpers", () => {
  it("maps placeholder tokens in values and passes plain values through", () => {
    expect(
      humanizeFilterParams({ values: [":workspace_members", "alice@acme.com"] }, PLACEHOLDERS),
    ).toEqual({ kind: "items", items: ["Workspace members", "alice@acme.com"] });
  });

  it("flattens keywords lists and stringifies numbers", () => {
    expect(humanizeFilterParams({ keywords: ["urgent", 2] }, PLACEHOLDERS)).toEqual({
      kind: "items",
      items: ["urgent", "2"],
    });
  });

  it("returns none for empty params and raw JSON for unknown shapes", () => {
    expect(humanizeFilterParams({}, PLACEHOLDERS)).toEqual({ kind: "none" });
    expect(humanizeFilterParams({ values: [] }, PLACEHOLDERS)).toEqual({
      kind: "raw",
      json: '{"values":[]}',
    });
    expect(
      humanizeFilterParams({ values: ["x"], extra: true }, PLACEHOLDERS),
    ).toEqual({ kind: "raw", json: '{"values":["x"],"extra":true}' });
    expect(humanizeFilterParams({ min_attendees: 3 }, PLACEHOLDERS)).toEqual({
      kind: "raw",
      json: '{"min_attendees":3}',
    });
  });

  it("spells out the common cron shapes", () => {
    expect(describeCronSchedule("0 8 * * *", PHRASES)).toBe("Daily at 8:00");
    expect(describeCronSchedule("30 18 * * 1-5", PHRASES)).toBe("Weekdays at 18:30");
    expect(describeCronSchedule("0 10 * * 0,6", PHRASES)).toBe("Weekends at 10:00");
    expect(describeCronSchedule("0 9 * * 1,3", PHRASES)).toBe("Mon, Wed at 9:00");
    expect(describeCronSchedule("0 9 * * 7", PHRASES)).toBe("Sun at 9:00");
    expect(describeCronSchedule("15 7 1 * *", PHRASES)).toBe(
      "Monthly on day 1 at 7:15",
    );
    expect(describeCronSchedule("*/15 * * * *", PHRASES)).toBe("Every 15 min");
    expect(describeCronSchedule("0 */6 * * *", PHRASES)).toBe("Every 6 hours");
  });

  it("returns null for shapes beyond the vocabulary (caller shows raw cron)", () => {
    expect(describeCronSchedule("0 9 * 1 *", PHRASES)).toBeNull(); // fixed month
    expect(describeCronSchedule("0 9 1 * 1", PHRASES)).toBeNull(); // dom + dow
    expect(describeCronSchedule("0,30 9 * * *", PHRASES)).toBeNull(); // minute list
    expect(describeCronSchedule("0 25 * * *", PHRASES)).toBeNull(); // invalid hour
    expect(describeCronSchedule("0 9 * *", PHRASES)).toBeNull(); // 4 fields
    expect(describeCronSchedule("0 9 * * 8", PHRASES)).toBeNull(); // bad day
  });
});
