/**
 * Contract tests for `ub.ingest.append.v1`.
 * Component tag: [COMP:shared/ingest-append-contract].
 *
 * The schema IS the published contract (ingestion-external-endpoint.md §4,
 * mirrored to agent-docs) — these tests pin the wire shape so an
 * accidental edit here fails loudly instead of silently breaking every
 * external consumer (X8: breaking changes bump the version).
 */

import { describe, it, expect } from 'vitest'
import {
  INGEST_APPEND_CONTRACT_V1,
  INGEST_APPEND_IDEMPOTENCY_HEADER,
  INGEST_APPEND_SIGNATURE_HEADER,
  canonicalIngestMessageSchema,
  ingestAppendRequestSchema,
  ingestAppendResponseSchema,
} from '../ingest-append-contract.js'

const MESSAGE = {
  provider_message_id: 'MsgSvrID-42',
  conversation_id: 'room-1',
  sender_id: 'wxid_1',
  sender_display: 'Alice',
  sent_at: '2026-07-23T08:00:00Z',
  direction: 'inbound',
  kind: 'text',
  body_text: 'hello',
  media_ref: null,
  reply_to_provider_id: null,
  raw_provider_blob: { svr: 42 },
}

const REQUEST = {
  contract: INGEST_APPEND_CONTRACT_V1,
  instance_id: '4a1e6bd8-0000-4000-8000-000000000001',
  source: 'wechat',
  workspace_id: '4a1e6bd8-0000-4000-8000-000000000002',
  owner_user_id: '4a1e6bd8-0000-4000-8000-000000000003',
  cursor: { offset: 7 },
  messages: [MESSAGE],
}

describe('[COMP:shared/ingest-append-contract] wire shape', () => {
  it('pins the contract id and header names', () => {
    expect(INGEST_APPEND_CONTRACT_V1).toBe('ub.ingest.append.v1')
    expect(INGEST_APPEND_IDEMPOTENCY_HEADER).toBe('x-ub-idempotency-key')
    expect(INGEST_APPEND_SIGNATURE_HEADER).toBe('x-ub-signature')
  })

  it('accepts the §4 example request round-tripped through JSON', () => {
    const parsed = ingestAppendRequestSchema.safeParse(JSON.parse(JSON.stringify(REQUEST)))
    expect(parsed.success).toBe(true)
  })

  it('requires the exact contract literal', () => {
    expect(
      ingestAppendRequestSchema.safeParse({ ...REQUEST, contract: 'ub.ingest.append.v2' }).success,
    ).toBe(false)
  })

  it('rejects an empty batch and an unknown message kind', () => {
    expect(ingestAppendRequestSchema.safeParse({ ...REQUEST, messages: [] }).success).toBe(false)
    expect(
      canonicalIngestMessageSchema.safeParse({ ...MESSAGE, kind: 'video-call' }).success,
    ).toBe(false)
  })

  it('owner_user_id is nullable (not every source is person-scoped)', () => {
    expect(
      ingestAppendRequestSchema.safeParse({ ...REQUEST, owner_user_id: null }).success,
    ).toBe(true)
  })

  it('media records carry metadata-only refs (D14)', () => {
    const media = {
      ...MESSAGE,
      kind: 'image',
      body_text: null,
      media_ref: { filename: 'photo.jpg', mime: 'image/jpeg', size_bytes: 2048 },
    }
    expect(canonicalIngestMessageSchema.safeParse(media).success).toBe(true)
    expect(
      canonicalIngestMessageSchema.safeParse({
        ...media,
        media_ref: { filename: 'photo.jpg', mime: 'image/jpeg', size_bytes: -1 },
      }).success,
    ).toBe(false)
  })

  it('accepts a full response ack, with coverage reserved for the gap model (D11)', () => {
    const parsed = ingestAppendResponseSchema.safeParse({
      contract: INGEST_APPEND_CONTRACT_V1,
      accepted: 3,
      duplicates: 2,
      ack_cursor: { offset: 12 },
      coverage: {
        'room-1': { last_provider_message_id: 'MsgSvrID-42', gaps: [{ from: 'a', to: 'b' }] },
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepted/duplicates must be non-negative integers', () => {
    const base = { contract: INGEST_APPEND_CONTRACT_V1, accepted: 0, duplicates: 0 }
    expect(ingestAppendResponseSchema.safeParse(base).success).toBe(true)
    expect(ingestAppendResponseSchema.safeParse({ ...base, accepted: -1 }).success).toBe(false)
    expect(ingestAppendResponseSchema.safeParse({ ...base, duplicates: 1.5 }).success).toBe(false)
  })
})
