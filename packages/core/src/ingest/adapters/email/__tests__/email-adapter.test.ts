import { describe, it, expect } from 'vitest'
import { normalizeEmailMessage, emailEpisodeText } from '../normalize.js'
import { emailFilterImplementations } from '../filters.js'
import { episodeEnvelopeSchema } from '../../../schemas.js'
import type { EmailMessageInput } from '../types.js'
import type { IngestEvent } from '../../../filters.js'

const BASE: EmailMessageInput = {
  inbox_address: 'ada@agentmail.to',
  thread_id: 'thread_1',
  message_id: 'msg_2',
  from: 'Sarah Chen <sarah@acme.com>',
  to: ['ada@agentmail.to'],
  cc: ['Bob <bob@acme.com>'],
  subject: 'Q3 contract',
  text: 'Please review.\n> quoted history',
  extracted_text: 'Please review.',
  timestamp: '2026-07-15T00:00:00Z',
  prior_message_ids: ['msg_1'],
  attachments: [{ attachment_id: 'a1', filename: 'contract.pdf', content_type: 'application/pdf', size: 1234 }],
  gate: 'allowlisted',
}

const CTX = {
  workspace_id: '00000000-0000-0000-0000-0000000000aa',
  user_id: '00000000-0000-0000-0000-0000000000bb',
  assistant_id: '00000000-0000-0000-0000-0000000000cc',
  created_by_user_id: '00000000-0000-0000-0000-0000000000bb',
  created_by_assistant_id: null,
}

function event(normalized: Record<string, unknown>): IngestEvent {
  return { source: 'email', normalized }
}

describe('[COMP:brain/source-adapters/email] Email ingest adapter', () => {
  it('normalizes to a schema-valid email_thread envelope with the message-id chain', () => {
    const envelope = normalizeEmailMessage(BASE, CTX)
    expect(() => episodeEnvelopeSchema.parse(envelope)).not.toThrow()
    expect(envelope.source_kind).toBe('email_thread')
    expect(envelope.source_ref).toEqual({
      source_kind: 'email_thread',
      message_id_chain: ['msg_1', 'msg_2'],
    })
    expect(envelope.occurred_at).toEqual(new Date('2026-07-15T00:00:00Z'))
    expect(envelope.content.raw).toEqual({ ref: 'email:ada@agentmail.to/thread_1/msg_2' })
  })

  it('collects deduped lowercase actors: sender + recipients', () => {
    const envelope = normalizeEmailMessage(
      { ...BASE, cc: ['SARAH@acme.com', 'Bob <bob@acme.com>'] },
      CTX,
    )
    expect(envelope.actors).toEqual([
      { role: 'sender', external_id: 'sarah@acme.com' },
      { role: 'recipient', external_id: 'ada@agentmail.to' },
      { role: 'recipient', external_id: 'bob@acme.com' },
    ])
  })

  it('maps attachments and survives a malformed timestamp', () => {
    const envelope = normalizeEmailMessage({ ...BASE, timestamp: 'not-a-date' }, CTX)
    expect(envelope.content.attachments).toEqual([
      { kind: 'file', ref: 'a1', mime: 'application/pdf', size: 1234 },
    ])
    expect(Number.isNaN(envelope.occurred_at.getTime())).toBe(false)
  })

  it('builds the episode text from sender + subject + reply-extracted body', () => {
    expect(emailEpisodeText(BASE)).toBe(
      'From: Sarah Chen <sarah@acme.com>\nSubject: Q3 contract\n\nPlease review.',
    )
    expect(emailEpisodeText({ ...BASE, extracted_text: null, subject: null })).toBe(
      'From: Sarah Chen <sarah@acme.com>\n\nPlease review.\n> quoted history',
    )
  })

  describe('filters', () => {
    it('gate_match keys off the webhook sender-gate verdict', () => {
      const gm = emailFilterImplementations.gate_match
      expect(gm(event({ gate: 'allowlisted' }), { values: ['allowlisted'] })).toBe(true)
      expect(gm(event({ gate: 'stranger' }), { values: ['allowlisted'] })).toBe(false)
      expect(gm(event({}), { values: ['allowlisted'] })).toBe(false)
      expect(gm(event({ gate: 'allowlisted' }), {})).toBe(false)
    })

    it('subject_match is a case-insensitive keyword match over the subject only', () => {
      const sm = emailFilterImplementations.subject_match
      expect(sm(event({ subject: 'URGENT: invoice overdue' }), { keywords: ['invoice'] })).toBe(true)
      expect(sm(event({ subject: 'weekly digest' }), { values: ['Invoice'] })).toBe(false)
      expect(sm(event({ text: 'invoice in body only' }), { keywords: ['invoice'] })).toBe(false)
    })

    it('domain_match matches the sender domain with or without a leading @', () => {
      const dm = emailFilterImplementations.domain_match
      expect(dm(event({ sender: 'sarah@acme.com' }), { values: ['acme.com'] })).toBe(true)
      expect(dm(event({ sender: 'sarah@acme.com' }), { values: ['@ACME.com'] })).toBe(true)
      expect(dm(event({ sender: 'sarah@other.com' }), { values: ['acme.com'] })).toBe(false)
      expect(dm(event({}), { values: ['acme.com'] })).toBe(false)
    })
  })
})
