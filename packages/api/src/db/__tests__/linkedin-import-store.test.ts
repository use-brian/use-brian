import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn(), getPool: vi.fn() }))

import {
  claimNextLinkedInImportRun,
  completeLinkedInImportRun,
  createOrGetLinkedInImportRun,
  findLinkedInImportRunByHash,
  listLinkedInExternalIdentities,
  markLinkedInImportFailed,
  persistLinkedInProjection,
  setLinkedInImportStage,
  upsertLinkedInImportRows,
} from '../linkedin-import-store.js'
import { getPool, query } from '../client.js'

const mockQuery = vi.mocked(query)
const mockGetPool = vi.mocked(getPool)

const row = {
  id: 'run-1', workspaceId: 'ws-1', actingUserId: 'u-1', assistantId: null,
  archiveFileId: 'f-1', archiveName: 'linkedin.zip', archiveSha256: 'a'.repeat(64),
  archiveSizeBytes: '123', status: 'pending', stage: 'queued', attempts: 0,
  lastError: null, leaseToken: null, memberCount: 0, completedMemberCount: 0, rowCount: 0,
  mappedCount: 0, storedCount: 0, unresolvedCount: 0, malformedCount: 0,
  entityCount: 0, edgeCount: 0, createdAt: new Date(), updatedAt: new Date(),
  completedAt: null,
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/linkedin-import-store] LinkedIn import ledger store', () => {
  it('creates idempotently on workspace + private actor + archive hash and maps bigint size', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, inserted: true }] } as never)
    const result = await createOrGetLinkedInImportRun({
      workspaceId: 'ws-1', actingUserId: 'u-1', assistantId: null,
      archiveFileId: 'f-1', archiveName: 'linkedin.zip', archiveSha256: 'a'.repeat(64),
      archiveSizeBytes: 123,
    })
    expect(result).toMatchObject({ created: true, run: { archiveSizeBytes: 123 } })
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (workspace_id, acting_user_id, archive_sha256)'), [
      'ws-1', 'u-1', null, 'f-1', 'linkedin.zip', 'a'.repeat(64), 123,
    ])
  })

  it('looks up duplicate archives inside the importing user partition', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row }] } as never)
    await findLinkedInImportRunByHash('ws-1', 'u-1', 'a'.repeat(64))
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining(
      'workspace_id = $1 AND acting_user_id = $2 AND archive_sha256 = $3',
    ), ['ws-1', 'u-1', 'a'.repeat(64)])
  })

  it('reaps a stale lease before claiming with SKIP LOCKED', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, status: 'processing', attempts: 1, leaseToken: 'lease-1' }] } as never)
    const claimed = await claimNextLinkedInImportRun()
    expect(claimed).toMatchObject({ id: 'run-1', status: 'processing' })
    expect(mockQuery.mock.calls[0][0]).toContain('Worker lease expired')
    expect(mockQuery.mock.calls[0][0]).toContain('lease_token = NULL')
    expect(mockQuery.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED')
    expect(mockQuery.mock.calls[1][0]).toContain('lease_token = gen_random_uuid()')
  })

  it('requeues failures below the cap and reports the persisted status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ attempts: 1, status: 'pending' }] } as never)
    await expect(markLinkedInImportFailed('run-1', 'lease-1', 'boom')).resolves.toEqual({ retrying: true })
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'processing' AND lease_token = $4")
  })

  it('rejects a stage update from a stale worker lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await expect(setLinkedInImportStage('run-1', 'stale-lease', 'projecting_graph'))
      .rejects.toThrow('lost its worker lease')
  })

  it('seeds exact identities from existing private person entities', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{
        entityId: 'person-1',
        canonicalId: 'Ada@Example.com',
        attributes: { email: ['other@example.com'], phone: '+1 (555) 123-4567' },
      }] } as never)
    await expect(listLinkedInExternalIdentities({ workspaceId: 'ws-1', userId: 'u-1' }))
      .resolves.toEqual(expect.arrayContaining([
        { kind: 'email', normalizedValue: 'ada@example.com', originalValue: 'Ada@Example.com', entityId: 'person-1' },
        { kind: 'email', normalizedValue: 'other@example.com', originalValue: 'other@example.com', entityId: 'person-1' },
        { kind: 'phone', normalizedValue: '+15551234567', originalValue: '+1 (555) 123-4567', entityId: 'person-1' },
      ]))
    expect(mockQuery.mock.calls[1][0]).toContain('user_id = $2')
  })

  it('bulk-upserts exact ordered cells and explicit terminal outcomes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await upsertLinkedInImportRows({
      runId: 'run-1', memberId: 'member-1', workspaceId: 'ws-1',
      rows: [{
        memberPath: 'Connections.csv', rowOrdinal: 1, dataOrdinal: null,
        recordKind: 'header', startLine: 1, endLine: 1,
        cells: ['First Name', 'Last Name'], values: null, rawSha256: 'b'.repeat(64),
        outcome: 'stored', outcomeReason: 'header', entityIds: [],
      }],
    })
    const payload = JSON.parse(mockQuery.mock.calls[0][1]![3] as string)
    expect(payload[0]).toMatchObject({
      cells: ['First Name', 'Last Name'], outcome: 'stored', outcome_reason: 'header',
    })
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT (run_id, member_path, row_ordinal)')
  })

  it('rebases a raced draft identity under the advisory lock before graph writes', async () => {
    const draftId = '00000000-0000-4000-8000-000000000010'
    const committedId = '00000000-0000-4000-8000-000000000011'
    const selfId = '00000000-0000-4000-8000-000000000012'
    const clientQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM jsonb_to_recordset($3::jsonb) AS candidate')) {
        return { rows: [{ kind: 'profile_url', normalizedValue: 'https://linkedin.com/in/ada', entityId: committedId }] }
      }
      return { rows: [] }
    })
    mockGetPool.mockReturnValue({
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    } as never)

    await persistLinkedInProjection(row as never, {
      entities: [{
        id: draftId, kind: 'person', displayName: 'Ada', canonicalId: null,
        attributes: { linkedin: { imported: true } },
      }],
      identities: [{
        kind: 'profile_url', normalizedValue: 'https://linkedin.com/in/ada',
        originalValue: 'https://linkedin.com/in/Ada', entityId: draftId,
      }],
      edges: [{
        sourceId: selfId, targetId: draftId, edgeType: 'connected_to', attributes: { observation_count: 1 },
      }],
      rowOutcomes: [{
        memberPath: 'Connections.csv', rowOrdinal: 2, outcome: 'mapped',
        outcomeReason: 'direct_connection', entityIds: [draftId],
      }],
    })

    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO entities'))).toBe(false)
    const paramsFor = (needle: string): unknown[] => {
      const call = clientQuery.mock.calls.find(([sql]) => String(sql).includes(needle))
      expect(call).toBeDefined()
      return call?.[1] ?? []
    }
    expect(JSON.parse(String(paramsFor('INSERT INTO entity_external_identities')[3]))).toMatchObject([{ entity_id: committedId }])
    expect(JSON.parse(String(paramsFor('INSERT INTO entity_links')[2]))).toMatchObject([{ target_id: committedId }])
    expect(JSON.parse(String(paramsFor('UPDATE linkedin_import_rows')[1]))).toMatchObject([{ entity_ids: [committedId] }])
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('refuses completion when members or row outcomes do not reconcile', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      memberCount: '2', completedMemberCount: '1', rowCount: '4',
      mappedCount: '1', storedCount: '1', unresolvedCount: '1', malformedCount: '1',
      entityCount: '3', edgeCount: '2',
    }] } as never)
    await expect(completeLinkedInImportRun({ runId: 'run-1', leaseToken: 'lease-1' })).rejects.toThrow(/1\/2 members completed/)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('cannot complete a run after its lease has been reclaimed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      memberCount: '1', completedMemberCount: '1', rowCount: '1',
      mappedCount: '1', storedCount: '0', unresolvedCount: '0', malformedCount: '0',
      entityCount: '1', edgeCount: '1',
    }] } as never)
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await expect(completeLinkedInImportRun({ runId: 'run-1', leaseToken: 'stale-lease' }))
      .rejects.toThrow('lost its worker lease')
    expect(mockQuery.mock.calls[1][0]).toContain("status = 'processing' AND lease_token = $11")
  })
})
