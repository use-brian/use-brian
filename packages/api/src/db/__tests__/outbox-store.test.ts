/**
 * Unit tests for the extraction-outbox store.
 * Component tag: [COMP:brain/outbox-store].
 *
 * Mocks the pg pool/client so the test is DB-free. Verifies the
 * idempotent enqueue, transaction-composition via a caller-supplied
 * client, the `FOR UPDATE SKIP LOCKED` claim, the retry-vs-permanent
 * failure branch, and lease-expiry reclamation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolQueries: { text: string; values?: unknown[] }[] = []
const clientQueries: { text: string; values?: unknown[] }[] = []

let poolResults: Record<string, unknown>[] = []
let claimRowResult: { id: string }[] = []

const fakeClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    clientQueries.push({ text, values })
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: claimRowResult, rowCount: claimRowResult.length }
    }
    if (text.trim().startsWith('UPDATE extraction_outbox')) {
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

import { createOutboxStore } from '../outbox-store.js'

const store = createOutboxStore()

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    episodeId: 'ep-1',
    derivationKind: 'extract',
    contentHash: 'abc123',
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: new Date('2026-05-15T00:00:00Z'),
    lastError: null,
    lockedBy: null,
    lockedUntil: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    completedAt: null,
    ...over,
  }
}

beforeEach(() => {
  poolQueries.length = 0
  clientQueries.length = 0
  poolResults = []
  claimRowResult = []
  fakePool.query.mockClear()
  fakePool.connect.mockClear()
  fakeClient.query.mockClear()
  fakeClient.release.mockClear()
})

describe('[COMP:brain/outbox-store] enqueue', () => {
  it('inserts with ON CONFLICT DO NOTHING and returns the job', async () => {
    poolResults = [makeRow()]
    const job = await store.enqueue({
      workspaceId: 'ws-1',
      episodeId: 'ep-1',
      derivationKind: 'extract',
      contentHash: 'abc123',
    })
    expect(job).not.toBeNull()
    expect(job!.derivationKind).toBe('extract')
    const sql = poolQueries[0].text
    expect(sql).toContain('INSERT INTO extraction_outbox')
    expect(sql).toContain(
      'ON CONFLICT (episode_id, derivation_kind, content_hash) DO NOTHING',
    )
    expect(poolQueries[0].values).toEqual(['ws-1', 'ep-1', 'extract', 'abc123'])
  })

  it('returns null when the idempotency key already exists (no RETURNING row)', async () => {
    poolResults = []
    const job = await store.enqueue({
      workspaceId: 'ws-1',
      episodeId: 'ep-1',
      derivationKind: 'extract',
      contentHash: 'dup',
    })
    expect(job).toBeNull()
  })

  it('runs on a caller-supplied client to compose into an outer transaction', async () => {
    const txQuery = vi.fn(async () => ({ rows: [makeRow()], rowCount: 1 }))
    const txClient = { query: txQuery } as unknown as Parameters<typeof store.enqueue>[1]
    await store.enqueue(
      {
        workspaceId: 'ws-1',
        episodeId: 'ep-1',
        derivationKind: 'extract',
        contentHash: 'abc123',
      },
      txClient,
    )
    expect(txQuery).toHaveBeenCalledOnce()
    expect(fakePool.query).not.toHaveBeenCalled()
  })
})

describe('[COMP:brain/outbox-store] claimNext', () => {
  it('leases a due job with FOR UPDATE SKIP LOCKED inside a transaction', async () => {
    claimRowResult = [{ id: 'job-1' }]
    poolResults = [makeRow({ status: 'processing', attemptCount: 1, lockedBy: 'worker-a' })]

    const job = await store.claimNext('worker-a')
    expect(job).not.toBeNull()
    expect(job!.status).toBe('processing')

    const texts = clientQueries.map((q) => q.text)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.some((t) => t.includes('FOR UPDATE SKIP LOCKED'))).toBe(true)
    expect(texts.some((t) => t.includes("status       = 'processing'"))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('returns null and commits when the queue is empty', async () => {
    claimRowResult = []
    const job = await store.claimNext('worker-a')
    expect(job).toBeNull()
    expect(clientQueries.map((q) => q.text)).toContain('COMMIT')
  })
})

describe('[COMP:brain/outbox-store] fail', () => {
  it('re-queues with backoff while under the attempt cap', async () => {
    // claimNext already incremented attempt_count → 2 here.
    fakePool.query
      .mockImplementationOnce(async () => ({ rows: [{ attemptCount: 2 }], rowCount: 1 }))
      .mockImplementationOnce(async (text: string, values?: unknown[]) => {
        poolQueries.push({ text, values })
        return { rows: [makeRow({ status: 'pending', attemptCount: 2 })], rowCount: 1 }
      })

    const job = await store.fail('job-1', 'LLM timeout')
    expect(job!.status).toBe('pending')
    const update = poolQueries.find((q) => q.text.includes('next_attempt_at'))
    expect(update).toBeDefined()
    expect(update!.text).toContain("status          = 'pending'")
  })

  it('marks permanently failed at the attempt cap', async () => {
    fakePool.query
      .mockImplementationOnce(async () => ({ rows: [{ attemptCount: 5 }], rowCount: 1 }))
      .mockImplementationOnce(async (text: string, values?: unknown[]) => {
        poolQueries.push({ text, values })
        return { rows: [makeRow({ status: 'failed', attemptCount: 5 })], rowCount: 1 }
      })

    const job = await store.fail('job-1', 'persistent parse error')
    expect(job!.status).toBe('failed')
    const update = poolQueries.find((q) => q.text.includes("status       = 'failed'"))
    expect(update).toBeDefined()
  })

  it('returns null when the job id is unknown', async () => {
    fakePool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
    const job = await store.fail('ghost', 'x')
    expect(job).toBeNull()
  })
})

describe('[COMP:brain/outbox-store] reclaimExpired', () => {
  it('returns processing jobs with an elapsed lease back to pending', async () => {
    fakePool.query.mockImplementationOnce(async (text: string) => {
      poolQueries.push({ text })
      return { rows: [], rowCount: 3 }
    })
    const reclaimed = await store.reclaimExpired()
    expect(reclaimed).toBe(3)
    const sql = poolQueries[0].text
    expect(sql).toContain("status = 'processing'")
    expect(sql).toContain('locked_until < now()')
  })
})

describe('[COMP:brain/outbox-store] countByStatus', () => {
  it('groups counts by status and zero-fills missing statuses', async () => {
    fakePool.query.mockImplementationOnce(async () => ({
      rows: [
        { status: 'pending', n: '4' },
        { status: 'failed', n: '1' },
      ],
      rowCount: 2,
    }))
    const counts = await store.countByStatus('ws-1')
    expect(counts).toEqual({ pending: 4, processing: 0, completed: 0, failed: 1 })
  })
})
