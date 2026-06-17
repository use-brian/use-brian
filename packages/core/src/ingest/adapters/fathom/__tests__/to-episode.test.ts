import { describe, expect, it } from 'vitest'

import { episodeContentRefSchema, episodeEnvelopeSchema } from '../../../schemas.js'
import { fathomMeetingToEpisode } from '../to-episode.js'
import type { FathomEpisodeContext, FathomNormalizedMeeting } from '../types.js'

const BASE_MEETING: FathomNormalizedMeeting = {
  recording_id: 'rec-123',
  title: 'Q2 planning sync',
  recorded_at: new Date('2026-05-14T10:00:00.000Z'),
  duration_secs: 1800,
  recording_url: 'https://fathom.video/calls/abc',
  transcript_text: 'Alice: kicking off Q2 planning...',
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
}

const BASE_CTX: FathomEpisodeContext = {
  workspace_id: 'ws-1',
  user_id: 'u-1',
  assistant_id: null,
  created_by_user_id: 'u-1',
  created_by_assistant_id: null,
}

describe('[COMP:brain/source-adapters/fathom] fathomMeetingToEpisode', () => {
  it('builds an EpisodeEnvelope that round-trips through episodeEnvelopeSchema', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, BASE_CTX)
    const parsed = episodeEnvelopeSchema.parse(envelope)
    expect(parsed).toEqual(envelope)
  })

  it('stamps source_kind=meeting and emits a MeetingContentRef-shaped source_ref', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, BASE_CTX)
    expect(envelope.source_kind).toBe('meeting')
    expect(envelope.source_ref).toMatchObject({
      source_kind: 'meeting',
      transcript_file_id: 'fathom:transcript:rec-123',
      recording_url: 'https://fathom.video/calls/abc',
      attendee_external_ids: ['alice@acme.com', 'bob@acme.com'],
      recording_id: 'rec-123',
    })
    // The source_ref is a valid MeetingContentRef per the discriminated
    // union in `packages/core/src/ingest/types.ts`.
    expect(() => episodeContentRefSchema.parse(envelope.source_ref)).not.toThrow()
  })

  it('omits recording_url from source_ref when the normalized meeting has none', () => {
    const envelope = fathomMeetingToEpisode(
      { ...BASE_MEETING, recording_url: null },
      BASE_CTX,
    )
    expect('recording_url' in envelope.source_ref).toBe(false)
    expect(() => episodeContentRefSchema.parse(envelope.source_ref)).not.toThrow()
  })

  it('maps participants to actors with role + external_id (no user_id)', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, BASE_CTX)
    expect(envelope.actors).toEqual([
      { role: 'host', external_id: 'alice@acme.com' },
      { role: 'attendee', external_id: 'bob@acme.com' },
    ])
  })

  it('uses recorded_at as occurred_at and leaves content.attachments empty', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, BASE_CTX)
    expect(envelope.occurred_at).toEqual(new Date('2026-05-14T10:00:00.000Z'))
    expect(envelope.content.attachments).toEqual([])
  })

  it('inlines a short transcript and references the transcript for an oversize one', () => {
    const shortEnvelope = fathomMeetingToEpisode(BASE_MEETING, BASE_CTX)
    expect(shortEnvelope.content.raw).toBe('Alice: kicking off Q2 planning...')

    const huge = 'x'.repeat(16 * 1024 + 1)
    const bigEnvelope = fathomMeetingToEpisode(
      { ...BASE_MEETING, transcript_text: huge },
      BASE_CTX,
    )
    expect(bigEnvelope.content.raw).toEqual({ ref: 'fathom:transcript:rec-123' })
  })

  it('points content.raw at the meeting when no transcript is fetched yet', () => {
    const envelope = fathomMeetingToEpisode(
      { ...BASE_MEETING, transcript_text: null },
      BASE_CTX,
    )
    expect(envelope.content.raw).toEqual({ ref: 'fathom:meeting:rec-123' })
  })

  it('keeps attendee_external_ids in sync with actors[].external_id', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, BASE_CTX)
    const fromActors = envelope.actors
      .map((a) => a.external_id)
      .filter((x): x is string => typeof x === 'string')
    expect(envelope.source_ref.attendee_external_ids).toEqual(fromActors)
  })

  it('defaults sensitivity to internal and respects an explicit override', () => {
    expect(fathomMeetingToEpisode(BASE_MEETING, BASE_CTX).sensitivity).toBe('internal')
    expect(
      fathomMeetingToEpisode(BASE_MEETING, { ...BASE_CTX, sensitivity: 'confidential' })
        .sensitivity,
    ).toBe('confidential')
  })

  it('supports assistant-only visibility', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, {
      ...BASE_CTX,
      user_id: null,
      assistant_id: 'a-1',
      created_by_assistant_id: 'a-1',
    })
    const parsed = episodeEnvelopeSchema.parse(envelope)
    expect(parsed.user_id).toBeNull()
    expect(parsed.assistant_id).toBe('a-1')
  })

  it('rejects an envelope built with neither user_id nor assistant_id (visibility invariant)', () => {
    const envelope = fathomMeetingToEpisode(BASE_MEETING, {
      ...BASE_CTX,
      user_id: null,
      assistant_id: null,
    })
    expect(() => episodeEnvelopeSchema.parse(envelope)).toThrow(/visibility/)
  })

  it('handles a meeting with no participants', () => {
    const envelope = fathomMeetingToEpisode(
      { ...BASE_MEETING, participants: [] },
      BASE_CTX,
    )
    expect(envelope.actors).toEqual([])
    expect(envelope.source_ref.attendee_external_ids).toEqual([])
    expect(() => episodeEnvelopeSchema.parse(envelope)).not.toThrow()
  })
})
