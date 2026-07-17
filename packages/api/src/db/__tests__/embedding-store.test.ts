/**
 * Unit tests for the embedding store adapter.
 * Component tag: [COMP:brain/embedding-store].
 *
 * Mocks the pg pool/client so the test is DB-free. Verifies the claim
 * SQL (priority ordering + FOR UPDATE SKIP LOCKED), per-primitive table
 * routing, content-hash derivation, commit / fail write-back, the
 * transaction envelope (BEGIN / COMMIT / ROLLBACK), and the
 * unsupported-primitive guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const queries: { text: string; values?: unknown[] }[] = []

let claimRows: { id: string; embed_text: string | null }[] = []

const fakeClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values })
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: claimRows, rowCount: claimRows.length }
    }
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
}

vi.mock('../client.js', () => ({
  getPool: () => ({ connect: async () => fakeClient }),
}))

import { createDbEmbeddingStore } from '../embedding-store.js'
import type { EmbeddingResult } from '@use-brian/core'

const store = createDbEmbeddingStore()

function sql(): string {
  return queries.map((q) => q.text).join('\n---\n')
}

beforeEach(() => {
  queries.length = 0
  claimRows = []
  fakeClient.query.mockClear()
  fakeClient.release.mockClear()
})

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
    const claim = queries.find((q) => q.text.includes('FOR UPDATE SKIP LOCKED'))
    expect(claim).toBeDefined()
    expect(claim!.text).toContain('FROM memories')
    expect(claim!.text).toContain('embedding IS NULL')
    expect(claim!.text).toContain('embedding_failed_at IS NULL')
    expect(claim!.text).toContain("INTERVAL '24 hours'")
    expect(claim!.values).toEqual([50])
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
    const claim = queries.find((q) => q.text.includes('FROM file_segments'))
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

  it('wraps the work in BEGIN/COMMIT (system pool, owner bypasses RLS)', async () => {
    claimRows = []
    await store.withClaimedRows('memories', 10, async () => undefined)
    expect(queries[0].text).toBe('BEGIN')
    // Two-role model: no system_bypass GUC — this runs on the system pool (owner),
    // which bypasses RLS for the cross-workspace drain.
    expect(queries.every((q) => !q.text.includes('system_bypass'))).toBe(true)
    expect(queries[queries.length - 1].text).toBe('COMMIT')
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
    const update = queries.find((q) => q.text.includes('UPDATE memories') && q.text.includes('embedding'))
    expect(update).toBeDefined()
    expect(update!.text).toContain('$1::vector')
    expect(update!.text).toContain('embedding_failed_at      = NULL')
    expect(update!.values?.[0]).toBe('[0.1,0.2,0.3]')
    expect(update!.values?.[1]).toBe('gemini:gemini-embedding-001')
    expect(update!.values?.[3]).toBe('m-1')
  })

  it('fail() stamps embedding_failed_at + reason', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await store.withClaimedRows('memories', 10, async (_rows, apply) => {
      await apply.fail([{ id: 'm-1', reason: 'Gemini API error 429' }])
    })
    const update = queries.find((q) => q.text.includes('embedding_failed_at      = now()'))
    expect(update).toBeDefined()
    expect(update!.values).toEqual(['Gemini API error 429', 'm-1'])
  })

  it('ROLLBACKs and rethrows when the handler throws', async () => {
    claimRows = [{ id: 'm-1', embed_text: 'hello' }]
    await expect(
      store.withClaimedRows('memories', 10, async () => {
        throw new Error('embed batch exploded')
      }),
    ).rejects.toThrow('embed batch exploded')
    expect(sql()).toContain('ROLLBACK')
    expect(sql()).not.toContain('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })
})
