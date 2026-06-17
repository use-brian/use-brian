/**
 * Calendar adapter — filter implementations.
 *
 * Pure `(event, params) → boolean` functions registered into the
 * central filter library (WU-3.7, `packages/core/src/ingest/filters.ts`).
 * The rule-evaluation engine looks each `filter_type` up by string key
 * (per migration 130) and calls the matching implementation.
 *
 * Spec: docs/plans/company-brain/ingest.md §Filter library →
 * "Source-specific filters per canonical adapter at launch" (Calendar
 * line 520).
 *
 * Placeholder semantics: `filter_params` values like `:workspace_members`
 * are resolved upstream by the engine (ingest.md:454) before reaching
 * these implementations — filters see fully-resolved string values.
 *
 * [COMP:brain/source-adapters/calendar]
 */

import { z } from 'zod'

import type { CalendarNormalizedEvent } from './types.js'

// ── Param schemas (used at agent tool layer for validation) ──────────

export const attendeeMatchParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type AttendeeMatchParams = z.infer<typeof attendeeMatchParamsSchema>

export const organizerMatchParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type OrganizerMatchParams = z.infer<typeof organizerMatchParamsSchema>

export const subjectContainsParamsSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1),
})
export type SubjectContainsParams = z.infer<typeof subjectContainsParamsSchema>

/** `is_recurring` takes no parameters. */
export const isRecurringParamsSchema = z.object({}).strict()
export type IsRecurringParams = z.infer<typeof isRecurringParamsSchema>

// ── Filter implementations ───────────────────────────────────────────

function lower(s: string): string {
  return s.trim().toLowerCase()
}

export function attendeeMatch(
  event: CalendarNormalizedEvent,
  params: AttendeeMatchParams,
): boolean {
  if (event.attendees.length === 0) return false
  const wanted = new Set(params.values.map(lower))
  for (const a of event.attendees) {
    if (wanted.has(a)) return true
  }
  return false
}

export function organizerMatch(
  event: CalendarNormalizedEvent,
  params: OrganizerMatchParams,
): boolean {
  if (!event.organizer) return false
  const wanted = new Set(params.values.map(lower))
  return wanted.has(event.organizer)
}

export function subjectContains(
  event: CalendarNormalizedEvent,
  params: SubjectContainsParams,
): boolean {
  if (params.keywords.length === 0) return false
  const subject = event.subject.toLowerCase()
  for (const k of params.keywords) {
    if (subject.includes(k.toLowerCase())) return true
  }
  return false
}

export function isRecurring(
  event: CalendarNormalizedEvent,
  _params: IsRecurringParams,
): boolean {
  return event.is_recurring
}

// ── Registry export ──────────────────────────────────────────────────

/**
 * Calendar's source-specific filter set per ingest.md:520. Each entry is
 * keyed by the `filter_type` string stored in `ingest_rules.filter_type`
 * (migration 130). Param values arrive already validated by the agent
 * tool layer using the matching schema above; the implementations
 * trust their inputs.
 */
export const calendarFilterImplementations = {
  attendee_match: attendeeMatch,
  organizer_match: organizerMatch,
  subject_contains: subjectContains,
  is_recurring: isRecurring,
} as const

export type CalendarFilterType = keyof typeof calendarFilterImplementations

export const calendarFilterParamsSchemas = {
  attendee_match: attendeeMatchParamsSchema,
  organizer_match: organizerMatchParamsSchema,
  subject_contains: subjectContainsParamsSchema,
  is_recurring: isRecurringParamsSchema,
} as const
