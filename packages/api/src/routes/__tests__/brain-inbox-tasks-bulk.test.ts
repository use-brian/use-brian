/**
 * Unit tests for the Tasks operator surface's server bulk lane.
 * Component tag: [COMP:api/tasks-bulk-route].
 *
 * Mocks the db seams (`query`, `updateTask`, the brain-inbox store) and
 * mounts `brainInboxRoutes()` with a stub workspace store. Verifies the
 * body validation (action / ids / set), the once-per-call assignee
 * membership check, per-row ownership (cross-workspace rows fail their id
 * without failing the batch), the priority merge into each row's live
 * attributes, and the delete path's set-wise task / goal / audit operation.
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
vi.mock('../../db/task-admission-store.js', () => ({ rejectTask: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyBrainInboxChange: vi.fn() }))

import { brainInboxRoutes } from '../brain-inbox.js'
import { query } from '../../db/client.js'
import { updateTask } from '../../db/tasks.js'
import { rejectTask } from '../../db/task-admission-store.js'
import { appendBrainVerification } from '../../db/brain-inbox-store.js'

const mockQuery = vi.mocked(query)
const mockUpdate = vi.mocked(updateTask)
const mockReject = vi.mocked(rejectTask)
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
    expect(
      (await request(app).post(URL).send({ action: 'delete', ids: ['t1'], reason: 'no' })).status,
    ).toBe(400)
    expect(
      (await request(app).post(URL).send({ action: 'delete', ids: ['t1'], create_rule: true })).status,
    ).toBe(400)
    expect(
      (await request(app).post(URL).send({ action: 'delete', ids: ['t1', 't1'] })).status,
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

  it('plain delete closes tasks, retires every hosted goal, and audits in one set operation', async () => {
    const app = makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }] } as any)
    const res = await request(app).post(URL).send({ action: 'delete', ids: ['t1', 'missing'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: false,
      results: [
        { id: 't1', ok: true },
        { id: 'missing', ok: false },
      ],
    })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toContain('WITH deleted_tasks AS')
    expect(sql).toContain('id = ANY($1::uuid[])')
    expect(sql).toContain('UPDATE goals')
    expect(sql).toContain("status = 'abandoned'")
    expect(sql).toContain('INSERT INTO brain_verifications')
    expect(mockQuery.mock.calls[0][1]).toEqual([
      ['t1', 'missing'],
      'w1',
      ['done', 'abandoned'],
      'u1',
    ])
    expect(mockAudit).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('applies one shared reason as an independent tombstone and narrow active rule per task', async () => {
    const app = makeApp()
    queueRow('w1')
    queueRow('w1')
    mockReject
      .mockResolvedValueOnce({
        task: { id: 't1' },
        tombstoneId: 'ts1',
        activeRuleId: 'rule1',
        proposedRuleId: null,
      } as any)
      .mockResolvedValueOnce({
        task: { id: 't2' },
        tombstoneId: 'ts2',
        activeRuleId: 'rule2',
        proposedRuleId: null,
      } as any)

    const reason = 'Slack discussion about existing work is not a new task.'
    const res = await request(app)
      .post(URL)
      .send({
        action: 'delete',
        ids: ['t1', 't2'],
        reason,
        create_rule: true,
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      results: [
        { id: 't1', ok: true, tombstoned: true, activeRuleId: 'rule1' },
        { id: 't2', ok: true, tombstoned: true, activeRuleId: 'rule2' },
      ],
    })
    expect(mockReject).toHaveBeenNthCalledWith(1, {
      workspaceId: 'w1',
      userId: 'u1',
      taskId: 't1',
      reason,
      createRule: true,
    })
    expect(mockReject).toHaveBeenNthCalledWith(2, {
      workspaceId: 'w1',
      userId: 'u1',
      taskId: 't2',
      reason,
      createRule: true,
    })
    expect(mockAudit).toHaveBeenCalledTimes(2)
    // Only the two ownership probes touch the route-level query seam; the
    // rejection primitive owns each atomic delete/tombstone/rule transaction.
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
})
