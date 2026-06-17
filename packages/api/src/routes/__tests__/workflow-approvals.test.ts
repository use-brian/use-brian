/**
 * Unit tests for the workflow approvals routes.
 * Component tag: [COMP:api/approval-routes].
 *
 * Mocks resumeFromApproval and mounts workflowApprovalsRoutes() with
 * injected mock stores. Verifies GET /workspaces/:id/approvals (auth +
 * membership gate, row serialization) and the approve / reject
 * handlers (not-found, wrong-approver, the already-resolved idempotent
 * short-circuit, and the resume hand-off).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../workflow/approval.js', () => ({
  resumeFromApproval: vi.fn(),
}))

import { workflowApprovalsRoutes } from '../workflow-approvals.js'
import { resumeFromApproval } from '../../workflow/approval.js'

const mockResume = vi.mocked(resumeFromApproval)

const approvalsStore = {
  listPendingForWorkspace: vi.fn(),
  getById: vi.fn(),
}
const workspaceStore = {
  getRole: vi.fn(),
}

function app(userId?: string) {
  return createTestApp(
    '/api',
    workflowApprovalsRoutes({
      approvalsStore: approvalsStore as never,
      workspaceStore: workspaceStore as never,
      bridgeDeps: {} as never,
    }),
    userId ? { userId } : undefined,
  )
}

function approvalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'appr-1',
    workflowRunId: 'run-1',
    toolName: 'sendEmail',
    arguments: { to: 'x@y.z' },
    approverUserId: 'u-1',
    deliveryChannelType: 'web',
    status: 'pending',
    expiresAt: null,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/approval-routes] GET /workspaces/:id/approvals', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app()).get('/api/workspaces/ws-1/approvals')).status).toBe(401)
  })

  it('rejects a non-member of the workspace with 403', async () => {
    workspaceStore.getRole.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/workspaces/ws-1/approvals')).status).toBe(403)
  })

  it('lists the pending approvals serialized for the workspace', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    approvalsStore.listPendingForWorkspace.mockResolvedValueOnce([approvalRow()])
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/approvals')
    expect(res.status).toBe(200)
    expect(res.body.approvals[0]).toMatchObject({ id: 'appr-1', toolName: 'sendEmail' })
    expect(res.body.approvals[0].createdAt).toBe('2026-05-16T00:00:00.000Z')
  })
})

describe('[COMP:api/approval-routes] POST /approvals/:id/approve', () => {
  it('returns 404 when the approval does not exist', async () => {
    approvalsStore.getById.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).post('/api/approvals/appr-x/approve')).status).toBe(404)
  })

  it('rejects a caller who is not the assigned approver with 403', async () => {
    approvalsStore.getById.mockResolvedValueOnce(approvalRow({ approverUserId: 'someone-else' }))
    expect((await request(app('u-1')).post('/api/approvals/appr-1/approve')).status).toBe(403)
  })

  it('short-circuits idempotently when the approval is already resolved', async () => {
    approvalsStore.getById.mockResolvedValueOnce(approvalRow({ status: 'approved' }))
    const res = await request(app('u-1')).post('/api/approvals/appr-1/approve')
    expect(res.body).toMatchObject({ status: 'approved', idempotent: true })
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('resumes the run when a pending approval is approved', async () => {
    approvalsStore.getById.mockResolvedValueOnce(approvalRow())
    mockResume.mockResolvedValueOnce({ status: 'approved', runId: 'run-1' } as never)
    const res = await request(app('u-1')).post('/api/approvals/appr-1/approve')
    expect(res.status).toBe(200)
    expect(mockResume).toHaveBeenCalledWith({}, 'appr-1', 'approved', 'u-1')
  })
})

describe('[COMP:api/approval-routes] POST /approvals/:id/reject', () => {
  it('rejects a pending approval and forwards the reason', async () => {
    approvalsStore.getById.mockResolvedValueOnce(approvalRow())
    mockResume.mockResolvedValueOnce({ status: 'rejected', runId: 'run-1' } as never)
    const res = await request(app('u-1'))
      .post('/api/approvals/appr-1/reject')
      .send({ reason: 'not safe' })
    expect(res.status).toBe(200)
    expect(mockResume).toHaveBeenCalledWith({}, 'appr-1', 'rejected', 'u-1', 'not safe')
  })
})
