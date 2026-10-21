import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  current: vi.fn(),
  audience: vi.fn(),
  budget: vi.fn(),
}))

vi.mock('../../db/sessions.js', async original => ({
  ...(await original<typeof import('../../db/sessions.js')>()),
  findOrCreateSession: vi.fn(async () => ({ id: 'session', visibility: 'personal', channelType: 'feishu' })),
  getSessionMessages: mocks.history,
}))
vi.mock('../../db/workspace-store.js', async original => ({
  ...(await original<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceRoleSystem: vi.fn(async () => 'member'),
  getWorkspacePlan: vi.fn(async () => 'pro'),
}))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('../../channel-room/room.js', async original => ({
  ...(await original<typeof import('../../channel-room/room.js')>()),
  resolveRoomBinding: vi.fn(async () => null),
}))
vi.mock('../../context-scope/execution-context.js', async original => ({
  ...(await original<typeof import('../../context-scope/execution-context.js')>()),
  resolveExecutionContextSystem: vi.fn(async (input: { workspaceId?: string | null }) => ({
    turnScope: {
      access: { userId: 'user', workspaceId: input.workspaceId, clearance: 'internal', compartments: [], projectIds: [] },
      effectiveCompartments: [], writeCompartments: [], effectiveProjectIds: [], writeProjectIds: [],
    },
    executionContext: {
      security: { authority: { assertCurrent: mocks.current } },
      ownership: input.workspaceId ? { kind: 'workspace', workspaceId: input.workspaceId } : { kind: 'personal', ownerUserId: 'owner' },
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'user' } },
    },
  })),
}))
vi.mock('../../context-scope/delivery-authority.js', async original => ({
  ...(await original<typeof import('../../context-scope/delivery-authority.js')>()),
  createDeliveryAudienceAuthorizer: () => mocks.audience,
}))
vi.mock('../route-helpers.js', async original => ({
  ...(await original<typeof import('../route-helpers.js')>()), checkUsageBudget: mocks.budget,
}))

import { processChannelMessage, type ChannelPipelineParams } from '../channel-pipeline.js'
import { channelConfirmations } from '../channel-interactions.js'

const scope = { channelType: 'feishu', integrationId: 'integration', conversationId: 'conversation', senderId: 'sender' }

function turn() {
  const hooks = {
    onProcessingStart: vi.fn(async () => {}),
    onCleanup: vi.fn(async () => {}),
    sendResponse: vi.fn(async () => {}),
    sendError: vi.fn(async () => {}),
  }
  const params = {
    admittedAnswerContext: { kind: 'continue' },
    interactionScope: scope,
    abortController: new AbortController(),
    assistant: { id: 'assistant', workspaceId: null, clearance: 'internal' },
    userId: 'user', ownerId: 'owner', isIdentified: true,
    channelType: 'feishu', channelId: 'conversation', isGroupChat: false,
    messageText: 'What is in progress?', userContentBlocks: [{ type: 'text', text: 'What is in progress?' }],
    hooks,
  } as unknown as ChannelPipelineParams
  return { params, hooks }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.current.mockResolvedValue(undefined)
  mocks.audience.mockResolvedValue({ allowed: true, evidence: { sensitivity: 'public', compartments: [], projectIds: [] } })
  mocks.budget.mockResolvedValue({ status: 'ok' })
})

describe('[COMP:api/channel-pipeline-audience-refusal] processing feedback lifetime', () => {
  it('shows progress while setup is pending and cleans it once when setup fails', async () => {
    const failure = new Error('Synthetic history failure')
    let rejectHistory!: (error: Error) => void
    mocks.history.mockImplementation(() => new Promise((_resolve, reject) => { rejectHistory = reject }))
    const { params, hooks } = turn()
    const running = processChannelMessage(params)
    const outcome = running.then(() => null, error => error)
    await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce())
    expect(hooks.onProcessingStart).toHaveBeenCalledOnce()
    expect(mocks.audience).toHaveBeenCalledOnce()
    expect(hooks.onCleanup).not.toHaveBeenCalled()
    rejectHistory(failure)
    expect(await outcome).toBe(failure)
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(channelConfirmations.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(false)
  })

  it('cleans a partially failed start and unregisters even when cleanup fails', async () => {
    const { params, hooks } = turn()
    hooks.onProcessingStart.mockRejectedValue(new Error('Synthetic progress failure'))
    hooks.onCleanup.mockRejectedValue(new Error('Synthetic cleanup failure'))
    await expect(processChannelMessage(params)).rejects.toThrow('Synthetic cleanup failure')
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(channelConfirmations.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(false)
  })

  it('does not start progress for a blocked budget', async () => {
    mocks.budget.mockResolvedValue({ status: 'blocked' })
    const { params, hooks } = turn()
    params.assistant.workspaceId = 'workspace'
    params.usageStore = {} as ChannelPipelineParams['usageStore']
    await processChannelMessage(params)
    expect(hooks.sendError).toHaveBeenCalledOnce()
    expect(hooks.onProcessingStart).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
  })

  it('does not start progress when Stop arrives during audience admission', async () => {
    const { params, hooks } = turn()
    mocks.audience.mockImplementation(async () => {
      params.abortController.abort()
      return { allowed: true, evidence: { sensitivity: 'public', compartments: [], projectIds: [] } }
    })
    await processChannelMessage(params)
    expect(hooks.onProcessingStart).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
  })

  it('cleans up without starting setup when Stop arrives during progress delivery', async () => {
    const { params, hooks } = turn()
    hooks.onProcessingStart.mockImplementation(async () => { params.abortController.abort() })
    await processChannelMessage(params)
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(mocks.history).not.toHaveBeenCalled()
  })
})
