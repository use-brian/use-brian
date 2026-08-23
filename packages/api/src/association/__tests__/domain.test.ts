import { describe, expect, it } from 'vitest'
import {
  associationFingerprint,
  decodeAssociationCursor,
  encodeAssociationCursor,
  EnquiryCreateSchema,
  EventInputSchema,
  mayTransitionRegistration,
  mayTransitionOrder,
  OrderCreateSchema,
} from '../domain.js'

const CONTACT_ID = '11111111-1111-4111-8111-111111111111'
const TICKET_ID = '22222222-2222-4222-8222-222222222222'

describe('[COMP:crm/association-domain] bounded domain contracts', () => {
  it('applies deterministic intake defaults', () => {
    const parsed = EnquiryCreateSchema.parse({
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-1',
      subject: 'Membership question',
      message: 'Could you tell me which plan applies?',
    })
    expect(parsed.queueKey).toBe('general')
    expect(parsed.submittedData).toEqual({})
  })

  it('rejects invalid event windows and oversized flexible payloads', () => {
    expect(EventInputSchema.safeParse({
      slug: 'annual-forum',
      title: 'Annual Forum',
      startsAt: '2027-02-02T11:00:00.000Z',
      endsAt: '2027-02-02T10:00:00.000Z',
      timezone: 'Asia/Hong_Kong',
      mode: 'venue',
    }).success).toBe(false)

    expect(EnquiryCreateSchema.safeParse({
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-2',
      subject: 'Question',
      message: 'Hello',
      submittedData: { importBlob: 'x'.repeat(33_000) },
    }).success).toBe(false)
  })

  it('requires one attendee per reserved place', () => {
    const result = OrderCreateSchema.safeParse({
      contactId: CONTACT_ID,
      idempotencyKey: 'checkout-1',
      lines: [{
        ticketId: TICKET_ID,
        quantity: 2,
        attendees: [{ name: 'Example Attendee' }],
      }],
    })
    expect(result.success).toBe(false)
  })

  it('fingerprints equivalent object key order identically', () => {
    expect(associationFingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      associationFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    )
  })

  it('permits only named order transitions', () => {
    expect(mayTransitionOrder('pending', 'paid')).toBe(true)
    expect(mayTransitionOrder('paid', 'refunded')).toBe(true)
    expect(mayTransitionOrder('paid', 'failed')).toBe(false)
    expect(mayTransitionOrder('refunded', 'paid')).toBe(false)
    expect(mayTransitionRegistration('confirmed', 'checked_in')).toBe(true)
    expect(mayTransitionRegistration('reserved', 'checked_in')).toBe(false)
  })

  it('requires an IANA timezone instead of an arbitrary display label', () => {
    const base = {
      slug: 'annual-forum',
      title: 'Annual Forum',
      startsAt: '2027-02-02T10:00:00.000Z',
      endsAt: '2027-02-02T11:00:00.000Z',
      mode: 'venue' as const,
    }
    expect(EventInputSchema.safeParse({ ...base, timezone: 'Asia/Hong_Kong' }).success).toBe(true)
    expect(EventInputSchema.safeParse({ ...base, timezone: 'Hong Kong time' }).success).toBe(false)
  })

  it('round-trips opaque list cursors and rejects malformed values', () => {
    const cursor = {
      createdAt: '2027-02-02T10:00:00.000Z',
      id: CONTACT_ID,
    }
    expect(decodeAssociationCursor(encodeAssociationCursor(cursor))).toEqual(cursor)
    expect(decodeAssociationCursor('not-a-cursor')).toBeNull()
  })
})
