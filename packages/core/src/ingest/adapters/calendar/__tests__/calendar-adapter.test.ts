import { describe, it, expect } from 'vitest'

import {
  calendarAdapter,
  calendarDefaultRules,
  calendarFilterImplementations,
  calendarFilterParamsSchemas,
  normalizeCalendarEvent,
  rawCalendarEventSchema,
  type CalendarNormalizedEvent,
  type RawCalendarEvent,
} from '../index.js'

const TIMED_EVENT: RawCalendarEvent = {
  id: 'evt-timed-1',
  calendarId: 'primary',
  summary: 'Quarterly review with ACME',
  description: 'Sync on Q2 results',
  status: 'confirmed',
  location: 'Zoom',
  start: { dateTime: '2026-05-20T09:00:00Z' },
  end: { dateTime: '2026-05-20T10:00:00Z' },
  organizer: { email: 'Alice@Example.COM', displayName: 'Alice' },
  attendees: [
    { email: 'Alice@Example.COM' },
    { email: 'bob@acme.com', responseStatus: 'accepted' },
    { email: 'carol@acme.com' },
  ],
  updated: '2026-05-14T11:00:00Z',
}

function makeEvent(
  overrides: Partial<CalendarNormalizedEvent> = {},
): CalendarNormalizedEvent {
  return {
    external_id: 'evt-1',
    calendar_id: 'primary',
    subject: 'Meeting',
    description: undefined,
    start: new Date('2026-05-20T09:00:00Z'),
    end: new Date('2026-05-20T10:00:00Z'),
    is_all_day: false,
    organizer: 'alice@example.com',
    attendees: ['alice@example.com', 'bob@acme.com'],
    is_recurring: false,
    status: 'confirmed',
    location: undefined,
    occurred_at: new Date('2026-05-20T09:00:00Z'),
    ...overrides,
  }
}

describe('[COMP:brain/source-adapters/calendar] Calendar adapter', () => {
  describe('normalizeCalendarEvent', () => {
    it('maps a typical timed event', () => {
      const ev = normalizeCalendarEvent(TIMED_EVENT)
      expect(ev.external_id).toBe('evt-timed-1')
      expect(ev.calendar_id).toBe('primary')
      expect(ev.subject).toBe('Quarterly review with ACME')
      expect(ev.description).toBe('Sync on Q2 results')
      expect(ev.location).toBe('Zoom')
      expect(ev.is_all_day).toBe(false)
      expect(ev.is_recurring).toBe(false)
      expect(ev.status).toBe('confirmed')
      expect(ev.start?.toISOString()).toBe('2026-05-20T09:00:00.000Z')
      expect(ev.end?.toISOString()).toBe('2026-05-20T10:00:00.000Z')
      expect(ev.occurred_at.toISOString()).toBe('2026-05-20T09:00:00.000Z')
    })

    it('lowercases organizer + attendee emails', () => {
      const ev = normalizeCalendarEvent(TIMED_EVENT)
      expect(ev.organizer).toBe('alice@example.com')
      expect(ev.attendees).toContain('alice@example.com')
      expect(ev.attendees).toContain('bob@acme.com')
      // No uppercase survives
      for (const a of ev.attendees) expect(a).toBe(a.toLowerCase())
      expect(ev.organizer).toBe(ev.organizer.toLowerCase())
    })

    it('dedupes attendees by lowercased email', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        attendees: [
          { email: 'a@x.com' },
          { email: 'A@X.COM' },
          { email: 'b@x.com' },
          { email: 'a@x.com' },
        ],
      })
      expect(ev.attendees).toEqual(['a@x.com', 'b@x.com'])
    })

    it('skips attendees with missing email', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        attendees: [
          { email: 'a@x.com' },
          { displayName: 'Mystery guest' },
          { email: '' },
          { email: 'b@x.com' },
        ],
      })
      expect(ev.attendees).toEqual(['a@x.com', 'b@x.com'])
    })

    it('maps an all-day event', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        start: { date: '2026-05-21' },
        end: { date: '2026-05-22' },
      })
      expect(ev.is_all_day).toBe(true)
      expect(ev.start?.toISOString().startsWith('2026-05-21')).toBe(true)
      expect(ev.end?.toISOString().startsWith('2026-05-22')).toBe(true)
    })

    it('flags a recurring-series master via recurrence[]', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      })
      expect(ev.is_recurring).toBe(true)
    })

    it('flags a recurring-instance via recurringEventId', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        recurringEventId: 'evt-master-1',
      })
      expect(ev.is_recurring).toBe(true)
    })

    it('defaults status to confirmed when absent', () => {
      const ev = normalizeCalendarEvent({ ...TIMED_EVENT, status: undefined })
      expect(ev.status).toBe('confirmed')
    })

    it('passes through cancelled status', () => {
      const ev = normalizeCalendarEvent({ ...TIMED_EVENT, status: 'cancelled' })
      expect(ev.status).toBe('cancelled')
    })

    it('passes through tentative status', () => {
      const ev = normalizeCalendarEvent({ ...TIMED_EVENT, status: 'tentative' })
      expect(ev.status).toBe('tentative')
    })

    it('defaults unknown status to confirmed', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        status: 'unknown-future-tier',
      })
      expect(ev.status).toBe('confirmed')
    })

    it('handles a missing summary', () => {
      const ev = normalizeCalendarEvent({ ...TIMED_EVENT, summary: undefined })
      expect(ev.subject).toBe('')
    })

    it('defaults calendar_id to primary when not supplied', () => {
      const { calendarId: _ignored, ...rest } = TIMED_EVENT
      const ev = normalizeCalendarEvent(rest)
      expect(ev.calendar_id).toBe('primary')
    })

    it('handles a missing organizer', () => {
      const ev = normalizeCalendarEvent({ ...TIMED_EVENT, organizer: undefined })
      expect(ev.organizer).toBe('')
    })

    it('returns start=null when no start present and falls back occurred_at to updated', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        start: undefined,
        end: undefined,
        updated: '2026-05-14T12:00:00Z',
      })
      expect(ev.start).toBeNull()
      expect(ev.end).toBeNull()
      expect(ev.occurred_at.toISOString()).toBe('2026-05-14T12:00:00.000Z')
    })

    it('falls back occurred_at to created if updated is absent', () => {
      const ev = normalizeCalendarEvent({
        ...TIMED_EVENT,
        start: undefined,
        end: undefined,
        updated: undefined,
        created: '2026-05-10T08:00:00Z',
      })
      expect(ev.occurred_at.toISOString()).toBe('2026-05-10T08:00:00.000Z')
    })

    it('validates at the trust boundary when validate=true', () => {
      // Missing required `id`.
      expect(() =>
        normalizeCalendarEvent(
          { summary: 'oops' } as unknown as RawCalendarEvent,
          { validate: true },
        ),
      ).toThrow()
    })

    it('rawCalendarEventSchema accepts unknown keys via passthrough', () => {
      const parsed = rawCalendarEventSchema.parse({
        id: 'evt-1',
        summary: 'x',
        htmlLink: 'https://example.com',
        creator: { email: 'a@b.com' },
        iCalUID: 'asdf',
        sequence: 3,
      })
      expect(parsed.id).toBe('evt-1')
      expect(parsed.summary).toBe('x')
    })
  })

  describe('filters', () => {
    describe('attendee_match', () => {
      it('matches a present attendee (case-insensitive)', () => {
        const ev = makeEvent({ attendees: ['alice@example.com', 'bob@acme.com'] })
        expect(
          calendarFilterImplementations.attendee_match(ev, {
            values: ['BOB@ACME.COM'],
          }),
        ).toBe(true)
      })

      it('returns false when no attendee matches', () => {
        const ev = makeEvent({ attendees: ['alice@example.com'] })
        expect(
          calendarFilterImplementations.attendee_match(ev, {
            values: ['someone-else@elsewhere.com'],
          }),
        ).toBe(false)
      })

      it('returns false when attendees is empty', () => {
        const ev = makeEvent({ attendees: [] })
        expect(
          calendarFilterImplementations.attendee_match(ev, {
            values: ['anyone@nowhere.com'],
          }),
        ).toBe(false)
      })
    })

    describe('organizer_match', () => {
      it('matches the organizer (case-insensitive)', () => {
        const ev = makeEvent({ organizer: 'alice@example.com' })
        expect(
          calendarFilterImplementations.organizer_match(ev, {
            values: ['Alice@Example.com'],
          }),
        ).toBe(true)
      })

      it('returns false on different organizer', () => {
        const ev = makeEvent({ organizer: 'alice@example.com' })
        expect(
          calendarFilterImplementations.organizer_match(ev, {
            values: ['bob@example.com'],
          }),
        ).toBe(false)
      })

      it('returns false when organizer is missing', () => {
        const ev = makeEvent({ organizer: '' })
        expect(
          calendarFilterImplementations.organizer_match(ev, {
            values: ['alice@example.com'],
          }),
        ).toBe(false)
      })
    })

    describe('subject_contains', () => {
      it('matches a substring (case-insensitive)', () => {
        const ev = makeEvent({ subject: 'Quarterly Review with ACME' })
        expect(
          calendarFilterImplementations.subject_contains(ev, {
            keywords: ['review'],
          }),
        ).toBe(true)
      })

      it('returns false when no keyword matches', () => {
        const ev = makeEvent({ subject: 'Quarterly review' })
        expect(
          calendarFilterImplementations.subject_contains(ev, {
            keywords: ['daily', 'standup'],
          }),
        ).toBe(false)
      })

      it('returns true if any keyword matches', () => {
        const ev = makeEvent({ subject: 'urgent: triage' })
        expect(
          calendarFilterImplementations.subject_contains(ev, {
            keywords: ['planning', 'urgent', 'eod'],
          }),
        ).toBe(true)
      })
    })

    describe('is_recurring', () => {
      it('returns true when the normalized event is_recurring', () => {
        const ev = makeEvent({ is_recurring: true })
        expect(calendarFilterImplementations.is_recurring(ev, {})).toBe(true)
      })

      it('returns false otherwise', () => {
        const ev = makeEvent({ is_recurring: false })
        expect(calendarFilterImplementations.is_recurring(ev, {})).toBe(false)
      })
    })

    describe('param schemas (trust-boundary validation)', () => {
      it('attendee_match requires a non-empty values array', () => {
        expect(() =>
          calendarFilterParamsSchemas.attendee_match.parse({ values: [] }),
        ).toThrow()
        expect(
          calendarFilterParamsSchemas.attendee_match.parse({
            values: ['x@y.com'],
          }),
        ).toEqual({ values: ['x@y.com'] })
      })

      it('subject_contains requires a non-empty keywords array', () => {
        expect(() =>
          calendarFilterParamsSchemas.subject_contains.parse({ keywords: [] }),
        ).toThrow()
      })

      it('is_recurring rejects unexpected fields', () => {
        expect(() =>
          calendarFilterParamsSchemas.is_recurring.parse({ values: ['x'] }),
        ).toThrow()
      })
    })
  })

  describe('defaultRules', () => {
    it('has exactly 4 rules in the spec order', () => {
      expect(calendarDefaultRules).toHaveLength(4)
      expect(calendarDefaultRules.map((r) => r.filter_type)).toEqual([
        'attendee_match',
        'attendee_match',
        'is_recurring',
        'always',
      ])
    })

    it('places :workspace_members before :crm_contacts', () => {
      const firstParams = calendarDefaultRules[0]!.filter_params as {
        values: string[]
      }
      const secondParams = calendarDefaultRules[1]!.filter_params as {
        values: string[]
      }
      expect(firstParams.values).toEqual([':workspace_members'])
      expect(secondParams.values).toEqual([':crm_contacts'])
    })

    it('drops recurring events', () => {
      const recurring = calendarDefaultRules.find(
        (r) => r.filter_type === 'is_recurring',
      )
      expect(recurring?.routing_mode).toBe('drop')
      expect(recurring?.routing_schedule).toBeUndefined()
    })

    it('schedules the catch-all to the 8am morning preview', () => {
      const always = calendarDefaultRules.find((r) => r.filter_type === 'always')
      expect(always?.routing_mode).toBe('scheduled')
      expect(always?.routing_schedule).toBe('0 8 * * *')
    })

    it('preserves placeholders un-resolved (engine resolves at evaluation time)', () => {
      const placeholders = calendarDefaultRules
        .filter((r) => r.filter_type === 'attendee_match')
        .flatMap((r) => (r.filter_params as { values: string[] }).values)
      for (const v of placeholders) {
        expect(v.startsWith(':')).toBe(true)
      }
    })
  })

  describe('calendarAdapter aggregate', () => {
    it('exposes the expected source', () => {
      expect(calendarAdapter.source).toBe('calendar')
    })

    it('exposes exactly the four calendar filter implementations', () => {
      expect(Object.keys(calendarAdapter.filterImplementations).sort()).toEqual([
        'attendee_match',
        'is_recurring',
        'organizer_match',
        'subject_contains',
      ])
    })

    it('round-trips normalize → filter against a real fixture', () => {
      const ev = calendarAdapter.normalize(TIMED_EVENT)
      expect(
        calendarAdapter.filterImplementations.attendee_match(ev, {
          values: ['bob@acme.com'],
        }),
      ).toBe(true)
      expect(
        calendarAdapter.filterImplementations.subject_contains(ev, {
          keywords: ['acme'],
        }),
      ).toBe(true)
      expect(
        calendarAdapter.filterImplementations.is_recurring(ev, {}),
      ).toBe(false)
    })

    it('exposes the default rule list', () => {
      expect(calendarAdapter.defaultRules).toBe(calendarDefaultRules)
    })
  })
})
