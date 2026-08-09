/**
 * Google API client — thin fetch-based wrappers for Calendar, Gmail, Tasks,
 * Drive, Docs, Sheets, and Slides.
 *
 * No heavy SDK. Each function takes an access token and uses direct fetch;
 * token refresh is handled by the caller. Composite Calendar intents such as
 * safe attendee merges and "this and following" deliberately make the
 * provider's required get/split/update sequence inside this adapter.
 *
 * See docs/architecture/integrations/mcp.md → "Built-in connectors".
 */

import { randomUUID } from 'node:crypto'
import type {
  GmailOutgoingAttachment,
  CalendarEventCreateInput,
  CalendarEventUpdateInput,
  CalendarRecurrenceScope,
  CalendarAttendeeInput,
  CalendarAttachmentInput,
} from '@use-brian/core'
import { renderEmailBody } from '@use-brian/channels'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
const GMAIL_API = 'https://www.googleapis.com/gmail/v1'
// Media upload base — messages with attachments go through the upload
// endpoint (`uploadType=media`, raw RFC 822 body, 35 MB transport cap)
// instead of base64url-in-JSON, which is sized for text-only messages.
const GMAIL_UPLOAD_API = 'https://www.googleapis.com/upload/gmail/v1'
const TASKS_API = 'https://www.googleapis.com/tasks/v1'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DOCS_API = 'https://docs.googleapis.com/v1'
const SHEETS_API = 'https://sheets.googleapis.com/v4'
const SLIDES_API = 'https://slides.googleapis.com/v1'

// ── Token refresh ─────────────────────────────────────────────

export async function refreshGoogleAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google token refresh failed (${res.status}): ${err}`)
  }

  const data = await res.json() as { access_token: string }
  return data.access_token
}

// ── Calendar ──────────────────────────────────────────────────

type CalendarBoundary = { dateTime?: string; date?: string; timeZone?: string }
type CalendarAttendee = CalendarAttendeeInput & {
  responseStatus?: string
  self?: boolean
  organizer?: boolean
}
type CalendarAttachment = CalendarAttachmentInput & { fileId?: string; iconLink?: string }

export type CalendarEvent = {
  id: string
  summary: string
  description?: string
  start: CalendarBoundary
  end: CalendarBoundary
  originalStartTime?: CalendarBoundary
  recurringEventId?: string
  recurrence?: string[]
  location?: string
  attendees?: CalendarAttendee[]
  attachments?: CalendarAttachment[]
  reminders?: Record<string, unknown>
  conferenceData?: Record<string, unknown> | null
  hangoutLink?: string
  transparency?: string
  visibility?: string
  eventType?: string
  focusTimeProperties?: Record<string, unknown>
  outOfOfficeProperties?: Record<string, unknown>
  workingLocationProperties?: Record<string, unknown>
  guestsCanInviteOthers?: boolean
  guestsCanModify?: boolean
  guestsCanSeeOtherGuests?: boolean
  htmlLink?: string
  status?: string
  [key: string]: unknown
}

export type CalendarListEntry = {
  id: string
  summary: string
  summaryOverride?: string
  timeZone?: string
  primary?: boolean
  selected?: boolean
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner'
  backgroundColor?: string
  foregroundColor?: string
}

export type CalendarSendUpdates = 'all' | 'externalOnly' | 'none'

async function calendarJson<T>(res: Response, context = 'Calendar API'): Promise<T> {
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`${context} error (${res.status}): ${err}`)
  }
  return await res.json() as T
}

function calendarHeaders(accessToken: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

export async function listCalendarList(accessToken: string): Promise<CalendarListEntry[]> {
  const items: CalendarListEntry[] = []
  let pageToken: string | undefined
  do {
    const qs = new URLSearchParams({ maxResults: '250', showHidden: 'false' })
    if (pageToken) qs.set('pageToken', pageToken)
    const data = await calendarJson<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
      await fetch(`${CALENDAR_API}/users/me/calendarList?${qs}`, {
        headers: calendarHeaders(accessToken),
      }),
    )
    items.push(...(data.items ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)
  return items
}

export async function listCalendarEvents(
  accessToken: string,
  params: {
    timeMin?: string
    timeMax?: string
    calendarId?: string
    maxResults?: number
    query?: string
    timeZone?: string
  },
): Promise<CalendarEvent[]> {
  const calendarId = encodeURIComponent(params.calendarId ?? 'primary')
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(params.maxResults ?? 20),
  })
  if (params.timeMin) qs.set('timeMin', params.timeMin)
  if (params.timeMax) qs.set('timeMax', params.timeMax)
  if (params.query) qs.set('q', params.query)
  if (params.timeZone) qs.set('timeZone', params.timeZone)

  const data = await calendarJson<{ items?: CalendarEvent[] }>(
    await fetch(`${CALENDAR_API}/calendars/${calendarId}/events?${qs}`, {
      headers: calendarHeaders(accessToken),
    }),
  )
  return data.items ?? []
}

export async function getCalendarEvent(
  accessToken: string,
  eventId: string,
  calendarId = 'primary',
): Promise<CalendarEvent> {
  return calendarJson<CalendarEvent>(await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: calendarHeaders(accessToken) },
  ))
}

/**
 * Raw Google Calendar `events.list` for the ingest poller. Ordered by last
 * modification and expanded into instances.
 */
export async function listCalendarEventsRaw(
  accessToken: string,
  params: { updatedMin?: string; calendarId?: string; maxResults?: number },
): Promise<Array<Record<string, unknown>>> {
  const calendarId = encodeURIComponent(params.calendarId ?? 'primary')
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'updated',
    maxResults: String(params.maxResults ?? 250),
  })
  if (params.updatedMin) qs.set('updatedMin', params.updatedMin)
  const data = await calendarJson<{ items?: Array<Record<string, unknown>> }>(
    await fetch(`${CALENDAR_API}/calendars/${calendarId}/events?${qs}`, {
      headers: calendarHeaders(accessToken),
    }),
  )
  return data.items ?? []
}

export async function queryCalendarFreeBusy(
  accessToken: string,
  params: {
    timeMin: string
    timeMax: string
    calendarIds: string[]
    timeZone?: string
    durationMinutes?: number
  },
): Promise<Record<string, unknown>> {
  const data = await calendarJson<{
    timeMin?: string
    timeMax?: string
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>
    groups?: Record<string, unknown>
  }>(await fetch(`${CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: calendarHeaders(accessToken, true),
    body: JSON.stringify({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      ...(params.timeZone ? { timeZone: params.timeZone } : {}),
      items: params.calendarIds.map((id) => ({ id })),
    }),
  }))

  const windowStart = new Date(params.timeMin).getTime()
  const windowEnd = new Date(params.timeMax).getTime()
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    throw new Error('Calendar free/busy window must have valid timeMin < timeMax')
  }

  const calendarResults = data.calendars ?? {}
  const failedCalendars = params.calendarIds.filter((calendarId) => {
    const result = calendarResults[calendarId]
    return !result || (result.errors?.length ?? 0) > 0
  })
  if (failedCalendars.length > 0) {
    throw new Error(`Calendar free/busy unavailable for: ${failedCalendars.join(', ')}`)
  }

  const busy = Object.values(calendarResults)
    .flatMap((calendar) => calendar.busy ?? [])
    .map((block) => ({
      start: Math.max(windowStart, new Date(block.start).getTime()),
      end: Math.min(windowEnd, new Date(block.end).getTime()),
    }))
    .filter((block) => Number.isFinite(block.start) && Number.isFinite(block.end) && block.end > block.start)
    .sort((a, b) => a.start - b.start)

  const merged: Array<{ start: number; end: number }> = []
  for (const block of busy) {
    const last = merged[merged.length - 1]
    if (last && block.start <= last.end) last.end = Math.max(last.end, block.end)
    else merged.push({ ...block })
  }

  const minimumMs = (params.durationMinutes ?? 30) * 60_000
  const available: Array<{ start: string; end: string }> = []
  let cursor = windowStart
  for (const block of merged) {
    if (block.start - cursor >= minimumMs) {
      available.push({ start: new Date(cursor).toISOString(), end: new Date(block.start).toISOString() })
    }
    cursor = Math.max(cursor, block.end)
  }
  if (windowEnd - cursor >= minimumMs) {
    available.push({ start: new Date(cursor).toISOString(), end: new Date(windowEnd).toISOString() })
  }

  return { ...data, durationMinutes: params.durationMinutes ?? 30, available }
}

function eventBoundary(value: string, allDay: boolean, timeZone?: string): CalendarBoundary {
  if (allDay) return { date: value }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) }
}

function normalizeWorkingLocation(input: NonNullable<CalendarEventCreateInput['workingLocationProperties']>): Record<string, unknown> {
  if (input.type === 'homeOffice') return { type: 'homeOffice', homeOffice: {} }
  if (input.type === 'customLocation') return { type: 'customLocation', customLocation: { label: input.label } }
  const { type: _, ...officeLocation } = input
  return { type: 'officeLocation', officeLocation }
}

function addGuestPermissions(body: Record<string, unknown>, permissions: CalendarEventCreateInput['guestPermissions']): void {
  if (!permissions) return
  if (permissions.canInviteOthers !== undefined) body.guestsCanInviteOthers = permissions.canInviteOthers
  if (permissions.canModify !== undefined) body.guestsCanModify = permissions.canModify
  if (permissions.canSeeOtherGuests !== undefined) body.guestsCanSeeOtherGuests = permissions.canSeeOtherGuests
}

function addStatusProperties(body: Record<string, unknown>, event: CalendarEventCreateInput): void {
  const eventType = event.eventType ?? 'default'
  if (eventType !== 'default' && (event.calendarId ?? 'primary') !== 'primary') {
    throw new Error(`${eventType} events are supported only on the primary calendar`)
  }
  if (eventType === 'focusTime') {
    if (event.allDay) throw new Error('Focus Time cannot be an all-day event')
    if (!event.focusTimeProperties) throw new Error('focusTimeProperties is required for a Focus Time event')
    body.eventType = eventType
    body.focusTimeProperties = event.focusTimeProperties
    body.transparency = 'opaque'
  } else if (eventType === 'outOfOffice') {
    if (event.allDay) throw new Error('Out of Office cannot be an all-day event')
    if (!event.outOfOfficeProperties) throw new Error('outOfOfficeProperties is required for an Out of Office event')
    body.eventType = eventType
    body.outOfOfficeProperties = event.outOfOfficeProperties
    body.transparency = 'opaque'
  } else if (eventType === 'workingLocation') {
    if (!event.workingLocationProperties) throw new Error('workingLocationProperties is required for a Working Location event')
    if (event.workingLocationProperties.type === 'customLocation' && !event.workingLocationProperties.label) {
      throw new Error('A custom Working Location requires a label')
    }
    if (event.allDay) {
      const start = Date.parse(`${event.start}T00:00:00Z`)
      const end = Date.parse(`${event.end}T00:00:00Z`)
      if (!Number.isFinite(start) || end - start !== 86_400_000) {
        throw new Error('An all-day Working Location must span exactly one day')
      }
    }
    body.eventType = eventType
    body.workingLocationProperties = normalizeWorkingLocation(event.workingLocationProperties)
    body.visibility = 'public'
    body.transparency = 'transparent'
  }
}

function createEventBody(event: CalendarEventCreateInput): Record<string, unknown> {
  if (event.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.start) || !/^\d{4}-\d{2}-\d{2}$/.test(event.end)) {
      throw new Error('All-day events require YYYY-MM-DD start and end dates')
    }
    if (Date.parse(`${event.end}T00:00:00Z`) <= Date.parse(`${event.start}T00:00:00Z`)) {
      throw new Error('An all-day event end date must be after its start date')
    }
  }
  const body: Record<string, unknown> = {
    summary: event.summary,
    start: eventBoundary(event.start, event.allDay === true, event.timeZone),
    end: eventBoundary(event.end, event.allDay === true, event.timeZone),
  }
  if (event.description !== undefined) body.description = event.description
  if (event.location !== undefined) body.location = event.location
  if (event.attendees) body.attendees = event.attendees
  if (event.recurrence?.length) body.recurrence = event.recurrence
  if (event.reminders) body.reminders = event.reminders
  if (event.availability) body.transparency = event.availability === 'free' ? 'transparent' : 'opaque'
  if (event.visibility) body.visibility = event.visibility
  if (event.attachments) body.attachments = event.attachments
  if (event.conference === 'google_meet') {
    body.conferenceData = {
      createRequest: {
        requestId: randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    }
  }
  addGuestPermissions(body, event.guestPermissions)
  addStatusProperties(body, event)
  return body
}

function eventMutationQuery(
  sendUpdates: CalendarSendUpdates,
  options: { conference?: boolean; attachments?: boolean } = {},
): string {
  const qs = new URLSearchParams({ sendUpdates })
  if (options.conference) qs.set('conferenceDataVersion', '1')
  if (options.attachments) qs.set('supportsAttachments', 'true')
  return qs.toString()
}

async function insertCalendarEventBody(
  accessToken: string,
  calendarId: string,
  body: Record<string, unknown>,
  sendUpdates: CalendarSendUpdates,
): Promise<CalendarEvent> {
  const query = eventMutationQuery(sendUpdates, {
    conference: Object.hasOwn(body, 'conferenceData'),
    attachments: Object.hasOwn(body, 'attachments'),
  })
  return calendarJson<CalendarEvent>(await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
    {
      method: 'POST',
      headers: calendarHeaders(accessToken, true),
      body: JSON.stringify(body),
    },
  ))
}

export async function createCalendarEvent(
  accessToken: string,
  event: CalendarEventCreateInput,
  calendarId = event.calendarId ?? 'primary',
  sendUpdates: CalendarSendUpdates = 'all',
): Promise<CalendarEvent> {
  return insertCalendarEventBody(accessToken, calendarId, createEventBody({ ...event, calendarId }), sendUpdates)
}

function mergeAttendees(current: CalendarAttendee[], updates: CalendarEventUpdateInput): CalendarAttendee[] | undefined {
  let attendees = updates.attendees ? [...updates.attendees] as CalendarAttendee[] : [...current]
  let changed = updates.attendees !== undefined
  if (updates.attendeeChanges) {
    changed = true
    const remove = new Set((updates.attendeeChanges.remove ?? []).map((email) => email.toLowerCase()))
    attendees = attendees.filter((attendee) => !remove.has(attendee.email.toLowerCase()))
    for (const addition of updates.attendeeChanges.add ?? []) {
      const index = attendees.findIndex((attendee) => attendee.email.toLowerCase() === addition.email.toLowerCase())
      if (index >= 0) attendees[index] = { ...attendees[index], ...addition }
      else attendees.push(addition)
    }
  }
  if (updates.responseStatus || updates.responseComment !== undefined) {
    const selfIndex = attendees.findIndex((attendee) => attendee.self)
    if (selfIndex < 0) throw new Error('The authenticated user is not an attendee on this event')
    changed = true
    attendees[selfIndex] = {
      ...attendees[selfIndex],
      ...(updates.responseStatus ? { responseStatus: updates.responseStatus } : {}),
      ...(updates.responseComment !== undefined ? { comment: updates.responseComment } : {}),
    }
  }
  return changed ? attendees : undefined
}

function mergeAttachments(current: CalendarAttachment[], changes: CalendarEventUpdateInput['attachmentChanges']): CalendarAttachment[] | undefined {
  if (!changes) return undefined
  const remove = new Set((changes.removeFileUrls ?? []).map((url) => url.toLowerCase()))
  const attachments = current.filter((item) => !remove.has(item.fileUrl.toLowerCase()))
  for (const addition of changes.add ?? []) {
    const index = attachments.findIndex((item) => item.fileUrl.toLowerCase() === addition.fileUrl.toLowerCase())
    if (index >= 0) attachments[index] = { ...attachments[index], ...addition }
    else attachments.push(addition)
  }
  return attachments
}

type CalendarBoundaryMode = 'all-day' | 'timed'

const DATE_ONLY_BOUNDARY = /^\d{4}-\d{2}-\d{2}$/

function boundaryMode(value: string): CalendarBoundaryMode {
  return DATE_ONLY_BOUNDARY.test(value) ? 'all-day' : 'timed'
}

function inferAllDay(event: CalendarEvent, updates: CalendarEventUpdateInput): boolean {
  const currentAllDay = Boolean(event.start?.date)
  const hasStart = updates.start !== undefined
  const hasEnd = updates.end !== undefined

  if (updates.allDay !== undefined) {
    if (!hasStart || !hasEnd) {
      throw new Error('Changing all-day mode requires both start and end boundaries')
    }
    return updates.allDay
  }

  if (hasStart && hasEnd) {
    const startMode = boundaryMode(updates.start!)
    const endMode = boundaryMode(updates.end!)
    if (startMode !== endMode) {
      throw new Error('Calendar start and end must both be date-only or both be date-time values')
    }
    return startMode === 'all-day'
  }

  const suppliedBoundary = updates.start ?? updates.end
  if (suppliedBoundary !== undefined) {
    const suppliedAllDay = boundaryMode(suppliedBoundary) === 'all-day'
    if (suppliedAllDay !== currentAllDay) {
      throw new Error('Changing between all-day and timed events requires both start and end boundaries')
    }
  }
  return currentAllDay
}

function validateUpdateBoundaryMode(updates: CalendarEventUpdateInput, allDay: boolean): void {
  for (const value of [updates.start, updates.end]) {
    if (value === undefined) continue
    const mode = boundaryMode(value)
    if (allDay && mode !== 'all-day') {
      throw new Error('All-day events require YYYY-MM-DD start and end dates')
    }
    if (!allDay && mode !== 'timed') {
      throw new Error('Timed events require RFC 3339 start and end date-times')
    }
  }

  if (allDay && updates.start !== undefined && updates.end !== undefined) {
    if (Date.parse(`${updates.end}T00:00:00Z`) <= Date.parse(`${updates.start}T00:00:00Z`)) {
      throw new Error('An all-day event end date must be after its start date')
    }
  }
}

function updateEventBody(updates: CalendarEventUpdateInput, current: CalendarEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const allDay = inferAllDay(current, updates)
  validateUpdateBoundaryMode(updates, allDay)
  if (updates.summary !== undefined) body.summary = updates.summary
  if (updates.start !== undefined) body.start = eventBoundary(updates.start, allDay, updates.timeZone)
  if (updates.end !== undefined) body.end = eventBoundary(updates.end, allDay, updates.timeZone)
  if (updates.description !== undefined) body.description = updates.description
  if (updates.location !== undefined) body.location = updates.location
  if (updates.recurrence !== undefined) body.recurrence = updates.recurrence
  if (updates.reminders !== undefined) body.reminders = updates.reminders
  if (updates.availability !== undefined) body.transparency = updates.availability === 'free' ? 'transparent' : 'opaque'
  if (updates.visibility !== undefined) body.visibility = updates.visibility
  const attendees = mergeAttendees(current.attendees ?? [], updates)
  if (attendees) body.attendees = attendees
  const attachments = mergeAttachments(current.attachments ?? [], updates.attachmentChanges)
  if (attachments) body.attachments = attachments
  if (updates.conference === 'google_meet') {
    body.conferenceData = {
      createRequest: {
        requestId: randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    }
  } else if (updates.conference === 'none') {
    body.conferenceData = null
  }
  addGuestPermissions(body, updates.guestPermissions)
  if (updates.focusTimeProperties !== undefined) {
    if (current.eventType !== 'focusTime') throw new Error('focusTimeProperties can update only a Focus Time event')
    body.focusTimeProperties = updates.focusTimeProperties
    body.transparency = 'opaque'
  }
  if (updates.outOfOfficeProperties !== undefined) {
    if (current.eventType !== 'outOfOffice') throw new Error('outOfOfficeProperties can update only an Out of Office event')
    body.outOfOfficeProperties = updates.outOfOfficeProperties
    body.transparency = 'opaque'
  }
  if (updates.workingLocationProperties !== undefined) {
    if (current.eventType !== 'workingLocation') throw new Error('workingLocationProperties can update only a Working Location event')
    body.workingLocationProperties = normalizeWorkingLocation(updates.workingLocationProperties)
    body.visibility = 'public'
    body.transparency = 'transparent'
  }
  if (updates.allDay === true && (current.eventType === 'focusTime' || current.eventType === 'outOfOffice')) {
    throw new Error(`${current.eventType} cannot be an all-day event`)
  }
  return body
}

async function patchCalendarEventBody(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: Record<string, unknown>,
  sendUpdates: CalendarSendUpdates,
): Promise<CalendarEvent> {
  const query = eventMutationQuery(sendUpdates, {
    conference: Object.hasOwn(body, 'conferenceData'),
    attachments: Object.hasOwn(body, 'attachments'),
  })
  return calendarJson<CalendarEvent>(await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${query}`,
    {
      method: 'PATCH',
      headers: calendarHeaders(accessToken, true),
      body: JSON.stringify(body),
    },
  ))
}

async function listInstancesBefore(
  accessToken: string,
  calendarId: string,
  recurringEventId: string,
  target: CalendarBoundary,
): Promise<number> {
  const rawTimeMax = target.dateTime ?? (target.date ? `${target.date}T00:00:00Z` : undefined)
  if (!rawTimeMax) throw new Error('Recurring instance is missing originalStartTime')
  let pageToken: string | undefined
  let count = 0
  do {
    const qs = new URLSearchParams({ timeMax: rawTimeMax, maxResults: '2500', showDeleted: 'true' })
    if (pageToken) qs.set('pageToken', pageToken)
    const data = await calendarJson<{ items?: CalendarEvent[]; nextPageToken?: string }>(await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(recurringEventId)}/instances?${qs}`,
      { headers: calendarHeaders(accessToken) },
    ))
    count += data.items?.length ?? 0
    pageToken = data.nextPageToken
  } while (pageToken)
  return count
}

function untilBefore(boundary: CalendarBoundary): string {
  if (boundary.date) {
    const previous = new Date(`${boundary.date}T00:00:00Z`)
    previous.setUTCDate(previous.getUTCDate() - 1)
    return previous.toISOString().slice(0, 10).replaceAll('-', '')
  }
  if (!boundary.dateTime) throw new Error('Recurring instance is missing originalStartTime')
  const previous = new Date(new Date(boundary.dateTime).getTime() - 1000)
  if (!Number.isFinite(previous.getTime())) throw new Error('Recurring instance has an invalid originalStartTime')
  return previous.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function splitRule(line: string, prefix: 'RRULE' | 'EXRULE', until: string, elapsed: number): { before: string; following?: string } {
  const parts = line.slice(`${prefix}:`.length).split(';').filter(Boolean)
  let originalCount: number | undefined
  const originalUntil = parts.find((part) => part.toUpperCase().startsWith('UNTIL='))
  const base = parts.filter((part) => {
    const upper = part.toUpperCase()
    if (upper.startsWith('COUNT=')) {
      originalCount = Number(part.slice('COUNT='.length))
      return false
    }
    return !upper.startsWith('UNTIL=')
  })
  const before = `${prefix}:${[...base, `UNTIL=${until}`].join(';')}`
  if (originalCount !== undefined) {
    const remaining = originalCount - elapsed
    return { before, following: remaining > 0 ? `${prefix}:${[...base, `COUNT=${remaining}`].join(';')}` : undefined }
  }
  return { before, following: `${prefix}:${[...base, ...(originalUntil ? [originalUntil] : [])].join(';')}` }
}

function basicDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`
}

function recurrenceTargetKey(linePrefix: string, value: string, target: CalendarBoundary): string {
  const dateOnly = /^\d{8}$/.test(value.split('/')[0] ?? '')
  if (dateOnly) {
    if (target.date) return target.date.replaceAll('-', '')
    if (!target.dateTime) throw new Error('Recurring instance is missing originalStartTime')
    return target.dateTime.slice(0, 10).replaceAll('-', '')
  }
  if (!target.dateTime) {
    if (!target.date) throw new Error('Recurring instance is missing originalStartTime')
    return `${target.date.replaceAll('-', '')}T000000`
  }
  const targetDate = new Date(target.dateTime)
  if (value.split('/')[0]?.endsWith('Z')) return basicDateTime(targetDate, 'UTC')
  const tzid = /(?:^|;)TZID=([^;:]+)/i.exec(linePrefix)?.[1]
  if (tzid) return basicDateTime(targetDate, tzid)
  return target.dateTime.slice(0, 19).replace(/[-:]/g, '')
}

function partitionDateLine(line: string, target: CalendarBoundary): { before?: string; following?: string } {
  const colon = line.indexOf(':')
  if (colon < 0) return { before: line, following: line }
  const prefix = line.slice(0, colon + 1)
  const values = line.slice(colon + 1).split(',').filter(Boolean)
  const beforeValues: string[] = []
  const followingValues: string[] = []
  for (const value of values) {
    const comparable = (value.split('/')[0] ?? '').replace(/[-:]/g, '').replace(/Z$/, '')
    const targetKey = recurrenceTargetKey(prefix, value, target)
    if (comparable < targetKey) beforeValues.push(value)
    else followingValues.push(value)
  }
  return {
    ...(beforeValues.length ? { before: `${prefix}${beforeValues.join(',')}` } : {}),
    ...(followingValues.length ? { following: `${prefix}${followingValues.join(',')}` } : {}),
  }
}

function splitRecurrence(lines: string[], target: CalendarBoundary, elapsed: number): { before: string[]; following: string[] } {
  const until = untilBefore(target)
  const before: string[] = []
  const following: string[] = []
  for (const line of lines) {
    if (line.toUpperCase().startsWith('RRULE:')) {
      const split = splitRule(line, 'RRULE', until, elapsed)
      before.push(split.before)
      if (split.following) following.push(split.following)
    } else if (line.toUpperCase().startsWith('EXRULE:')) {
      const split = splitRule(line, 'EXRULE', until, elapsed)
      before.push(split.before)
      if (split.following) following.push(split.following)
    } else {
      const partitioned = partitionDateLine(line, target)
      if (partitioned.before) before.push(partitioned.before)
      if (partitioned.following) following.push(partitioned.following)
    }
  }
  return { before, following }
}

function cloneSeriesBody(
  parent: CalendarEvent,
  target: CalendarEvent,
  recurrence: string[],
  updates: CalendarEventUpdateInput,
): Record<string, unknown> {
  const copyFields = [
    'summary', 'description', 'location', 'colorId', 'attendees', 'reminders',
    'visibility', 'transparency', 'guestsCanInviteOthers', 'guestsCanModify',
    'guestsCanSeeOtherGuests', 'attachments', 'conferenceData',
    'extendedProperties', 'source', 'eventType', 'focusTimeProperties',
    'outOfOfficeProperties', 'workingLocationProperties',
  ] as const
  const body: Record<string, unknown> = {}
  for (const field of copyFields) {
    if (parent[field] !== undefined) body[field] = parent[field]
  }
  body.start = target.start
  body.end = target.end
  body.recurrence = recurrence
  Object.assign(body, updateEventBody({ ...updates, recurrence: undefined }, parent))
  if (updates.recurrence) body.recurrence = updates.recurrence
  return body
}

export async function updateCalendarEvent(
  accessToken: string,
  eventId: string,
  updates: CalendarEventUpdateInput,
  calendarId = updates.calendarId ?? 'primary',
  sendUpdates: CalendarSendUpdates = 'all',
): Promise<CalendarEvent> {
  const scope = updates.recurringScope ?? 'instance'
  if (updates.recurrence && scope === 'instance') {
    throw new Error('Changing recurrence requires recurringScope="series" or "following"')
  }
  const target = await getCalendarEvent(accessToken, eventId, calendarId)
  const cleanUpdates = { ...updates }
  delete cleanUpdates.calendarId
  delete cleanUpdates.recurringScope

  if (scope === 'instance') {
    return patchCalendarEventBody(accessToken, calendarId, eventId, updateEventBody(cleanUpdates, target), sendUpdates)
  }

  const parentId = target.recurringEventId ?? (target.recurrence?.length ? target.id : undefined)
  if (!parentId) throw new Error(`recurringScope="${scope}" requires a recurring event or instance`)
  const parent = parentId === target.id ? target : await getCalendarEvent(accessToken, parentId, calendarId)

  if (scope === 'series') {
    return patchCalendarEventBody(accessToken, calendarId, parentId, updateEventBody(cleanUpdates, parent), sendUpdates)
  }

  if (!target.recurringEventId) {
    throw new Error('recurringScope="following" requires a concrete recurring instance ID')
  }
  const originalStart = target.originalStartTime ?? target.start
  const recurrence = parent.recurrence ?? []
  if (!recurrence.some((line) => line.toUpperCase().startsWith('RRULE:'))) {
    throw new Error('The recurring parent has no RRULE to split')
  }
  const elapsed = await listInstancesBefore(accessToken, calendarId, parentId, originalStart)
  const split = splitRecurrence(recurrence, originalStart, elapsed)
  await patchCalendarEventBody(accessToken, calendarId, parentId, { recurrence: split.before }, sendUpdates)
  try {
    const clone = cloneSeriesBody(parent, target, split.following, cleanUpdates)
    return await insertCalendarEventBody(accessToken, calendarId, clone, sendUpdates)
  } catch (err) {
    try {
      await patchCalendarEventBody(accessToken, calendarId, parentId, { recurrence }, 'none')
    } catch (rollbackErr) {
      throw new Error(`Calendar following-update failed and recurrence rollback also failed: ${err instanceof Error ? err.message : String(err)}; rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`)
    }
    throw err
  }
}

async function deleteCalendarEventById(
  accessToken: string,
  eventId: string,
  calendarId: string,
  sendUpdates: CalendarSendUpdates,
): Promise<void> {
  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    { method: 'DELETE', headers: calendarHeaders(accessToken) },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Calendar API error (${res.status}): ${err}`)
  }
}

export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string,
  calendarId = 'primary',
  sendUpdates: CalendarSendUpdates = 'all',
  recurringScope: CalendarRecurrenceScope = 'instance',
): Promise<void> {
  if (recurringScope === 'instance') {
    await deleteCalendarEventById(accessToken, eventId, calendarId, sendUpdates)
    return
  }
  const target = await getCalendarEvent(accessToken, eventId, calendarId)
  const parentId = target.recurringEventId ?? (target.recurrence?.length ? target.id : undefined)
  if (!parentId) throw new Error(`recurringScope="${recurringScope}" requires a recurring event or instance`)
  if (recurringScope === 'series') {
    await deleteCalendarEventById(accessToken, parentId, calendarId, sendUpdates)
    return
  }
  if (!target.recurringEventId) {
    throw new Error('recurringScope="following" requires a concrete recurring instance ID')
  }
  const parent = await getCalendarEvent(accessToken, parentId, calendarId)
  const recurrence = parent.recurrence ?? []
  if (!recurrence.some((line) => line.toUpperCase().startsWith('RRULE:'))) {
    throw new Error('The recurring parent has no RRULE to truncate')
  }
  const originalStart = target.originalStartTime ?? target.start
  const elapsed = await listInstancesBefore(accessToken, calendarId, parentId, originalStart)
  const split = splitRecurrence(recurrence, originalStart, elapsed)
  await patchCalendarEventBody(accessToken, calendarId, parentId, { recurrence: split.before }, sendUpdates)
}

// ── Gmail ─────────────────────────────────────────────────────

export type GmailMessage = {
  id: string
  threadId: string
  snippet: string
  labelIds?: string[]
  payload?: {
    headers: Array<{ name: string; value: string }>
    body?: { data?: string; size: number }
    parts?: Array<{
      mimeType: string
      body?: { data?: string; size: number }
    }>
  }
  internalDate?: string
}

export async function listGmailMessages(
  accessToken: string,
  params: {
    query?: string
    maxResults?: number
    labelIds?: string[]
  },
): Promise<Array<{ id: string; threadId: string; snippet: string; from: string; subject: string; date: string }>> {
  const qs = new URLSearchParams({
    maxResults: String(params.maxResults ?? 10),
  })
  if (params.query) qs.set('q', params.query)
  if (params.labelIds?.length) {
    for (const l of params.labelIds) qs.append('labelIds', l)
  }

  const listRes = await fetch(`${GMAIL_API}/users/me/messages?${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!listRes.ok) {
    const err = await listRes.text()
    throw new Error(`Gmail API error (${listRes.status}): ${err}`)
  }

  const listData = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> }
  if (!listData.messages?.length) return []

  // Fetch metadata for each message (batch via individual requests — simple for now)
  const messages = await Promise.all(
    listData.messages.slice(0, params.maxResults ?? 10).map(async (m) => {
      const msgRes = await fetch(
        `${GMAIL_API}/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!msgRes.ok) return null
      const msg = await msgRes.json() as GmailMessage
      const headers = msg.payload?.headers ?? []
      return {
        id: msg.id,
        threadId: msg.threadId,
        snippet: msg.snippet,
        from: headers.find((h) => h.name === 'From')?.value ?? '',
        subject: headers.find((h) => h.name === 'Subject')?.value ?? '',
        date: headers.find((h) => h.name === 'Date')?.value ?? '',
      }
    }),
  )

  return messages.filter((m): m is NonNullable<typeof m> => m !== null)
}

export async function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<{ id: string; from: string; to: string; subject: string; date: string; body: string }> {
  const res = await fetch(
    `${GMAIL_API}/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail API error (${res.status}): ${err}`)
  }

  const msg = await res.json() as GmailMessage
  const headers = msg.payload?.headers ?? []
  const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

  // Extract plain text body
  let body = ''
  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf8')
  } else if (msg.payload?.parts) {
    const textPart = msg.payload.parts.find((p) => p.mimeType === 'text/plain')
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64url').toString('utf8')
    }
  }

  return {
    id: msg.id,
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    body,
  }
}

/**
 * Strip CR/LF from a header value before it is interpolated into a raw
 * message — otherwise a value containing embedded newlines could inject
 * extra headers (e.g. a spoofed `Bcc:`) into the outgoing message.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

/** RFC 2047: encode a header value as Base64 UTF-8 when it contains non-ASCII chars. */
function encodeHeaderWord(value: string): string {
  const sanitized = sanitizeHeaderValue(value)
  return /[^\x00-\x7F]/.test(sanitized)
    ? `=?UTF-8?B?${Buffer.from(sanitized, 'utf-8').toString('base64')}?=`
    : sanitized
}

/** Fold base64 into 76-char lines per RFC 2045. */
function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n')
}

/**
 * Content-Disposition filename params: a plain ASCII fallback plus an
 * RFC 2231 `filename*` when the name carries non-ASCII characters.
 */
function filenameParams(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
  if (ascii === filename) return `filename="${ascii}"`
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * Lines for a multipart/alternative body section: the model's markdown
 * rendered to a text/plain part (markers stripped) + a text/html part
 * (`renderEmailBody`, packages/channels/src/email/markdown.ts) — email
 * clients pick the richest part they can render, so markdown never ships
 * literally. Used standalone (no attachments) and nested inside
 * multipart/mixed (attachments). See
 * docs/architecture/integrations/gmail.md → "Body formatting".
 */
function alternativeBodyLines(body: string, boundary: string): string[] {
  const { text, html } = renderEmailBody(body)
  return [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(text, 'utf-8').toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(html, 'utf-8').toString('base64')),
    `--${boundary}--`,
  ]
}

/** Sanitize each address and join into one RFC 822 address-list header value. */
function addressHeaderValue(value: string | string[]): string {
  const list = Array.isArray(value) ? value : [value]
  return list.map(sanitizeHeaderValue).filter(Boolean).join(', ')
}

/**
 * Assemble a multipart/mixed RFC 822 message: a nested multipart/alternative
 * body (text + html) + base64 attachment parts. Returned as a Buffer — the
 * upload endpoint takes the raw bytes, not base64url-in-JSON.
 */
function buildMultipartMessage(params: {
  to: string | string[]
  cc?: string[]
  bcc?: string[]
  from?: string
  subject: string
  body: string
  attachments: GmailOutgoingAttachment[]
}): Buffer {
  const boundary = `=_usebrian_${randomUUID()}`
  const altBoundary = `=_usebrian_alt_${randomUUID()}`
  const lines: string[] = [
    ...(params.from ? [`From: ${sanitizeHeaderValue(params.from)}`] : []),
    `To: ${addressHeaderValue(params.to)}`,
    ...(params.cc?.length ? [`Cc: ${addressHeaderValue(params.cc)}`] : []),
    ...(params.bcc?.length ? [`Bcc: ${addressHeaderValue(params.bcc)}`] : []),
    `Subject: ${encodeHeaderWord(params.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    ...alternativeBodyLines(params.body, altBoundary),
  ]
  for (const att of params.attachments) {
    const mime = att.mime || 'application/octet-stream'
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mime}; name="${att.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")}"`,
      `Content-Disposition: attachment; ${filenameParams(att.filename)}`,
      'Content-Transfer-Encoding: base64',
      '',
      foldBase64(Buffer.from(att.data).toString('base64')),
    )
  }
  lines.push(`--${boundary}--`, '')
  return Buffer.from(lines.join('\r\n'), 'utf-8')
}

export async function sendGmailMessage(
  accessToken: string,
  params: {
    to: string | string[]
    cc?: string[]
    bcc?: string[]
    from?: string
    subject: string
    body: string
    attachments?: GmailOutgoingAttachment[]
  },
): Promise<{ id: string; threadId: string }> {
  // With attachments: multipart/mixed through the media-upload endpoint.
  if (params.attachments && params.attachments.length > 0) {
    const raw = buildMultipartMessage({
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      from: params.from,
      subject: params.subject,
      body: params.body,
      attachments: params.attachments,
    })
    const res = await fetch(`${GMAIL_UPLOAD_API}/users/me/messages/send?uploadType=media`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'message/rfc822',
      },
      body: raw,
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gmail API error (${res.status}): ${err}`)
    }

    return await res.json() as { id: string; threadId: string }
  }

  // No attachments: base64url-in-JSON endpoint, multipart/alternative body
  // (rendered text + html — see alternativeBodyLines).
  const encodedSubject = encodeHeaderWord(params.subject)
  const altBoundary = `=_usebrian_alt_${randomUUID()}`

  // Build RFC 2822 message
  const rawMessage = [
    ...(params.from ? [`From: ${sanitizeHeaderValue(params.from)}`] : []),
    `To: ${addressHeaderValue(params.to)}`,
    ...(params.cc?.length ? [`Cc: ${addressHeaderValue(params.cc)}`] : []),
    ...(params.bcc?.length ? [`Bcc: ${addressHeaderValue(params.bcc)}`] : []),
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    ...alternativeBodyLines(params.body, altBoundary),
  ].join('\r\n')

  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail API error (${res.status}): ${err}`)
  }

  return await res.json() as { id: string; threadId: string }
}

// ── Tasks ──────────────────────────────────────────────────────

export type TaskList = {
  id: string
  title: string
  updated?: string
}

export type GoogleTask = {
  id: string
  title: string
  notes?: string
  status: 'needsAction' | 'completed'
  due?: string
  completed?: string
  parent?: string
  position?: string
  updated?: string
}

export async function listTaskLists(
  accessToken: string,
  params: { maxResults?: number },
): Promise<TaskList[]> {
  const qs = new URLSearchParams({
    maxResults: String(params.maxResults ?? 100),
  })

  const res = await fetch(`${TASKS_API}/users/@me/lists?${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tasks API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { items?: TaskList[] }
  return data.items ?? []
}

export async function listGoogleTasks(
  accessToken: string,
  params: {
    taskListId: string
    showCompleted?: boolean
    dueMin?: string
    dueMax?: string
    maxResults?: number
  },
): Promise<GoogleTask[]> {
  const qs = new URLSearchParams({
    maxResults: String(params.maxResults ?? 100),
  })
  if (params.showCompleted !== undefined) qs.set('showCompleted', String(params.showCompleted))
  if (params.dueMin) qs.set('dueMin', params.dueMin)
  if (params.dueMax) qs.set('dueMax', params.dueMax)

  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(params.taskListId)}/tasks?${qs}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tasks API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { items?: GoogleTask[] }
  return data.items ?? []
}

export async function getGoogleTask(
  accessToken: string,
  taskListId: string,
  taskId: string,
): Promise<GoogleTask> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tasks API error (${res.status}): ${err}`)
  }

  return await res.json() as GoogleTask
}

export async function createGoogleTask(
  accessToken: string,
  taskListId: string,
  task: {
    title: string
    notes?: string
    due?: string
    parent?: string
  },
): Promise<GoogleTask> {
  const body: Record<string, unknown> = { title: task.title }
  if (task.notes) body.notes = task.notes
  if (task.due) body.due = task.due
  if (task.parent) body.parent = task.parent

  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tasks API error (${res.status}): ${err}`)
  }

  return await res.json() as GoogleTask
}

export async function updateGoogleTask(
  accessToken: string,
  taskListId: string,
  taskId: string,
  updates: {
    title?: string
    notes?: string
    due?: string
    status?: 'needsAction' | 'completed'
  },
): Promise<GoogleTask> {
  const body: Record<string, unknown> = {}
  if (updates.title !== undefined) body.title = updates.title
  if (updates.notes !== undefined) body.notes = updates.notes
  if (updates.due !== undefined) body.due = updates.due
  if (updates.status !== undefined) body.status = updates.status

  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tasks API error (${res.status}): ${err}`)
  }

  return await res.json() as GoogleTask
}

export async function deleteGoogleTask(
  accessToken: string,
  taskListId: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tasks API error (${res.status}): ${err}`)
  }
}

// ── Drive ─────────────────────────────────────────────────────

export type DriveFile = {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
  webViewLink?: string
  parents?: string[]
}

/** MIME types for Google Workspace documents (need export, not download). */
const WORKSPACE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
])

export async function listDriveFiles(
  accessToken: string,
  params: {
    query?: string
    maxResults?: number
    folderId?: string
  },
): Promise<DriveFile[]> {
  const qs = new URLSearchParams({
    pageSize: String(params.maxResults ?? 20),
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,parents)',
  })

  const qParts: string[] = ['trashed = false']
  if (params.folderId) qParts.push(`'${params.folderId}' in parents`)
  if (params.query) qParts.push(`name contains '${params.query.replace(/'/g, "\\'")}'`)
  qs.set('q', qParts.join(' and '))
  qs.set('orderBy', 'modifiedTime desc')

  const res = await fetch(`${DRIVE_API}/files?${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { files?: DriveFile[] }
  return data.files ?? []
}

export async function getDriveFile(
  accessToken: string,
  fileId: string,
): Promise<DriveFile> {
  const qs = new URLSearchParams({
    fields: 'id,name,mimeType,modifiedTime,size,webViewLink,parents',
  })

  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive API error (${res.status}): ${err}`)
  }

  return await res.json() as DriveFile
}

export async function getDriveFileContent(
  accessToken: string,
  fileId: string,
  exportMimeType?: string,
): Promise<string> {
  // First get metadata to determine file type
  const meta = await getDriveFile(accessToken, fileId)

  if (WORKSPACE_MIME_TYPES.has(meta.mimeType)) {
    // Google Workspace files must be exported
    let mime = exportMimeType ?? 'text/plain'
    if (meta.mimeType === 'application/vnd.google-apps.spreadsheet' && !exportMimeType) {
      mime = 'text/csv'
    }
    const res = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mime)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Drive export error (${res.status}): ${err}`)
    }
    return await res.text()
  }

  // Regular files — download content
  const res = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive download error (${res.status}): ${err}`)
  }
  return await res.text()
}

export async function createDriveFile(
  accessToken: string,
  params: {
    name: string
    content: string
    mimeType?: string
    folderId?: string
  },
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = { name: params.name }
  if (params.mimeType) metadata.mimeType = params.mimeType
  if (params.folderId) metadata.parents = [params.folderId]

  const boundary = '---usebrian-multipart'
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${params.mimeType ?? 'text/plain'}`,
    '',
    params.content,
    `--${boundary}--`,
  ].join('\r\n')

  const res = await fetch(
    `${DRIVE_API.replace('/drive/v3', '/upload/drive/v3')}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive create error (${res.status}): ${err}`)
  }

  return await res.json() as DriveFile
}

export async function updateDriveFileContent(
  accessToken: string,
  fileId: string,
  params: {
    name?: string
    content?: string
  },
): Promise<DriveFile> {
  // Metadata-only update
  if (!params.content) {
    const body: Record<string, unknown> = {}
    if (params.name) body.name = params.name

    const res = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,webViewLink`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Drive update error (${res.status}): ${err}`)
    }
    return await res.json() as DriveFile
  }

  // Content + optional metadata update via multipart
  const metadata: Record<string, unknown> = {}
  if (params.name) metadata.name = params.name

  const boundary = '---usebrian-multipart'
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    params.content,
    `--${boundary}--`,
  ].join('\r\n')

  const res = await fetch(
    `${DRIVE_API.replace('/drive/v3', '/upload/drive/v3')}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive update error (${res.status}): ${err}`)
  }

  return await res.json() as DriveFile
}

// ── Docs ──────────────────────────────────────────────────────

export async function getDocContent(
  accessToken: string,
  documentId: string,
): Promise<{ documentId: string; title: string; body: string }> {
  const res = await fetch(
    `${DOCS_API}/documents/${encodeURIComponent(documentId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Docs API error (${res.status}): ${err}`)
  }

  const doc = await res.json() as {
    documentId: string
    title: string
    body?: { content?: Array<{ paragraph?: { elements?: Array<{ textRun?: { content?: string } }> } }> }
  }

  // Extract plain text from the structured body
  let text = ''
  for (const block of doc.body?.content ?? []) {
    for (const el of block.paragraph?.elements ?? []) {
      if (el.textRun?.content) text += el.textRun.content
    }
  }

  return { documentId: doc.documentId, title: doc.title, body: text }
}

export async function appendToDoc(
  accessToken: string,
  documentId: string,
  text: string,
): Promise<void> {
  // Get current document length to find the end index
  const docRes = await fetch(
    `${DOCS_API}/documents/${encodeURIComponent(documentId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!docRes.ok) {
    const err = await docRes.text()
    throw new Error(`Docs API error (${docRes.status}): ${err}`)
  }
  const doc = await docRes.json() as { body?: { content?: Array<{ endIndex?: number }> } }
  const lastBlock = doc.body?.content?.at(-1)
  const endIndex = (lastBlock?.endIndex ?? 2) - 1 // Insert before final newline

  const res = await fetch(
    `${DOCS_API}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: endIndex }, text } }],
      }),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Docs API error (${res.status}): ${err}`)
  }
}

export async function replaceInDoc(
  accessToken: string,
  documentId: string,
  findText: string,
  replaceText: string,
): Promise<{ occurrencesChanged: number }> {
  const res = await fetch(
    `${DOCS_API}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [{
          replaceAllText: {
            containsText: { text: findText, matchCase: true },
            replaceText,
          },
        }],
      }),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Docs API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> }
  return { occurrencesChanged: data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0 }
}

export async function createDocument(
  accessToken: string,
  title: string,
): Promise<{ documentId: string; title: string; url: string }> {
  const res = await fetch(`${DOCS_API}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Docs API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { documentId: string; title: string }
  return {
    documentId: data.documentId,
    title: data.title,
    url: `https://docs.google.com/document/d/${data.documentId}/edit`,
  }
}

// ── Sheets ────────────────────────────────────────────────────

export type SheetInfo = {
  spreadsheetId: string
  title: string
  sheets: Array<{ sheetId: number; title: string; rowCount: number; columnCount: number }>
}

export async function getSpreadsheetInfo(
  accessToken: string,
  spreadsheetId: string,
): Promise<SheetInfo> {
  const res = await fetch(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  const data = await res.json() as {
    spreadsheetId: string
    properties: { title: string }
    sheets: Array<{ properties: { sheetId: number; title: string; gridProperties: { rowCount: number; columnCount: number } } }>
  }

  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties.title,
    sheets: data.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      rowCount: s.properties.gridProperties.rowCount,
      columnCount: s.properties.gridProperties.columnCount,
    })),
  }
}

export async function readSheetRange(
  accessToken: string,
  spreadsheetId: string,
  range: string,
): Promise<{ range: string; values: string[][] }> {
  const res = await fetch(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { range: string; values?: string[][] }
  return { range: data.range, values: data.values ?? [] }
}

export async function writeSheetRange(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<{ updatedCells: number }> {
  const res = await fetch(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range, values }),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { updatedCells?: number }
  return { updatedCells: data.updatedCells ?? 0 }
}

export async function appendSheetRows(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<{ updatedCells: number }> {
  const res = await fetch(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range, values }),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { updates?: { updatedCells?: number } }
  return { updatedCells: data.updates?.updatedCells ?? 0 }
}

export type SpreadsheetFormatOptions = {
  /** Sheet tab name to format. Defaults to the first sheet. */
  sheetName?: string
  /** Bold row 1 (the header row). */
  boldHeader?: boolean
  /** Number of rows to freeze from the top (1 freezes the header). */
  freezeRows?: number
  /** Number of columns to freeze from the left. */
  freezeColumns?: number
  /** Auto-resize all columns to fit their contents. */
  autoResizeColumns?: boolean
  /** Set explicit pixel widths per column. Applied after autoResizeColumns. */
  columnWidths?: Array<{ column: string; pixelSize: number }>
  /** Enable text wrapping across the sheet (true) or a single A1 range. */
  wrapText?: boolean | { range: string }
  /** Dropdown data validation rules: each range gets a ONE_OF_LIST validator. */
  dataValidations?: Array<{
    range: string
    values: string[]
    strict?: boolean
  }>
}

export type SpreadsheetFormatResult = {
  sheetId: number
  sheetTitle: string
  applied: string[]
}

function columnLetterToIndex(letter: string): number {
  const upper = letter.toUpperCase()
  let result = 0
  for (const c of upper) {
    if (c < 'A' || c > 'Z') {
      throw new Error(`Invalid column letter: "${letter}"`)
    }
    result = result * 26 + (c.charCodeAt(0) - 64)
  }
  return result - 1
}

function parseColumnRange(col: string): { start: number; end: number } {
  const parts = col.split(':')
  if (parts.length === 1) {
    const i = columnLetterToIndex(parts[0])
    return { start: i, end: i + 1 }
  }
  if (parts.length === 2) {
    const a = columnLetterToIndex(parts[0])
    const b = columnLetterToIndex(parts[1])
    return { start: Math.min(a, b), end: Math.max(a, b) + 1 }
  }
  throw new Error(`Invalid column range: "${col}"`)
}

type GridRange = {
  sheetId: number
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}

function parseA1Range(range: string, sheetId: number): GridRange {
  const bang = range.indexOf('!')
  const body = bang >= 0 ? range.slice(bang + 1) : range
  const parts = body.split(':')
  if (parts.length < 1 || parts.length > 2) {
    throw new Error(`Invalid A1 range: "${range}"`)
  }

  const parseRef = (ref: string) => {
    const m = /^([A-Z]+)?(\d+)?$/.exec(ref.toUpperCase())
    if (!m || (!m[1] && !m[2])) {
      throw new Error(`Invalid A1 reference: "${ref}"`)
    }
    return {
      col: m[1] !== undefined ? columnLetterToIndex(m[1]) : undefined,
      row: m[2] !== undefined ? parseInt(m[2], 10) - 1 : undefined,
    }
  }

  const a = parseRef(parts[0])
  const b = parts.length === 2 ? parseRef(parts[1]) : a

  const out: GridRange = { sheetId }
  if (a.row !== undefined) out.startRowIndex = a.row
  if (b.row !== undefined) out.endRowIndex = b.row + 1
  if (a.col !== undefined) out.startColumnIndex = a.col
  if (b.col !== undefined) out.endColumnIndex = b.col + 1
  return out
}

export async function formatSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  opts: SpreadsheetFormatOptions,
): Promise<SpreadsheetFormatResult> {
  // Resolve target sheet — need sheetId (numeric) and columnCount for autoResize.
  const info = await getSpreadsheetInfo(accessToken, spreadsheetId)
  const sheet = opts.sheetName
    ? info.sheets.find((s) => s.title === opts.sheetName)
    : info.sheets[0]
  if (!sheet) {
    throw new Error(`Sheets format error: sheet "${opts.sheetName ?? '(first)'}" not found`)
  }

  const requests: unknown[] = []
  const applied: string[] = []

  if (opts.boldHeader) {
    requests.push({
      repeatCell: {
        range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    })
    applied.push('boldHeader')
  }

  if (opts.freezeRows !== undefined || opts.freezeColumns !== undefined) {
    const gridProps: Record<string, number> = {}
    const fieldParts: string[] = []
    if (opts.freezeRows !== undefined) {
      gridProps.frozenRowCount = opts.freezeRows
      fieldParts.push('gridProperties.frozenRowCount')
    }
    if (opts.freezeColumns !== undefined) {
      gridProps.frozenColumnCount = opts.freezeColumns
      fieldParts.push('gridProperties.frozenColumnCount')
    }
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sheet.sheetId, gridProperties: gridProps },
        fields: fieldParts.join(','),
      },
    })
    if (opts.freezeRows !== undefined) applied.push(`freezeRows=${opts.freezeRows}`)
    if (opts.freezeColumns !== undefined) applied.push(`freezeColumns=${opts.freezeColumns}`)
  }

  if (opts.autoResizeColumns) {
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: sheet.sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: sheet.columnCount,
        },
      },
    })
    applied.push('autoResizeColumns')
  }

  // Per-column pixel widths. Emitted after autoResize so they win on overlap.
  for (const cw of opts.columnWidths ?? []) {
    const { start, end } = parseColumnRange(cw.column)
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: sheet.sheetId,
          dimension: 'COLUMNS',
          startIndex: start,
          endIndex: end,
        },
        properties: { pixelSize: cw.pixelSize },
        fields: 'pixelSize',
      },
    })
    applied.push(`columnWidth[${cw.column}=${cw.pixelSize}px]`)
  }

  if (opts.wrapText) {
    const wrapRange: GridRange = opts.wrapText === true
      ? {
          sheetId: sheet.sheetId,
          startRowIndex: 0,
          endRowIndex: sheet.rowCount,
          startColumnIndex: 0,
          endColumnIndex: sheet.columnCount,
        }
      : parseA1Range(opts.wrapText.range, sheet.sheetId)
    requests.push({
      repeatCell: {
        range: wrapRange,
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat.wrapStrategy',
      },
    })
    applied.push(opts.wrapText === true ? 'wrapText' : `wrapText[${opts.wrapText.range}]`)
  }

  for (const dv of opts.dataValidations ?? []) {
    if (dv.values.length === 0) {
      throw new Error('Sheets format error: dataValidation requires at least one value')
    }
    requests.push({
      setDataValidation: {
        range: parseA1Range(dv.range, sheet.sheetId),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: dv.values.map((v) => ({ userEnteredValue: v })),
          },
          strict: dv.strict ?? true,
          showCustomUi: true,
        },
      },
    })
    applied.push(`dataValidation[${dv.range}=${dv.values.length} values]`)
  }

  if (requests.length === 0) {
    return { sheetId: sheet.sheetId, sheetTitle: sheet.title, applied: [] }
  }

  const res = await fetch(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  return { sheetId: sheet.sheetId, sheetTitle: sheet.title, applied }
}

/**
 * Raw `spreadsheets.batchUpdate` escape hatch — forwards arbitrary
 * [Request](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request#Request)
 * objects to the Sheets API. The typed tools (`formatSpreadsheet`,
 * `writeSheetRange`, etc.) cover the common cases; this handles the long
 * tail (charts, pivots, conditional formatting, merges, borders, filters,
 * protected ranges, row/column insertion).
 */
export async function batchUpdateSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  requests: unknown[],
): Promise<{ requestCount: number; replies: unknown[] }> {
  const res = await fetch(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    },
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { replies?: unknown[] }
  return { requestCount: requests.length, replies: data.replies ?? [] }
}

export async function createSpreadsheet(
  accessToken: string,
  title: string,
): Promise<{ spreadsheetId: string; title: string; url: string }> {
  const res = await fetch(`${SHEETS_API}/spreadsheets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties: { title } }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API error (${res.status}): ${err}`)
  }

  const data = await res.json() as {
    spreadsheetId: string
    properties: { title: string }
    spreadsheetUrl?: string
  }
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties.title,
    url: data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit`,
  }
}

// ── Slides ────────────────────────────────────────────────────
//
// See docs/architecture/integrations/google-slides.md for the design
// rationale. Summary: tools are structured + placeholder-targeted +
// atomic so a single `createSlide` lands a complete slide in one HTTP
// call, and text edits *replace* rather than prepending.

export type SlidePlaceholderType =
  | 'TITLE'
  | 'SUBTITLE'
  | 'BODY'
  | 'CENTERED_TITLE'
  | 'HEADER'
  | 'FOOTER'
  | 'PAGE_NUMBER'
  | 'DATE_AND_TIME'
  | 'OBJECT'
  | 'PICTURE'
  | 'UNSPECIFIED'

export type SlideLayoutType =
  | 'BLANK'
  | 'TITLE'
  | 'TITLE_AND_BODY'
  | 'TITLE_AND_TWO_COLUMNS'
  | 'TITLE_ONLY'
  | 'SECTION_HEADER'
  | 'SECTION_TITLE_AND_DESCRIPTION'
  | 'ONE_COLUMN_TEXT'
  | 'MAIN_POINT'
  | 'BIG_NUMBER'

export type PresentationInfo = {
  presentationId: string
  title: string
  slideWidthEmu: number
  slideHeightEmu: number
  slides: Array<{
    objectId: string
    pageNumber: number
    elementCount: number
  }>
}

export type SlideElement = {
  objectId: string
  /** Shape type reported by Slides API — e.g. TEXT_BOX, RECTANGLE, LINE. */
  shapeType?: string
  /** Placeholder role when this is a layout-derived shape. */
  placeholderType?: SlidePlaceholderType
  /** Concatenated text from every textRun in the shape. Empty for non-text shapes. */
  text: string
  /** Whether this element carries an inline image. */
  hasImage: boolean
  /** Normalized bounding box (0-1 of page dims). Undefined when size is missing. */
  box?: { xRel: number; yRel: number; wRel: number; hRel: number }
}

export type SlideContent = {
  slideObjectId: string
  pageNumber: number
  elements: SlideElement[]
}

// Raw-ish Slides API types kept local to this section.
type SlidesPage = {
  objectId: string
  pageElements?: SlidesPageElement[]
}

type SlidesPageElement = {
  objectId: string
  size?: { width?: { magnitude?: number }; height?: { magnitude?: number } }
  transform?: { translateX?: number; translateY?: number; scaleX?: number; scaleY?: number }
  shape?: {
    shapeType?: string
    placeholder?: { type?: string; index?: number }
    text?: { textElements?: Array<{ textRun?: { content?: string } }> }
  }
  image?: { contentUrl?: string }
}

type Presentation = {
  presentationId: string
  title: string
  pageSize?: { width?: { magnitude?: number }; height?: { magnitude?: number } }
  slides?: SlidesPage[]
}

function slidesHeaders(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, ...extra }
}

async function slidesError(res: Response, op: string): Promise<never> {
  const body = await res.text()
  throw new Error(`Slides API ${op} error (${res.status}): ${body}`)
}

async function fetchPresentation(accessToken: string, presentationId: string): Promise<Presentation> {
  const res = await fetch(
    `${SLIDES_API}/presentations/${encodeURIComponent(presentationId)}`,
    { headers: slidesHeaders(accessToken) },
  )
  if (!res.ok) await slidesError(res, 'getPresentation')
  return res.json() as Promise<Presentation>
}

async function slidesBatchUpdate(
  accessToken: string,
  presentationId: string,
  requests: unknown[],
): Promise<{ replies?: Array<Record<string, unknown>> }> {
  const res = await fetch(
    `${SLIDES_API}/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
    {
      method: 'POST',
      headers: slidesHeaders(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ requests }),
    },
  )
  if (!res.ok) await slidesError(res, 'batchUpdate')
  return res.json() as Promise<{ replies?: Array<Record<string, unknown>> }>
}

function extractShapeText(el: SlidesPageElement): string {
  let text = ''
  for (const te of el.shape?.text?.textElements ?? []) {
    if (te.textRun?.content) text += te.textRun.content
  }
  return text
}

function deriveBox(
  el: SlidesPageElement,
  pageW: number,
  pageH: number,
): SlideElement['box'] {
  const w = el.size?.width?.magnitude
  const h = el.size?.height?.magnitude
  const tx = el.transform?.translateX ?? 0
  const ty = el.transform?.translateY ?? 0
  const sx = el.transform?.scaleX ?? 1
  const sy = el.transform?.scaleY ?? 1
  if (!w || !h || !pageW || !pageH) return undefined
  return {
    xRel: tx / pageW,
    yRel: ty / pageH,
    wRel: (w * sx) / pageW,
    hRel: (h * sy) / pageH,
  }
}

function mapElement(el: SlidesPageElement, pageW: number, pageH: number): SlideElement {
  const placeholderType = el.shape?.placeholder?.type as SlidePlaceholderType | undefined
  return {
    objectId: el.objectId,
    shapeType: el.shape?.shapeType,
    placeholderType,
    text: extractShapeText(el),
    hasImage: Boolean(el.image),
    box: deriveBox(el, pageW, pageH),
  }
}

export async function getPresentationInfo(
  accessToken: string,
  presentationId: string,
): Promise<PresentationInfo> {
  const data = await fetchPresentation(accessToken, presentationId)
  const slideWidth = data.pageSize?.width?.magnitude ?? 0
  const slideHeight = data.pageSize?.height?.magnitude ?? 0
  return {
    presentationId: data.presentationId,
    title: data.title,
    slideWidthEmu: slideWidth,
    slideHeightEmu: slideHeight,
    slides: (data.slides ?? []).map((s, i) => ({
      objectId: s.objectId,
      pageNumber: i + 1,
      elementCount: s.pageElements?.length ?? 0,
    })),
  }
}

export async function getSlideContent(
  accessToken: string,
  presentationId: string,
  slideIndex: number,
): Promise<SlideContent> {
  const pres = await fetchPresentation(accessToken, presentationId)
  const slide = pres.slides?.[slideIndex]
  if (!slide) {
    throw new Error(`Slide index ${slideIndex} out of range (${pres.slides?.length ?? 0} slides)`)
  }
  const pageW = pres.pageSize?.width?.magnitude ?? 0
  const pageH = pres.pageSize?.height?.magnitude ?? 0
  return {
    slideObjectId: slide.objectId,
    pageNumber: slideIndex + 1,
    elements: (slide.pageElements ?? []).map((el) => mapElement(el, pageW, pageH)),
  }
}

export async function getSlideThumbnail(
  accessToken: string,
  presentationId: string,
  slideObjectId: string,
  options?: { mimeType?: 'PNG'; size?: 'LARGE' | 'MEDIUM' | 'SMALL' },
): Promise<{ contentUrl: string; width: number; height: number }> {
  const params = new URLSearchParams()
  params.set('thumbnailProperties.mimeType', options?.mimeType ?? 'PNG')
  params.set('thumbnailProperties.thumbnailSize', options?.size ?? 'MEDIUM')
  const res = await fetch(
    `${SLIDES_API}/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(slideObjectId)}/thumbnail?${params}`,
    { headers: slidesHeaders(accessToken) },
  )
  if (!res.ok) await slidesError(res, 'getThumbnail')
  const data = (await res.json()) as { contentUrl?: string; width?: number; height?: number }
  if (!data.contentUrl) {
    throw new Error('Slides API getThumbnail returned no contentUrl')
  }
  return { contentUrl: data.contentUrl, width: data.width ?? 0, height: data.height ?? 0 }
}

// ── Write ops ─────────────────────────────────────────────────

export async function createPresentation(
  accessToken: string,
  title: string,
): Promise<{ presentationId: string; title: string; url: string }> {
  const res = await fetch(`${SLIDES_API}/presentations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Slides API error (${res.status}): ${err}`)
  }

  const data = await res.json() as { presentationId: string; title: string }
  return {
    presentationId: data.presentationId,
    title: data.title,
    url: `https://docs.google.com/presentation/d/${data.presentationId}/edit`,
  }
}

export type CreateSlideArgs = {
  /** Zero-based insertion index. Omit to append at the end. */
  insertionIndex?: number
  /** Predefined layout. Defaults to BLANK if no placeholders are given. */
  layout?: SlideLayoutType
  /** Placeholder text to fill. Keys are placeholder types; values are the text. */
  placeholders?: Partial<Record<SlidePlaceholderType, string>>
  /** Images to drop into picture placeholders (by type) or at explicit boxes. */
  images?: Array<{
    source: { driveFileId: string } | { url: string }
    target?:
      | { placeholderType: 'PICTURE' | 'OBJECT' }
      | { boxEmu: { x: number; y: number; w: number; h: number } }
  }>
}

export type CreateSlideResult = {
  slideObjectId: string
  /** Mapping from placeholder type → minted object ID (only for types we asked for). */
  placeholderIds: Partial<Record<SlidePlaceholderType, string>>
}

/**
 * Atomic slide creation: create + layout + fill placeholders + drop images,
 * all in one `batchUpdate`. The `placeholderIdMappings` trick pre-names the
 * placeholder object IDs Google will mint so the same batch can `insertText`
 * into them.
 */
export async function createSlide(
  accessToken: string,
  presentationId: string,
  args: CreateSlideArgs,
): Promise<CreateSlideResult> {
  const slideObjectId = mintId('sl')
  const placeholderTypes = Object.keys(args.placeholders ?? {}) as SlidePlaceholderType[]
  const imagePlaceholderTypes = (args.images ?? [])
    .map((i) => (i.target && 'placeholderType' in i.target ? (i.target.placeholderType as SlidePlaceholderType) : null))
    .filter((t): t is SlidePlaceholderType => t !== null)

  const placeholderIds: Partial<Record<SlidePlaceholderType, string>> = {}
  const placeholderIdMappings: Array<{ layoutPlaceholder: { type: string; index: number }; objectId: string }> = []

  for (const type of [...placeholderTypes, ...imagePlaceholderTypes]) {
    if (placeholderIds[type]) continue // one slot per type in this simplified model
    const id = mintId(`ph_${type.toLowerCase()}`)
    placeholderIds[type] = id
    placeholderIdMappings.push({
      layoutPlaceholder: { type, index: 0 },
      objectId: id,
    })
  }

  const requests: unknown[] = []
  const createSlideReq: Record<string, unknown> = { objectId: slideObjectId }
  if (args.insertionIndex !== undefined) createSlideReq.insertionIndex = args.insertionIndex
  if (args.layout) {
    createSlideReq.slideLayoutReference = { predefinedLayout: args.layout }
  }
  if (placeholderIdMappings.length > 0) {
    createSlideReq.placeholderIdMappings = placeholderIdMappings
  }
  requests.push({ createSlide: createSlideReq })

  for (const [type, text] of Object.entries(args.placeholders ?? {})) {
    const id = placeholderIds[type as SlidePlaceholderType]
    if (!id || !text) continue
    requests.push({ insertText: { objectId: id, text } })
  }

  for (const img of args.images ?? []) {
    const imgRequest = buildImageRequest(img, placeholderIds, slideObjectId)
    if (imgRequest) requests.push(imgRequest)
  }

  await slidesBatchUpdate(accessToken, presentationId, requests)
  return { slideObjectId, placeholderIds }
}

/**
 * Replace text in one or more targets on a slide. Each target is either a
 * placeholder type (the first shape whose `placeholder.type` matches) or an
 * explicit shape object ID. Text is *replaced*, not prepended — the
 * underlying batch emits `deleteText` (all) + `insertText`.
 */
export async function updateSlideContent(
  accessToken: string,
  presentationId: string,
  args: {
    slideObjectId: string
    updates: Array<
      | { placeholderType: SlidePlaceholderType; text: string }
      | { shapeObjectId: string; text: string }
    >
  },
): Promise<{ updated: number }> {
  const res = await fetch(
    `${SLIDES_API}/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(args.slideObjectId)}`,
    { headers: slidesHeaders(accessToken) },
  )
  if (!res.ok) await slidesError(res, 'getPage')
  const page = (await res.json()) as SlidesPage

  const requests: unknown[] = []
  let updated = 0
  for (const upd of args.updates) {
    let objectId: string | undefined
    if ('placeholderType' in upd) {
      const match = page.pageElements?.find(
        (el) => el.shape?.placeholder?.type === upd.placeholderType,
      )
      objectId = match?.objectId
    } else {
      objectId = upd.shapeObjectId
    }
    if (!objectId) continue

    // Determine whether the shape has existing text to clear.
    const hasExistingText = page.pageElements?.some(
      (el) => el.objectId === objectId && extractShapeText(el).length > 0,
    )
    if (hasExistingText) {
      requests.push({ deleteText: { objectId, textRange: { type: 'ALL' } } })
    }
    requests.push({ insertText: { objectId, text: upd.text } })
    updated += 1
  }

  if (updated === 0) {
    return { updated: 0 }
  }
  await slidesBatchUpdate(accessToken, presentationId, requests)
  return { updated }
}

export type InsertImageArgs = {
  slideObjectId: string
  source: { driveFileId: string } | { url: string }
  target?:
    | { placeholderType: 'PICTURE' | 'OBJECT' }
    | { boxEmu: { x: number; y: number; w: number; h: number } }
}

export async function insertImage(
  accessToken: string,
  presentationId: string,
  args: InsertImageArgs,
): Promise<{ imageObjectId: string }> {
  const placeholderIds: Partial<Record<SlidePlaceholderType, string>> = {}
  const placeholderTarget = args.target && 'placeholderType' in args.target ? args.target : null
  if (placeholderTarget) {
    const res = await fetch(
      `${SLIDES_API}/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(args.slideObjectId)}`,
      { headers: slidesHeaders(accessToken) },
    )
    if (!res.ok) await slidesError(res, 'getPage')
    const page = (await res.json()) as SlidesPage
    const hit = page.pageElements?.find(
      (el) => el.shape?.placeholder?.type === placeholderTarget.placeholderType,
    )
    if (hit?.objectId) {
      placeholderIds[placeholderTarget.placeholderType as SlidePlaceholderType] = hit.objectId
    }
  }

  const request = buildImageRequest(
    { source: args.source, target: args.target },
    placeholderIds,
    args.slideObjectId,
  )
  if (!request) {
    throw new Error('insertImage: target placeholder not found on slide')
  }
  const result = await slidesBatchUpdate(accessToken, presentationId, [request])
  const reply = result.replies?.[0] as { createImage?: { objectId?: string }; replaceImage?: { objectId?: string } } | undefined
  const imageObjectId = reply?.createImage?.objectId ?? reply?.replaceImage?.objectId
  if (!imageObjectId) {
    throw new Error('insertImage: Slides API did not return an image objectId')
  }
  return { imageObjectId }
}

export async function deleteSlide(
  accessToken: string,
  presentationId: string,
  slideObjectId: string,
): Promise<void> {
  await slidesBatchUpdate(accessToken, presentationId, [
    { deleteObject: { objectId: slideObjectId } },
  ])
}

export async function reorderSlides(
  accessToken: string,
  presentationId: string,
  slideObjectIds: string[],
  insertionIndex: number,
): Promise<void> {
  await slidesBatchUpdate(accessToken, presentationId, [
    { updateSlidesPosition: { slideObjectIds, insertionIndex } },
  ])
}

export async function duplicateSlide(
  accessToken: string,
  presentationId: string,
  slideObjectId: string,
  insertionIndex?: number,
): Promise<{ newSlideObjectId: string }> {
  const newId = mintId('sl')
  const dup: Record<string, unknown> = { objectId: slideObjectId, objectIds: { [slideObjectId]: newId } }
  const requests: unknown[] = [{ duplicateObject: dup }]
  if (insertionIndex !== undefined) {
    requests.push({ updateSlidesPosition: { slideObjectIds: [newId], insertionIndex } })
  }
  await slidesBatchUpdate(accessToken, presentationId, requests)
  return { newSlideObjectId: newId }
}

export async function batchUpdateSlides(
  accessToken: string,
  presentationId: string,
  requests: unknown[],
): Promise<unknown> {
  return slidesBatchUpdate(accessToken, presentationId, requests)
}

// ── Internal helpers ──────────────────────────────────────────

function mintId(prefix: string): string {
  // Slides object IDs must be 5-50 chars, start with a letter/underscore,
  // and only contain alnum + `_`. A short ULID-ish suffix is plenty.
  const rand = Math.random().toString(36).slice(2, 10)
  const time = Date.now().toString(36).slice(-6)
  return `${prefix}_${time}${rand}`.slice(0, 50)
}

function buildImageRequest(
  img: {
    source: { driveFileId: string } | { url: string }
    target?:
      | { placeholderType: 'PICTURE' | 'OBJECT' }
      | { boxEmu: { x: number; y: number; w: number; h: number } }
  },
  placeholderIds: Partial<Record<SlidePlaceholderType, string>>,
  slideObjectId: string,
): unknown | null {
  const url = 'driveFileId' in img.source
    ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(img.source.driveFileId)}`
    : img.source.url

  // Case A: target a placeholder already on the slide → replaceImage.
  if (img.target && 'placeholderType' in img.target) {
    const id = placeholderIds[img.target.placeholderType as SlidePlaceholderType]
    if (!id) return null
    return { replaceImage: { imageObjectId: id, url, imageReplaceMethod: 'CENTER_INSIDE' } }
  }

  // Case B: explicit box → createImage on the target slide.
  if (img.target && 'boxEmu' in img.target) {
    const { x, y, w, h } = img.target.boxEmu
    return {
      createImage: {
        objectId: mintId('img'),
        url,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: w, unit: 'EMU' },
            height: { magnitude: h, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: x,
            translateY: y,
            unit: 'EMU',
          },
        },
      },
    }
  }

  // Case C: no explicit target → createImage with default sizing at origin.
  return {
    createImage: {
      objectId: mintId('img'),
      url,
      elementProperties: { pageObjectId: slideObjectId },
    },
  }
}
