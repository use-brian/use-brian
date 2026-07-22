/**
 * Unit tests for the Tasks operator surface's server bulk lane.
 * Component tag: [COMP:api/tasks-bulk-route].
 *
 * Mocks the db seams (`query`, `updateTask`, the brain-inbox store) and
 * mounts `brainInboxRoutes()` with a stub workspace store. Verifies the
 * body validation (action / ids / set), the once-per-call assignee
 * membership check, per-row ownership (cross-workspace rows fail their id
 * without failing the batch), the priority merge into each row's live
 * attributes, and the delete path's soft-delete + audit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/brain-inbox-store.js', () => ({
  listBrainInbox: vi.fn(),
  countBrainInbox: vi.fn(),
  getBrainInboxRow: vi.fn(),
  markVerifiedGeneric: vi.fn(),
  appendBrainVerification: vi.fn(),
  pruneDanglingEntityLinks: vi.fn(),
  primitiveToTable: vi.fn((p: string) => (p === 'task' ? 'tasks' : p)),
}))
vi.mock('../../db/sessions.js', () => ({ createInspectionSession: vi.fn() }))
vi.mock('../../db/memories.js', () => ({
  updateMemory: vi.fn(),
  getMemoryByIdSystem: vi.fn(),
  markVerifiedDirect: vi.fn(),
}))
vi.mock('../../db/memory-verifications-store.js', () => ({ recordVerification: vi.fn() }))
vi.mock('../../db/entities-store.js', () => ({
  updateEntity: vi.fn(),
  reclassifyEntityKind: vi.fn(),
  promoteEntityToCrm: vi.fn(),
  addEntityAlias: vi.fn(),
  removeEntityAlias: vi.fn(),
}))
vi.mock('../../db/workspace-files.js', () => ({ updateWorkspaceFileMeta: vi.fn() }))
vi.mock('../../db/tasks.js', () => ({ updateTask: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyBrainInboxChange: vi.fn() }))

import { brainInboxRoutes } from '../brain-inbox.js'
import { query } from '../../db/client.js'
import { updateTask } from '../../db/tasks.js'
import { appendBrainVerification } from '../../db/brain-inbox-store.js'

const mockQuery = vi.mocked(query)
const mockUpdate = vi.mocked(updateTask)
const mockAudit = vi.mocked(appendBrainVerification)

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeApp(role: string | null = 'member') {
  const router = brainInboxRoutes({
    workspaceStore: { getRole: vi.fn().mockResolvedValue(role) } as any,
  })
  return createTestApp('/api/brain-inbox', router, { userId: 'u1' })
}

const URL = '/api/brain-inbox/w1/tasks/bulk'

/** Queue the per-row ownership pre-check SELECT result. */
function queueRow(workspaceId: string, attributes: Record<string, unknown> = {}) {
  mockQuery.mockResolvedValueOnce({ rows: [{ workspace_id: workspaceId, attributes }] } as any)
}

describe('[COMP:api/tasks-bulk-route] POST /:workspaceId/tasks/bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('403s a non-member', async () => {
    const res = await request(makeApp(null)).post(URL).send({ action: 'delete', ids: ['t1'] })
    expect(res.status).toBe(403)
  })

  it('validates action, ids, status, and a non-empty set', async () => {
    const app = makeApp()
    expect((await request(app).post(URL).send({ action: 'nuke', ids: ['t1'] })).status).toBe(400)
    expect((await request(app).post(URL).send({ action: 'update', ids: [] })).status).toBe(400)
    expect(
      (await request(app).post(URL).send({
        action: 'update',
        ids: Array.from({ length: 201 }, (_, i) => `t${i}`),
        set: { status: 'done' },
      })).status,
    ).toBe(400)
    expect(
      (await request(app).post(URL).send({ action: 'update', ids: ['t1'], set: { status: 'bogus' } })).status,
    ).toBe(400)
    expect(
      (await request(app).post(URL).send({ action: 'update', ids: ['t1'], set: {} })).status,
    ).toBe(400)
    expect(
      (await request(app).post(URL).send({ action: 'update', ids: ['t1'], set: { priority: 'mega' } })).status,
    ).toBe(400)
  })

  it('validates a string assignee against workspace_members once per call', async () => {
    const app = makeApp()
    // Membership probe returns no rows → 400 before any row is touched.
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    const res = await request(app)
      .post(URL)
      .send({ action: 'update', ids: ['t1'], set: { assignee_id: 'stranger' } })
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('updates each owned row (supersession newId back), fails cross-workspace ids without failing the batch', async () => {
    const app = makeApp()
    queueRow('w1', { estimate_days: 3, priority: 'low' })
    mockUpdate.mockResolvedValueOnce({ id: 't1-v2' } as any)
    queueRow('OTHER') // cross-workspace → ok:false, no update call
    const res = await request(app)
      .post(URL)
      .send({ action: 'update', ids: ['t1', 't2'], set: { status: 'archived', priority: 'urgent' } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.results).toEqual([
      { id: 't1', ok: true, newId: 't1-v2' },
      { id: 't2', ok: false },
    ])
    // Priority merged into the row's LIVE attributes (sibling keys survive).
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const fields = mockUpdate.mock.calls[0][2] as { status?: string; attributes?: Record<string, unknown> }
    expect(fields.status).toBe('archived')
    expect(fields.attributes).toEqual({ estimate_days: 3, priority: 'urgent' })
  })

  it('delete soft-deletes each owned row and audits it', async () => {
    const app = makeApp()
    queueRow('w1') // pre-check
    mockQuery.mockResolvedValueOnce({ rows: [] } as any) // the UPDATE … SET valid_to
    const res = await request(app).post(URL).send({ action: 'delete', ids: ['t1'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, results: [{ id: 't1', ok: true }] })
    const updateSql = String(mockQuery.mock.calls[1][0])
    expect(updateSql).toContain('SET valid_to = now()')
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: 'task', targetId: 't1', action: 'delete' }),
    )
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
