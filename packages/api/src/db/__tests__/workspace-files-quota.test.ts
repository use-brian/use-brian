import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  queryWithRLS: vi.fn(),
  query: vi.fn(),
  getPool: vi.fn(),
}))

import { sumWorkspaceFilesSizeBytes, QUOTA_EXEMPT_META_KEY } from '../workspace-files.js'
import { queryWithRLS } from '../client.js'

/**
 * The workspace quota sum (`sumWorkspaceFilesSizeBytes`, the store fn behind
 * the files API's quota gate). Component tag: [COMP:files/api].
 *
 * The exemption exists so recording MEDIA can carry a workspace_files row (which
 * is what makes it visible to erasure — erasure.md gives workspace_files
 * hard-delete + GCS object delete, and a recording with no row survives forever)
 * WITHOUT the 1 GiB cap becoming a 2-to-20-recordings limit.
 *
 * Erasure visibility and quota accounting are separate concerns; this predicate
 * is what keeps them separate. Getting it wrong in either direction is bad: too
 * broad and users get free storage, too narrow and recordings eat the cap.
 */

const mockRls = vi.mocked(queryWithRLS)
const ctx = { userId: 'u-1', workspaceId: 'ws-1' } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockRls.mockResolvedValue({ rows: [{ total: '700' }] } as never)
})

describe('[COMP:files/api] workspace quota sum', () => {
  it('excludes quota-exempt rows from the sum', async () => {
    await sumWorkspaceFilesSizeBytes(ctx)
    const [, sql] = mockRls.mock.calls[0]!
    expect(sql).toContain(`metadata->>'${QUOTA_EXEMPT_META_KEY}'`)
    // COALESCE, not a bare cast: the overwhelming majority of rows have no such
    // key, and `NULL::boolean` in a NOT would drop EVERY normal file from the
    // sum — i.e. silently give the whole workspace an unlimited quota.
    expect(sql).toMatch(/NOT COALESCE\(\(metadata->>'quota_exempt'\)::boolean, false\)/)
  })

  it('still excludes superseded rows (the pre-existing rule)', async () => {
    await sumWorkspaceFilesSizeBytes(ctx)
    const [, sql] = mockRls.mock.calls[0]!
    expect(sql).toContain('valid_to IS NULL')
  })

  it('goes through RLS, not the owner pool', async () => {
    await sumWorkspaceFilesSizeBytes(ctx)
    expect(mockRls.mock.calls[0]![0]).toBe('u-1')
  })

  it('normalizes pg BIGINT strings to a number', async () => {
    // SUM(bigint) returns a string; `currentBytes + bytes.length` would
    // concatenate rather than add, and the cap would never fire.
    mockRls.mockResolvedValue({ rows: [{ total: '1073741824' }] } as never)
    await expect(sumWorkspaceFilesSizeBytes(ctx)).resolves.toBe(1_073_741_824)
  })

  it('returns 0 for an empty workspace', async () => {
    mockRls.mockResolvedValue({ rows: [{ total: null }] } as never)
    await expect(sumWorkspaceFilesSizeBytes(ctx)).resolves.toBe(0)
  })
})
