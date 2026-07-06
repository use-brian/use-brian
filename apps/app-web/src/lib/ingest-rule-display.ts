/**
 * Ingest-rule display helpers — the pure humanizing behind the routing-rule
 * read rows in Studio → Events (`IngestRuleEditor`).
 *
 * Two translations, both display-only (the stored rule is never touched;
 * editing still round-trips the raw JSON / cron):
 *
 *   - `humanizeFilterParams` — a rule's `filter_params` JSON → value chips.
 *     Knows the two seeded-placeholder tokens (`:workspace_members`,
 *     `:crm_contacts` — resolved at match time by the API placeholder
 *     resolver) so defaults read as "Workspace members", not a token. Params
 *     whose shape isn't a recognised `values` / `keywords` string list fall
 *     back to compact JSON.
 *
 *   - `describeCronSchedule` — a 5-field cron → a spelled-out phrase for the
 *     common shapes (daily / weekdays / weekends / specific days / monthly /
 *     every-N-minutes / every-N-hours). Anything else returns null and the
 *     caller shows the raw cron. Phrases + weekday names come in as copy so
 *     the helper stays locale-free and pure.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Agent-mediated rule
 * management" (Studio UI).
 *
 * [COMP:app-web/ingest-rule-display]
 */

/** Locale copy for `describeCronSchedule` — templates use {time}/{days}/{day}/{n}. */
export type SchedulePhrases = {
  dailyAt: string;
  weekdaysAt: string;
  weekendsAt: string;
  daysAt: string;
  monthlyAt: string;
  everyNMinutes: string;
  everyNHours: string;
  /** Joiner between weekday names in {days}. */
  dayJoiner: string;
  /** Sunday-first, 7 entries (index 0-6). */
  weekdayNames: readonly string[];
};

export type FilterParamsDisplay =
  | { kind: "none" }
  | { kind: "items"; items: string[] }
  | { kind: "raw"; json: string };

const PARAM_LIST_KEYS = ["values", "keywords"] as const;

/**
 * Flatten `filter_params` into display strings. `placeholderLabels` maps a
 * placeholder token (`":crm_contacts"`) to its human label; unknown values
 * pass through verbatim.
 */
export function humanizeFilterParams(
  params: Record<string, unknown>,
  placeholderLabels: Record<string, string>,
): FilterParamsDisplay {
  const keys = Object.keys(params);
  if (keys.length === 0) return { kind: "none" };
  // Exactly one recognised list key holding a non-empty string/number list —
  // the shape every built-in filter uses. Anything richer shows as JSON.
  if (keys.length === 1 && (PARAM_LIST_KEYS as readonly string[]).includes(keys[0])) {
    const list = params[keys[0]];
    if (
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((v) => typeof v === "string" || typeof v === "number")
    ) {
      return {
        kind: "items",
        items: list.map((v) => placeholderLabels[String(v)] ?? String(v)),
      };
    }
  }
  return { kind: "raw", json: JSON.stringify(params) };
}

/** A field that is a plain non-negative integer (no steps/ranges/lists). */
function num(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

/** Parse a day-of-week list ("1", "1,3,5") into 0-6 indices; null if not one. */
function dayList(field: string): number[] | null {
  if (!/^\d(,\d)*$/.test(field)) return null;
  const days = field.split(",").map(Number);
  if (days.some((d) => d > 7)) return null;
  // Cron allows 7 for Sunday.
  return days.map((d) => (d === 7 ? 0 : d));
}

function timeLabel(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

/**
 * Spell out a 5-field cron in the copy's language, or null when the shape is
 * beyond the vocabulary (caller falls back to the raw expression).
 */
export function describeCronSchedule(
  cron: string,
  phrases: SchedulePhrases,
): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  if (monF !== "*") return null;

  // Interval shapes: */n minutes, or 0 */n hours.
  const minStep = /^\*\/(\d+)$/.exec(minF);
  if (minStep && hourF === "*" && domF === "*" && dowF === "*") {
    return fill(phrases.everyNMinutes, { n: minStep[1] });
  }
  const hourStep = /^\*\/(\d+)$/.exec(hourF);
  if (minF === "0" && hourStep && domF === "*" && dowF === "*") {
    return fill(phrases.everyNHours, { n: hourStep[1] });
  }

  const minute = num(minF);
  const hour = num(hourF);
  if (minute === null || hour === null || minute > 59 || hour > 23) return null;
  const time = timeLabel(hour, minute);

  // Monthly: fixed day-of-month, any weekday.
  const dom = num(domF);
  if (dom !== null && dowF === "*") {
    return fill(phrases.monthlyAt, { day: String(dom), time });
  }
  if (domF !== "*") return null;

  // Daily / weekday-set shapes.
  if (dowF === "*") return fill(phrases.dailyAt, { time });
  if (dowF === "1-5") return fill(phrases.weekdaysAt, { time });
  const days = dayList(dowF);
  if (!days || days.length === 0) return null;
  const uniq = [...new Set(days)];
  if (uniq.length === 2 && uniq.includes(0) && uniq.includes(6)) {
    return fill(phrases.weekendsAt, { time });
  }
  const names = uniq.map((d) => phrases.weekdayNames[d] ?? String(d));
  return fill(phrases.daysAt, { days: names.join(phrases.dayJoiner), time });
}
