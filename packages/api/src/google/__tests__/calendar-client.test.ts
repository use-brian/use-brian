/**
 * Google Calendar event transport tests.
 *
 * [COMP:tools/google-calendar]
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEventColors,
  listCalendarList,
  queryCalendarFreeBusy,
  updateCalendarEvent,
} from '../client.js'

const mockFetch = vi.fn()

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => '' }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(ok({ id: 'evt-series', summary: 'Running' }))
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[COMP:tools/google-calendar] createCalendarEvent transport', () => {
  it('sends named event labels with eventLabelVersion=1', async () => {
    await createCalendarEvent('tok', {
      summary: 'Client call',
      start: '2026-08-15T09:00:00+08:00',
      end: '2026-08-15T10:00:00+08:00',
      eventLabelId: 'label-client',
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&eventLabelVersion=1',
    )
    expect(JSON.parse(init.body as string)).toMatchObject({ eventLabelId: 'label-client' })
  })

  it('keeps legacy colorId on the version-0 compatibility path', async () => {
    await createCalendarEvent('tok', {
      summary: 'Deadline',
      start: '2026-08-15T09:00:00+08:00',
      end: '2026-08-15T10:00:00+08:00',
      colorId: '11',
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('eventLabelVersion')
    expect(JSON.parse(init.body as string)).toMatchObject({ colorId: '11' })
  })

  it('rejects simultaneous eventLabelId and colorId before transport', async () => {
    await expect(createCalendarEvent('tok', {
      summary: 'Ambiguous',
      start: '2026-08-15T09:00:00+08:00',
      end: '2026-08-15T10:00:00+08:00',
      eventLabelId: 'label-client',
      colorId: '11',
    })).rejects.toThrow('not both')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('posts recurrence lines and the IANA timezone on both series boundaries', async () => {
    await createCalendarEvent('tok', {
      summary: 'Running',
      start: '2026-08-11T18:30:00+08:00',
      end: '2026-08-11T22:00:00+08:00',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      timeZone: 'Asia/Hong_Kong',
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body as string)).toEqual({
      summary: 'Running',
      start: {
        dateTime: '2026-08-11T18:30:00+08:00',
        timeZone: 'Asia/Hong_Kong',
      },
      end: {
        dateTime: '2026-08-11T22:00:00+08:00',
        timeZone: 'Asia/Hong_Kong',
      },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
    })
  })

  it('maps all-day boundaries plus Meet, reminders, privacy, guests, and Drive attachments', async () => {
    await createCalendarEvent('tok', {
      summary: 'Retreat',
      start: '2026-09-18',
      end: '2026-09-20',
      allDay: true,
      calendarId: 'work@example.com',
      conference: 'google_meet',
      attendees: [{ email: 'alice@example.com', optional: true }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
      availability: 'free',
      visibility: 'private',
      guestPermissions: { canInviteOthers: false, canSeeOtherGuests: true },
      attachments: [{ fileUrl: 'https://drive.google.com/file/d/brief', title: 'Brief' }],
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/work%40example.com/events?sendUpdates=all&conferenceDataVersion=1&supportsAttachments=true',
    )
    expect(JSON.parse(init.body as string)).toMatchObject({
      summary: 'Retreat',
      start: { date: '2026-09-18' },
      end: { date: '2026-09-20' },
      attendees: [{ email: 'alice@example.com', optional: true }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
      transparency: 'transparent',
      visibility: 'private',
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
      attachments: [{ fileUrl: 'https://drive.google.com/file/d/brief', title: 'Brief' }],
      conferenceData: {
        createRequest: {
          conferenceSolutionKey: { type: 'hangoutsMeet' },
          requestId: expect.any(String),
        },
      },
    })
  })

  it('maps Focus Time, Out of Office, and Working Location provider requirements', async () => {
    await createCalendarEvent('tok', {
      summary: 'Focus',
      start: '2026-08-05T09:00:00Z',
      end: '2026-08-05T11:00:00Z',
      eventType: 'focusTime',
      availability: 'free',
      focusTimeProperties: {
        autoDeclineMode: 'declineOnlyNewConflictingInvitations',
        chatStatus: 'doNotDisturb',
      },
    })
    let body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body).toMatchObject({
      eventType: 'focusTime',
      transparency: 'opaque',
      focusTimeProperties: {
        autoDeclineMode: 'declineOnlyNewConflictingInvitations',
        chatStatus: 'doNotDisturb',
      },
    })

    mockFetch.mockClear()
    await createCalendarEvent('tok', {
      summary: 'Away',
      start: '2026-08-05T12:00:00Z',
      end: '2026-08-05T18:00:00Z',
      eventType: 'outOfOffice',
      outOfOfficeProperties: {
        autoDeclineMode: 'declineAllConflictingInvitations',
        declineMessage: 'I am away',
      },
    })
    body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body).toMatchObject({
      eventType: 'outOfOffice',
      transparency: 'opaque',
      outOfOfficeProperties: {
        autoDeclineMode: 'declineAllConflictingInvitations',
        declineMessage: 'I am away',
      },
    })

    mockFetch.mockClear()
    await createCalendarEvent('tok', {
      summary: 'Home',
      start: '2026-08-06',
      end: '2026-08-07',
      allDay: true,
      eventType: 'workingLocation',
      workingLocationProperties: { type: 'homeOffice' },
    })
    body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body).toMatchObject({
      eventType: 'workingLocation',
      transparency: 'transparent',
      visibility: 'public',
      workingLocationProperties: { type: 'homeOffice', homeOffice: {} },
    })
  })

  it('rejects invalid status-event combinations before reporting success', async () => {
    await expect(createCalendarEvent('tok', {
      summary: 'Bad focus',
      start: '2026-08-05',
      end: '2026-08-06',
      allDay: true,
      eventType: 'focusTime',
      focusTimeProperties: {},
    })).rejects.toThrow('Focus Time cannot be an all-day event')

    await expect(createCalendarEvent('tok', {
      summary: 'Bad location',
      start: '2026-08-05',
      end: '2026-08-07',
      allDay: true,
      eventType: 'workingLocation',
      workingLocationProperties: { type: 'homeOffice' },
    })).rejects.toThrow('must span exactly one day')
  })

  it('omits recurrence and timezone fields for an unchanged one-off event request', async () => {
    await createCalendarEvent('tok', {
      summary: 'One-off',
      start: '2026-08-11T18:30:00+08:00',
      end: '2026-08-11T22:00:00+08:00',
    }, 'team/calendar@example.com', 'none')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/team%2Fcalendar%40example.com/events?sendUpdates=none')
    expect(JSON.parse(init.body as string)).toEqual({
      summary: 'One-off',
      start: { dateTime: '2026-08-11T18:30:00+08:00' },
      end: { dateTime: '2026-08-11T22:00:00+08:00' },
    })
  })

  it('surfaces Calendar API errors without reporting a series as created', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'Invalid recurrence rule',
    })

    await expect(createCalendarEvent('tok', {
      summary: 'Bad series',
      start: '2026-08-11T18:30:00+08:00',
      end: '2026-08-11T22:00:00+08:00',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      timeZone: 'Asia/Hong_Kong',
    })).rejects.toThrow('Calendar API error (400): Invalid recurrence rule')
  })
})

describe('[COMP:tools/google-calendar] calendar discovery and availability transport', () => {
  it('lists calendar-specific event labels and the live legacy palette', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        labelProperties: {
          eventLabels: [
            { id: 'label-client', name: 'Client', backgroundColor: '#039be5' },
            { id: 'incomplete', name: 'Incomplete' },
          ],
        },
      }))
      .mockResolvedValueOnce(ok({
        event: {
          9: { background: '#5484ed', foreground: '#ffffff' },
          broken: { background: '#000000' },
        },
      }))

    await expect(listCalendarEventColors('tok', 'team@example.com')).resolves.toEqual({
      calendarId: 'team@example.com',
      eventLabels: [{ id: 'label-client', name: 'Client', backgroundColor: '#039be5' }],
      palette: [{ colorId: '9', background: '#5484ed', foreground: '#ffffff' }],
    })
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/team%40example.com',
    )
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe(
      'https://www.googleapis.com/calendar/v3/colors',
    )
  })

  it('paginates the user calendar list', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ items: [{ id: 'primary', summary: 'Main' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(ok({ items: [{ id: 'work', summary: 'Work', accessRole: 'writer' }] }))

    await expect(listCalendarList('tok')).resolves.toEqual([
      { id: 'primary', summary: 'Main' },
      { id: 'work', summary: 'Work', accessRole: 'writer' },
    ])
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain('pageToken=next')
  })

  it('returns per-calendar busy blocks and their common-free complement', async () => {
    mockFetch.mockResolvedValueOnce(ok({
      calendars: {
        primary: { busy: [{ start: '2026-08-05T09:30:00Z', end: '2026-08-05T10:00:00Z' }] },
        'alice@example.com': { busy: [{ start: '2026-08-05T11:00:00Z', end: '2026-08-05T12:00:00Z' }] },
      },
    }))

    const result = await queryCalendarFreeBusy('tok', {
      timeMin: '2026-08-05T09:00:00Z',
      timeMax: '2026-08-05T13:00:00Z',
      calendarIds: ['primary', 'alice@example.com'],
      durationMinutes: 45,
      timeZone: 'Asia/Hong_Kong',
    })

    expect(JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      timeMin: '2026-08-05T09:00:00Z',
      timeMax: '2026-08-05T13:00:00Z',
      timeZone: 'Asia/Hong_Kong',
      items: [{ id: 'primary' }, { id: 'alice@example.com' }],
    })
    expect(result.available).toEqual([
      { start: '2026-08-05T10:00:00.000Z', end: '2026-08-05T11:00:00.000Z' },
      { start: '2026-08-05T12:00:00.000Z', end: '2026-08-05T13:00:00.000Z' },
    ])
  })

  it('fails closed when any requested calendar has a per-calendar error', async () => {
    mockFetch.mockResolvedValueOnce(ok({
      calendars: {
        primary: { busy: [] },
        'private@example.com': { busy: [], errors: [{ reason: 'notFound' }] },
      },
    }))

    await expect(queryCalendarFreeBusy('tok', {
      timeMin: '2026-08-05T09:00:00Z',
      timeMax: '2026-08-05T13:00:00Z',
      calendarIds: ['primary', 'private@example.com'],
    })).rejects.toThrow('Calendar free/busy unavailable for: private@example.com')
  })
})

describe('[COMP:tools/google-calendar] updateCalendarEvent transport', () => {
  it('updates a named event label with eventLabelVersion=1', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'evt-label',
        summary: 'Client call',
        start: { dateTime: '2026-08-15T09:00:00+08:00' },
        end: { dateTime: '2026-08-15T10:00:00+08:00' },
      }))
      .mockResolvedValueOnce(ok({ id: 'evt-label', eventLabelId: 'label-client' }))

    await updateCalendarEvent('tok', 'evt-label', { eventLabelId: 'label-client' })

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('eventLabelVersion=1')
    expect(JSON.parse(init.body as string)).toEqual({ eventLabelId: 'label-client' })
  })

  it('clears a named event label with eventLabelVersion=1', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'evt-label',
        eventLabelId: 'label-client',
        summary: 'Client call',
        start: { dateTime: '2026-08-15T09:00:00+08:00' },
        end: { dateTime: '2026-08-15T10:00:00+08:00' },
      }))
      .mockResolvedValueOnce(ok({ id: 'evt-label' }))

    await updateCalendarEvent('tok', 'evt-label', { eventLabelId: '' })

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('eventLabelVersion=1')
    expect(JSON.parse(init.body as string)).toEqual({ eventLabelId: '' })
  })

  it('converts an all-day event to timed boundaries from an RFC 3339 pair without requiring allDay=false', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'dinner',
        summary: 'Dinner',
        start: { date: '2026-08-23' },
        end: { date: '2026-08-24' },
      }))
      .mockResolvedValueOnce(ok({ id: 'dinner' }))

    await updateCalendarEvent('tok', 'dinner', {
      start: '2026-08-23T19:00:00+09:00',
      end: '2026-08-23T23:00:00+09:00',
    })

    expect(JSON.parse((mockFetch.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      start: { dateTime: '2026-08-23T19:00:00+09:00' },
      end: { dateTime: '2026-08-23T23:00:00+09:00' },
    })
  })

  it('rejects a partial all-day to timed conversion before calling Google', async () => {
    mockFetch.mockResolvedValueOnce(ok({
      id: 'dinner',
      summary: 'Dinner',
      start: { date: '2026-08-23' },
      end: { date: '2026-08-24' },
    }))

    await expect(updateCalendarEvent('tok', 'dinner', {
      start: '2026-08-23T19:00:00+09:00',
    })).rejects.toThrow('requires both start and end boundaries')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('updates all-day boundaries, reminders, privacy, availability, guest permissions, and conference removal', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'evt-options',
        summary: 'Options',
        start: { dateTime: '2026-08-05T09:00:00Z' },
        end: { dateTime: '2026-08-05T10:00:00Z' },
        conferenceData: { conferenceId: 'old' },
      }))
      .mockResolvedValueOnce(ok({ id: 'evt-options' }))

    await updateCalendarEvent('tok', 'evt-options', {
      start: '2026-08-06',
      end: '2026-08-07',
      allDay: true,
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] },
      availability: 'free',
      visibility: 'private',
      guestPermissions: { canInviteOthers: false, canModify: false, canSeeOtherGuests: false },
      conference: 'none',
    })

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('conferenceDataVersion=1')
    expect(JSON.parse(init.body as string)).toEqual({
      start: { date: '2026-08-06' },
      end: { date: '2026-08-07' },
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] },
      transparency: 'transparent',
      visibility: 'private',
      conferenceData: null,
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false,
    })
  })

  it('updates the matching Calendar status property object without changing eventType', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'where',
        eventType: 'workingLocation',
        summary: 'Office',
        start: { date: '2026-08-06' },
        end: { date: '2026-08-07' },
      }))
      .mockResolvedValueOnce(ok({ id: 'where', eventType: 'workingLocation' }))

    await updateCalendarEvent('tok', 'where', {
      workingLocationProperties: {
        type: 'officeLocation',
        label: 'HQ',
        buildingId: 'building-1',
        deskId: '42',
      },
    })

    expect(JSON.parse((mockFetch.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      workingLocationProperties: {
        type: 'officeLocation',
        officeLocation: { label: 'HQ', buildingId: 'building-1', deskId: '42' },
      },
      visibility: 'public',
      transparency: 'transparent',
    })
  })

  it('merges attendee and attachment changes without dropping RSVP metadata', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'evt1',
        summary: 'Meeting',
        start: { dateTime: '2026-08-05T09:00:00Z' },
        end: { dateTime: '2026-08-05T10:00:00Z' },
        attendees: [
          { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
          { email: 'keep@example.com', responseStatus: 'accepted' },
          { email: 'remove@example.com', responseStatus: 'tentative' },
        ],
        attachments: [
          { fileUrl: 'https://drive.google.com/file/d/keep', title: 'Keep' },
          { fileUrl: 'https://drive.google.com/file/d/remove', title: 'Remove' },
        ],
      }))
      .mockResolvedValueOnce(ok({ id: 'evt1' }))

    await updateCalendarEvent('tok', 'evt1', {
      calendarId: 'work@example.com',
      responseStatus: 'accepted',
      responseComment: 'See you there',
      attendeeChanges: {
        add: [{ email: 'new@example.com', optional: true }],
        remove: ['remove@example.com'],
      },
      attachmentChanges: {
        add: [{ fileUrl: 'https://drive.google.com/file/d/new', title: 'New' }],
        removeFileUrls: ['https://drive.google.com/file/d/remove'],
      },
      conference: 'google_meet',
    })

    const [patchUrl, patchInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(patchUrl).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/work%40example.com/events/evt1?sendUpdates=all&conferenceDataVersion=1&supportsAttachments=true',
    )
    expect(JSON.parse(patchInit.body as string)).toMatchObject({
      attendees: [
        { email: 'me@example.com', self: true, responseStatus: 'accepted', comment: 'See you there' },
        { email: 'keep@example.com', responseStatus: 'accepted' },
        { email: 'new@example.com', optional: true },
      ],
      attachments: [
        { fileUrl: 'https://drive.google.com/file/d/keep', title: 'Keep' },
        { fileUrl: 'https://drive.google.com/file/d/new', title: 'New' },
      ],
      conferenceData: {
        createRequest: {
          requestId: expect.any(String),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    })
  })

  it('resolves a recurring instance to its parent for a series update', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'instance-2',
        recurringEventId: 'series-1',
        originalStartTime: { dateTime: '2026-08-18T10:00:00Z' },
        start: { dateTime: '2026-08-18T10:00:00Z' },
        end: { dateTime: '2026-08-18T11:00:00Z' },
      }))
      .mockResolvedValueOnce(ok({
        id: 'series-1',
        summary: 'Weekly',
        recurrence: ['RRULE:FREQ=WEEKLY'],
        start: { dateTime: '2026-08-11T10:00:00Z' },
        end: { dateTime: '2026-08-11T11:00:00Z' },
      }))
      .mockResolvedValueOnce(ok({ id: 'series-1', summary: 'Renamed' }))

    await updateCalendarEvent('tok', 'instance-2', {
      recurringScope: 'series',
      summary: 'Renamed',
    })

    expect(String(mockFetch.mock.calls[2]?.[0])).toContain('/events/series-1?sendUpdates=all')
    expect(JSON.parse((mockFetch.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({ summary: 'Renamed' })
  })

  it('splits this-and-following, trims the parent, and inserts the replacement series', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'instance-3',
        recurringEventId: 'series-1',
        originalStartTime: { dateTime: '2026-08-18T10:00:00Z' },
        start: { dateTime: '2026-08-18T10:00:00Z' },
        end: { dateTime: '2026-08-18T11:00:00Z' },
      }))
      .mockResolvedValueOnce(ok({
        id: 'series-1',
        summary: 'Weekly',
        location: 'Old room',
        eventLabelId: 'label-client',
        recurrence: [
          'RRULE:FREQ=WEEKLY;COUNT=5',
          'RDATE:20260810T100000Z,20260825T100000Z',
          'EXDATE:20260811T100000Z,20260825T100000Z',
        ],
        start: { dateTime: '2026-08-04T10:00:00Z' },
        end: { dateTime: '2026-08-04T11:00:00Z' },
      }))
      .mockResolvedValueOnce(ok({ items: [{ id: 'instance-1' }, { id: 'instance-2' }] }))
      .mockResolvedValueOnce(ok({ id: 'series-1' }))
      .mockResolvedValueOnce(ok({ id: 'series-2', summary: 'Weekly' }))

    const result = await updateCalendarEvent('tok', 'instance-3', {
      recurringScope: 'following',
      location: 'New room',
    })

    expect(result.id).toBe('series-2')
    expect(JSON.parse((mockFetch.mock.calls[3]?.[1] as RequestInit).body as string)).toEqual({
      recurrence: [
        'RRULE:FREQ=WEEKLY;UNTIL=20260818T095959Z',
        'RDATE:20260810T100000Z',
        'EXDATE:20260811T100000Z',
      ],
    })
    expect(JSON.parse((mockFetch.mock.calls[4]?.[1] as RequestInit).body as string)).toMatchObject({
      summary: 'Weekly',
      location: 'New room',
      eventLabelId: 'label-client',
      start: { dateTime: '2026-08-18T10:00:00Z' },
      end: { dateTime: '2026-08-18T11:00:00Z' },
      recurrence: [
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'RDATE:20260825T100000Z',
        'EXDATE:20260825T100000Z',
      ],
    })
    expect(String(mockFetch.mock.calls[4]?.[0])).toContain('eventLabelVersion=1')
  })
})

describe('[COMP:tools/google-calendar] recurring delete transport', () => {
  it('resolves an instance and deletes the parent for series scope', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'instance-2',
        recurringEventId: 'series-1',
        start: { dateTime: '2026-08-18T10:00:00Z' },
        end: { dateTime: '2026-08-18T11:00:00Z' },
      }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' })

    await deleteCalendarEvent('tok', 'instance-2', 'primary', 'all', 'series')

    expect(String(mockFetch.mock.calls[1]?.[0])).toContain('/events/series-1?sendUpdates=all')
    expect((mockFetch.mock.calls[1]?.[1] as RequestInit).method).toBe('DELETE')
  })

  it('truncates the parent for this-and-following without deleting the parent', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({
        id: 'instance-2',
        recurringEventId: 'series-1',
        originalStartTime: { dateTime: '2026-08-18T10:00:00Z' },
        start: { dateTime: '2026-08-18T10:00:00Z' },
        end: { dateTime: '2026-08-18T11:00:00Z' },
      }))
      .mockResolvedValueOnce(ok({
        id: 'series-1',
        recurrence: ['RRULE:FREQ=WEEKLY'],
        start: { dateTime: '2026-08-11T10:00:00Z' },
        end: { dateTime: '2026-08-11T11:00:00Z' },
      }))
      .mockResolvedValueOnce(ok({ items: [{ id: 'instance-1' }] }))
      .mockResolvedValueOnce(ok({ id: 'series-1' }))

    await deleteCalendarEvent('tok', 'instance-2', 'primary', 'all', 'following')

    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect((mockFetch.mock.calls[3]?.[1] as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((mockFetch.mock.calls[3]?.[1] as RequestInit).body as string)).toEqual({
      recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260818T095959Z'],
    })
  })
})
