/**
 * Unit tests for the embedding store adapter.
 * Component tag: [COMP:brain/embedding-store].
 *
 * Mocks the pg pool/client so the test is DB-free. Verifies the claim
 * SQL (priority ordering + FOR UPDATE SKIP LOCKED), per-primitive table
 * routing, content-hash derivation, commit / fail write-back, the
 * claim → commit → embed → write connection shape (B2), and the
 * unsupported-primitive guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const queries: { text: string; values?: unknown[] }[] = []

/** Rows served to the priority half of the claim (`created_at > cutoff`). */
let claimRows: { id: string; embed_text: string | null }[] = []
/** Rows served to the backlog half (`created_at <= cutoff`), when it runs. */
let olderRows: { id: string; embed_text: string | null }[] = []
/** Rows served by the delayed failed-row retry lane. */
let retryRows: { id: string; embed_text: string | null }[] = []

/**
 * Checked-out-connection ledger. B2's whole point is that no pooled
 * connection is held while the embedder runs, so the test needs to see
 * checkouts, not just queries.
 */
let checkedOut = 0
let maxCheckedOut = 0

/** What the budget probe reports: approximate rows already embedded. */
let embeddedCount = 0
/** Set to true to make the budget probe report an un-analyzed table. */
let reltuplesUnavailable = false

const fakeClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values })
    if (text.includes('reltuples')) {
      return {
        rows: [
          reltuplesUnavailable
            ? { approx_total: null, unattempted: '0', failed_unembedded: '0' }
            : { approx_total: String(embeddedCount + 500), unattempted: '500', failed_unembedded: '0' },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('WITH retry AS')) {
      return { rows: retryRows, rowCount: retryRows.length }
    }
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      // The claim is split across two bounded range scans (see
      // embedding-store.ts); serve each half its own fixture so a test can
      // tell them apart.
      const rows = /\w+ <= now\(\) - INTERVAL '24 hours'/.test(text) ? olderRows : claimRows
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(() => {
    checkedOut -= 1
  }),
}

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: async () => {
      checkedOut += 1
      maxCheckedOut = Math.max(maxCheckedOut, checkedOut)
      return fakeClient
    },
  }),
}))

import { createDbEmbeddingStore, __resetEmbedBudgetCache } from '../embedding-store.js'
import {
  DEFAULT_EMBED_BUDGET_SEGMENTS,
  DEFAULT_EMBED_RECENCY_WINDOW_MONTHS,
  type EmbeddingResult,
} from '@use-brian/core'

const store = createDbEmbeddingStore()

function sql(): string {
  return queries.map((q) => q.text).join('\n---\n')
}

beforeEach(() => {
  queries.length = 0
  claimRows = []
  olderRows = []
  retryRows = []
  checkedOut = 0
  maxCheckedOut = 0
  embeddedCount = 0
  reltuplesUnavailable = false
  __resetEmbedBudgetCache()
  fakeClient.query.mockClear()
  fakeClient.release.mockClear()
})

function claims(): { text: string; values?: unknown[] }[] {
  return queries.filter((q) => q.text.includes('FOR UPDATE SKIP LOCKED') && !q.text.includes('WITH retry AS'))
}

function retryClaims(): { text: string; values?: unknown[] }[] {
  return queries.filter((q) => q.text.includes('WITH retry AS'))
}

/** The content hash the store derives for a given embed text. */
function rowsHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('[COMP:brain/embedding-store] withClaimedRows', () => {
  it('throws for a primitive without a vector column (episodes)', async () => {
    await expect(
      store.withClaimedRows('episodes', 10, async () => undefined),
    ).rejects.toThrow(/episodes.*no embedding column/)
  })

  it('claims NULL-embedding rows with priority ordering + skip-locked lease', async () => {
    claimRows = []
    await store.withClaimedRows('memories', 50, async (rows) => {
      expect(rows).toEqual([])
    })
    // Priority class first (new writes < 24h), then the backlog — both against
    // the same predicate, oldest-first, under a skip-locked lease.
    const [priority, backlog] = claims()
    expect(priority).toBeDefined()
    expect(backlog).toBeDefined()
    for (const claim of [priority, backlog]) {
      expect(claim.text).toContain('FROM memories')
      expect(claim.text).toContain('embedding IS NULL')
      expect(claim.text).toContain('embedding_failed_at IS NULL')
      expect(claim.text).toContain("INTERVAL '24 hours'")
      expect(claim.text).toContain('ORDER BY created_at ASC')
    }
    expect(priority.text).toContain('created_at > now()')
    expect(backlog.text).toContain('created_at <= now()')
    expect(priority.values).toEqual([50])
  })

  // [COMP:brain/embedding-drain-index] — this is the query shape the partial
  // drain index exists to serve; its component-map row points here.
  it('claims via indexable range scans — never a CASE-expression sort', async () => {
    // Regression guard for the 2026-07-28 connection-exhaustion outage
    // (embeddings.md §"Worker priority queue"). A `CASE WHEN created_at >
    // now() ...` in ORDER BY cannot be indexed (now() is not IMMUTABLE), so it
    // forces a full scan + sort of every unembedded row on each tick; at 415k
    // rows that ran 5-20 min per claim, and because the claim holds its
    // transaction's connection the whole time, claims stacked until all 25
    // Cloud SQL slots were gone. The bound must stay in WHERE, not ORDER BY.
    await store.withClaimedRows('email_segment', 100, async () => undefined)
    expect(claims()).not.toHaveLength(0)
    for (const claim of claims()) {
      // Assert on the ORDER BY tail specifically: a textExpr may legitimately
      // contain a CASE (file_segment's heading breadcrumb does), so a blanket
      // "no CASE anywhere" check would be primitive-dependent and misleading.
      const orderBy = claim.text.slice(claim.text.indexOf('ORDER BY'))
      expect(orderBy).not.toContain('CASE')
      // The sort key is the primitive's recency column (B5), so assert the
      // shape rather than a specific column: a bare column, never an
      // expression — anything over now() is not IMMUTABLE and cannot be
      // indexed.
      expect(orderBy).toMatch(/^ORDER BY \w+ ASC/)
      expect(orderBy).not.toContain('now()')
      expect(claim.text).toMatch(/AND \w+ [<>]=? now\(\)/)
    }
  })

  it('skips the backlog scan when the priority class fills the batch', async () => {
    claimRows = [
      { id: 'm-1', embed_text: 'one' },
      { id: 'm-2', embed_text: 'two' },
    ]
    await store.withClaimedRows('memories', 2, async (rows) => {
      expect(rows.map((r) => r.id)).toEqual(['m-1', 'm-2'])
    })
    expect(claims()).toHaveLength(1)
  })

  it('tops the batch up from the backlog, requesting only the remainder', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'recent' }]
    olderRows = [{ id: 'm-9', embed_text: 'old' }]
    await store.withClaimedRows('memories', 3, async (rows) => {
      // Priority rows lead, backlog rows follow — the ordering the single
      // CASE-sorted query used to produce.
      expect(rows.map((r) => r.id)).toEqual(['m-1', 'm-9'])
    })
    const [priority, backlog] = claims()
    expect(priority.values).toEqual([3])
    expect(backlog.values).toEqual([2])
  })

  it('uses only unused capacity for a bounded delayed failure retry lane', async () => {
    claimRows = [{ id: 'new-1', embed_text: 'new' }]
    olderRows = []
    retryRows = [{ id: 'retry-1', embed_text: 'recovered' }]
    await store.withClaimedRows('email_segment', 50, async (rows) => {
      expect(rows.map((row) => row.id)).toEqual(['new-1', 'retry-1'])
    })

    expect(retryClaims()).toHaveLength(1)
    expect(retryClaims()[0].values).toEqual([10])
    expect(retryClaims()[0].text).toContain("embedding_failed_at <= now() - INTERVAL '1 hour'")
    expect(retryClaims()[0].text).toContain('ORDER BY valid_from DESC, embedding_failed_at ASC')
    expect(retryClaims()[0].text).toContain('SET embedding_failed_at = NULL')
  })

  it('does not touch failed rows when normal work fills the batch', async () => {
    claimRows = [
      { id: 'new-1', embed_text: 'one' },
      { id: 'new-2', embed_text: 'two' },
    ]
    retryRows = [{ id: 'retry-1', embed_text: 'old failure' }]
    await store.withClaimedRows('memories', 2, async (rows) => {
      expect(rows.map((row) => row.id)).toEqual(['new-1', 'new-2'])
    })
    expect(retryClaims()).toHaveLength(0)
  })

  // ── B5: recency expression + embed budget ─────────────────────
  //
  // corpus-substrate-hardening §5. Two defects, one mechanism: the tier keyed
  // on the row-insert clock (so a backfill put the whole archive in the
  // new-writes bucket), and nothing bounded how much index a bulk backfill
  // could create.

  it('keys the email corpus on its SENT time, not on the sync clock', async () => {
    // D6. `created_at` on email_archive_segments is when the sync wrote the
    // row: the IMAP backfill stamped ~528k historical messages with `now()`,
    // so a created_at tier matched the entire archive as "new writes".
    await store.withClaimedRows('email_segment', 10, async () => undefined)
    for (const claim of claims()) {
      expect(claim.text).toContain('ORDER BY valid_from ASC')
      expect(claim.text).toContain("valid_from > now() - INTERVAL '12 months'")
      expect(claim.text).not.toContain('created_at')
    }
  })

  it('refuses chat history, which is embedded in the message store', async () => {
    // The chat archive lives in its own database and embeds its own corpus,
    // because it also executes search — keeping both sides of every cosine
    // comparison behind one embedder makes vector compatibility structural.
    // Claiming here would query a table this database no longer has.
    await expect(
      store.withClaimedRows('chat_segment' as never, 10, async () => undefined),
    ).rejects.toThrow()
    expect(claims()).toHaveLength(0)
  })

  it('keys a primitive whose row IS the event on created_at', async () => {
    await store.withClaimedRows('memories', 10, async () => undefined)
    for (const claim of claims()) {
      expect(claim.text).toContain('ORDER BY created_at ASC')
      expect(claim.text).toContain(
        `created_at > now() - INTERVAL '${DEFAULT_EMBED_RECENCY_WINDOW_MONTHS} months'`,
      )
    }
  })

  it('stops claiming once the corpus reaches its embed budget', async () => {
    // D7: full drain is NOT a goal. A fully embedded email corpus is a ~1.7 GB
    // HNSW index on an instance with 0.6 GB of RAM, so rows past the ceiling
    // stay queued and retrieval discloses the partial coverage instead.
    embeddedCount = DEFAULT_EMBED_BUDGET_SEGMENTS
    claimRows = [{ id: 'm-1', embed_text: 'would have been embedded' }]
    let handed: unknown[] | undefined
    await store.withClaimedRows('email_segment', 100, async (rows) => {
      handed = rows
    })
    expect(handed).toEqual([])
    expect(claims()).toHaveLength(0)
  })

  it('drains a synthetic backfill only up to the budget, then stops', async () => {
    // The backfill shape: every claim returns a full batch, forever. Without a
    // ceiling this never terminates; with one it stops within a batch of it.
    embeddedCount = DEFAULT_EMBED_BUDGET_SEGMENTS - 250
    claimRows = Array.from({ length: 100 }, (_, i) => ({
      id: `e-${i}`,
      embed_text: `segment ${i}`,
    }))
    let batches = 0
    for (let tick = 0; tick < 20; tick++) {
      await store.withClaimedRows('email_segment', 100, async (rows, apply) => {
        if (rows.length === 0) return
        batches += 1
        await apply.commit(
          rows.map((r) => ({
            id: r.id,
            embedding: [0.1],
            embeddingModelId: 'gemini:gemini-embedding-001',
            contentHash: r.contentHash,
          })),
        )
      })
    }
    // 250 rows of headroom at 100/batch — three batches, then the drain stops
    // even though the queue still has rows and ticks keep firing.
    expect(batches).toBe(3)
  })

  it('proceeds unbudgeted when the table has never been analyzed', async () => {
    // reltuples is -1/NULL until autovacuum ANALYZEs. A ceiling that guessed
    // would be worse than one that abstains — the recency window still bounds
    // the work.
    reltuplesUnavailable = true
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    let handed: unknown[] | undefined
    await store.withClaimedRows('email_segment', 10, async (rows) => {
      handed = rows
    })
    expect(handed).toHaveLength(1)
  })

  it('measures the budget without scanning for embedding IS NOT NULL', async () => {
    // The direct count has no index to ride and would seq-scan the 5.6 GB
    // table this budget exists to protect.
    await store.withClaimedRows('email_segment', 10, async () => undefined)
    const probe = queries.find((q) => q.text.includes('reltuples'))
    expect(probe).toBeDefined()
    expect(probe!.text).not.toContain('embedding IS NOT NULL')
    expect(probe!.text).toContain('embedding IS NULL AND embedding_failed_at IS NULL')
  })

  it('does not re-measure the budget on every tick', async () => {
    claimRows = []
    await store.withClaimedRows('memories', 10, async () => undefined)
    await store.withClaimedRows('memories', 10, async () => undefined)
    await store.withClaimedRows('memories', 10, async () => undefined)
    expect(queries.filter((q) => q.text.includes('reltuples'))).toHaveLength(1)
  })

  it('routes each primitive to its own table', async () => {
    for (const [primitive, table] of [
      ['entities', 'FROM entities'],
      ['kb_chunks', 'FROM kb_chunks'],
      ['workspace_files', 'FROM workspace_files'],
      ['transcript_segment', 'FROM transcript_segments'],
      ['file_segment', 'FROM file_segments'],
    ] as const) {
      queries.length = 0
      await store.withClaimedRows(primitive, 10, async () => undefined)
      expect(sql()).toContain(table)
    }
  })

  it('file_segment embed text prefixes the heading breadcrumb when present', async () => {
    queries.length = 0
    await store.withClaimedRows('file_segment', 10, async () => undefined)
    const claim = claims().find((q) => q.text.includes('FROM file_segments'))
    expect(claim).toBeDefined()
    // Breadcrumb joined ' > ' + newline, empty when heading_path = '{}'.
    expect(claim!.text).toContain("array_to_string(heading_path, ' > ')")
    expect(claim!.text).toContain("heading_path <> '{}'")
    expect(claim!.text).toContain('|| content')
  })

  it('derives a sha256 content hash from the assembled embed text', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'Ada prefers Tuesday standups' }]
    let seen: { id: string; text: string; contentHash: string } | undefined
    await store.withClaimedRows('memories', 10, async (rows) => {
      seen = rows[0]
    })
    expect(seen).toBeDefined()
    expect(seen!.id).toBe('m-1')
    expect(seen!.text).toBe('Ada prefers Tuesday standups')
    expect(seen!.contentHash).toBe(
      createHash('sha256').update('Ada prefers Tuesday standups', 'utf8').digest('hex'),
    )
  })

  it('wraps the claim in its own BEGIN/COMMIT (system pool, owner bypasses RLS)', async () => {
    claimRows = []
    await store.withClaimedRows('memories', 10, async () => undefined)
    expect(queries[0].text).toBe('BEGIN')
    // Two-role model: no system_bypass GUC — this runs on the system pool (owner),
    // which bypasses RLS for the cross-workspace drain.
    expect(queries.every((q) => !q.text.includes('system_bypass'))).toBe(true)
    expect(queries[queries.length - 1].text).toBe('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  // ── B2: claim → commit → embed → write ────────────────────────
  //
  // corpus-substrate-hardening §4. The embedder call must not run inside the
  // claim's transaction: doing so denominates provider latency in database
  // slots, which is how both the 2026-07-28 and 2026-07-29 outages pinned
  // every Cloud SQL connection. Also graded by `pnpm check`
  // (`invariants/embed-claim-shape`), which reads the source; this asserts the
  // runtime behavior.

  it('holds NO pooled connection while the handler runs', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    let heldDuringHandler = -1
    let committedBeforeHandler = false
    await store.withClaimedRows('memories', 10, async () => {
      heldDuringHandler = checkedOut
      committedBeforeHandler = queries.some((q) => q.text === 'COMMIT')
    })
    expect(heldDuringHandler).toBe(0)
    // ...and the claim was committed before the handler ran, so the rows are
    // not sitting under an open row lock either.
    expect(committedBeforeHandler).toBe(true)
  })

  it('checks out at most one connection at a time across the whole drain', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await store.withClaimedRows('memories', 10, async (rows, apply) => {
      await apply.commit([
        {
          id: 'm-1',
          embedding: [0.5],
          embeddingModelId: 'gemini:gemini-embedding-001',
          contentHash: rows[0].contentHash,
        },
      ])
    })
    expect(maxCheckedOut).toBe(1)
    expect(checkedOut).toBe(0)
    // Claim transaction + write-back transaction — two separate short ones.
    expect(queries.filter((q) => q.text === 'BEGIN')).toHaveLength(2)
    expect(queries.filter((q) => q.text === 'COMMIT')).toHaveLength(2)
  })

  it('opens no write-back transaction when there is nothing to write', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await store.withClaimedRows('memories', 10, async (_rows, apply) => {
      await apply.commit([])
      await apply.fail([])
    })
    expect(queries.filter((q) => q.text === 'BEGIN')).toHaveLength(1)
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('commit() writes the vector, model id, content hash, and clears failure columns', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await store.withClaimedRows('memories', 10, async (rows, apply) => {
      const results: EmbeddingResult[] = [
        {
          id: 'm-1',
          embedding: [0.1, 0.2, 0.3],
          embeddingModelId: 'gemini:gemini-embedding-001',
          contentHash: rows[0].contentHash,
        },
      ]
      await apply.commit(results)
    })
    const update = queries.find((q) => q.text.includes('UPDATE memories') && q.text.includes('v.embedding::vector'))
    expect(update).toBeDefined()
    expect(update!.text).toContain('v.embedding::vector')
    expect(update!.text).toContain('embedding_failed_at      = NULL')
    expect(update!.values).toEqual([
      'm-1',
      '[0.1,0.2,0.3]',
      'gemini:gemini-embedding-001',
      rowsHash('hello'),
    ])
  })

  // ── B4: batched commit ────────────────────────────────────────
  //
  // corpus-substrate-hardening §5. Up to 100 round trips become one, which
  // shortens exactly the transactions that pin a connection.

  it('writes a whole batch in ONE UPDATE ... FROM (VALUES ...)', async () => {
    claimRows = [
      { id: 'm-1', embed_text: 'one' },
      { id: 'm-2', embed_text: 'two' },
      { id: 'm-3', embed_text: 'three' },
    ]
    await store.withClaimedRows('memories', 10, async (rows, apply) => {
      await apply.commit(
        rows.map((r, i) => ({
          id: r.id,
          embedding: [i],
          embeddingModelId: 'gemini:gemini-embedding-001',
          contentHash: r.contentHash,
        })),
      )
    })
    const updates = queries.filter((q) => q.text.startsWith('UPDATE memories'))
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain(
      'AS v(id, embedding, model_id, content_hash)',
    )
    expect(updates[0].text).toContain('($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)')
    expect(updates[0].values).toHaveLength(12)
    // The join must cast the BOUND side, not the column: `t.id::text = v.id`
    // would seq-scan a 5.6 GB table instead of riding the primary key.
    expect(updates[0].text).toContain('WHERE t.id = v.id::uuid')
    expect(updates[0].text).not.toContain('t.id::')
  })

  it('fail() stamps embedding_failed_at + reason for the whole batch in one statement', async () => {
    claimRows = [
      { id: 'm-1', embed_text: 'hello' },
      { id: 'm-2', embed_text: 'there' },
    ]
    await store.withClaimedRows('memories', 10, async (_rows, apply) => {
      await apply.fail([
        { id: 'm-1', reason: 'Gemini API error 429' },
        { id: 'm-2', reason: 'Gemini API error 429' },
      ])
    })
    const updates = queries.filter((q) => q.text.includes('embedding_failed_at      = now()'))
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toContain('AS v(id, reason)')
    expect(updates[0].values).toEqual([
      'm-1',
      'Gemini API error 429',
      'm-2',
      'Gemini API error 429',
    ])
  })

  it('truncates a failure reason to 1000 chars', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await store.withClaimedRows('memories', 10, async (_rows, apply) => {
      await apply.fail([{ id: 'm-1', reason: 'x'.repeat(5000) }])
    })
    const update = queries.find((q) => q.text.includes('embedding_failed_at      = now()'))
    expect((update!.values?.[1] as string).length).toBe(1000)
  })

  it('rethrows a handler failure with the claim already committed and the connection back', async () => {
    // The claim commits before the embedder runs (B2), so a thrown batch no
    // longer rolls anything back — the rows simply stay `embedding IS NULL`
    // and return to the queue on the next tick. That is correct, not a leak
    // (D4: `maxScale = 1` + the worker tick guard are the concurrency
    // argument, not a held lease).
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await expect(
      store.withClaimedRows('memories', 10, async () => {
        throw new Error('embed batch exploded')
      }),
    ).rejects.toThrow('embed batch exploded')
    expect(sql()).toContain('COMMIT')
    expect(sql()).not.toContain('ROLLBACK')
    expect(checkedOut).toBe(0)
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('ROLLBACKs and releases when the CLAIM itself throws', async () => {
    fakeClient.query.mockImplementationOnce(async (text: string) => {
      queries.push({ text })
      return { rows: [], rowCount: 0 }
    })
    fakeClient.query.mockImplementationOnce(async () => {
      throw new Error('claim exploded')
    })
    await expect(
      store.withClaimedRows('memories', 10, async () => undefined),
    ).rejects.toThrow('claim exploded')
    expect(sql()).toContain('ROLLBACK')
    expect(checkedOut).toBe(0)
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('ROLLBACKs the write-back transaction when a commit UPDATE throws', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await expect(
      store.withClaimedRows('memories', 10, async (rows, apply) => {
        fakeClient.query.mockImplementationOnce(async (text: string) => {
          queries.push({ text })
          return { rows: [], rowCount: 0 }
        })
        fakeClient.query.mockImplementationOnce(async () => {
          throw new Error('write-back exploded')
        })
        await apply.commit([
          {
            id: 'm-1',
            embedding: [0.1],
            embeddingModelId: 'gemini:gemini-embedding-001',
            contentHash: rows[0].contentHash,
          },
        ])
      }),
    ).rejects.toThrow('write-back exploded')
    expect(sql()).toContain('ROLLBACK')
    expect(checkedOut).toBe(0)
  })
})
