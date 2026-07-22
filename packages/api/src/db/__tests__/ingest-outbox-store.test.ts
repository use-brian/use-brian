/**
 * Unit tests for the ingest external-sink outbox store.
 * Component tag: [COMP:brain/ingest-outbox].
 *
 * Mocks the pg pool/client so the test is DB-free. Verifies the
 * transaction-composable enqueue (the D10 atomic record+outbox commit),
 * the enabled-sink-joined `FOR UPDATE SKIP LOCKED` claim, the
 * unbounded-retry backoff (X7 — retryable failures never go terminal),
 * the terminal dead-letter path, and lease-expiry reclamation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolQueries: { text: string; values?: unknown[] }[] = []
const clientQueries: { text: string; values?: unknown[] }[] = []

let poolResults: Record<string, unknown>[] = []
let claimIdResult: { id: string }[] = []

const fakeClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    clientQueries.push({ text, values })
    if (text.includes('FOR UPDATE OF o SKIP LOCKED')) {
      return { rows: claimIdResult, rowCount: claimIdResult.length }
    }
    if (text.trim().startsWith('UPDATE ingest_outbox')) {
      return { rows: poolResults, rowCount: poolResults.length }
    }
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
}

const fakePool = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    poolQueries.push({ text, values })
    return { rows: poolResults, rowCount: poolResults.length }
  }),
  connect: vi.fn(async () => fakeClient),
}

vi.mock('../client.js', () => ({
  getPool: () => fakePool,
}))

import { createIngestOutboxStore } from '../ingest-outbox-store.js'

const store = createIngestOutboxStore()

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ob-1',
    sinkId: 'sink-1',
    connectorInstanceId: 'ci-1',
    workspaceId: 'ws-1',
    ownerUserId: 'user-1',
    source: 'wechat',
    batchId: 'batch-1',
    messages: [{ provider_message_id: 'm1' }],
    sourceCursor: { offset: 5 },
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: new Date('2026-07-23T00:00:00Z'),
    lastError: null,
    lockedBy: null,
    lockedUntil: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    deliveredAt: null,
    ...over,
  }
}

beforeEach(() => {
  poolQueries.length = 0
  clientQueries.length = 0
  poolResults = []
  claimIdResult = []
  fakePool.query.mockClear()
  fakePool.connect.mockClear()
  fakeClient.query.mockClear()
  fakeClient.release.mockClear()
})

describe('[COMP:brain/ingest-outbox] enqueue', () => {
  it('inserts the row and returns the mapped outbox row', async () => {
    poolResults = [makeRow()]
    const row = await store.enqueue({
      sinkId: 'sink-1',
      connectorInstanceId: 'ci-1',
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      source: 'wechat',
      messages: [{ provider_message_id: 'm1' }],
      sourceCursor: { offset: 5 },
    })
    expect(row.batchId).toBe('batch-1')
    expect(row.messages).toHaveLength(1)
    const sql = poolQueries[0].text
    expect(sql).toContain('INSERT INTO ingest_outbox')
    expect(poolQueries[0].values?.[0]).toBe('sink-1')
    expect(poolQueries[0].values?.[5]).toBe(JSON.stringify([{ provider_message_id: 'm1' }]))
  })

  it('runs on a caller-supplied client to compose into the capture transaction (D10)', async () => {
    const txQuery = vi.fn(async () => ({ rows: [makeRow()], rowCount: 1 }))
    const txClient = { query: txQuery } as unknown as Parameters<typeof store.enqueue>[1]
    await store.enqueue(
      {
        sinkId: 'sink-1',
        connectorInstanceId: 'ci-1',
        workspaceId: 'ws-1',
        source: 'wechat',
        messages: [{ provider_message_id: 'm1' }],
      },
      txClient,
    )
    expect(txQuery).toHaveBeenCalledOnce()
    expect(fakePool.query).not.toHaveBeenCalled()
  })
})

describe('[COMP:brain/ingest-outbox] claimDue', () => {
  it('claims due rows of ENABLED sinks only, inside one transaction', async () => {
    claimIdResult = [{ id: 'ob-1' }]
    poolResults = [makeRow({ status: 'processing', attemptCount: 1, lockedBy: 'relay-1' })]

    const rows = await store.claimDue(10, 'relay-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('processing')

    const texts = clientQueries.map((q) => q.text)
    expect(texts[0]).toBe('BEGIN')
    const claim = texts.find((t) => t.includes('FOR UPDATE OF o SKIP LOCKED'))
    expect(claim).toBeDefined()
    expect(claim).toContain('s.enabled = true')
    expect(texts.some((t) => t.includes("status        = 'processing'"))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('returns [] and commits when nothing is due', async () => {
    claimIdResult = []
    const rows = await store.claimDue(10, 'relay-1')
    expect(rows).toEqual([])
    expect(clientQueries.map((q) => q.text)).toContain('COMMIT')
  })
})

describe('[COMP:brain/ingest-outbox] fail', () => {
  it('re-queues with capped backoff and NEVER goes terminal (X7)', async () => {
    poolResults = [makeRow({ status: 'pending', attemptCount: 99, lastError: 'HTTP 503' })]
    const row = await store.fail('ob-1', 'HTTP 503')
    expect(row!.status).toBe('pending')
    const sql = poolQueries[0].text
    expect(sql).toContain("status          = 'pending'")
    expect(sql).toContain('next_attempt_at')
    expect(sql).toContain('LEAST(POWER(2, attempt_count) * 15000, 3600000)')
    expect(sql).not.toContain("'failed'")
    expect(sql).not.toContain("'dead'")
  })
})

describe('[COMP:brain/ingest-outbox] deadLetter', () => {
  it('marks the row dead with the error, admin-visible', async () => {
    await store.deadLetter('ob-1', 'HTTP 400: schema mismatch')
    const sql = poolQueries[0].text
    expect(sql).toContain("status       = 'dead'")
    expect(poolQueries[0].values).toEqual(['ob-1', 'HTTP 400: schema mismatch'])
  })
})

describe('[COMP:brain/ingest-outbox] reclaimExpired', () => {
  it('returns processing rows with an elapsed lease back to pending', async () => {
    fakePool.query.mockImplementationOnce(async (text: string) => {
      poolQueries.push({ text })
      return { rows: [], rowCount: 2 }
    })
    const reclaimed = await store.reclaimExpired()
    expect(reclaimed).toBe(2)
    const sql = poolQueries[0].text
    expect(sql).toContain("status = 'processing'")
    expect(sql).toContain('locked_until < now()')
  })
})

describe('[COMP:brain/ingest-outbox] listDead / countByStatus', () => {
  it('lists dead rows newest-first with a limit', async () => {
    poolResults = [makeRow({ status: 'dead', lastError: 'HTTP 422: bad shape' })]
    const rows = await store.listDead({ limit: 5 })
    expect(rows[0].status).toBe('dead')
    const sql = poolQueries[0].text
    expect(sql).toContain("WHERE status = 'dead'")
    expect(sql).toContain('ORDER BY created_at DESC')
    expect(poolQueries[0].values).toEqual([5])
  })

  it('groups counts by status and zero-fills missing statuses', async () => {
    fakePool.query.mockImplementationOnce(async () => ({
      rows: [
        { status: 'pending', n: '3' },
        { status: 'dead', n: '1' },
      ],
      rowCount: 2,
    }))
    const counts = await store.countByStatus()
    expect(counts).toEqual({ pending: 3, processing: 0, delivered: 0, dead: 1 })
  })
})
