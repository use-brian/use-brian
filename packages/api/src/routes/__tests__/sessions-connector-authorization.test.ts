/**
 * [COMP:api/connector-authorization-resume]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// The session read gate now loads workspace authority for private sessions too.
vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [{ workspaceId: 'ws-1' }] })),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithReadScopeSystem: vi.fn(async () => ({
    clearance: 'internal', compartments: null, projectIds: null,
  })),
}))
vi.mock('../../workflow/approval.js', () => ({
  enqueueToolInvocationResume: vi.fn(async () => ({ kind: 'enqueued', jobId: 'job-1' })),
}))
vi.mock('../../db/sessions.js', () => ({
  findSessionById: vi.fn(),
  findSessionTurnLeaseState: vi.fn(async () => null),
}))
vi.mock('../../db/users.js', () => ({
  getUserAssistant: vi.fn(async () => ({ id: 'assistant-test' })), findAssistantById: vi.fn() }))

import { CONFIGURE_CAPABILITY } from '@use-brian/core'
import { sessionQuestionRoutes } from '../sessions-questions.js'
import { enqueueToolInvocationResume } from '../../workflow/approval.js'
import { findSessionById } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import type { PendingApproval } from '../../db/pending-approvals-store.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const APPROVAL = '22222222-2222-4222-8222-222222222222'
const ASSISTANT = '33333333-3333-4333-8333-333333333333'
const WORKSPACE = '44444444-4444-4444-8444-444444444444'
const INSTANCE = '55555555-5555-4555-8555-555555555555'

function row(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: APPROVAL,
    workspaceId: WORKSPACE,
    workflowRunId: null as never,
    workflowStepRunId: null as never,
    toolName: 'askQuestion',
    arguments: { question: 'Connect Google Calendar' },
    approverUserId: 'user-1',
    deliveryChannelType: 'web',
    deliveryChannelId: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    respondedAt: null,
    respondedBy: null,
    rejectReason: null,
    createdAt: new Date(),
    kind: 'question',
    blockingSessionId: SESSION,
    approvalPayload: {
      question: 'Connect Google Calendar',
      toolUseId: 'call-1',
      actionId: 'connector_authorization:gcal',
    },
    originatingAssistantId: ASSISTANT,
    answerText: null,
    ...overrides,
  }
}

function makeApp(input: {
  approval?: PendingApproval
  instance?: Record<string, unknown> | null
  capabilities?: string[]
} = {}) {
  const approval = input.approval ?? row()
  const getById = vi.fn(async () => approval)
  const recordAnswer = vi.fn(async (_id, answer: string) => {
    approval.status = 'approved'
    approval.answerText = answer
    return approval
  })
  const listPendingForWorkspace = vi.fn(async () => [approval])
  const connectorGet = vi.fn(async () => input.instance === undefined ? ({
    id: INSTANCE,
    scope: 'user',
    userId: 'user-1',
    workspaceId: null,
    provider: 'gcal',
    connected: true,
  }) : input.instance)
  const grantCreate = vi.fn(async () => ({ id: 'grant-1' }))
  const listActive = vi.fn(async () => input.capabilities ?? [CONFIGURE_CAPABILITY])
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'user-1'
    next()
  })
  app.use('/api/sessions', sessionQuestionRoutes({
    approvalsStore: {
      getById,
      getByIdSystem: vi.fn(async () => approval),
      recordAnswer,
      listPendingForWorkspace,
    } as never,
    resumeDeps: {} as never,
    capabilityStore: { listActive } as never,
    connectorInstanceStore: { get: connectorGet } as never,
    connectorGrantStore: { create: grantCreate } as never,
  }))
  return { app, recordAnswer, connectorGet, grantCreate, listActive }
}

beforeEach(() => {
  vi.mocked(findSessionById).mockReset().mockResolvedValue({
    id: SESSION,
    assistantId: ASSISTANT,
    userId: 'user-1',
  } as never)
  vi.mocked(findAssistantById).mockReset().mockResolvedValue({
    id: ASSISTANT,
    workspaceId: WORKSPACE,
  } as never)
  vi.mocked(enqueueToolInvocationResume).mockClear()
})

describe('[COMP:api/connector-authorization-resume] connector action', () => {
  it('exposes a structured Connect action only while configure remains granted', async () => {
    const fixture = makeApp()
    const response = await request(fixture.app).get(`/api/sessions/${SESSION}/pending`).expect(200)
    expect(response.body.pending.action).toMatchObject({
      kind: 'connector_authorization',
      provider: 'gcal',
      label: 'Google Calendar',
    })
    expect(response.body.pending.action.connectPath).toContain(`setupSession=${SESSION}`)
    expect(response.body.pending.action.connectPath).toContain(`setupApproval=${APPROVAL}`)
  })

  it('does not expose a fabricated or no-longer-authorized connector action', async () => {
    const revoked = makeApp({ capabilities: [] })
    const revokedResponse = await request(revoked.app)
      .get(`/api/sessions/${SESSION}/pending`)
      .expect(200)
    expect(revokedResponse.body.pending.action).toBeNull()

    const fabricated = makeApp({
      approval: row({
        approvalPayload: {
          question: 'Connect it',
          toolUseId: 'call-1',
          actionId: 'connector_authorization:not-a-provider',
        },
      }),
    })
    const fabricatedResponse = await request(fabricated.app)
      .get(`/api/sessions/${SESSION}/pending`)
      .expect(200)
    expect(fabricatedResponse.body.pending.action).toBeNull()
  })

  it('verifies, grants, settles, and enqueues exactly one resume', async () => {
    const fixture = makeApp()
    const response = await request(fixture.app)
      .post(`/api/sessions/${SESSION}/connector-authorization/${APPROVAL}/complete`)
      .send({ provider: 'gcal', connectorInstanceId: INSTANCE })
      .expect(200)

    expect(response.body).toMatchObject({ status: 'approved', idempotent: false })
    expect(fixture.connectorGet).toHaveBeenCalledWith('user-1', INSTANCE)
    expect(fixture.grantCreate).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      connectorInstanceId: INSTANCE,
      targetType: 'workspace',
      targetId: WORKSPACE,
    })
    expect(fixture.recordAnswer).toHaveBeenCalledWith(
      APPROVAL,
      'Google Calendar connected and verified for this workspace. Continue the original task.',
      'user-1',
    )
    expect(enqueueToolInvocationResume).toHaveBeenCalledTimes(1)

    const replay = await request(fixture.app)
      .post(`/api/sessions/${SESSION}/connector-authorization/${APPROVAL}/complete`)
      .send({ provider: 'gcal', connectorInstanceId: INSTANCE })
      .expect(200)
    expect(replay.body).toMatchObject({ status: 'approved', idempotent: true })
    expect(fixture.grantCreate).toHaveBeenCalledTimes(1)
    expect(enqueueToolInvocationResume).toHaveBeenCalledTimes(1)
  })

  it('treats an already-approved callback replay as idempotent', async () => {
    const fixture = makeApp({ approval: row({ status: 'approved' }) })
    const response = await request(fixture.app)
      .post(`/api/sessions/${SESSION}/connector-authorization/${APPROVAL}/complete`)
      .send({ provider: 'gcal', connectorInstanceId: INSTANCE })
      .expect(200)
    expect(response.body).toMatchObject({ status: 'approved', idempotent: true })
    expect(fixture.connectorGet).not.toHaveBeenCalled()
    expect(enqueueToolInvocationResume).not.toHaveBeenCalled()
  })

  it('rejects a provider or instance that does not match the frozen action', async () => {
    const fixture = makeApp()
    await request(fixture.app)
      .post(`/api/sessions/${SESSION}/connector-authorization/${APPROVAL}/complete`)
      .send({ provider: 'notion', connectorInstanceId: INSTANCE })
      .expect(400)
    expect(fixture.recordAnswer).not.toHaveBeenCalled()
  })

  it('rejects a disconnected instance or one outside the verified workspace', async () => {
    const disconnected = makeApp({
      instance: {
        id: INSTANCE,
        scope: 'user',
        userId: 'user-1',
        workspaceId: null,
        provider: 'gcal',
        connected: false,
      },
    })
    await request(disconnected.app)
      .post(`/api/sessions/${SESSION}/connector-authorization/${APPROVAL}/complete`)
      .send({ provider: 'gcal', connectorInstanceId: INSTANCE })
      .expect(409)

    const foreignWorkspace = makeApp({
      instance: {
        id: INSTANCE,
        scope: 'workspace',
        userId: null,
        workspaceId: '66666666-6666-4666-8666-666666666666',
        provider: 'gcal',
        connected: true,
      },
    })
    await request(foreignWorkspace.app)
      .post(`/api/sessions/${SESSION}/connector-authorization/${APPROVAL}/complete`)
      .send({ provider: 'gcal', connectorInstanceId: INSTANCE })
      .expect(403)
    expect(foreignWorkspace.recordAnswer).not.toHaveBeenCalled()
    expect(enqueueToolInvocationResume).not.toHaveBeenCalled()
  })
})
