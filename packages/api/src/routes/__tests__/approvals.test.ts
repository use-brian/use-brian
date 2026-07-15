/**
 * Unit tests for the unified approval queue route.
 * Component tag: [COMP:api/unified-approvals-route].
 *
 * Injects fake stores; mocks `resumeFromApproval` (the workflow-step
 * resume bridge). Covers the membership gate, the full-projection list,
 * the pending count, and the per-kind respond dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../workflow/approval.js', () => ({
  resumeFromApproval: vi.fn(async () => ({ status: 'completed', runId: 'run-1' })),
}))

import { approvalsRoutes } from '../approvals.js'
import { resumeFromApproval } from '../../workflow/approval.js'
import type { PendingApproval } from '../../db/pending-approvals-store.js'

const mockResume = vi.mocked(resumeFromApproval)

function makeApproval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'ap-1',
    workspaceId: 'ws-1',
    workflowRunId: 'run-1',
    workflowStepRunId: 'step-1',
    toolName: 'sendEmail',
    arguments: { to: 'a@b.c' },
    approverUserId: 'u-1',
    deliveryChannelType: 'web',
    deliveryChannelId: null,
    status: 'pending',
    expiresAt: null,
    respondedAt: null,
    respondedBy: null,
    rejectReason: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    kind: 'workflow_step',
    blockingSessionId: null,
    approvalPayload: {},
    originatingAssistantId: null,
    answerText: null,
    ...over,
  }
}

type Stores = {
  listPendingForWorkspace: ReturnType<typeof vi.fn>
  getById: ReturnType<typeof vi.fn>
  getRole: ReturnType<typeof vi.fn>
}

function makeApp(stores: Partial<Stores> = {}) {
  const listPendingForWorkspace = stores.listPendingForWorkspace ?? vi.fn(async () => [])
  const getById = stores.getById ?? vi.fn(async () => null)
  const getRole = stores.getRole ?? vi.fn(async () => 'member')

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'u-1'
    next()
  })
  app.use(
    '/api/approvals',
    approvalsRoutes({
      approvalsStore: { listPendingForWorkspace, getById } as never,
      workspaceStore: { getRole } as never,
      bridgeDeps: {} as never,
    }),
  )
  return { app, listPendingForWorkspace, getById, getRole }
}

beforeEach(() => {
  mockResume.mockClear()
  mockResume.mockResolvedValue({ status: 'completed', runId: 'run-1' })
})

describe('[COMP:api/unified-approvals-route] GET /', () => {
  it('400s without a workspaceId', async () => {
    const { app } = makeApp()
    await request(app).get('/api/approvals').expect(400)
  })

  it('404s when the caller is not a workspace member', async () => {
    const { app } = makeApp({ getRole: vi.fn(async () => null) })
    await request(app).get('/api/approvals?workspaceId=ws-1').expect(404)
  })

  it('lists every pending approval with the full kind-aware projection', async () => {
    const { app } = makeApp({
      listPendingForWorkspace: vi.fn(async () => [
        makeApproval({ kind: 'workflow_step' }),
        makeApproval({
          id: 'ap-2',
          kind: 'tool_invocation',
          blockingSessionId: 'sess-9',
          approvalPayload: { description: 'Send the proposal' },
        }),
      ]),
    })
    const res = await request(app).get('/api/approvals?workspaceId=ws-1').expect(200)
    expect(res.body.approvals).toHaveLength(2)
    expect(res.body.approvals[0].kind).toBe('workflow_step')
    expect(res.body.approvals[1].kind).toBe('tool_invocation')
    expect(res.body.approvals[1].blockingSessionId).toBe('sess-9')
    expect(res.body.approvals[1].approvalPayload).toEqual({ description: 'Send the proposal' })
    expect(typeof res.body.approvals[0].createdAt).toBe('string')
  })
})

describe('[COMP:api/unified-approvals-route] GET /count', () => {
  it('returns the pending count for the workspace', async () => {
    const { app } = makeApp({
      listPendingForWorkspace: vi.fn(async () => [makeApproval(), makeApproval({ id: 'ap-2' })]),
    })
    const res = await request(app).get('/api/approvals/count?workspaceId=ws-1').expect(200)
    expect(res.body.pending).toBe(2)
  })
})

describe('[COMP:api/unified-approvals-route] POST /:id/respond', () => {
  it('400s on a missing/invalid decision', async () => {
    const { app } = makeApp()
    await request(app).post('/api/approvals/ap-1/respond').send({}).expect(400)
    await request(app).post('/api/approvals/ap-1/respond').send({ decision: 'maybe' }).expect(400)
  })

  it('404s when the approval is unknown', async () => {
    const { app } = makeApp({ getById: vi.fn(async () => null) })
    await request(app)
      .post('/api/approvals/ghost/respond')
      .send({ decision: 'approved' })
      .expect(404)
  })

  it('403s when the caller is not the assigned approver', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeApproval({ approverUserId: 'someone-else' })),
    })
    await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(403)
  })

  it('echoes the settled state idempotently when already responded', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeApproval({ status: 'approved' })),
    })
    const res = await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(200)
    expect(res.body.idempotent).toBe(true)
    expect(res.body.status).toBe('approved')
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('resolves a workflow_step approval in place via resumeFromApproval', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeApproval({ kind: 'workflow_step' })),
    })
    const res = await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(200)
    expect(res.body.kind).toBe('workflow_step')
    expect(res.body.status).toBe('completed')
    expect(mockResume).toHaveBeenCalledWith(
      expect.anything(),
      'ap-1',
      'approved',
      'u-1',
      undefined,
    )
  })

  it('422s a tool_invocation respond, pointing at the chat surface', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () =>
        makeApproval({ kind: 'tool_invocation', blockingSessionId: 'sess-9' }),
      ),
    })
    const res = await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(422)
    expect(res.body.kind).toBe('tool_invocation')
    expect(res.body.nativeSurface).toBe('chat')
    expect(res.body.blockingSessionId).toBe('sess-9')
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('422s a distribution_draft respond, pointing at the feed surface', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeApproval({ kind: 'distribution_draft' })),
    })
    const res = await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'rejected' })
      .expect(422)
    expect(res.body.nativeSurface).toBe('feed')
  })
})

describe('[COMP:api/unified-approvals-route] email_sender respond (agentmail.md D4)', () => {
  function makeEmailApp(over: { getById?: ReturnType<typeof vi.fn>; respond?: ReturnType<typeof vi.fn>; allowlistSender?: ReturnType<typeof vi.fn>; withDeps?: boolean } = {}) {
    const getById =
      over.getById ??
      vi.fn(async () =>
        makeApproval({
          kind: 'email_sender',
          toolName: 'emailSenderReview',
          approvalPayload: {
            kind: 'email_sender',
            inboxAddress: 'ada@agentmail.to',
            channelIntegrationId: 'integ-1',
            sender: 'stranger@example.com',
            senderName: 'Stranger',
            subject: 'Hello',
            preview: 'Hi there',
          },
        }),
      )
    const respond =
      over.respond ?? vi.fn(async (_id: string, decision: string) => makeApproval({ status: decision as never }))
    const allowlistSender = over.allowlistSender ?? vi.fn(async () => undefined)

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = 'u-1'
      next()
    })
    app.use(
      '/api/approvals',
      approvalsRoutes({
        approvalsStore: { listPendingForWorkspace: vi.fn(async () => []), getById, respond } as never,
        workspaceStore: { getRole: vi.fn(async () => 'member') } as never,
        bridgeDeps: {} as never,
        ...(over.withDeps === false ? {} : { emailSenderDeps: { allowlistSender } }),
      }),
    )
    return { app, respond, allowlistSender }
  }

  it('approve allowlists the sender on the inbox integration, then settles', async () => {
    const { app, respond, allowlistSender } = makeEmailApp()
    const res = await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(200)
    expect(res.body.kind).toBe('email_sender')
    expect(allowlistSender).toHaveBeenCalledWith('integ-1', 'stranger@example.com')
    expect(respond).toHaveBeenCalledWith('ap-1', 'approved', 'u-1', undefined)
  })

  it('reject dismisses without touching the allowlist (NOT a blocklist)', async () => {
    const { app, respond, allowlistSender } = makeEmailApp()
    await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'rejected' })
      .expect(200)
    expect(allowlistSender).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith('ap-1', 'rejected', 'u-1', undefined)
  })

  it('a failed allowlist write leaves the card pending and retryable (502)', async () => {
    const { app, respond } = makeEmailApp({
      allowlistSender: vi.fn(async () => {
        throw new Error('config write failed')
      }),
    })
    await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(502)
    expect(respond).not.toHaveBeenCalled()
  })

  it('falls back to the 422 deep-link when emailSenderDeps is not wired', async () => {
    const { app } = makeEmailApp({ withDeps: false })
    const res = await request(app)
      .post('/api/approvals/ap-1/respond')
      .send({ decision: 'approved' })
      .expect(422)
    expect(res.body.kind).toBe('email_sender')
    expect(res.body.nativeSurface).toBe('web')
  })
})
