/**
 * Unit tests for `appendBatchEvent`'s size-based early flush.
 * Component tag: [COMP:brain/pending-ingest-batches-store].
 *
 * Injects a fake pool so the flush decision (pull a future `fires_at` back to
 * `now()` once the accumulated window text crosses `EARLY_FLUSH_CHARS`) is
 * exercised without a real database. The accumulated char count is modelled by
 * the fake's `RETURNING length(events::text)` response.
 *
 * See docs/architecture/brain/ingest-pipeline.md → "Batch flush — cron
 * backstop + size trigger".
 */

import { describe, it, expect } from 'vitest'
import {
  appendBatchEvent,
  appendProgrammaticBatchEvent,
  createDbProgrammaticBatchStore,
  EARLY_FLUSH_TOKENS,
  EARLY_FLUSH_CHARS,
} from '../pending-ingest-batches-store.js'

type Call = { text: string; params?: unknown[] }

/**
 * Fake pool covering the three statements `appendBatchEvent` issues. `chars`
 * is the value returned for `length(events::text)`; `existingId` controls
 * whether the find-or-create SELECT hits an existing row (UPDATE) or misses
 * it (INSERT). Every query is recorded so the test can assert whether the
 * `fires_at = now()` early-flush UPDATE was issued.
 */
function makeFakePool(opts: { chars: number; existingId?: string }) {
  const calls: Call[] = []
  const pool = {
    async query<R extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: R[] }> {
      calls.push({ text, params })
      let rows: unknown[] = []
      if (text.includes('SELECT id FROM pending_ingest_batches')) {
        rows = opts.existingId ? [{ id: opts.existingId }] : []
      } else if (
        text.includes('UPDATE pending_ingest_batches SET')
        && text.includes('events = events')
      ) {
        rows = [{ id: opts.existingId, chars: opts.chars }]
      } else if (text.includes('INSERT INTO pending_ingest_batches')) {
        rows = [{ id: 'batch-new', chars: opts.chars }]
      }
      // The early-flush UPDATE (and anything else) returns no rows.
      return { rows: rows as R[] }
    },
  }
  return { pool, calls }
}

const baseInput = {
  workspaceId: 'ws-1',
  ruleId: 'rule-1',
  source: 'whatsapp',
  // Future cron firing — the early flush should be able to pull it earlier.
  firesAt: new Date('2099-01-01T09:00:00Z'),
  event: { normalized: { text: 'hi' } },
}

function firesAtFlush(calls: Call[]): Call | undefined {
  return calls.find((c) => c.text.includes('SET fires_at = now()'))
}

describe('[COMP:brain/pending-ingest-batches-store] appendBatchEvent early flush', () => {
  it('pulls fires_at to now() once accumulated text crosses 32k tokens', async () => {
    const { pool, calls } = makeFakePool({ chars: EARLY_FLUSH_CHARS, existingId: 'batch-1' })
    await appendBatchEvent(baseInput, pool)

    const flush = firesAtFlush(calls)
    expect(flush).toBeDefined()
    // Scoped to the appended batch and only moves a still-future fires_at.
    expect(flush!.text).toContain('fires_at > now()')
    expect(flush!.params).toEqual(['batch-1'])
  })

  it('leaves fires_at at the cron time when below the threshold', async () => {
    const { pool, calls } = makeFakePool({
      chars: EARLY_FLUSH_CHARS - 1,
      existingId: 'batch-1',
    })
    await appendBatchEvent(baseInput, pool)
    expect(firesAtFlush(calls)).toBeUndefined()
  })

  it('flushes a freshly-created (INSERT) batch that already crosses the bound', async () => {
    const { pool, calls } = makeFakePool({ chars: EARLY_FLUSH_CHARS + 5_000 })
    await appendBatchEvent(baseInput, pool)
    const flush = firesAtFlush(calls)
    expect(flush).toBeDefined()
    expect(flush!.params).toEqual(['batch-new'])
  })

  it('keeps the token bound and char proxy coupled at ~4 chars/token', () => {
    expect(EARLY_FLUSH_TOKENS).toBe(32_000)
    expect(EARLY_FLUSH_CHARS).toBe(EARLY_FLUSH_TOKENS * 4)
  })

  it('raises an existing batch to the union of every appended Team and Project scope', async () => {
    const { pool, calls } = makeFakePool({ chars: 10, existingId: 'batch-1' })
    const compartments = ['team:11111111-1111-4111-8111-111111111111']
    const projectIds = ['22222222-2222-4222-8222-222222222222']

    await appendBatchEvent({ ...baseInput, compartments, projectIds }, pool)

    const update = calls.find((call) => call.text.includes('events = events'))
    expect(update?.text).toContain('SELECT DISTINCT unnest(compartments')
    expect(update?.text).toContain('SELECT DISTINCT unnest(project_ids')
    expect(update?.params).toEqual([
      'batch-1',
      JSON.stringify([baseInput.event]),
      compartments,
      projectIds,
    ])
  })
})

describe('[COMP:api/programmatic-capture] atomic pooled append', () => {
  it('commits the idempotency receipt and concurrent-safe batch upsert together', async () => {
    const calls: Call[] = []
    const client = {
      async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
        calls.push({ text, params })
        if (text.includes('INSERT INTO programmatic_capture_receipts')) {
          return { rows: [{ id: 'receipt-1' }] as unknown as R[] }
        }
        if (text.includes('INSERT INTO pending_ingest_batches')) {
          return {
            rows: [{
              id: 'batch-1',
              firesAt: new Date('2026-09-03T11:00:00.000Z'),
              chars: 100,
            }] as unknown as R[],
          }
        }
        return { rows: [] as R[] }
      },
      release() {},
    }
    const pool = {
      async connect() { return client },
      async query<R extends Record<string, unknown>>() { return { rows: [] as R[] } },
    }

    const result = await appendProgrammaticBatchEvent({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      assistantId: '22222222-2222-4222-8222-222222222222',
      ruleId: '33333333-3333-4333-8333-333333333333',
      partitionKey: 'session:draft-42',
      firesAt: new Date('2026-09-03T11:00:00.000Z'),
      episodeSensitivity: 'internal',
      compartments: [],
      projectIds: [],
      event: {
        eventId: 'message-7',
        content: 'Draft observation',
        occurredAt: '2026-09-03T10:00:00.000Z',
        receivedAt: '2026-09-03T10:00:01.000Z',
        role: 'user',
        metadata: {},
        principalKind: 'api_key',
        principalId: '44444444-4444-4444-8444-444444444444',
      },
    }, pool)

    expect(result).toMatchObject({ duplicate: false, status: 'queued', batchId: 'batch-1' })
    const upsert = calls.find((call) => call.text.includes('INSERT INTO pending_ingest_batches'))
    expect(upsert?.text).toContain('ON CONFLICT (rule_id, assistant_id, partition_key, fires_at)')
    expect(upsert?.text).toContain("source = 'programmatic'")
    expect(calls.map((call) => call.text.trim())).toEqual(expect.arrayContaining([
      'BEGIN',
      'COMMIT',
    ]))
    expect(calls.findIndex((call) => call.text.trim() === 'COMMIT')).toBeGreaterThan(
      calls.findIndex((call) => call.text.includes("SET status = 'queued'")),
    )
  })

  it('completes every queued receipt in the same transaction that marks a batch processed', async () => {
    const calls: Call[] = []
    const client = {
      async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
        calls.push({ text, params })
        if (text.includes("source = 'programmatic'")) {
          return { rows: [{
            id: 'batch-1', workspace_id: 'ws-1', rule_id: 'rule-1',
            assistant_id: 'assistant-1', partition_key: 'session:draft-42',
            source: 'programmatic', fires_at: new Date(), events: [], created_at: new Date(),
            episode_sensitivity: 'internal', compartments: [], project_ids: [],
          }] as unknown as R[] }
        }
        return { rows: [] as R[] }
      },
      release() {},
    }
    const store = createDbProgrammaticBatchStore({
      async connect() { return client },
      async query<R extends Record<string, unknown>>() { return { rows: [] as R[] } },
    })

    await store.withClaimedBatches(1, async (batches, markProcessed) => {
      expect(batches).toHaveLength(1)
      await markProcessed(batches[0]!.id)
    })

    const processed = calls.findIndex((call) => call.text.includes('SET processed_at = now()'))
    const receipts = calls.findIndex((call) => call.text.includes("SET status = 'completed'"))
    const committed = calls.findIndex((call) => call.text.trim() === 'COMMIT')
    expect(processed).toBeGreaterThan(-1)
    expect(receipts).toBeGreaterThan(processed)
    expect(committed).toBeGreaterThan(receipts)
  })
})
