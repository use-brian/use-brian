import { describe, expect, it } from 'vitest'

import { normalizeFathomMeeting } from '../normalize.js'
import type { FathomRawMeeting } from '../types.js'

const BASE_RAW: FathomRawMeeting = {
  recording_id: 'rec-123',
  title: 'Q2 planning sync',
  recorded_at: '2026-05-14T10:00:00.000Z',
  duration_secs: 1800,
  recording_url: 'https://fathom.video/calls/abc',
  default_summary: 'Discussed Q2 roadmap.',
  transcript: { text: 'Alice: ...\nBob: ...' },
  participants: [
    { id: 'p-1', email: 'alice@acme.com', name: 'Alice', is_host: true },
    { id: 'p-2', email: 'bob@acme.com', name: 'Bob' },
  ],
}

describe('[COMP:brain/source-adapters/fathom] normalizeFathomMeeting', () => {
  it('produces a fully-typed normalized meeting from a representative payload', () => {
    const out = normalizeFathomMeeting(BASE_RAW)
    expect(out).toEqual({
      recording_id: 'rec-123',
      title: 'Q2 planning sync',
      recorded_at: new Date('2026-05-14T10:00:00.000Z'),
      duration_secs: 1800,
      recording_url: 'https://fathom.video/calls/abc',
      transcript_text: 'Alice: ...\nBob: ...',
      summary_text: 'Discussed Q2 roadmap.',
      participants: [
        {
          external_id: 'alice@acme.com',
          email: 'alice@acme.com',
          name: 'Alice',
          role: 'host',
        },
        {
          external_id: 'bob@acme.com',
          email: 'bob@acme.com',
          name: 'Bob',
          role: 'attendee',
        },
      ],
    })
  })

  it('parses recorded_at from an ISO timestamp into a Date', () => {
    const out = normalizeFathomMeeting(BASE_RAW)
    expect(out.recorded_at).toBeInstanceOf(Date)
    expect(out.recorded_at.toISOString()).toBe('2026-05-14T10:00:00.000Z')
  })

  it('falls back to fathom:participant:{id} when email is missing', () => {
    const out = normalizeFathomMeeting({
      ...BASE_RAW,
      participants: [
        { id: 'p-7', name: 'Anonymous' },
        { id: 99, email: null },
      ],
    })
    expect(out.participants).toEqual([
      { external_id: 'fathom:participant:p-7', email: null, name: 'Anonymous', role: 'attendee' },
      { external_id: 'fathom:participant:99', email: null, name: null, role: 'attendee' },
    ])
  })

  it('drops participants that have neither email nor id', () => {
    const out = normalizeFathomMeeting({
      ...BASE_RAW,
      participants: [
        { name: 'Ghost' },
        { id: 'p-1', email: 'alice@acme.com' },
      ],
    })
    expect(out.participants).toEqual([
      { external_id: 'alice@acme.com', email: 'alice@acme.com', name: null, role: 'attendee' },
    ])
  })

  it('returns null for optional fields when absent', () => {
    const out = normalizeFathomMeeting({
      recording_id: 'rec-x',
      recorded_at: '2026-05-14T11:00:00Z',
    })
    expect(out.title).toBeNull()
    expect(out.duration_secs).toBeNull()
    expect(out.recording_url).toBeNull()
    expect(out.transcript_text).toBeNull()
    expect(out.summary_text).toBeNull()
    expect(out.participants).toEqual([])
  })

  it('throws when recording_id is missing', () => {
    expect(() =>
      normalizeFathomMeeting({ recorded_at: '2026-05-14T10:00:00Z' } as FathomRawMeeting),
    ).toThrow(/recording_id/)
  })

  it('throws when recorded_at is missing', () => {
    expect(() =>
      normalizeFathomMeeting({ recording_id: 'rec-1' }),
    ).toThrow(/recorded_at/)
  })

  it('throws when recorded_at is not a parseable timestamp', () => {
    expect(() =>
      normalizeFathomMeeting({ recording_id: 'rec-1', recorded_at: 'not-a-date' }),
    ).toThrow(/recorded_at/)
  })
})
