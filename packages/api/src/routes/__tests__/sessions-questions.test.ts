/**
 * Unit tests for the askQuestion suspend-resume routes.
 * Component tag: [COMP:api/pending-questions-resume].
 *
 * Covers:
 *   - GET  /api/sessions/:sessionId/pending — returns row or null
 *   - POST /api/sessions/:sessionId/answer/:approvalId — submit answer,
 *     records to DB, enqueues resume
 *   - POST /api/sessions/:sessionId/cancel/:approvalId — cancels, sets
 *     rejected, enqueues resume with 'rejected' decision
 *
 * Stubs the approvals store + the `enqueueToolInvocationResume` bridge.
 * Stubs `findSessionById` + `findAssistantById` for the GET /pending
 * workspace lookup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../workflow/approval.js', () => ({
  enqueueToolInvocationResume: vi.fn(async () => ({ kind: 'enqueued', jobId: 'job-1' })),
}))
vi.mock('../../db/sessions.js', () => ({
  findSessionById: vi.fn(),
}))
vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(),
}))

import { sessionQuestionRoutes } from '../sessions-questions.js'
import { enqueueToolInvocationResume } from '../../workflow/approval.js'
import { findSessionById } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import type { PendingApproval } from '../../db/pending-approvals-store.js'

const mockEnqueue = vi.mocked(enqueueToolInvocationResume)
const mockFindSession = vi.mocked(findSessionById)
const mockFindAssistant = vi.mocked(findAssistantById)

function makeQuestionRow(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'ap-q-1',
    workspaceId: 'ws-1',
    workflowRunId: null as unknown as string,
    workflowStepRunId: null as unknown as string,
    toolName: 'askQuestion',
    arguments: { question: 'Which MeshJS?' },
    approverUserId: 'u-1',
    deliveryChannelType: 'web',
    deliveryChannelId: null,
    status: 'pending',
    expiresAt: new Date('2026-05-28T00:00:00Z'),
    respondedAt: null,
    respondedBy: null,
    rejectReason: null,
    createdAt: new Date('2026-05-27T00:00:00Z'),
    kind: 'question',
    blockingSessionId: 'sess-1',
    approvalPayload: { question: 'Which MeshJS?', toolUseId: 'call_42' },
    originatingAssistantId: 'asst-1',
    answerText: null,
    ...over,
  }
}

type StoreStubs = {
  getById: ReturnType<typeof vi.fn>
  recordAnswer: ReturnType<typeof vi.fn>
  respond: ReturnType<typeof vi.fn>
  listPendingForWorkspace: ReturnType<typeof vi.fn>
  loadForSession: ReturnType<typeof vi.fn>
}

function makeApp(stubs: Partial<StoreStubs> = {}) {
  const getById = stubs.getById ?? vi.fn(async () => null)
  const recordAnswer = stubs.recordAnswer ?? vi.fn(async () => null)
  const respond = stubs.respond ?? vi.fn(async () => null)
  const listPendingForWorkspace = stubs.listPendingForWorkspace ?? vi.fn(async () => [])
  const loadForSession = stubs.loadForSession ?? vi.fn(async () => [])

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'u-1'
    next()
  })
  app.use(
    '/api/sessions',
    sessionQuestionRoutes({
      approvalsStore: { getById, recordAnswer, respond, listPendingForWorkspace } as never,
      resumeDeps: {} as never,
      workerRunsStore: {
        loadForSession,
        recordSpawn: vi.fn(),
        recordTurn: vi.fn(),
        recordCompletion: vi.fn(),
      } as never,
    }),
  )
  return { app, getById, recordAnswer, respond, listPendingForWorkspace, loadForSession }
}

beforeEach(() => {
  mockEnqueue.mockClear()
  mockEnqueue.mockResolvedValue({ kind: 'enqueued', jobId: 'job-1' })
  mockFindSession.mockReset()
  mockFindAssistant.mockReset()
})

// ── GET /:sessionId/pending ──────────────────────────────────────

describe('[COMP:api/pending-questions-resume] GET /:sessionId/pending', () => {
  it('returns the pending row when one exists for this session', async () => {
    const row = makeQuestionRow()
    mockFindSession.mockResolvedValue({
      id: 'sess-1',
      assistantId: 'asst-1',
      userId: 'u-1',
    } as never)
    mockFindAssistant.mockResolvedValue({ workspaceId: 'ws-1' } as never)
    const { app } = makeApp({
      listPendingForWorkspace: vi.fn(async () => [row]),
    })
    const res = await request(app).get('/api/sessions/sess-1/pending').expect(200)
    expect(res.body.pending).toMatchObject({
      approvalId: 'ap-q-1',
      question: 'Which MeshJS?',
    })
  })

  it('returns null when no question is pending', async () => {
    mockFindSession.mockResolvedValue({
      id: 'sess-1', assistantId: 'asst-1', userId: 'u-1',
    } as never)
    mockFindAssistant.mockResolvedValue({ workspaceId: 'ws-1' } as never)
    const { app } = makeApp({ listPendingForWorkspace: vi.fn(async () => []) })
    const res = await request(app).get('/api/sessions/sess-1/pending').expect(200)
    expect(res.body.pending).toBeNull()
  })

  it('404s when session is not found or owned by another user', async () => {
    mockFindSession.mockResolvedValue(null as never)
    const { app } = makeApp()
    await request(app).get('/api/sessions/sess-x/pending').expect(404)
  })
})

// ── POST /:sessionId/answer/:approvalId ───────────────────────────

describe('[COMP:api/pending-questions-resume] POST /answer', () => {
  it('writes the answer and enqueues resume on the happy path', async () => {
    const row = makeQuestionRow()
    const updated = makeQuestionRow({ status: 'approved', answerText: 'the Cardano SDK' })
    const { app, recordAnswer } = makeApp({
      getById: vi.fn(async () => row),
      recordAnswer: vi.fn(async () => updated),
    })

    const res = await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'the Cardano SDK' })
      .expect(200)

    expect(recordAnswer).toHaveBeenCalledWith('ap-q-1', 'the Cardano SDK', 'u-1')
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue.mock.calls[0]?.[1].decision).toBe('approved')
    expect(res.body.status).toBe('approved')
    expect(res.body.resume).toMatchObject({ kind: 'enqueued' })
  })

  it('400s on missing/empty answer', async () => {
    const { app } = makeApp({ getById: vi.fn(async () => makeQuestionRow()) })
    await request(app).post('/api/sessions/sess-1/answer/ap-q-1').send({}).expect(400)
    await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: '   ' })
      .expect(400)
  })

  it('400s on overly long answer', async () => {
    const { app } = makeApp({ getById: vi.fn(async () => makeQuestionRow()) })
    await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'x'.repeat(8001) })
      .expect(400)
  })

  it('404s when the approval is not found', async () => {
    const { app } = makeApp({ getById: vi.fn(async () => null) })
    await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'hi' })
      .expect(404)
  })

  it('400s when the approval kind is not question', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeQuestionRow({ kind: 'tool_invocation' })),
    })
    await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'hi' })
      .expect(400)
  })

  it('403s when the approval belongs to a different user', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeQuestionRow({ approverUserId: 'someone-else' })),
    })
    await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'hi' })
      .expect(403)
  })

  it('400s when the approval is for a different session', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeQuestionRow({ blockingSessionId: 'other-session' })),
    })
    await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'hi' })
      .expect(400)
  })

  it('409s when the row is already resolved (idempotent)', async () => {
    const { app } = makeApp({
      getById: vi.fn(async () => makeQuestionRow({ status: 'approved' })),
    })
    const res = await request(app)
      .post('/api/sessions/sess-1/answer/ap-q-1')
      .send({ answer: 'hi' })
      .expect(409)
    expect(res.body.idempotent).toBe(true)
  })
})

// ── POST /:sessionId/cancel/:approvalId ───────────────────────────

describe('[COMP:api/pending-questions-resume] POST /cancel', () => {
  it('flips status to rejected and enqueues resume with cancellation', async () => {
    const row = makeQuestionRow()
    const rejected = makeQuestionRow({ status: 'rejected', rejectReason: 'cancelled' })
    const { app, respond } = makeApp({
      getById: vi.fn(async () => row),
      respond: vi.fn(async () => rejected),
    })

    const res = await request(app)
      .post('/api/sessions/sess-1/cancel/ap-q-1')
      .send({})
      .expect(200)

    expect(respond).toHaveBeenCalledWith('ap-q-1', 'rejected', 'u-1', 'cancelled')
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue.mock.calls[0]?.[1].decision).toBe('rejected')
    expect(res.body.status).toBe('rejected')
  })

  it('404s when approval not found', async () => {
    const { app } = makeApp({ getById: vi.fn(async () => null) })
    await request(app).post('/api/sessions/sess-1/cancel/ap-q-1').send({}).expect(404)
  })
})

// ── GET /:sessionId/worker-runs ──────────────────────────────────

describe('[COMP:api/pending-questions-resume] GET /:sessionId/worker-runs', () => {
  it('returns a status histogram + active worker descriptions', async () => {
    mockFindSession.mockResolvedValue({
      id: 'sess-1', assistantId: 'asst-1', userId: 'u-1',
    } as never)
    const { app, loadForSession } = makeApp({
      loadForSession: vi.fn(async () => [
        { workerId: 'worker_1', status: 'running', description: 'check pricing',
          prompt: '', researchMode: true, model: 'gemini-pro', turnCount: 1,
          result: null, history: [] },
        { workerId: 'worker_2', status: 'running', description: 'check creators',
          prompt: '', researchMode: true, model: 'gemini-pro', turnCount: 0,
          result: null, history: [] },
        { workerId: 'worker_3', status: 'completed', description: 'find URLs',
          prompt: '', researchMode: true, model: 'gemini-pro', turnCount: 2,
          result: 'done', history: [] },
        { workerId: 'worker_4', status: 'failed', description: 'broke',
          prompt: '', researchMode: true, model: 'gemini-pro', turnCount: 0,
          result: 'err', history: [] },
      ]),
    })
    const res = await request(app).get('/api/sessions/sess-1/worker-runs').expect(200)
    expect(loadForSession).toHaveBeenCalledWith('sess-1')
    expect(res.body.summary).toMatchObject({
      total: 4, running: 2, completed: 1, failed: 1, stopped: 0,
    })
    expect(res.body.summary.active).toHaveLength(2)
    expect(res.body.summary.active.map((w: { workerId: string }) => w.workerId).sort())
      .toEqual(['worker_1', 'worker_2'])
  })

  it('returns an empty summary when no workers have been recorded', async () => {
    mockFindSession.mockResolvedValue({
      id: 'sess-1', assistantId: 'asst-1', userId: 'u-1',
    } as never)
    const { app } = makeApp({ loadForSession: vi.fn(async () => []) })
    const res = await request(app).get('/api/sessions/sess-1/worker-runs').expect(200)
    expect(res.body.summary).toMatchObject({
      total: 0, running: 0, completed: 0, failed: 0, stopped: 0,
    })
    expect(res.body.summary.active).toEqual([])
  })

  it('404s when session is not found or owned by another user', async () => {
    mockFindSession.mockResolvedValue(null as never)
    const { app } = makeApp()
    await request(app).get('/api/sessions/sess-x/worker-runs').expect(404)
  })
})
