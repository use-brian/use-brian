/**
 * Schedule computation: convert structured schedules to next_run_at timestamps.
 */

export type StructuredSchedule =
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: string[]; time: string }
  | { type: 'monthly'; dayOfMonth: number; time: string }
  | { type: 'cron'; expression: string }
  | { type: 'once'; datetime: string }

const DAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}

/**
 * Compute the next run time from a schedule, in UTC.
 * Uses the job's timezone to interpret the schedule time.
 */
export function computeNextRun(schedule: StructuredSchedule, timezone: string, after?: Date): Date {
  const now = after ?? new Date()

  switch (schedule.type) {
    case 'daily':
      return nextDailyRun(schedule.time, timezone, now)
    case 'weekly':
      return nextWeeklyRun(schedule.days, schedule.time, timezone, now)
    case 'monthly':
      return nextMonthlyRun(schedule.dayOfMonth, schedule.time, timezone, now)
    case 'cron':
      return nextCronRun(schedule.expression, now)
    case 'once':
      return parseOnceDateTime(schedule.datetime, timezone)
  }
}

function nextDailyRun(time: string, timezone: string, after: Date): Date {
  const [hours, minutes] = time.split(':').map(Number)
  const candidate = dateInTimezone(after, timezone, hours, minutes)

  if (candidate > after) return candidate
  // Next day
  return dateInTimezone(new Date(after.getTime() + 24 * 60 * 60 * 1000), timezone, hours, minutes)
}

function nextWeeklyRun(days: string[], time: string, timezone: string, after: Date): Date {
  const [hours, minutes] = time.split(':').map(Number)
  const targetDays = days.map((d) => DAY_MAP[d.toLowerCase()]).filter((d) => d !== undefined).sort()

  if (targetDays.length === 0) return nextDailyRun(time, timezone, after)

  // Check each day for the next 8 days
  for (let offset = 0; offset <= 7; offset++) {
    const checkDate = new Date(after.getTime() + offset * 24 * 60 * 60 * 1000)
    const dayOfWeek = getLocalDay(checkDate, timezone)

    if (targetDays.includes(dayOfWeek)) {
      const candidate = dateInTimezone(checkDate, timezone, hours, minutes)
      if (candidate > after) return candidate
    }
  }

  // Fallback: next week
  return nextWeeklyRun(days, time, timezone, new Date(after.getTime() + 7 * 24 * 60 * 60 * 1000))
}

function nextMonthlyRun(dayOfMonth: number, time: string, timezone: string, after: Date): Date {
  const [hours, minutes] = time.split(':').map(Number)

  // Try this month
  const candidate = dateInTimezoneWithDay(after, timezone, dayOfMonth, hours, minutes)
  if (candidate > after) return candidate

  // Next month
  const nextMonth = new Date(after)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  return dateInTimezoneWithDay(nextMonth, timezone, dayOfMonth, hours, minutes)
}

/**
 * Simple cron parser for basic expressions.
 * Supports: minute hour day-of-month month day-of-week
 * Only handles simple cases:
 *   - `*`  — every tick
 *   - `N`  — a specific value
 *   - `*\/N` — step expression ("every N minutes/hours")
 * Anything else throws `UnsupportedCronExpressionError` so a malformed
 * expression never produces an Invalid Date downstream (pg rejects
 * Invalid Date as 22007).
 */
export class UnsupportedCronExpressionError extends Error {
  constructor(expression: string, reason: string) {
    super(`Unsupported cron expression "${expression}": ${reason}`)
    this.name = 'UnsupportedCronExpressionError'
  }
}

type MinuteSpec = { kind: 'any' } | { kind: 'fixed'; value: number } | { kind: 'step'; step: number }
type HourSpec = { kind: 'any' } | { kind: 'fixed'; value: number } | { kind: 'step'; step: number }

function parseCronField(expr: string, field: 'minute' | 'hour', max: number): MinuteSpec {
  if (expr === '*') return { kind: 'any' }

  const stepMatch = expr.match(/^\*\/(\d+)$/)
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10)
    if (!Number.isInteger(step) || step <= 0 || step > max) {
      throw new UnsupportedCronExpressionError(expr, `${field} step must be a positive integer up to ${max}`)
    }
    return { kind: 'step', step }
  }

  if (/^\d+$/.test(expr)) {
    const value = parseInt(expr, 10)
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new UnsupportedCronExpressionError(expr, `${field} must be 0-${max}`)
    }
    return { kind: 'fixed', value }
  }

  throw new UnsupportedCronExpressionError(expr, `${field} field accepts "*", "N", or "*\/N" only`)
}

function nextCronRun(expression: string, after: Date): Date {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new UnsupportedCronExpressionError(expression, 'cron expression must have 5 space-separated fields')
  }

  const [minExpr, hourExpr] = parts
  const minuteSpec = parseCronField(minExpr, 'minute', 59)
  const hourSpec: HourSpec = parseCronField(hourExpr, 'hour', 23)

  // Advance to the next tick strictly after `after`. We step minute-by-minute
  // from (after + 1 min), rounded down to minute boundary. For practical
  // schedules this loop terminates in at most ~44640 iterations (one month).
  const candidate = new Date(after.getTime() + 60_000)
  candidate.setUTCSeconds(0, 0)

  const maxIterations = 60 * 24 * 32 // a month of minutes — upper bound
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(candidate, minuteSpec, hourSpec)) {
      if (Number.isNaN(candidate.getTime())) {
        throw new UnsupportedCronExpressionError(expression, 'computed run time is Invalid Date')
      }
      return candidate
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  }
  throw new UnsupportedCronExpressionError(expression, 'no matching run within 31 days')
}

function cronMatches(d: Date, minute: MinuteSpec, hour: HourSpec): boolean {
  const m = d.getUTCMinutes()
  const h = d.getUTCHours()
  if (minute.kind === 'fixed' && m !== minute.value) return false
  if (minute.kind === 'step' && m % minute.step !== 0) return false
  if (hour.kind === 'fixed' && h !== hour.value) return false
  if (hour.kind === 'step' && h % hour.step !== 0) return false
  return true
}

/**
 * Parse a once-schedule datetime string. Always interprets the datetime
 * in the user's timezone (provided separately), stripping any Z or offset
 * suffix. This prevents the common LLM mistake of appending "Z" to a
 * local time, which would shift the schedule by the user's UTC offset.
 */
function parseOnceDateTime(datetime: string, timezone: string): Date {
  // Strip any timezone offset — the separate `timezone` param is authoritative.
  // LLMs frequently append "Z" to local times (e.g. "2026-04-16T04:01:00Z"
  // when they mean 04:01 in Asia/Hong_Kong), causing an off-by-N-hours bug.
  const bare = datetime.replace(/Z|[+-]\d{2}:\d{2}$/, '')

  const match = bare.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) {
    return new Date(datetime)
  }

  const [, year, month, day, hoursStr, minutesStr] = match
  const hours = parseInt(hoursStr, 10)
  const minutes = parseInt(minutesStr, 10)

  // Build a date string for the exact calendar date, then use dateInTimezone
  // with a base date that has the correct calendar date in the target timezone.
  // We create a noon-UTC date for that calendar day — noon UTC is the same
  // calendar date in every timezone from UTC-12 to UTC+14.
  const noonUtc = new Date(`${year}-${month}-${day}T12:00:00Z`)
  return dateInTimezone(noonUtc, timezone, hours, minutes)
}

// ── Timezone helpers ───────────────────────────────────────────

function dateInTimezone(baseDate: Date, timezone: string, hours: number, minutes: number): Date {
  const dateStr = baseDate.toLocaleDateString('en-CA', { timeZone: timezone }) // YYYY-MM-DD
  const target = new Date(`${dateStr}T${pad(hours)}:${pad(minutes)}:00`)

  // Convert from local timezone to UTC by computing the offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(target)
  const localStr = `${getPart(parts, 'year')}-${getPart(parts, 'month')}-${getPart(parts, 'day')}T${getPart(parts, 'hour')}:${getPart(parts, 'minute')}:00`

  // Offset = target - local interpretation
  const local = new Date(localStr)
  const offset = target.getTime() - local.getTime()
  return new Date(target.getTime() + offset)
}

function dateInTimezoneWithDay(baseDate: Date, timezone: string, day: number, hours: number, minutes: number): Date {
  const dateStr = baseDate.toLocaleDateString('en-CA', { timeZone: timezone })
  const [year, month] = dateStr.split('-')
  const clampedDay = Math.min(day, daysInMonth(parseInt(year), parseInt(month)))
  const targetStr = `${year}-${month}-${pad(clampedDay)}T${pad(hours)}:${pad(minutes)}:00`
  const target = new Date(targetStr)

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(target)
  const localStr = `${getPart(parts, 'year')}-${getPart(parts, 'month')}-${getPart(parts, 'day')}T${getPart(parts, 'hour')}:${getPart(parts, 'minute')}:00`
  const local = new Date(localStr)
  const offset = target.getTime() - local.getTime()
  return new Date(target.getTime() + offset)
}

function getLocalDay(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' })
  const dayName = formatter.format(date).toLowerCase()
  return DAY_MAP[dayName] ?? 0
}

function getPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '00'
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}
