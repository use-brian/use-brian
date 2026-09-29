import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryWithRLS, query, poolQuery } = vi.hoisted(() => ({
  queryWithRLS: vi.fn(async (_userId: unknown, _sql: unknown, _params?: unknown[]) => ({ rows: [] as unknown[] })),
  query: vi.fn(async (_sql: unknown, _params?: unknown[]) => ({ rows: [] as unknown[] })),
  poolQuery: vi.fn(async (_sql: unknown, _params?: unknown[]) => ({ rows: [] as unknown[] })),
}))

vi.mock('../../db/client.js', () => ({
  queryWithRLS,
  query,
  getPool: () => ({ query: poolQuery }),
}))

import {
  listWorkspaceFilesByPath,
  listWorkspaceFilesIndexRanked,
  searchWorkspaceFiles,
} from '../../db/workspace-files.js'
import { createOfficeArtifactStore } from '../../db/office-artifacts.js'
import { enqueueFileIngestJob } from '../../db/file-ingest-jobs-store.js'
import { indexFileArtifact } from '../artifact-index.js'

const context = {
  userId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000002',
  assistantId: '10000000-0000-4000-8000-000000000001',
  assistantKind: 'standard',
  clearance: 'confidential',
} as const

beforeEach(() => {
  vi.clearAllMocks()
  queryWithRLS.mockResolvedValue({ rows: [] })
  query.mockResolvedValue({ rows: [] })
  poolQuery.mockResolvedValue({ rows: [] })
})

describe('[COMP:api/office-pdf-sessions] PDF session discovery boundary', () => {
  it('keeps session-mode rows out of the Office library', async () => {
    const sql: string[] = []
    const store = createOfficeArtifactStore(async (_userId, statement) => {
      sql.push(statement)
      return { rows: [] }
    })
    await store.list(context.userId, context.workspaceId, 'active')
    expect(sql[0]).toContain("mode = 'artifact'")
  })

  it('keeps every user-facing Files list, search, and prompt-index query outside the session namespace', async () => {
    await listWorkspaceFilesByPath(context, {})
    await searchWorkspaceFiles(context, { query: 'agreement' })
    await listWorkspaceFilesIndexRanked(context, 10)

    expect(queryWithRLS).toHaveBeenCalledTimes(3)
    for (const call of queryWithRLS.mock.calls) {
      const sql = String(call[1])
      expect(sql).toContain("path NOT LIKE '/office/sessions/%'")
      expect(sql).toContain("NOT COALESCE((metadata->>'noIndex')::boolean, false)")
    }
  })

  it('keeps the session namespace out of ingest and rejects direct index insertion', async () => {
    await enqueueFileIngestJob({
      fileId: '10000000-0000-4000-8000-000000000003',
      workspaceId: context.workspaceId,
      actingUserId: context.userId,
    })
    expect(String(query.mock.calls[0]?.[0])).toContain("f.path NOT LIKE '/office/sessions/%'")

    poolQuery.mockResolvedValueOnce({ rows: [{
      path: '/office/sessions/10000000-0000-4000-8000-000000000004/source/source.pdf',
      user_id: context.userId,
      assistant_id: null,
      sensitivity: 'confidential',
      compartments: [],
      tags: [],
      source: 'upload',
      metadata: { officeSession: true, noIndex: true },
    }] })
    await expect(indexFileArtifact({
      fileId: '10000000-0000-4000-8000-000000000003',
      workspaceId: context.workspaceId,
      actingUserId: context.userId,
      text: 'must never be indexed',
    })).rejects.toMatchObject({ code: 'file_index_forbidden' })
    expect(poolQuery).toHaveBeenCalledTimes(1)
  })
})
