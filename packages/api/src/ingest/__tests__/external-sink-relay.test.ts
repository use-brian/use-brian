/**
 * Unit tests for the external-sink relay worker.
 * Component tag: [COMP:api/ingest-external-relay].
 *
 * Drives one relay tick against mocked stores + fetch and asserts the
 * plan's acceptance rows (ingestion-external-endpoint.md §Goal):
 *
 *   - 200 + valid ack        → cursor advances (recordAck) + delivered
 *   - 5xx                    → fail (retry), cursor does NOT advance (X3)
 *   - 429                    → fail (retry)
 *   - non-429 4xx            → dead-letter + analytics alert (X7)
 *   - all-duplicates replay  → success (consumer idempotency proven, X4)
 *   - partial ack            → whole-batch retry
 *   - auth: bearer header / hmac signature over the exact body + stable
 *     X-UB-Idempotency-Key
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  INGEST_APPEND_CONTRACT_V1,
  INGEST_APPEND_IDEMPOTENCY_HEADER,
  INGEST_APPEND_SIGNATURE_HEADER,
  ingestAppendRequestSchema,
} from '@use-brian/shared'
import { createExternalSinkRelay, buildAppendRequest } from '../external-sink-relay.js'
import { signIngestAppendBody, verifyIngestAppendSignature } from '../append-signing.js'
import type { IngestOutboxRow, IngestOutboxStore } from '../../db/ingest-outbox-store.js'
import type { IngestExternalSink } from '../../db/ingest-sink-store.js'

const MESSAGES = [
  {
    provider_message_id: 'm1',
    conversation_id: 'room-1',
    sender_id: 'wxid_1',
    sender_display: 'Alice',
    sent_at: '2026-07-23T08:00:00Z',
    direction: 'inbound',
    kind: 'text',
    body_text: 'hello',
    media_ref: null,
    reply_to_provider_id: null,
    raw_provider_blob: null,
  },
  {
    provider_message_id: 'm2',
    conversation_id: 'room-1',
    sender_id: 'wxid_2',
    sender_display: null,
    sent_at: '2026-07-23T08:01:00Z',
    direction: 'outbound',
    kind: 'image',
    body_text: null,
    media_ref: { filename: 'photo.jpg', mime: 'image/jpeg', size_bytes: 1024 },
    reply_to_provider_id: 'm1',
    raw_provider_blob: { raw: true },
  },
]

function makeRow(over: Partial<IngestOutboxRow> = {}): IngestOutboxRow {
  return {
    id: 'ob-1',
    sinkId: 'sink-1',
    connectorInstanceId: '4a1e6bd8-0000-4000-8000-000000000001',
    workspaceId: '4a1e6bd8-0000-4000-8000-000000000002',
    ownerUserId: '4a1e6bd8-0000-4000-8000-000000000003',
    source: 'wechat',
    batchId: 'batch-1',
    messages: MESSAGES,
    sourceCursor: { offset: 7 },
    status: 'processing',
    attemptCount: 1,
    nextAttemptAt: new Date('2026-07-23T09:00:00Z'),
    lastError: null,
    lockedBy: 'relay-test',
    lockedUntil: null,
    createdAt: new Date('2026-07-23T09:00:00Z'),
    deliveredAt: null,
    ...over,
  }
}

function makeSink(over: Partial<IngestExternalSink> = {}): IngestExternalSink {
  return {
    id: 'sink-1',
    connectorInstanceId: '4a1e6bd8-0000-4000-8000-000000000001',
    workspaceId: '4a1e6bd8-0000-4000-8000-000000000002',
    endpointUrl: 'https://archive.example.com/append',
    authKind: 'bearer',
    mode: 'all',
    enabled: true,
    hasSecret: true,
    lastAckCursor: null,
    lastDeliveredAt: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    ...over,
  }
}

function ackBody(over: Record<string, unknown> = {}) {
  return {
    contract: INGEST_APPEND_CONTRACT_V1,
    accepted: MESSAGES.length,
    duplicates: 0,
    ack_cursor: { offset: 9 },
    ...over,
  }
}

type Harness = {
  relay: ReturnType<typeof createExternalSinkRelay>
  outbox: {
    reclaimExpired: ReturnType<typeof vi.fn>
    claimDue: ReturnType<typeof vi.fn>
    markDelivered: ReturnType<typeof vi.fn>
    fail: ReturnType<typeof vi.fn>
    deadLetter: ReturnType<typeof vi.fn>
  }
  sinks: {
    get: ReturnType<typeof vi.fn>
    getSecretSystem: ReturnType<typeof vi.fn>
    recordAck: ReturnType<typeof vi.fn>
  }
  fetchImpl: ReturnType<typeof vi.fn>
  analytics: { logEvent: ReturnType<typeof vi.fn> }
}

function makeHarness(opts: {
  rows: IngestOutboxRow[]
  sink?: IngestExternalSink
  secret?: string | null
  response?: () => Promise<Response> | Response
}): Harness {
  const outbox = {
    reclaimExpired: vi.fn(async () => 0),
    claimDue: vi.fn(async () => opts.rows),
    markDelivered: vi.fn(async () => {}),
    fail: vi.fn(async () => null),
    deadLetter: vi.fn(async () => {}),
  }
  const sinks = {
    get: vi.fn(async () => opts.sink ?? makeSink()),
    getSecretSystem: vi.fn(async () => (opts.secret === undefined ? 'sink-secret-token' : opts.secret)),
    recordAck: vi.fn(async () => {}),
  }
  const fetchImpl = vi.fn(async () =>
    opts.response
      ? opts.response()
      : new Response(JSON.stringify(ackBody()), { status: 200 }),
  )
  const analytics = { logEvent: vi.fn() }
  const relay = createExternalSinkRelay({
    outbox: outbox as unknown as IngestOutboxStore,
    sinks: sinks as never,
    fetchImpl: fetchImpl as never,
    analytics,
    workerId: 'relay-test',
  })
  return { relay, outbox, sinks, fetchImpl, analytics }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('[COMP:api/ingest-external-relay] ack-gated cursor advance (X3)', () => {
  it('a 200 with a valid ack advances the cursor and marks delivered', async () => {
    const h = makeHarness({ rows: [makeRow()] })
    await h.relay.tick()
    expect(h.sinks.recordAck).toHaveBeenCalledWith('sink-1', { offset: 9 })
    expect(h.outbox.markDelivered).toHaveBeenCalledWith('ob-1')
    expect(h.outbox.fail).not.toHaveBeenCalled()
    expect(h.outbox.deadLetter).not.toHaveBeenCalled()
  })

  it('a 5xx does NOT advance the cursor — the row is retried', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () => new Response('boom', { status: 503 }),
    })
    await h.relay.tick()
    expect(h.sinks.recordAck).not.toHaveBeenCalled()
    expect(h.outbox.markDelivered).not.toHaveBeenCalled()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', 'HTTP 503')
    expect(h.outbox.deadLetter).not.toHaveBeenCalled()
  })

  it('a 429 backs off and retries, never dead-letters', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () => new Response('slow down', { status: 429 }),
    })
    await h.relay.tick()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', 'HTTP 429')
    expect(h.outbox.deadLetter).not.toHaveBeenCalled()
  })

  it('a network error is a retryable failure', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () => {
        throw new TypeError('fetch failed')
      },
    })
    await h.relay.tick()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', expect.stringContaining('fetch failed'))
    expect(h.sinks.recordAck).not.toHaveBeenCalled()
  })

  it('a 200 without ack_cursor still delivers but moves no cursor', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () =>
        new Response(JSON.stringify(ackBody({ ack_cursor: undefined })), { status: 200 }),
    })
    await h.relay.tick()
    expect(h.outbox.markDelivered).toHaveBeenCalledWith('ob-1')
    expect(h.sinks.recordAck).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/ingest-external-relay] dead-letter on 4xx (X7)', () => {
  it('a 400 dead-letters the row and emits the admin-visible analytics event', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () => new Response('schema mismatch', { status: 400 }),
    })
    await h.relay.tick()
    expect(h.outbox.deadLetter).toHaveBeenCalledWith(
      'ob-1',
      expect.stringContaining('HTTP 400'),
    )
    expect(h.outbox.fail).not.toHaveBeenCalled()
    expect(h.sinks.recordAck).not.toHaveBeenCalled()
    expect(h.analytics.logEvent).toHaveBeenCalledOnce()
    const event = h.analytics.logEvent.mock.calls[0][0]
    expect(event.eventName).toBe('ingest_sink_dead_letter')
    expect(event.metadata).toMatchObject({ http_status: 400, outbox_id: 'ob-1' })
  })
})

describe('[COMP:api/ingest-external-relay] idempotent batch replay (X4)', () => {
  it('an all-duplicates ack counts as success — replay stored nothing, cursor advances', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () =>
        new Response(
          JSON.stringify(ackBody({ accepted: 0, duplicates: MESSAGES.length })),
          { status: 200 },
        ),
    })
    await h.relay.tick()
    expect(h.outbox.markDelivered).toHaveBeenCalledWith('ob-1')
    expect(h.sinks.recordAck).toHaveBeenCalledOnce()
  })

  it('a partial ack (accepted + duplicates != messages.length) retries the whole batch', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () =>
        new Response(JSON.stringify(ackBody({ accepted: 1, duplicates: 0 })), { status: 200 }),
    })
    await h.relay.tick()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', expect.stringContaining('partial ack'))
    expect(h.outbox.markDelivered).not.toHaveBeenCalled()
    expect(h.sinks.recordAck).not.toHaveBeenCalled()
  })

  it('an unparseable ack is retryable — durability was not confirmed', async () => {
    const h = makeHarness({
      rows: [makeRow()],
      response: () => new Response('not json', { status: 200 }),
    })
    await h.relay.tick()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', expect.stringContaining('ack unreadable'))
    expect(h.outbox.markDelivered).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/ingest-external-relay] request shape + outbound auth', () => {
  it('sends a contract-valid ub.ingest.append.v1 body with a stable idempotency key', async () => {
    const h = makeHarness({ rows: [makeRow()] })
    await h.relay.tick()
    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://archive.example.com/append')
    const parsed = ingestAppendRequestSchema.safeParse(JSON.parse(init.body as string))
    expect(parsed.success).toBe(true)
    expect(parsed.data!.cursor).toEqual({ offset: 7 })
    expect(parsed.data!.messages).toHaveLength(2)
    const headers = init.headers as Record<string, string>
    expect(headers[INGEST_APPEND_IDEMPOTENCY_HEADER]).toBe('batch-1')
    expect(headers.authorization).toBe('Bearer sink-secret-token')
  })

  it('hmac sinks sign the exact body into X-UB-Signature', async () => {
    const h = makeHarness({ rows: [makeRow()], sink: makeSink({ authKind: 'hmac' }) })
    await h.relay.tick()
    const [, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    const signature = headers[INGEST_APPEND_SIGNATURE_HEADER]
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(headers.authorization).toBeUndefined()
    expect(
      verifyIngestAppendSignature(init.body as string, 'sink-secret-token', signature),
    ).toBe(true)
    expect(signature).toBe(signIngestAppendBody(init.body as string, 'sink-secret-token'))
  })

  it('a missing secret is a retryable failure, not a delivery without auth', async () => {
    const h = makeHarness({ rows: [makeRow()], secret: null })
    await h.relay.tick()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', expect.stringContaining('secret missing'))
  })

  it('buildAppendRequest maps the outbox row onto the wire shape', () => {
    const req = buildAppendRequest(makeRow())
    expect(req.contract).toBe(INGEST_APPEND_CONTRACT_V1)
    expect(req.instance_id).toBe('4a1e6bd8-0000-4000-8000-000000000001')
    expect(req.owner_user_id).toBe('4a1e6bd8-0000-4000-8000-000000000003')
    expect(req.source).toBe('wechat')
  })
})

describe('[COMP:api/ingest-external-relay] drain resilience', () => {
  it('a disabled sink that raced the claim re-queues without a POST', async () => {
    const h = makeHarness({ rows: [makeRow()], sink: makeSink({ enabled: false }) })
    await h.relay.tick()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', 'sink disabled')
  })

  it('one failing row does not block later rows in the same tick', async () => {
    const rows = [makeRow(), makeRow({ id: 'ob-2', batchId: 'batch-2' })]
    let call = 0
    const h = makeHarness({
      rows,
      response: () => {
        call += 1
        return call === 1
          ? new Response('boom', { status: 500 })
          : new Response(JSON.stringify(ackBody()), { status: 200 })
      },
    })
    await h.relay.tick()
    expect(h.outbox.fail).toHaveBeenCalledWith('ob-1', 'HTTP 500')
    expect(h.outbox.markDelivered).toHaveBeenCalledWith('ob-2')
  })

  it('reclaims expired leases at the top of each tick', async () => {
    const h = makeHarness({ rows: [] })
    await h.relay.tick()
    expect(h.outbox.reclaimExpired).toHaveBeenCalledOnce()
  })
})
