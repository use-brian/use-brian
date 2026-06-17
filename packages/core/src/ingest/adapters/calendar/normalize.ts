/**
 * Calendar adapter — normalization.
 *
 * Maps a raw Google Calendar `Event` resource to the source-normalized
 * shape consumed by the four Calendar filter implementations and the
 * engine's batch accumulator.
 *
 * Pure function — no network, no DB. The webhook receiver (downstream WU,
 * outside `packages/core`) is responsible for verifying the push channel,
 * fetching the event via the Calendar API, and invoking this normalizer.
 *
 * Spec: docs/plans/company-brain/ingest.md §Adapter strategy.
 *
 * [COMP:brain/source-adapters/calendar]
 */

import {
  CALENDAR_EVENT_STATUSES,
  rawCalendarEventSchema,
  type CalendarEventStatus,
  type CalendarNormalizedEvent,
  type RawCalendarEvent,
} from './types.js'

function parseMaybeDate(s: string | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function pickStart(raw: RawCalendarEvent): { date: Date | null; isAllDay: boolean } {
  const dt = raw.start?.dateTime
  if (dt) return { date: parseMaybeDate(dt), isAllDay: false }
  const d = raw.start?.date
  if (d) return { date: parseMaybeDate(d), isAllDay: true }
  return { date: null, isAllDay: false }
}

function pickEnd(raw: RawCalendarEvent): Date | null {
  return parseMaybeDate(raw.end?.dateTime ?? raw.end?.date)
}

function pickStatus(raw: RawCalendarEvent): CalendarEventStatus {
  const s = raw.status
  if (s && (CALENDAR_EVENT_STATUSES as readonly string[]).includes(s)) {
    return s as CalendarEventStatus
  }
  return 'confirmed'
}

function normalizeAttendees(raw: RawCalendarEvent): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of raw.attendees ?? []) {
    const email = a.email?.trim().toLowerCase()
    if (!email) continue
    if (seen.has(email)) continue
    seen.add(email)
    out.push(email)
  }
  return out
}

function normalizeOrganizer(raw: RawCalendarEvent): string {
  return raw.organizer?.email?.trim().toLowerCase() ?? ''
}

function isRecurring(raw: RawCalendarEvent): boolean {
  if (raw.recurringEventId) return true
  if (raw.recurrence && raw.recurrence.length > 0) return true
  return false
}

/**
 * Normalize a Google Calendar `Event` resource into the per-source shape
 * filters operate on.
 *
 * @param raw - parsed Google Calendar event payload. The caller may pass an
 *   already-validated object or one to be validated at the trust boundary
 *   via `rawCalendarEventSchema`. Pass `validate=true` for the latter.
 */
export function normalizeCalendarEvent(
  raw: RawCalendarEvent,
  opts: { validate?: boolean } = {},
): CalendarNormalizedEvent {
  const safe = opts.validate ? rawCalendarEventSchema.parse(raw) : raw

  const { date: start, isAllDay } = pickStart(safe)
  const end = pickEnd(safe)
  const updatedAt = parseMaybeDate(safe.updated) ?? parseMaybeDate(safe.created)
  const occurredAt = start ?? updatedAt ?? new Date(0)

  return {
    external_id: safe.id,
    calendar_id: safe.calendarId ?? 'primary',
    subject: safe.summary ?? '',
    description: safe.description,
    start,
    end,
    is_all_day: isAllDay,
    organizer: normalizeOrganizer(safe),
    attendees: normalizeAttendees(safe),
    is_recurring: isRecurring(safe),
    status: pickStatus(safe),
    location: safe.location,
    occurred_at: occurredAt,
  }
}
