import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  findSessionById: vi.fn(),
  getSessionMessages: vi.fn(),
  addSessionMessage: vi.fn(),
  toStampedMessages: vi.fn((messages: unknown[]) => messages),
  findAssistantById: vi.fn(),
  resolveLiveAccessCeilingSystem: vi.fn(),
  resolveTurnScopeSystem: vi.fn(),
  queryLoop: vi.fn(),
  authorizeAudience: vi.fn(async (input: { scopeEvidence?: object }) => ({ allowed: true, evidence: input.scopeEvidence ?? {} })),
}))

// The audience gate reads live sessions and membership; here it is a seam.
vi.mock('../delivery-authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery-authority.js')>()),
  createDeliveryAudienceAuthorizer: () => mocks.authorizeAudience,
}))

vi.mock('../../db/sessions.js', () => ({
  findSessionById: mocks.findSessionById,
  getSessionMessages: mocks.getSessionMessages,
  addSessionMessage: mocks.addSessionMessage,
  toStampedMessages: mocks.toStampedMessages,
  // Turn-kernel lease (the replay holds one like every runner).
  isTurnLeaseLive: async () => false,
  reclaimStaleTurn: async () => false,
  takeTurnSlot: async () => undefined,
  claimTurnSlot: async () => true,
  startTurnLease: async () => 'lease-token',
  touchTurnLease: async () => ({ held: true, cancelRequested: false }),
  releaseTurnLease: async () => true,
  TURN_HEARTBEAT_INTERVAL_MS: 20_000,
}))

vi.mock('../../db/users.js', () => ({
  findAssistantById: mocks.findAssistantById,
}))

vi.mock('../resolve-turn-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resolve-turn-scope.js')>()),
  formatActiveWorkspaceContext: vi.fn(() => ''),
  resolveLiveAccessCeilingSystem: mocks.resolveLiveAccessCeilingSystem,
  resolveTurnScopeSystem: mocks.resolveTurnScopeSystem,
}))

vi.mock('../../ledger/recorder.js', () => ({
  createTurnLedger: vi.fn(() => ({ ledger: {} })),
}))

vi.mock('../../ledger/runtime.js', () => ({
  getLedgerPayloadStore: vi.fn(() => ({})),
}))

vi.mock('@use-brian/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/core')>()),
  queryLoop: mocks.queryLoop,
}))

import {
  buildTool,
  type AccessCeiling,
  type Tool,
} from '@use-brian/core'
import { currentAgentAccess } from '../../db/agent-access-context.js'
import { AuthorityChangedError } from '../authority-lease.js'
import { createSessionResumeReplay } from '../../routes/session-resume-replay.js'
import type { ResumeReplayParams } from '../../routes/chat.js'

const SESSION = {
  id: 'session-1',
  userId: 'user-1',
  assistantId: 'assistant-1',
  channelType: 'web',
  channelId: 'web-1',
  contextGroupId: null,
  contextProjectId: null,
  contextLockedAt: null,
}

const ASSISTANT = {
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  kind: 'standard',
  clearance: 'confidential',
  systemPrompt: null,
}

function ceiling(overrides: Partial<AccessCeiling> = {}): AccessCeiling {
  return {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    clearance: 'confidential',
    compartments: ['product'],
    mutationCompartments: ['product'],
    projectIds: ['project-1'],
    visibilityAssistantIds: ['assistant-1'],
    ...overrides,
  }
}

function turnScope(access: AccessCeiling) {
  return {
    access: {
      ...access,
      assistantId: 'assistant-1',
      assistantKind: 'standard',
    },
    effectiveCompartments: access.compartments,
    effectiveProjectIds: access.projectIds,
    writeCompartments: access.mutationCompartments,
    writeProjectIds: access.projectIds,
    activeGroupId: null,
    activeProjectId: null,
    activeTeam: null,
    activeProject: null,
  }
}

function params(overrides: Partial<ResumeReplayParams> = {}): ResumeReplayParams {
  return {
    sessionId: 'session-1',
    approvalId: 'approval-1',
    suspendedToolName: 'sendThing',
    suspendedToolInput: { value: 'hello' },
    loopStepIndex: 2,
    startingAccessCeiling: ceiling(),
    approvalStatus: 'approved',
    rejectReason: null,
    answerText: null,
    approvalKind: 'tool_invocation',
    ...overrides,
  }
}

function replay(tools: Tool[] = []) {
  return createSessionResumeReplay({
    provider: {} as never,
    resolveWorkspaceCustomLlm: null,
    resolveWorkspaceByoGeminiKey: null,
    buildWorkspaceProvider: null,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    systemPrompt: 'system',
  })
}

function completedTurn() {
  mocks.queryLoop.mockImplementation(async function* () {
    yield {
      type: 'turn_complete',
      response: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        model: 'gemini-flash',
      },
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findSessionById.mockResolvedValue(SESSION)
  mocks.findAssistantById.mockResolvedValue(ASSISTANT)
  mocks.getSessionMessages.mockResolvedValue([])
  mocks.addSessionMessage.mockResolvedValue(undefined)
  const current = ceiling()
  mocks.resolveLiveAccessCeilingSystem.mockResolvedValue(current)
  mocks.resolveTurnScopeSystem.mockResolvedValue(turnScope(current))
  completedTurn()
})

describe('[COMP:api/scope-delivery-replay] persisted replay authority', () => {
  it('refuses a legacy checkpoint before loading session state or generating output', async () => {
    await expect(replay()(params({ startingAccessCeiling: undefined }))).rejects.toMatchObject({
      code: 'session_resume_authority_unavailable',
    })
    expect(mocks.findSessionById).not.toHaveBeenCalled()
    expect(mocks.queryLoop).not.toHaveBeenCalled()
    expect(mocks.addSessionMessage).not.toHaveBeenCalled()
  })

  it('refuses a saved principal that does not own the suspended session', async () => {
    mocks.findSessionById.mockResolvedValue({ ...SESSION, userId: 'other-user' })
    await expect(replay()(params())).rejects.toMatchObject({
      code: 'session_resume_authority_unavailable',
    })
    expect(mocks.resolveLiveAccessCeilingSystem).not.toHaveBeenCalled()
    expect(mocks.queryLoop).not.toHaveBeenCalled()
  })

  it('keeps an expanded current grant pinned to the starting ceiling', async () => {
    const expanded = ceiling({
      compartments: null,
      mutationCompartments: null,
      projectIds: null,
      visibilityAssistantIds: null,
    })
    mocks.resolveLiveAccessCeilingSystem.mockResolvedValue(expanded)
    mocks.resolveTurnScopeSystem.mockResolvedValue(turnScope(expanded))
    let executionAccess: ReturnType<typeof currentAgentAccess>
    const tool = buildTool({
      name: 'sendThing',
      description: 'fixed test operation',
      inputSchema: z.object({ value: z.string() }),
      isReadOnly: false,
      isConcurrencySafe: false,
      async execute() {
        executionAccess = currentAgentAccess()
        return { data: 'sent' }
      },
    })

    await expect(replay([tool])(params())).resolves.toBe('completed')
    expect(executionAccess).toMatchObject({
      compartments: ['product'],
      mutationCompartments: ['product'],
      projectIds: ['project-1'],
      visibilityAssistantIds: ['assistant-1'],
    })
    expect(mocks.queryLoop.mock.calls[0]?.[0].context).toMatchObject({
      compartments: ['product'],
      mutationCompartments: ['product'],
      projectIds: ['project-1'],
    })
  })

  it('refuses a contraction before tool, history, model or persistence work', async () => {
    const contracted = ceiling({ compartments: [], mutationCompartments: [] })
    mocks.resolveLiveAccessCeilingSystem.mockResolvedValue(contracted)
    mocks.resolveTurnScopeSystem.mockResolvedValue(turnScope(contracted))
    const execute = vi.fn(async () => ({ data: 'sent' }))
    const tool = buildTool({
      name: 'sendThing',
      description: 'fixed test operation',
      inputSchema: z.object({ value: z.string() }),
      isReadOnly: false,
      isConcurrencySafe: false,
      execute,
    })

    await expect(replay([tool])(params())).rejects.toMatchObject({
      code: 'session_resume_authority_unavailable',
    })
    expect(execute).not.toHaveBeenCalled()
    expect(mocks.getSessionMessages).not.toHaveBeenCalled()
    expect(mocks.queryLoop).not.toHaveBeenCalled()
    expect(mocks.addSessionMessage).not.toHaveBeenCalled()
  })

  it('withholds a possibly executed tool result after mid-operation revocation', async () => {
    let current = ceiling()
    mocks.resolveLiveAccessCeilingSystem.mockImplementation(async () => current)
    const tool = buildTool({
      name: 'sendThing',
      description: 'fixed test operation',
      inputSchema: z.object({ value: z.string() }),
      isReadOnly: false,
      isConcurrencySafe: false,
      async execute() {
        current = ceiling({ compartments: [], mutationCompartments: [] })
        return { data: 'provider accepted the request' }
      },
    })

    const error = await replay([tool])(params()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthorityChangedError)
    expect(error).toMatchObject({ operationMayHaveExecuted: true, retrySafe: false })
    expect(mocks.getSessionMessages).not.toHaveBeenCalled()
    expect(mocks.queryLoop).not.toHaveBeenCalled()
    expect(mocks.addSessionMessage).not.toHaveBeenCalled()
  })

  it('saves no continuation output its session audience cannot receive', async () => {
    mocks.authorizeAudience.mockImplementationOnce(async () => ({
      allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'user_visibility',
    }) as never)
    mocks.queryLoop.mockImplementation(async function* () {
      yield {
        type: 'turn_complete',
        response: { role: 'assistant', content: [{ type: 'text', text: 'personal result' }], model: 'gemini-flash' },
      }
    })
    const error = await replay()(params({
      suspendedToolName: 'askQuestion',
      suspendedToolInput: { question: 'Which one?' },
      approvalKind: 'question',
      answerText: 'the first',
    })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'user_visibility' })
    expect(mocks.addSessionMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant' }))
  })

  it('withholds a completed model event when authority changes before persistence', async () => {
    let current = ceiling()
    mocks.resolveLiveAccessCeilingSystem.mockImplementation(async () => current)
    mocks.queryLoop.mockImplementation(async function* () {
      current = ceiling({ compartments: [], mutationCompartments: [] })
      yield {
        type: 'turn_complete',
        response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'restricted result' }],
          model: 'gemini-flash',
        },
      }
    })

    const error = await replay()(params({
      suspendedToolName: 'askQuestion',
      suspendedToolInput: { question: 'Which one?' },
      approvalKind: 'question',
      answerText: 'the first',
    })).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthorityChangedError)
    expect(error).toMatchObject({ operationMayHaveExecuted: false })
    expect(mocks.addSessionMessage).toHaveBeenCalledTimes(1)
    expect(mocks.addSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'system' }))
    expect(mocks.addSessionMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant' }))
  })
})
