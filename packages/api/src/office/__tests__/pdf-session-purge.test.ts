import { describe, expect, it, vi } from 'vitest'
import { purgeExpiredPdfSessions, runPdfPurgeBlobWorker } from '../lifecycle-worker.js'

const workspaceId = '20000000-0000-4000-8000-000000000001'
const artifactId = '20000000-0000-4000-8000-000000000002'
const ownerUserId = '20000000-0000-4000-8000-000000000003'
const sourceId = '20000000-0000-4000-8000-000000000004'
const snapshotId = '20000000-0000-4000-8000-000000000005'
const originalId = '20000000-0000-4000-8000-000000000099'

describe('[COMP:api/office-pdf-purge] PDF session erasure', () => {
  it('queues and deletes only the complete tracked session-owned affected set', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    let claimed = false
    const client = { async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (sql.includes("FROM office_artifacts") && sql.includes('SKIP LOCKED')) {
        if (claimed) return { rows: [] }
        claimed = true
        return { rows: [{ id: artifactId, workspaceId, ownerUserId, expiresAt: new Date(Date.now() - 60_000), legalHold: false }] }
      }
      if (sql.includes('FROM office_pdf_session_assets a')) return { rows: [
        { fileId: sourceId, role: 'source', contentSha256: 'a'.repeat(64), path: `/office/sessions/${artifactId}/source/source.pdf`, storageUri: `gs://fictional/${workspaceId}/${sourceId}`, metadata: { officeSession: true, noIndex: true } },
        { fileId: snapshotId, role: 'snapshot', contentSha256: 'b'.repeat(64), path: `/office/sessions/${artifactId}/snapshot/0.json`, storageUri: `gs://fictional/${workspaceId}/${snapshotId}`, metadata: { officeSession: true, noIndex: true } },
      ] }
      if (sql.includes("f.confrelid='workspace_files'::regclass")) return { rows: [] }
      if (sql.includes('storage_uri=ANY')) return { rows: [{ count: 0 }] }
      if (sql.includes('DELETE FROM office_artifacts')) return { rows: [{ id: artifactId }], rowCount: 1 }
      if (sql.includes('DELETE FROM workspace_files')) return { rows: [{ id: sourceId }, { id: snapshotId }], rowCount: 2 }
      return { rows: [], rowCount: 1 }
    } }
    await expect(purgeExpiredPdfSessions(client as never, 1)).resolves.toBe(1)
    const fileDelete = calls.find((call) => call.sql.includes('DELETE FROM workspace_files'))
    expect(fileDelete?.params).toEqual([workspaceId, [sourceId, snapshotId]])
    expect(JSON.stringify(calls)).not.toContain(originalId)
    expect(calls.some((call) => call.sql.includes('office_pdf_purge_objects'))).toBe(true)
    expect(calls.some((call) => call.sql.includes('office_pdf_session_purged'))).toBe(true)
  })

  it('nulls the URI only after an idempotent canonical blob delete succeeds', async () => {
    const deleteObject = vi.fn(async () => {})
    const queries: string[] = []
    const client = { async query(sql: string) {
      queries.push(sql)
      if (sql.includes('WITH due AS')) return { rows: [{ id: 'queue-1', workspaceId, fileId: sourceId, storageUri: `gs://fictional/${workspaceId}/${sourceId}`, leaseToken: 'lease-1' }] }
      return { rows: [{ id: 'queue-1' }], rowCount: 1 }
    } }
    await expect(runPdfPurgeBlobWorker({ client: client as never, deleteObject })).resolves.toBe(1)
    expect(deleteObject).toHaveBeenCalledWith(`gs://fictional/${workspaceId}/${sourceId}`, `${workspaceId}/${sourceId}`)
    expect(queries.some((sql) => sql.includes('storage_uri=NULL'))).toBe(true)
  })
})
