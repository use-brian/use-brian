import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  createRecording,
  getRecording,
  getRecordingSystem,
  listRecordings,
  updateRecording,
  LIST_RECORDINGS_LIMIT_MAX,
} from '../recordings-store.js'
import { query, queryWithRLS } from '../client.js'

/**
 * The recordings row store (migration 335). SQL is asserted at the shape level:
 * which pool the call takes (RLS vs owner), and that the WHERE/SET clauses carry
 * the filters/patches — the DDL itself is exercised against a live PG by the
 * migration, not here.
 *
 * Component tag: [COMP:recordings/recordings-store].
 */

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

const ROW = {
  id: 'rec-1',
  workspaceId: 'ws-1',
  title: null,
  kind: 'memo',
  status: 'awaiting_upload',
  fileName: null,
  mime: 'audio/mp4',
  gcsKey: 'ws-1/recordings/f1',
  storageUri: null,
  bytes: null,
  durationMs: null,
  transcriptFileId: null,
  mediaFileId: null,
  participants: [],
  truncated: false,
  lastError: null,
  deleteAfter: null,
  userId: null,
  assistantId: 'a-1',
  sensitivity: 'internal',
  createdByUserId: 'u-1',
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:recordings/recordings-store] create', () => {
  it('writes on the owner pool and is idempotent on the anchor id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await createRecording({
      id: 'rec-1',
      workspaceId: 'ws-1',
      mime: 'audio/mp4',
      gcsKey: 'ws-1/recordings/f1',
      assistantId: 'a-1',
      createdByUserId: 'u-1',
    })
    const [sql, values] = mockQuery.mock.calls[0]!
    // Idempotent: a retried upload-url for the same Episode must not 23505.
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/)
    expect(values![0]).toBe('rec-1')
    // The route did the membership check; the worker has no user context.
    expect(mockRls).not.toHaveBeenCalled()
  })

  it('BIGINT columns come back from pg as strings and are normalized to numbers', async () => {
    // pg returns int8 as a string — a raw spread would leak '95580000' into a
    // field typed `number`, and `durationMs > x` comparisons would go lexical.
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ROW, bytes: '52428800', durationMs: '5735000' }],
    } as never)
    const rec = await getRecordingSystem('rec-1')
    expect(rec!.bytes).toBe(52_428_800)
    expect(rec!.durationMs).toBe(5_735_000)
  })
})

describe('[COMP:recordings/recordings-store] reads', () => {
  it('member read goes through RLS, system read does not', async () => {
    mockRls.mockResolvedValueOnce({ rows: [ROW] } as never)
    await getRecording('u-1', 'rec-1')
    expect(mockRls).toHaveBeenCalledWith('u-1', expect.stringMatching(/FROM recordings/), ['rec-1'])

    vi.clearAllMocks()
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await getRecordingSystem('rec-1')
    expect(mockQuery).toHaveBeenCalled()
    expect(mockRls).not.toHaveBeenCalled()
  })

  it('list is workspace-scoped, live-rows-only, newest-first, on the RLS pool', async () => {
    mockRls.mockResolvedValueOnce({ rows: [ROW] } as never)
    await listRecordings('u-1', 'ws-1')
    const [, sql, values] = mockRls.mock.calls[0]!
    expect(sql).toMatch(/workspace_id = \$1/)
    // Retracted / superseded recordings must not surface in a list.
    expect(sql).toMatch(/valid_to IS NULL/)
    expect(sql).toMatch(/retracted_at IS NULL/)
    expect(sql).toMatch(/ORDER BY created_at DESC/)
    expect(values![0]).toBe('ws-1')
  })

  it('applies temporal + kind filters — the "Tuesday\'s call" lookup', async () => {
    mockRls.mockResolvedValueOnce({ rows: [] } as never)
    const since = new Date('2026-07-14T00:00:00Z')
    const until = new Date('2026-07-15T00:00:00Z')
    await listRecordings('u-1', 'ws-1', { kind: 'meeting', since, until, q: 'client' })
    const [, sql, values] = mockRls.mock.calls[0]!
    expect(sql).toMatch(/kind = \$2/)
    expect(sql).toMatch(/created_at >= \$3/)
    expect(sql).toMatch(/created_at < \$4/)
    expect(sql).toMatch(/title ILIKE \$5 OR file_name ILIKE \$5/)
    expect(values).toEqual(['ws-1', 'meeting', since, until, '%client%', expect.any(Number)])
  })

  it('caps the limit so a caller cannot page the whole workspace', async () => {
    mockRls.mockResolvedValueOnce({ rows: [] } as never)
    await listRecordings('u-1', 'ws-1', {}, { limit: 10_000 })
    const [, , values] = mockRls.mock.calls[0]!
    expect(values![values!.length - 1]).toBe(LIST_RECORDINGS_LIMIT_MAX)
  })
})

describe('[COMP:recordings/recordings-store] update', () => {
  it('patches only the named fields, leaving the rest untouched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await updateRecording('rec-1', { status: 'processed', durationMs: 5_735_000 })
    const [sql, values] = mockQuery.mock.calls[0]!
    expect(sql).toMatch(/SET status = \$1, duration_ms = \$2, updated_at = now\(\)/)
    // A status write must not clobber a concurrent transcript-file write. Scope
    // the check to the SET clause — RETURNING legitimately names every column.
    const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'))
    expect(setClause).not.toMatch(/transcript_file_id/)
    expect(values).toEqual(['processed', 5_735_000, 'rec-1'])
  })

  it('distinguishes an explicit null from an omitted field', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await updateRecording('rec-1', { lastError: null })
    const [sql, values] = mockQuery.mock.calls[0]!
    expect(sql).toMatch(/SET last_error = \$1/)
    expect(values).toEqual([null, 'rec-1'])
  })

  // The language signal is instrumentation: it must land in typed columns an
  // operator can slice in SQL, and a density of 0 must be storable as 0. Zero
  // is a real reading — "Chinese, carrying no Cantonese", which is exactly the
  // normalization the metric exists to catch — so it can never be treated as
  // "nothing to write" and skipped.
  it('writes the language signal, including a density of zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await updateRecording('rec-1', {
      cantoDensityPerK: 0,
      cantoMarkerCount: 0,
      cjkCount: 240,
      latinTokens: 12,
      chineseVariant: 'mandarin',
    })
    const [sql, values] = mockQuery.mock.calls[0]!
    const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'))
    expect(setClause).toMatch(/canto_density_per_k = \$1/)
    expect(values).toEqual([0, 0, 240, 12, 'mandarin', 'rec-1'])
  })

  // An unmeasured recording and one measured at zero must stay distinguishable
  // in every aggregate, so "no CJK present" is written as a real NULL rather
  // than defaulted to 0 — a 0 there would report every English recording as
  // Chinese-with-no-Cantonese and drag the statistics with it.
  it('writes an unmeasurable density as NULL, never as 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await updateRecording('rec-1', { cantoDensityPerK: null, cjkCount: 0 })
    const [, values] = mockQuery.mock.calls[0]!
    expect(values).toEqual([null, 0, 'rec-1'])
  })

  it('bounds lastError — provider errors can be arbitrarily long', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await updateRecording('rec-1', { lastError: 'x'.repeat(5000) })
    const [, values] = mockQuery.mock.calls[0]!
    expect((values![0] as string).length).toBe(2000)
  })

  it('an empty patch does not emit a malformed UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] } as never)
    await updateRecording('rec-1', {})
    // Falls through to a plain read rather than `SET  WHERE`.
    expect(mockQuery.mock.calls[0]![0]).toMatch(/^\s*SELECT/)
  })
})
