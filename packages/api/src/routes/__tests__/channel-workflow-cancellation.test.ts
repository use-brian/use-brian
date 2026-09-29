import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool } from '@use-brian/core'
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn(async () => 'member') }))
vi.mock('../../context-scope/resolve-turn-scope.js', () => {
  const access = (input: { userId: string; workspaceId: string; assistant: { id: string } }) => ({
    userId: input.userId, workspaceId: input.workspaceId, assistantId: input.assistant.id,
    assistantKind: 'standard', clearance: 'internal', compartments: [], mutationCompartments: [],
    projectIds: [], visibilityAssistantIds: [input.assistant.id],
  })
  return {
    resolveTurnScopeSystem: async (input: Parameters<typeof access>[0]) => ({ access: access(input),
      effectiveCompartments: [], writeCompartments: [], effectiveProjectIds: [], writeProjectIds: [] }),
    resolveLiveAccessCeilingSystem: async (input: Parameters<typeof access>[0]) => access(input),
  }
})
vi.mock('../../workflow/mcp-bridge.js', () => ({ buildWorkflowToolRegistry: vi.fn() }))
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { buildWorkflowToolRegistry } from '../../workflow/mcp-bridge.js'
import { processChannelMessage, type ChannelPipelineParams } from '../channel-pipeline.js'
import { channelConfirmations } from '../channel-interactions.js'
import type { ChannelQuestion } from '../../workflow/channel-questions.js'

beforeEach(() => vi.clearAllMocks())

describe('pipeline workflow response cancellation', () => {
  it.each(['authorization', 'tool loading'] as const)('stop while awaiting %s prevents claim and execution', async stage => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async () => ({ data: 'done' }))
    const tool = buildTool({ name: 'answer_action', description: '', inputSchema: z.object({ answer: z.string() }),
      isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: false, execute })
    const tools = new Map([[tool.name, tool]])
    vi.mocked(buildWorkflowToolRegistry).mockImplementation(async () => {
      if (stage === 'tool loading') await paused
      return tools
    })
    vi.mocked(getWorkspaceRoleSystem).mockImplementation(async () => {
      if (stage === 'authorization') await paused
      return 'member'
    })
    const row: ChannelQuestion = { token: 'a'.repeat(24), integrationId: 'integration', workspaceId: 'workspace',
      assistantId: 'assistant', userId: 'actor', channelId: 'channel', messageId: 'prompt', available: true,
      question: { question: 'Where?' }, response: { toolName: tool.name, arguments: {}, answerField: 'answer' } }
    const store = { find: vi.fn(async () => [row]), isQuestionMessage: vi.fn(async () => true), consume: vi.fn(async () => true) }
    const scope = { channelType: 'slack', integrationId: 'channel-row', conversationId: 'channel', senderId: 'sender' }
    const abortController = new AbortController()
    const sendResponse = vi.fn(async () => {})
    const turn = processChannelMessage({
      interactionScope: scope, abortController, userId: 'actor', isIdentified: true,
      assistant: { id: 'assistant', workspaceId: 'workspace', ownerUserId: 'actor', name: 'Assistant',
        kind: 'standard', clearance: 'internal', compartments: [], systemPrompt: null },
      channelType: 'slack', channelId: 'channel', questionIntegrationId: 'integration',
      incomingMessage: { text: `wq:${row.token} prod`, userId: 'sender', channelId: 'channel', messageId: 'answer', raw: null },
      messageText: `wq:${row.token} prod`, questionStore: store, connectorStore: {}, mcpSettingsStore: {},
      hooks: { sendResponse },
    } as unknown as ChannelPipelineParams)
    try {
      await vi.waitFor(() => expect(stage === 'authorization' ? getWorkspaceRoleSystem : buildWorkflowToolRegistry).toHaveBeenCalledOnce())
      expect(channelConfirmations.handle(scope, { kind: 'text', text: '/stop' }).handled).toBe(true)
      expect(abortController.signal.aborted).toBe(true)
      expect(sendResponse).toHaveBeenCalledWith('Stopped.')
    } finally { release(); await turn }
    expect(store.consume).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    // The pre-lock Stop acknowledgement is the only reply; no late duplicate.
    expect(sendResponse).toHaveBeenCalledExactlyOnceWith('Stopped.')
    expect(channelConfirmations.handle(scope, { kind: 'text', text: '/stop' }).handled).toBe(false)
  })
})
