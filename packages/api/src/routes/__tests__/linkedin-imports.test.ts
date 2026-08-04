import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { sha256 } from '../../linkedin-import/archive.js'
import type { LinkedInImportRun } from '../../linkedin-import/types.js'
import { linkedinImportRoutes } from '../linkedin-imports.js'

const assistant = {
  id: '00000000-0000-4000-8000-000000000004',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  kind: 'primary',
  clearance: 'confidential',
  compartments: [],
}

function runFixture(hash: string, status: LinkedInImportRun['status'] = 'pending'): LinkedInImportRun {
  const now = new Date('2026-08-04T00:00:00Z')
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: assistant.workspaceId,
    actingUserId: 'user-1',
    assistantId: assistant.id,
    archiveFileId: 'file-1',
    archiveName: 'linkedin.zip',
    archiveSha256: hash,
    archiveSizeBytes: 12,
    status,
    stage: status === 'completed' ? 'completed' : 'queued',
    attempts: 0,
    lastError: null,
    leaseToken: null,
    memberCount: status === 'completed' ? 54 : 0,
    completedMemberCount: status === 'completed' ? 54 : 0,
    rowCount: status === 'completed' ? 15_026 : 0,
    mappedCount: 0,
    storedCount: 0,
    unresolvedCount: 0,
    malformedCount: 0,
    entityCount: 0,
    edgeCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'completed' ? now : null,
  }
}

function appFor(deps: Parameters<typeof linkedinImportRoutes>[0]) {
  const app = express()
  app.use((req, _res, next) => {
    ;(req as typeof req & { userId: string }).userId = 'user-1'
    next()
  })
  app.use('/api/imports/linkedin', linkedinImportRoutes(deps))
  return app
}

describe('[COMP:api/linkedin-import-http] LinkedIn import routes', () => {
  it('validates, stores confidential original bytes, and returns a queued run', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const hash = sha256(bytes)
    const writeBytes = vi.fn().mockResolvedValue({ ok: true, value: { id: 'file-1' } })
    const findRunByHash = vi.fn().mockResolvedValue(null)
    const createRun = vi.fn().mockResolvedValue({ run: runFixture(hash), created: true })
    const inspectArchive = vi.fn().mockResolvedValue([])
    const res = await request(appFor({
      filesApi: { writeBytes, readBytes: vi.fn() } as never,
      findRunByHash,
      createRun,
      getRun: vi.fn(),
      resolvePrimaryAssistant: vi.fn().mockResolvedValue(assistant as never),
      inspectArchive,
    }))
      .post('/api/imports/linkedin')
      .field('workspaceId', assistant.workspaceId)
      .attach('file', bytes, { filename: 'linkedin.zip', contentType: 'application/zip' })

    expect(res.status).toBe(202)
    expect(res.body.run).toMatchObject({ id: runFixture(hash).id, archiveSha256: hash, status: 'pending' })
    expect(inspectArchive).toHaveBeenCalledWith(expect.any(Buffer))
    expect(writeBytes).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: assistant.workspaceId, userId: 'user-1' }),
      expect.objectContaining({
        path: `/imports/linkedin/user-1/${hash}/archive.zip`,
        sensitivity: 'confidential',
        mime: 'application/zip',
      }),
    )
    expect(findRunByHash).toHaveBeenCalledWith(assistant.workspaceId, 'user-1', hash)
  })

  it('returns the existing completed run without writing duplicate bytes', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 5])
    const existing = runFixture(sha256(bytes), 'completed')
    const writeBytes = vi.fn()
    const res = await request(appFor({
      filesApi: { writeBytes, readBytes: vi.fn() } as never,
      findRunByHash: vi.fn().mockResolvedValue(existing),
      createRun: vi.fn(),
      getRun: vi.fn(),
      resolvePrimaryAssistant: vi.fn().mockResolvedValue(assistant as never),
      inspectArchive: vi.fn(),
    }))
      .post('/api/imports/linkedin')
      .field('workspaceId', assistant.workspaceId)
      .attach('file', bytes, { filename: 'linkedin.zip', contentType: 'application/zip' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ duplicate: true, run: { status: 'completed', counts: { rows: 15_026 } } })
    expect(writeBytes).not.toHaveBeenCalled()
  })

  it('rejects a non-ZIP before archive inspection or persistence', async () => {
    const inspectArchive = vi.fn()
    const writeBytes = vi.fn()
    const res = await request(appFor({
      filesApi: { writeBytes, readBytes: vi.fn() } as never,
      findRunByHash: vi.fn(), createRun: vi.fn(), getRun: vi.fn(),
      resolvePrimaryAssistant: vi.fn().mockResolvedValue(assistant as never),
      inspectArchive,
    }))
      .post('/api/imports/linkedin')
      .field('workspaceId', assistant.workspaceId)
      .attach('file', Buffer.from('not zip'), { filename: 'linkedin.zip', contentType: 'application/zip' })
    expect(res.status).toBe(400)
    expect(inspectArchive).not.toHaveBeenCalled()
    expect(writeBytes).not.toHaveBeenCalled()
  })

  it('scopes status to the importing user', async () => {
    const run = runFixture('d'.repeat(64), 'completed')
    const res = await request(appFor({
      filesApi: {} as never,
      getRun: vi.fn().mockResolvedValue(run),
      resolvePrimaryAssistant: vi.fn().mockResolvedValue(assistant as never),
    })).get(`/api/imports/linkedin/${run.id}`)
    expect(res.status).toBe(200)
    expect(res.body.run.counts.rows).toBe(15_026)

    const foreign = { ...run, actingUserId: 'someone-else' }
    const denied = await request(appFor({
      filesApi: {} as never,
      getRun: vi.fn().mockResolvedValue(foreign),
      resolvePrimaryAssistant: vi.fn(),
    })).get(`/api/imports/linkedin/${run.id}`)
    expect(denied.status).toBe(404)
  })
})
