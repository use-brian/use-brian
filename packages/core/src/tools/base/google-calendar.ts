/**
 * Google Calendar tools — list, get, and create events.
 *
 * Read tools are concurrency-safe; create requires confirmation.
 * The `callApi` callback is injected by the API layer so core stays
 * free of network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str, asRows } from './_connector-result.js'

export type GoogleCalendarApi = {
  listEvents(params: {
    timeMin?: string
    timeMax?: string
    calendarId?: string
    maxResults?: number
    query?: string
    timeZone?: string
  }): Promise<unknown>

  getEvent(eventId: string, calendarId?: string): Promise<unknown>

  createEvent(event: {
    summary: string
    start: string
    end: string
    description?: string
    location?: string
    attendees?: string[]
  }): Promise<unknown>

  updateEvent(eventId: string, updates: {
    summary?: string
    start?: string
    end?: string
    description?: string
    location?: string
    attendees?: string[]
    responseStatus?: 'accepted' | 'declined' | 'tentative'
  }): Promise<unknown>

  deleteEvent(eventId: string, calendarId?: string): Promise<void>
}

/**
 * Format an ISO datetime string into a human-readable local time.
 * Prevents the LLM from doing (often wrong) timezone math.
 */
function formatEventTime(isoString: string | undefined, tz: string): string | undefined {
  if (!isoString) return undefined
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return isoString
    return d.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
  } catch {
    return isoString
  }
}

type EventLike = {
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  [key: string]: unknown
}

/**
 * Project a raw Google Calendar event to the documented concise shape
 * (title, times, location, attendees) plus the pre-formatted local times.
 * Raw events carry ~40 fields (iCalUID, sequence, reminders, etag, creator,
 * full attendee objects, …) the model never needs. `full=true` keeps the
 * description + organizer for single-event reads. See `_connector-result.ts`.
 */
function projectEvent(evt: Json, tz: string, full = false): Json {
  const e = evt as EventLike
  const base: Json = {
    id: str(evt, 'id'),
    summary: str(evt, 'summary'),
    localStart: formatEventTime(e.start?.dateTime, tz) ?? e.start?.date,
    localEnd: formatEventTime(e.end?.dateTime, tz) ?? e.end?.date,
    location: str(evt, 'location'),
    status: str(evt, 'status'),
    attendees: asRows(evt.attendees).map((a) => ({
      email: str(a, 'email'),
      responseStatus: str(a, 'responseStatus'),
    })),
    htmlLink: str(evt, 'htmlLink'),
  }
  if (full) {
    base.description = str(evt, 'description')
    base.organizer = str((evt.organizer ?? {}) as Json, 'email')
    base.hangoutLink = str(evt, 'hangoutLink')
  }
  return base
}

/** Project + add `localStart` / `localEnd` to each event in a list. */
function enrichEventsWithLocalTime(events: unknown, tz: string): unknown {
  if (!Array.isArray(events)) return events
  return asRows(events).map((evt) => projectEvent(evt, tz))
}

function enrichEventWithLocalTime(evt: unknown, tz: string): unknown {
  if (!evt || typeof evt !== 'object') return evt
  return projectEvent(evt as Json, tz, true)
}

export function createGoogleCalendarTools(api: GoogleCalendarApi, userTimezone?: string): Tool[] {
  const listEvents = buildTool({
    name: 'googleCalendarListEvents',
    description:
      'List upcoming Google Calendar events. Returns event titles, times, locations, and attendees. ' +
      'Use ISO 8601 format for timeMin/timeMax (e.g. "2026-04-10T00:00:00Z"). ' +
      'IMPORTANT: Each event includes a `localStart` and `localEnd` field with the time already converted to the user\'s timezone — always use these for display instead of doing timezone math yourself.',
    inputSchema: z.object({
      timeMin: z.string().optional().describe('Start of time range (ISO 8601). Defaults to now.'),
      timeMax: z.string().optional().describe('End of time range (ISO 8601). Defaults to 7 days from now.'),
      query: z.string().optional().describe('Free text search term to filter events.'),
      maxResults: z.number().optional().describe('Max events to return (default 20).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.listEvents({
          timeMin: input.timeMin ?? new Date().toISOString(),
          timeMax: input.timeMax,
          query: input.query,
          maxResults: input.maxResults,
          timeZone: userTimezone,
        })
        return { data: enrichEventsWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) {
        return { data: `Calendar error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getEvent = buildTool({
    name: 'googleCalendarGetEvent',
    description: 'Get details of a specific Google Calendar event by ID.',
    inputSchema: z.object({
      eventId: z.string().describe('The event ID to fetch.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getEvent(input.eventId)
        return { data: enrichEventWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) {
        return { data: `Calendar error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createEvent = buildTool({
    name: 'googleCalendarCreateEvent',
    description:
      'Create a new Google Calendar event. ' +
      'Use ISO 8601 datetime format for start/end (e.g. "2026-04-15T14:00:00+08:00"). ' +
      'IMPORTANT: Before computing dates for "today", "tomorrow", "next Monday", etc., use the current date from User Context. If unsure, call getTime first. Never guess the date. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      summary: z.string().describe('Event title.'),
      start: z.string().describe('Start datetime (ISO 8601).'),
      end: z.string().describe('End datetime (ISO 8601).'),
      description: z.string().optional().describe('Event description.'),
      location: z.string().optional().describe('Event location.'),
      attendees: z.array(z.string()).optional().describe('Email addresses of attendees.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.createEvent({
          summary: input.summary,
          start: input.start,
          end: input.end,
          description: input.description,
          location: input.location,
          attendees: input.attendees,
        })
        return { data: enrichEventWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) {
        return { data: `Calendar error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const updateEvent = buildTool({
    name: 'googleCalendarUpdateEvent',
    description:
      'Update an existing Google Calendar event. ' +
      'Only include fields that need to change. Use ISO 8601 datetime format. ' +
      'IMPORTANT: Before computing dates for "today", "tomorrow", "next Monday", etc., use the current date from User Context. If unsure, call getTime first. Never guess the date. ' +
      'Supports updating RSVP status — use responseStatus to accept, decline, or mark "maybe/tentative" for an event. ' +
      'When updating only RSVP status, do NOT change summary or other fields. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      eventId: z.string().describe('The event ID to update.'),
      summary: z.string().optional().describe('New event title.'),
      start: z.string().optional().describe('New start datetime (ISO 8601).'),
      end: z.string().optional().describe('New end datetime (ISO 8601).'),
      description: z.string().optional().describe('New event description.'),
      location: z.string().optional().describe('New event location.'),
      attendees: z.array(z.string()).optional().describe('Updated attendee email list.'),
      responseStatus: z.enum(['accepted', 'declined', 'tentative']).optional().describe(
        'Update YOUR RSVP status for this event. Use this when the user wants to accept, decline, or mark "maybe"/"tentative" for an event.'
      ),
      // current* fields are auto-populated server-side from the real event data.
      // The AI may provide them but they will be overridden.
      currentSummary: z.string().optional().describe('Auto-populated. Do not set.'),
      currentStart: z.string().optional().describe('Auto-populated. Do not set.'),
      currentEnd: z.string().optional().describe('Auto-populated. Do not set.'),
      currentAttendees: z.array(z.string()).optional().describe('Auto-populated. Do not set.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const { eventId, currentSummary: _, currentStart: _s, currentEnd: _e, currentAttendees: _a, ...updates } = input
        const data = await api.updateEvent(eventId, updates)
        return { data: enrichEventWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) {
        return { data: `Calendar error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const deleteEvent = buildTool({
    name: 'googleCalendarDeleteEvent',
    description:
      'Delete a Google Calendar event by ID. ' +
      'ALWAYS include summary, startTime, endTime, and attendees for the confirmation prompt. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      eventId: z.string().describe('The event ID to delete.'),
      summary: z.string().optional().describe('Event title — include for the confirmation prompt.'),
      startTime: z.string().optional().describe('Event start time (ISO 8601) — include for the confirmation prompt.'),
      endTime: z.string().optional().describe('Event end time (ISO 8601) — include for the confirmation prompt.'),
      attendees: z.array(z.string()).optional().describe('Attendee emails — include for the confirmation prompt.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        await api.deleteEvent(input.eventId)
        return { data: `Event ${input.eventId} deleted successfully.` }
      } catch (err) {
        return { data: `Calendar error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [listEvents, getEvent, createEvent, updateEvent, deleteEvent]
}
