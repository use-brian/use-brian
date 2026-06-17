import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBatchWorker } from '../poll-worker.js'
import type { BatchStore, PendingBatch } from '../types.js'

function makeBatch(overrides: Partial<PendingBatch> = {}): PendingBatch {
  return {
    id: 'batch_1',
    workspaceId: 'w_1',
    ruleId: 'r_1',
    source: 'gmail',
    firesAt: new Date(Date.now() - 60_000),
    events: [{ kind: 'email', id: 'e_1' }],
    createdAt: new Date(Date.now() - 120_000),
    episodeSensitivity: null,
    ...overrides,
  }
}

/**
 * In-memory BatchStore for worker tests. `withClaimedBatches` removes
 * up to `limit` batches from the in-memory queue (mirroring the SELECT
 * FOR UPDATE SKIP LOCKED semantics — claimed rows are not visible to
 * subsequent claims), invokes the handler, and on COMMIT moves any
 * `markProcessed` ids into `processedIds`. If the handler throws, the
 * unprocessed batches are restored to the queue (rollback).
 */
function makeFakeBatchStore(initial: PendingBatch[] = []): BatchStore & {
  queued: PendingBatch[]
  processedIds: string[]
  claimCount: number
} {
  const queued = [...initial]
  const processedIds: string[] = []
  let claimCount = 0

  return {
    queued,
    processedIds,
    get claimCount() { return claimCount },
    async withClaimedBatches(limit, handler) {
      claimCount++
      const claimed = queued.splice(0, limit)
      const txProcessed: string[] = []
      try {
        const result = await handler(claimed, async (id) => {
          txProcessed.push(id)
        })
        for (const id of txProcessed) processedIds.push(id)
        return result
      } catch (err) {
        // ROLLBACK: unprocessed claims go back. Already-marked-processed
        // ids stay marked in tx scratch but are not committed.
        const survivors = claimed.filter((b) => !txProcessed.includes(b.id))
        queued.unshift(...survivors)
        throw err
      }
    },
  }
}

describe('[COMP:brain/ingest-batch-worker] createBatchWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains due batches and marks each processed', async () => {
    const a = makeBatch({ id: 'batch_a' })
    const b = makeBatch({ id: 'batch_b' })
    const store = makeFakeBatchStore([a, b])
    const processBatch = vi.fn(async () => {})
    const worker = createBatchWorker({ store, processBatch, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(processBatch).toHaveBeenCalledTimes(2)
      expect(store.processedIds).toEqual(['batch_a', 'batch_b'])
    })
    worker.stop()
  })

  it('leaves processed_at NULL when processBatch fails (retry next tick)', async () => {
    const a = makeBatch({ id: 'batch_a' })
    const b = makeBatch({ id: 'batch_b' })
    const store = makeFakeBatchStore([a, b])
    const processBatch = vi.fn(async (batch: PendingBatch) => {
      if (batch.id === 'batch_b') throw new Error('downstream blew up')
    })
    const worker = createBatchWorker({ store, processBatch, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(store.processedIds).toEqual(['batch_a'])
    })
    expect(processBatch).toHaveBeenCalledTimes(2)
    expect(store.processedIds).not.toContain('batch_b')
    worker.stop()
  })

  it('is a no-op when the queue is empty', async () => {
    const store = makeFakeBatchStore([])
    const processBatch = vi.fn(async () => {})
    const worker = createBatchWorker({ store, processBatch, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => expect(store.claimCount).toBeGreaterThanOrEqual(1))
    expect(processBatch).not.toHaveBeenCalled()
    worker.stop()
  })

  it('skips overlapping ticks (re-entry guard)', async () => {
    const a = makeBatch({ id: 'batch_a' })
    const store = makeFakeBatchStore([a])

    let release!: () => void
    const blocker = new Promise<void>((resolve) => { release = resolve })
    const processBatch = vi.fn(async () => { await blocker })

    const worker = createBatchWorker({ store, processBatch, intervalMs: 1_000 })
    worker.start()
    // First tick has fired (immediate) and is awaiting `blocker`.
    await vi.waitFor(() => expect(processBatch).toHaveBeenCalledTimes(1))

    // Advance through several intervals while the first tick is still in-
    // flight. The `running` guard should make every additional tick a no-op.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.claimCount).toBe(1)

    release()
    worker.stop()
  })

  it('is not running after stop()', () => {
    const worker = createBatchWorker({
      store: makeFakeBatchStore(),
      processBatch: async () => {},
    })
    expect(worker.isRunning).toBe(false)
    worker.start()
    expect(worker.isRunning).toBe(true)
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })
})
