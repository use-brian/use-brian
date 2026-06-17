/**
 * Cron expression validator + next-fire preview for the workflow trigger
 * editor (app-web).
 *
 * Ported from `apps/web/src/lib/workflow-cron.ts` (app consolidation §5a).
 * Standard 5-field syntax (minute hour dom month dow); does not support
 * seconds, jitter, or quartz extensions.
 *
 * The validator is permissive enough to accept what `node-cron`-shaped
 * runtimes accept and strict enough to surface obvious typos before the
 * user hits save. The next-fire computer enumerates upcoming minutes from
 * a reference time; bounded at 366 days so a perpetually-impossible
 * expression returns an empty list rather than spinning.
 *
 * Pure functions — no DOM, no network. The component-map tag is
 * `[COMP:app-web/workflow]` (shared with the trigger editor).
 *
 * Spec: docs/architecture/features/workflow.md → Schedule trigger UI.
 */

const RANGE_RE = /^(\*|\d+|\d+-\d+|\*\/\d+)(\/\d+)?$/

const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}

/** Field bounds inclusive on both ends, matching POSIX-ish cron. */
type FieldName = "minute" | "hour" | "dom" | "month" | "dow"
type FieldBounds = { min: number; max: number; names?: Record<string, number> }
const FIELDS: Record<FieldName, FieldBounds> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: MONTH_NAMES },
  dow: { min: 0, max: 6, names: DOW_NAMES },
}

export type CronValidationResult =
  | { valid: true }
  | { valid: false; reason: string }

/**
 * Validate a 5-field cron expression. Returns `{ valid: true }` on success
 * and a `{ valid: false, reason }` describing the first failure otherwise.
 */
export function validateCron(expression: string): CronValidationResult {
  const trimmed = expression.trim()
  if (!trimmed) return { valid: false, reason: "expression is empty" }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return {
      valid: false,
      reason: `expected 5 space-separated fields, got ${parts.length}`,
    }
  }
  const fieldOrder: FieldName[] = ["minute", "hour", "dom", "month", "dow"]
  for (let i = 0; i < 5; i++) {
    const result = validateField(parts[i], FIELDS[fieldOrder[i]], fieldOrder[i])
    if (!result.valid) return result
  }
  return { valid: true }
}

function validateField(
  raw: string,
  bounds: FieldBounds,
  name: FieldName,
): CronValidationResult {
  const segments = raw.split(",")
  if (segments.length === 0 || segments.some((s) => s === "")) {
    return { valid: false, reason: `${name}: empty segment in "${raw}"` }
  }
  for (const seg of segments) {
    const normalized = bounds.names ? replaceNames(seg, bounds.names) : seg
    if (!isValidSegment(normalized, bounds)) {
      return {
        valid: false,
        reason: `${name}: invalid segment "${seg}"`,
      }
    }
  }
  return { valid: true }
}

function replaceNames(input: string, names: Record<string, number>): string {
  let out = input.toUpperCase()
  for (const [name, value] of Object.entries(names)) {
    out = out.replaceAll(name, String(value))
  }
  return out
}

function isValidSegment(seg: string, bounds: FieldBounds): boolean {
  if (!RANGE_RE.test(seg)) return false
  // step part
  let basePart = seg
  let stepPart: number | null = null
  if (seg.includes("/")) {
    const [b, s] = seg.split("/")
    basePart = b
    stepPart = Number(s)
    if (!Number.isInteger(stepPart) || stepPart <= 0) return false
  }
  if (basePart === "*") return true
  if (basePart.includes("-")) {
    const [lo, hi] = basePart.split("-").map(Number)
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false
    if (lo > hi) return false
    return inBounds(lo, bounds) && inBounds(hi, bounds)
  }
  const n = Number(basePart)
  if (!Number.isInteger(n)) return false
  return inBounds(n, bounds)
}

function inBounds(n: number, bounds: FieldBounds): boolean {
  return n >= bounds.min && n <= bounds.max
}

// ── Next-fire preview ──────────────────────────────────────────────────

/**
 * Compute the next N fire times for a cron expression, walking forward
 * from `from`. Returns at most `count` Date objects. Caps the search at
 * 366 days — an unsatisfiable expression returns whatever it found.
 *
 * This is a preview helper, not a scheduler. It evaluates against the
 * provided `from` Date using its local-time getters; the trigger editor
 * passes the user's `new Date()` so the preview matches what they expect.
 */
export function nextFireTimes(
  expression: string,
  from: Date,
  count = 3,
): Date[] {
  const validation = validateCron(expression)
  if (!validation.valid) return []
  const parts = expression.trim().split(/\s+/)
  const allow = {
    minute: expand(parts[0], FIELDS.minute),
    hour: expand(parts[1], FIELDS.hour),
    dom: expand(parts[2], FIELDS.dom),
    month: expand(parts[3], FIELDS.month),
    dow: expand(parts[4], FIELDS.dow),
  }
  const out: Date[] = []
  // Start from the next minute.
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const HARD_CAP_MINUTES = 366 * 24 * 60
  let steps = 0
  while (out.length < count && steps < HARD_CAP_MINUTES) {
    if (
      allow.minute.has(cursor.getMinutes()) &&
      allow.hour.has(cursor.getHours()) &&
      allow.month.has(cursor.getMonth() + 1) &&
      matchesDayOfWeekOrMonth(cursor, allow.dom, allow.dow, parts[2], parts[4])
    ) {
      out.push(new Date(cursor.getTime()))
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
    steps++
  }
  return out
}

function matchesDayOfWeekOrMonth(
  d: Date,
  domAllow: Set<number>,
  dowAllow: Set<number>,
  rawDom: string,
  rawDow: string,
): boolean {
  const dom = d.getDate()
  const dow = d.getDay()
  // POSIX cron semantics: when both dom and dow are restricted (neither
  // is the bare `*`), the fire matches if either matches. Otherwise both
  // must match.
  const domRestricted = rawDom !== "*"
  const dowRestricted = rawDow !== "*"
  if (domRestricted && dowRestricted) {
    return domAllow.has(dom) || dowAllow.has(dow)
  }
  return domAllow.has(dom) && dowAllow.has(dow)
}

function expand(raw: string, bounds: FieldBounds): Set<number> {
  const out = new Set<number>()
  for (const seg of raw.split(",")) {
    const normalized = bounds.names ? replaceNames(seg, bounds.names) : seg
    expandSegment(normalized, bounds, out)
  }
  return out
}

function expandSegment(
  seg: string,
  bounds: FieldBounds,
  out: Set<number>,
): void {
  let step = 1
  let base = seg
  if (seg.includes("/")) {
    const [b, s] = seg.split("/")
    base = b
    step = Number(s)
  }
  let lo: number
  let hi: number
  if (base === "*") {
    lo = bounds.min
    hi = bounds.max
  } else if (base.includes("-")) {
    ;[lo, hi] = base.split("-").map(Number)
  } else {
    lo = Number(base)
    hi = base.includes("/") || step > 1 ? bounds.max : lo
    if (!seg.includes("/")) hi = lo
  }
  for (let n = lo; n <= hi; n += step) out.add(n)
}
