import { describe, expect, it, vi } from 'vitest'

import type { LinkedInImportStore } from '../../db/linkedin-import-store.js'
import { sha256 } from '../archive.js'
import { createLinkedInImportWorker } from '../worker.js'
import type { LinkedInArchiveMember, LinkedInImportRun } from '../types.js'

function runFixture(archiveBytes: Buffer): LinkedInImportRun {
  const now = new Date('2026-08-04T00:00:00Z')
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    actingUserId: '00000000-0000-4000-8000-000000000003',
    assistantId: '00000000-0000-4000-8000-000000000004',
    archiveFileId: 'archive-file',
    archiveName: 'linkedin.zip',
    archiveSha256: sha256(archiveBytes),
    archiveSizeBytes: archiveBytes.length,
    status: 'processing',
    stage: 'reading_archive',
    attempts: 1,
    lastError: null,
    leaseToken: '00000000-0000-4000-8000-000000000005',
    memberCount: 0,
    completedMemberCount: 0,
    rowCount: 0,
    mappedCount: 0,
    storedCount: 0,
    unresolvedCount: 0,
    malformedCount: 0,
    entityCount: 0,
    edgeCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
}

describe('[COMP:brain/linkedin-import] LinkedIn import worker', () => {
  it('stores/indexes every member, ledgers every CSV record, projects, then reconciles', async () => {
    const archiveBytes = Buffer.from('PK deterministic archive fixture')
    const run = runFixture(archiveBytes)
    const members: LinkedInArchiveMember[] = [
      {
        path: 'Profile.csv',
        bytes: Buffer.from('First Name,Last Name,Public Profile Url\nBrian,Lee,https://linkedin.com/in/brian\n'),
        contentSha256: '', compressedSize: 70, sizeBytes: 80, mime: 'text/csv',
      },
      {
        path: 'Connections.csv',
        bytes: Buffer.from('First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAda,Lovelace,https://linkedin.com/in/ada,,Acme,Founder,01 Jan 2020\n'),
        contentSha256: '', compressedSize: 120, sizeBytes: 140, mime: 'text/csv',
      },
      {
        path: 'README.txt',
        bytes: Buffer.from('source notes'),
        contentSha256: '', compressedSize: 12, sizeBytes: 12, mime: 'text/plain',
      },
    ].map((member) => ({ ...member, contentSha256: sha256(member.bytes), sizeBytes: member.bytes.length }))

    const claim = vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(null)
    const setStage = vi.fn().mockResolvedValue(undefined)
    const markFailed = vi.fn()
    const upsertMember = vi.fn(async (input: { memberPath: string }) => ({
      id: `member:${input.memberPath}`,
      runId: run.id,
      memberPath: input.memberPath,
      fileId: null,
      parseStatus: 'pending' as const,
    }))
    const setMemberArtifact = vi.fn().mockResolvedValue(undefined)
    const completeMember = vi.fn().mockResolvedValue(undefined)
    const failMember = vi.fn().mockResolvedValue(undefined)
    const upsertRows = vi.fn().mockResolvedValue(undefined)
    const listIdentities = vi.fn().mockResolvedValue([])
    const persistProjection = vi.fn().mockResolvedValue(undefined)
    const completeRun = vi.fn().mockResolvedValue(run)
    const store = {
      claim, setStage, markFailed, upsertMember, setMemberArtifact,
      completeMember, failMember, upsertRows, listIdentities,
      persistProjection, completeRun,
    } as unknown as LinkedInImportStore

    const writes: Array<{ path: string; sensitivity?: string }> = []
    const filesApi = {
      readBytes: vi.fn(async (_ctx: unknown, ref: string) => {
        if (ref === 'archive-file') return { ok: true, value: { file: { id: ref }, bytes: archiveBytes } }
        throw new Error(`unexpected read ${ref}`)
      }),
      writeBytes: vi.fn(async (_ctx: unknown, params: { path: string; sensitivity?: string }) => {
        writes.push(params)
        return { ok: true, value: { id: `file:${params.path}` } }
      }),
      stat: vi.fn(),
    }
    const indexArtifact = vi.fn().mockResolvedValue({ segmentsInserted: 1, segmentCount: 1, truncated: false })
    const worker = createLinkedInImportWorker({
      filesApi: filesApi as never,
      store,
      inspectArchive: vi.fn().mockResolvedValue(members),
      indexArtifact,
      resolveSelfEntity: vi.fn().mockResolvedValue({ id: 'self' }),
      intervalMs: 60_000,
    })

    await worker.tick()

    expect(markFailed).not.toHaveBeenCalled()
    expect(writes).toHaveLength(3)
    expect(writes.every((write) => write.sensitivity === 'confidential')).toBe(true)
    expect(indexArtifact).toHaveBeenCalledTimes(3)
    expect(upsertRows).toHaveBeenCalledTimes(2)
    expect(upsertRows.mock.calls[0][0].rows).toHaveLength(2) // header + profile row
    expect(upsertRows.mock.calls[1][0].rows).toHaveLength(2) // header + connection row
    expect(completeMember).toHaveBeenCalledTimes(3)
    expect(persistProjection).toHaveBeenCalledOnce()
    const projection = persistProjection.mock.calls[0][1]
    expect(projection.entities.map((entity: { displayName: string }) => entity.displayName)).toEqual(['Ada Lovelace', 'Acme'])
    expect(projection.edges.map((edge: { edgeType: string }) => edge.edgeType).sort()).toEqual(['connected_to', 'works_at'])
    expect(setStage).toHaveBeenCalledWith(run.id, run.leaseToken, 'validating_archive')
    expect(completeRun).toHaveBeenCalledWith({ runId: run.id, leaseToken: run.leaseToken })
  })

  it('parks processing through the retry seam when stored archive bytes do not reconcile', async () => {
    const archiveBytes = Buffer.from('expected')
    const run = runFixture(archiveBytes)
    const store = {
      claim: vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(null),
      markFailed: vi.fn().mockResolvedValue({ retrying: true }),
    } as unknown as LinkedInImportStore
    const worker = createLinkedInImportWorker({
      filesApi: {
        readBytes: vi.fn().mockResolvedValue({ ok: true, value: { file: { id: 'archive-file' }, bytes: Buffer.from('tampered') } }),
        writeBytes: vi.fn(),
        stat: vi.fn(),
      } as never,
      store,
    })
    await worker.tick()
    expect(store.markFailed).toHaveBeenCalledWith(
      run.id,
      run.leaseToken,
      expect.stringMatching(/hash does not match/),
    )
  })
})
