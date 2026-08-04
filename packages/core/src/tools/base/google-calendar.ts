/**
 * Google Calendar tools — lazy-discovered through mcp_search in normal chat.
 *
 * Read tools are concurrency-safe; every write requires confirmation. The API
 * callbacks are injected by packages/api so core stays free of OAuth/network
 * dependencies and deals only in user intent.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str, asRows } from './_connector-result.js'

export type CalendarRecurrenceScope = 'instance' | 'series' | 'following'
export type CalendarAvailability = 'busy' | 'free'
export type CalendarVisibility = 'default' | 'public' | 'private' | 'confidential'
export type CalendarConference = 'google_meet' | 'none'

export type CalendarAttendeeInput = {
  email: string
  displayName?: string
  optional?: boolean
  resource?: boolean
  comment?: string
  additionalGuests?: number
}

export type CalendarAttachmentInput = {
  fileUrl: string
  title?: string
  mimeType?: string
}

export type CalendarRemindersInput = {
  useDefault: boolean
  overrides?: Array<{ method: 'email' | 'popup'; minutes: number }>
}

export type CalendarGuestPermissionsInput = {
  canInviteOthers?: boolean
  canModify?: boolean
  canSeeOtherGuests?: boolean
}

type CalendarAutoDeclineMode =
  | 'declineNone'
  | 'declineAllConflictingInvitations'
  | 'declineOnlyNewConflictingInvitations'

export type CalendarFocusTimeProperties = {
  autoDeclineMode?: CalendarAutoDeclineMode
  declineMessage?: string
  chatStatus?: 'available' | 'doNotDisturb'
}

export type CalendarOutOfOfficeProperties = {
  autoDeclineMode?: CalendarAutoDeclineMode
  declineMessage?: string
}

export type CalendarWorkingLocationProperties = {
  type: 'homeOffice' | 'customLocation' | 'officeLocation'
  label?: string
  buildingId?: string
  floorId?: string
  floorSectionId?: string
  deskId?: string
}

export type CalendarEventCreateInput = {
  summary: string
  start: string
  end: string
  allDay?: boolean
  description?: string
  location?: string
  attendees?: CalendarAttendeeInput[]
  recurrence?: string[]
  timeZone?: string
  calendarId?: string
  conference?: CalendarConference
  reminders?: CalendarRemindersInput
  availability?: CalendarAvailability
  visibility?: CalendarVisibility
  guestPermissions?: CalendarGuestPermissionsInput
  attachments?: CalendarAttachmentInput[]
  eventType?: 'default' | 'focusTime' | 'outOfOffice' | 'workingLocation'
  focusTimeProperties?: CalendarFocusTimeProperties
  outOfOfficeProperties?: CalendarOutOfOfficeProperties
  workingLocationProperties?: CalendarWorkingLocationProperties
}

export type CalendarEventUpdateInput = {
  summary?: string
  start?: string
  end?: string
  allDay?: boolean
  description?: string
  location?: string
  attendees?: CalendarAttendeeInput[]
  attendeeChanges?: { add?: CalendarAttendeeInput[]; remove?: string[] }
  recurrence?: string[]
  responseStatus?: 'accepted' | 'declined' | 'tentative'
  responseComment?: string
  timeZone?: string
  calendarId?: string
  recurringScope?: CalendarRecurrenceScope
  conference?: CalendarConference
  reminders?: CalendarRemindersInput
  availability?: CalendarAvailability
  visibility?: CalendarVisibility
  guestPermissions?: CalendarGuestPermissionsInput
  attachmentChanges?: { add?: CalendarAttachmentInput[]; removeFileUrls?: string[] }
  focusTimeProperties?: CalendarFocusTimeProperties
  outOfOfficeProperties?: CalendarOutOfOfficeProperties
  workingLocationProperties?: CalendarWorkingLocationProperties
}

export type GoogleCalendarApi = {
  listCalendars(): Promise<unknown>

  listEvents(params: {
    timeMin?: string
    timeMax?: string
    calendarId?: string
    maxResults?: number
    query?: string
    timeZone?: string
  }): Promise<unknown>

  getEvent(eventId: string, calendarId?: string): Promise<unknown>

  queryFreeBusy(params: {
    timeMin: string
    timeMax: string
    calendarIds: string[]
    timeZone?: string
    durationMinutes?: number
  }): Promise<unknown>

  createEvent(event: CalendarEventCreateInput): Promise<unknown>

  updateEvent(eventId: string, updates: CalendarEventUpdateInput): Promise<unknown>

  deleteEvent(
    eventId: string,
    calendarId?: string,
    recurringScope?: CalendarRecurrenceScope,
  ): Promise<void>
}

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

type EventBoundary = { dateTime?: string; date?: string; timeZone?: string }
type EventLike = {
  start?: EventBoundary
  end?: EventBoundary
  originalStartTime?: EventBoundary
  recurrence?: unknown
  [key: string]: unknown
}

function projectEvent(evt: Json, tz: string, full = false): Json {
  const e = evt as EventLike
  const transparency = str(evt, 'transparency')
  const base: Json = {
    id: str(evt, 'id'),
    summary: str(evt, 'summary'),
    start: e.start,
    end: e.end,
    localStart: formatEventTime(e.start?.dateTime, tz) ?? e.start?.date,
    localEnd: formatEventTime(e.end?.dateTime, tz) ?? e.end?.date,
    location: str(evt, 'location'),
    status: str(evt, 'status'),
    eventType: str(evt, 'eventType'),
    recurringEventId: str(evt, 'recurringEventId'),
    originalStartTime: e.originalStartTime,
    localOriginalStart: formatEventTime(e.originalStartTime?.dateTime, tz) ?? e.originalStartTime?.date,
    availability: transparency === 'transparent' ? 'free' : 'busy',
    visibility: str(evt, 'visibility'),
    attendees: asRows(evt.attendees).map((a) => ({
      email: str(a, 'email'),
      displayName: str(a, 'displayName'),
      optional: a.optional,
      resource: a.resource,
      self: a.self,
      responseStatus: str(a, 'responseStatus'),
      comment: str(a, 'comment'),
      additionalGuests: a.additionalGuests,
    })),
    hangoutLink: str(evt, 'hangoutLink'),
    htmlLink: str(evt, 'htmlLink'),
  }
  if (full) {
    base.description = str(evt, 'description')
    base.organizer = str((evt.organizer ?? {}) as Json, 'email')
    base.recurrence = Array.isArray(e.recurrence)
      ? e.recurrence.filter((line): line is string => typeof line === 'string')
      : undefined
    base.reminders = evt.reminders
    base.attachments = evt.attachments
    base.guestPermissions = {
      canInviteOthers: evt.guestsCanInviteOthers,
      canModify: evt.guestsCanModify,
      canSeeOtherGuests: evt.guestsCanSeeOtherGuests,
    }
    base.focusTimeProperties = evt.focusTimeProperties
    base.outOfOfficeProperties = evt.outOfOfficeProperties
    base.workingLocationProperties = evt.workingLocationProperties
  }
  return base
}

function enrichEventsWithLocalTime(events: unknown, tz: string): unknown {
  if (!Array.isArray(events)) return events
  return asRows(events).map((evt) => projectEvent(evt, tz))
}

function enrichEventWithLocalTime(evt: unknown, tz: string): unknown {
  if (!evt || typeof evt !== 'object') return evt
  return projectEvent(evt as Json, tz, true)
}

const attendeeSchema = z.preprocess(
  (value) => typeof value === 'string' ? { email: value } : value,
  z.object({
    email: z.string().email().describe('Guest email address.'),
    displayName: z.string().optional().describe('Optional guest display name.'),
    optional: z.boolean().optional().describe('Whether this guest is optional.'),
    resource: z.boolean().optional().describe('Whether this attendee is a room or other resource.'),
    comment: z.string().optional().describe('Attendee comment.'),
    additionalGuests: z.number().int().min(0).optional().describe('Number of additional guests.'),
  }),
)

const attachmentSchema = z.object({
  fileUrl: z.string().url().describe('Google Drive file URL.'),
  title: z.string().optional().describe('Attachment title.'),
  mimeType: z.string().optional().describe('Attachment MIME type.'),
})

const remindersSchema = z.object({
  useDefault: z.boolean().describe('Use the calendar default reminders.'),
  overrides: z.array(z.object({
    method: z.enum(['email', 'popup']).describe('Reminder delivery method.'),
    minutes: z.number().int().min(0).max(40_320).describe('Minutes before the event.'),
  })).max(5).optional().describe('Up to five custom reminders.'),
})

const guestPermissionsSchema = z.object({
  canInviteOthers: z.boolean().optional().describe('Allow guests to invite others.'),
  canModify: z.boolean().optional().describe('Allow guests to modify the event.'),
  canSeeOtherGuests: z.boolean().optional().describe('Allow guests to see one another.'),
})

const autoDeclineModeSchema = z.enum([
  'declineNone',
  'declineAllConflictingInvitations',
  'declineOnlyNewConflictingInvitations',
])

const focusTimePropertiesSchema = z.object({
  autoDeclineMode: autoDeclineModeSchema.optional(),
  declineMessage: z.string().optional(),
  chatStatus: z.enum(['available', 'doNotDisturb']).optional(),
})

const outOfOfficePropertiesSchema = z.object({
  autoDeclineMode: autoDeclineModeSchema.optional(),
  declineMessage: z.string().optional(),
})

const workingLocationPropertiesSchema = z.object({
  type: z.enum(['homeOffice', 'customLocation', 'officeLocation']),
  label: z.string().optional().describe('Required for customLocation; optional office label.'),
  buildingId: z.string().optional(),
  floorId: z.string().optional(),
  floorSectionId: z.string().optional(),
  deskId: z.string().optional(),
})

const recurrenceSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to the unambiguous one-line form below.
    }
  }
  return [trimmed]
}, z.array(
  z.string().min(1).regex(
    /^(?:RRULE|EXRULE|RDATE|EXDATE)(?:;[^:]*)?:/i,
    'Recurrence lines must start with RRULE, EXRULE, RDATE, or EXDATE; use start/end fields instead of DTSTART/DTEND.',
  ),
).min(1)).describe(
  'Recurring-series rules as RFC 5545 content lines. Usually pass one RRULE, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=TU"]. Do not include DTSTART or DTEND.',
)

const calendarError = (err: unknown) => ({
  data: `Calendar error: ${err instanceof Error ? err.message : String(err)}`,
  isError: true as const,
})

export function createGoogleCalendarTools(api: GoogleCalendarApi, userTimezone?: string): Tool[] {
  const listCalendars = buildTool({
    name: 'googleCalendarListCalendars',
    description: 'List the user\'s Google calendars, including calendar IDs, names, timezones, primary status, and effective access roles. Use this before targeting a non-primary calendar.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,
    async execute() {
      try { return { data: await api.listCalendars() } } catch (err) { return calendarError(err) }
    },
  })

  const listEvents = buildTool({
    name: 'googleCalendarListEvents',
    description:
      'List Google Calendar events. Returns series identity, event type, local times, location, attendees, availability, visibility, and links. ' +
      'Use calendarId for a non-primary calendar. Each event includes localStart/localEnd already converted to the user timezone.',
    inputSchema: z.object({
      timeMin: z.string().optional().describe('Start of time range (RFC 3339). Defaults to now.'),
      timeMax: z.string().optional().describe('End of time range (RFC 3339). Defaults to 7 days from now.'),
      query: z.string().optional().describe('Free-text event search.'),
      maxResults: z.number().int().min(1).max(2500).optional().describe('Maximum events to return; default 20.'),
      calendarId: z.string().optional().describe('Calendar ID; defaults to primary.'),
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
          calendarId: input.calendarId,
          timeZone: userTimezone,
        })
        return { data: enrichEventsWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) { return calendarError(err) }
    },
  })

  const getEvent = buildTool({
    name: 'googleCalendarGetEvent',
    description: 'Get full details of a Google Calendar event or recurring instance by ID.',
    inputSchema: z.object({
      eventId: z.string().describe('Event or instance ID.'),
      calendarId: z.string().optional().describe('Calendar ID; defaults to primary.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,
    async execute(input) {
      try {
        const data = await api.getEvent(input.eventId, input.calendarId)
        return { data: enrichEventWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) { return calendarError(err) }
    },
  })

  const queryFreeBusy = buildTool({
    name: 'googleCalendarQueryFreeBusy',
    description: 'Find common free time across calendars or attendee email addresses inside an explicit time window. Returns per-calendar busy blocks and common available blocks; it does not assume working hours outside the window.',
    inputSchema: z.object({
      timeMin: z.string().describe('Window start in RFC 3339 format.'),
      timeMax: z.string().describe('Window end in RFC 3339 format.'),
      calendarIds: z.array(z.string()).min(1).optional().describe('Calendar IDs or attendee emails; defaults to ["primary"].'),
      durationMinutes: z.number().int().min(1).max(1440).optional().describe('Only return common-free blocks at least this long; default 30.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,
    async execute(input) {
      try {
        return { data: await api.queryFreeBusy({
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          calendarIds: input.calendarIds ?? ['primary'],
          timeZone: userTimezone,
          durationMinutes: input.durationMinutes,
        }) }
      } catch (err) { return calendarError(err) }
    },
  })

  const createEvent = buildTool({
    name: 'googleCalendarCreateEvent',
    description:
      'Create a timed, all-day, recurring, meeting, or Calendar status event. For all-day events set allDay=true and use YYYY-MM-DD with an exclusive end date. ' +
      'For a recurring series, use RFC 5545 recurrence lines such as ["RRULE:FREQ=WEEKLY;BYDAY=TU"]; never include DTSTART/DTEND or create each occurrence separately. ' +
      'Use conference="google_meet" to add Meet. eventType-specific properties are required for focusTime, outOfOffice, and workingLocation. Call directly; the UI handles Approve/Deny.',
    inputSchema: z.object({
      summary: z.string().describe('Event title.'),
      start: z.string().describe('RFC 3339 datetime, or YYYY-MM-DD when allDay=true.'),
      end: z.string().describe('RFC 3339 datetime, or exclusive YYYY-MM-DD end date when allDay=true.'),
      allDay: z.boolean().optional().describe('Use date-only all-day boundaries.'),
      calendarId: z.string().optional().describe('Target calendar ID; defaults to primary.'),
      description: z.string().optional().describe('Event description.'),
      location: z.string().optional().describe('Event location.'),
      attendees: z.array(attendeeSchema).optional().describe('Guest emails or structured attendee entries.'),
      recurrence: recurrenceSchema.optional(),
      conference: z.enum(['google_meet', 'none']).optional().describe('Create a Google Meet conference, or explicitly create without one.'),
      reminders: remindersSchema.optional(),
      availability: z.enum(['busy', 'free']).optional().describe('Whether the event blocks time.'),
      visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
      guestPermissions: guestPermissionsSchema.optional(),
      attachments: z.array(attachmentSchema).optional().describe('Google Drive attachments.'),
      eventType: z.enum(['default', 'focusTime', 'outOfOffice', 'workingLocation']).optional(),
      focusTimeProperties: focusTimePropertiesSchema.optional(),
      outOfOfficeProperties: outOfOfficePropertiesSchema.optional(),
      workingLocationProperties: workingLocationPropertiesSchema.optional(),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const event: CalendarEventCreateInput = { ...input }
        if (input.recurrence?.length && !input.allDay) event.timeZone = userTimezone ?? 'UTC'
        const data = await api.createEvent(event)
        return { data: enrichEventWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) { return calendarError(err) }
    },
  })

  const updateEvent = buildTool({
    name: 'googleCalendarUpdateEvent',
    description:
      'Update an event, RSVP, recurring occurrence, entire series, or this-and-following split. Only include fields that change. ' +
      'recurringScope defaults to instance; use series or following only when the user explicitly asks. recurrence changes require series/following. ' +
      'Use attendeeChanges and attachmentChanges to preserve existing RSVP/file metadata. responseStatus changes YOUR RSVP. eventType itself is immutable. Call directly; the UI handles Approve/Deny.',
    inputSchema: z.object({
      eventId: z.string().describe('Event or recurring-instance ID.'),
      calendarId: z.string().optional().describe('Calendar ID; defaults to primary.'),
      recurringScope: z.enum(['instance', 'series', 'following']).optional().describe('Apply to this instance (default), the whole series, or this and following.'),
      summary: z.string().optional().describe('New title.'),
      start: z.string().optional().describe('New RFC 3339 datetime or all-day date.'),
      end: z.string().optional().describe('New RFC 3339 datetime or exclusive all-day end date.'),
      allDay: z.boolean().optional().describe('Set when changing between timed and all-day boundaries.'),
      description: z.string().optional().describe('New description; empty string clears it.'),
      location: z.string().optional().describe('New location; empty string clears it.'),
      attendees: z.array(attendeeSchema).optional().describe('Complete attendee replacement. Prefer attendeeChanges for add/remove.'),
      attendeeChanges: z.object({
        add: z.array(attendeeSchema).optional(),
        remove: z.array(z.string().email()).optional(),
      }).optional().describe('Safely add/remove guests while preserving other RSVP metadata.'),
      recurrence: recurrenceSchema.optional(),
      responseStatus: z.enum(['accepted', 'declined', 'tentative']).optional().describe('Update YOUR RSVP status.'),
      responseComment: z.string().optional().describe('Optional comment on your RSVP response.'),
      conference: z.enum(['google_meet', 'none']).optional().describe('Create or clear conference data.'),
      reminders: remindersSchema.optional(),
      availability: z.enum(['busy', 'free']).optional(),
      visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
      guestPermissions: guestPermissionsSchema.optional(),
      attachmentChanges: z.object({
        add: z.array(attachmentSchema).optional(),
        removeFileUrls: z.array(z.string().url()).optional(),
      }).optional().describe('Safely add/remove Drive attachments.'),
      focusTimeProperties: focusTimePropertiesSchema.optional(),
      outOfOfficeProperties: outOfOfficePropertiesSchema.optional(),
      workingLocationProperties: workingLocationPropertiesSchema.optional(),
      currentSummary: z.string().optional().describe('Auto-populated. Do not set.'),
      currentStart: z.string().optional().describe('Auto-populated. Do not set.'),
      currentEnd: z.string().optional().describe('Auto-populated. Do not set.'),
      currentAttendees: z.array(z.string()).optional().describe('Auto-populated. Do not set.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        const {
          eventId,
          currentSummary: _,
          currentStart: _s,
          currentEnd: _e,
          currentAttendees: _a,
          ...updates
        } = input
        const payload: CalendarEventUpdateInput = { ...updates }
        if ((input.recurrence?.length || input.recurringScope === 'series' || input.recurringScope === 'following') && !input.allDay) {
          payload.timeZone = userTimezone ?? 'UTC'
        }
        const data = await api.updateEvent(eventId, payload)
        return { data: enrichEventWithLocalTime(data, userTimezone ?? 'UTC') }
      } catch (err) { return calendarError(err) }
    },
  })

  const deleteEvent = buildTool({
    name: 'googleCalendarDeleteEvent',
    description: 'Delete one event/occurrence, an entire recurring series, or this and all following occurrences. recurringScope defaults to instance; use broader scopes only when explicitly requested. Call directly; the UI handles Approve/Deny.',
    inputSchema: z.object({
      eventId: z.string().describe('Event or recurring-instance ID.'),
      calendarId: z.string().optional().describe('Calendar ID; defaults to primary.'),
      recurringScope: z.enum(['instance', 'series', 'following']).optional(),
      summary: z.string().optional().describe('Event title for the confirmation prompt.'),
      startTime: z.string().optional().describe('Event start for the confirmation prompt.'),
      endTime: z.string().optional().describe('Event end for the confirmation prompt.'),
      attendees: z.array(z.string()).optional().describe('Guest emails for the confirmation prompt.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        await api.deleteEvent(input.eventId, input.calendarId, input.recurringScope)
        return { data: `Event ${input.eventId} deleted successfully (${input.recurringScope ?? 'instance'} scope).` }
      } catch (err) { return calendarError(err) }
    },
  })

  return [listCalendars, listEvents, getEvent, queryFreeBusy, createEvent, updateEvent, deleteEvent]
}
