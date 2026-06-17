/**
 * Calendar adapter — types.
 *
 * `CalendarNormalizedEvent` is the per-source normalized shape the four
 * Calendar filter implementations (`attendee_match`, `organizer_match`,
 * `subject_contains`, `is_recurring`) operate on. It is also the shape
 * accumulated into `pending_ingest_batches.events` (JSONB) by the engine
 * when a rule routes to `scheduled` mode.
 *
 * The minimal Google Calendar `Event` resource Zod schema below validates
 * adapter inputs at the trust boundary, matching the fields the
 * normalize step actually reads (everything else from the upstream
 * payload is dropped). It deliberately stops short of the full Calendar
 * API schema — broadening it later is additive.
 *
 * Spec: docs/plans/company-brain/ingest.md §Adapter strategy + §Default
 * rule templates per source → Calendar. Locked vocabulary check:
 * the four filters live in ingest.md:520.
 *
 * [COMP:brain/source-adapters/calendar]
 */

import { z } from 'zod'

// ── Normalized event shape ───────────────────────────────────────────

/**
 * Locked Google Calendar `Event.status` vocabulary. `cancelled` flows
 * through the adapter unchanged — the engine / Pipeline B decides
 * whether to drop it.
 */
export const CALENDAR_EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const
export type CalendarEventStatus = typeof CALENDAR_EVENT_STATUSES[number]

export type CalendarNormalizedEvent = {
  external_id: string
  calendar_id: string
  subject: string
  description?: string
  start: Date | null
  end: Date | null
  is_all_day: boolean
  organizer: string
  attendees: string[]
  is_recurring: boolean
  status: CalendarEventStatus
  location?: string
  occurred_at: Date
}

// ── Raw Google Calendar Event resource (minimal) ─────────────────────

const rawDateOrDateTimeSchema = z
  .object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .optional()

const rawAttendeeSchema = z.object({
  email: z.string().min(1).optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
})

const rawOrganizerSchema = z
  .object({
    email: z.string().min(1).optional(),
    displayName: z.string().optional(),
    self: z.boolean().optional(),
  })
  .optional()

/**
 * The Google Calendar API `Event` resource carries far more fields than
 * the ingest pipeline needs. This schema accepts a permissive shape with
 * `.passthrough()` so unknown keys (`htmlLink`, `creator`, `iCalUID`,
 * `etag`, etc.) don't fail validation, while still type-checking the
 * fields normalize actually reads.
 */
export const rawCalendarEventSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    status: z.string().optional(),
    start: rawDateOrDateTimeSchema,
    end: rawDateOrDateTimeSchema,
    organizer: rawOrganizerSchema,
    attendees: z.array(rawAttendeeSchema).optional(),
    recurrence: z.array(z.string().min(1)).optional(),
    recurringEventId: z.string().min(1).optional(),
    updated: z.string().optional(),
    created: z.string().optional(),
    // Calendar context, supplied by the receiver when fetching from the API.
    // Not part of the Google `Event` resource itself.
    calendarId: z.string().min(1).optional(),
  })
  .passthrough()

export type RawCalendarEvent = z.infer<typeof rawCalendarEventSchema>
