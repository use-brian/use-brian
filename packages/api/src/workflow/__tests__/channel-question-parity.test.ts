import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool } from '@use-brian/core'
const { send, execute } = vi.hoisted(() => ({ send: vi.fn(async () => 'posted'), execute: vi.fn(async () => ({ data: 'done' })) }))
vi.mock('@use-brian/channels', async (original) => ({ ...(await original<typeof import('@use-brian/channels')>()),
  createTelegramAdapter: vi.fn(() => ({ sendMessage: send })), createSlackAdapter: vi.fn(() => ({ sendMessage: send })),
  createFeishuAdapter: vi.fn(() => ({ sendMessage: send })), createMsTeamsAdapter: vi.fn(() => ({ sendMessage: send })),
  createCustomAdapter: vi.fn(() => ({ sendMessage: send })), createWhatsAppAdapter: vi.fn(() => ({ sendMessage: send })),
}))
vi.mock('../../db/sessions.js', () => ({ findOrCreateSession: vi.fn(async () => ({ id: 'session' })), addSessionMessage: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn(async () => 'member') }))
vi.mock('../../feishu/client.js', () => ({ createFeishuApi: vi.fn(() => ({})) }))
vi.mock('../../context-scope/resolve-turn-scope.js', () => ({ resolveTurnScopeSystem: vi.fn(async () => ({ access: { clearance: 'internal' }, effectiveCompartments: [], effectiveProjectIds: [], writeCompartments: [], writeProjectIds: [] })) }))
vi.mock('../mcp-bridge.js', () => ({ buildWorkflowToolRegistry: vi.fn() }))
import { buildWorkflowToolRegistry } from '../mcp-bridge.js'
import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import { maybeHandleChannelWorkflowContext, type ChannelWorkflowContextParams } from '../../routes/channel-workflow-context.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { ChannelQuestion, ChannelQuestionStore } from '../channel-questions.js'
function fixture(channelType: 'telegram' | 'slack' | 'feishu' | 'msteams' | 'custom' | 'whatsapp') {
  let row: ChannelQuestion | undefined
  const token = 'a'.repeat(24)
  const store: ChannelQuestionStore = {
    create: vi.fn(async (input) => { row = { ...input, token, messageId: null, available: true }; return token }),
    attach: vi.fn(async (_token, messageId) => { row!.messageId = messageId }),
    find: vi.fn(async (address, selector) => {
      if (!row?.messageId || !Object.entries(address).every(([key, value]) => row![key as keyof ChannelQuestion] === value)) return []
      if (selector.token) return selector.token === row.token ? [row] : []
      if (selector.messageId) return [row.messageId, row.threadRef].includes(selector.messageId) ? [row] : []
      return row.available ? [row] : []
    }),
    isQuestionMessage: vi.fn(async (_integration, _channel, messageId) => !!row && [row.messageId, row.threadRef].includes(messageId)),
    consume: vi.fn(async () => { if (!row?.available) return false; row.available = false; return true }),
  }
  const channelId = channelType === 'whatsapp' ? 'peer@s.whatsapp.net' : 'peer'
  const threadRef = channelType === 'slack' || channelType === 'feishu' ? 'native-root' : undefined
  const params: ChannelWorkflowContextParams = { userId: 'actor', isIdentified: true, integrationId: 'integration', channelType, channelId,
    assistant: { id: 'assistant', workspaceId: 'workspace', ownerUserId: 'owner', kind: 'standard', name: 'A', clearance: 'internal', systemPrompt: null },
    messageText: '', questionStore: store, connectorStore: {} as never, mcpSettingsStore: {} as never,
  }
  const integrationStore = { getCredentialsForAssistantIntegrationSystem: vi.fn(async () => ({ id: 'integration', channelId: 'account', credentials: { bot_token: 'token' }, config: { msteamsServiceUrl: 'https://teams.example' } })) } as unknown as ChannelIntegrationStore
  const deliver = () => createWorkflowChannelDelivery({ integrationStore, questionStore: store, customChannelStore: { enqueue: vi.fn() }, waConnectorUrl: 'http://connector', waConnectorSecret: 'secret' })({
    workspaceId: 'workspace', assistantId: 'assistant', userId: 'actor', channelType, channelId, channelIntegrationId: 'integration', text: '', threadRef,
    question: { question: 'Where?', options: ['dev', 'prod'], allowCustom: false },
    questionResponse: { toolName: 'pinned_answer', arguments: { version: 7 }, answerField: 'answer' },
  })
  return { params, store, deliver, token, nativeReply: threadRef ?? 'posted' }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildWorkflowToolRegistry).mockResolvedValue(new Map([['pinned_answer', buildTool({ name: 'pinned_answer', description: '', inputSchema: z.object({ version: z.literal(7), answer: z.enum(['dev', 'prod']) }), requiresConfirmation: false, isConcurrencySafe: false, isReadOnly: false, execute })]]))
})
describe('durable question delivery → scoped inbound → pinned action', () => {
  it.each(['telegram', 'slack', 'feishu', 'msteams', 'custom', 'whatsapp'] as const)('round trips typed reference/numeric choice on %s without a quoted message ID', async (channelType) => {
    const f = fixture(channelType)
    expect(await f.deliver()).toMatchObject({ status: 'delivered' })
    expect(send).toHaveBeenCalledWith(f.params.channelId, expect.objectContaining({ text: expect.stringContaining(`wq:${f.token} <answer>`) }), ...(channelType === 'telegram' || channelType === 'slack' || channelType === 'feishu' ? [channelType === 'telegram' ? undefined : { threadTs: 'native-root' }] : []))
    const p = { ...f.params, messageText: `wq:${f.token} 2`, allowUnthreaded: false }
    expect(await maybeHandleChannelWorkflowContext(p)).toBe('Your answer was sent.')
    expect(execute).toHaveBeenCalledExactlyOnceWith({ version: 7, answer: 'prod' }, expect.objectContaining({ userId: 'actor', channelType }))
    expect(await maybeHandleChannelWorkflowContext(p)).toContain('already answered')
    expect(execute).toHaveBeenCalledOnce()
  })
  it.each(['telegram', 'slack', 'feishu', 'msteams', 'custom', 'whatsapp'] as const)('round trips native reply/label on %s and does not hijack an unrelated quoted message', async (channelType) => {
    const f = fixture(channelType)
    await f.deliver()
    expect(await maybeHandleChannelWorkflowContext({ ...f.params, messageText: 'prod', replyToMessageId: 'unrelated' })).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    expect(await maybeHandleChannelWorkflowContext({ ...f.params, messageText: 'PROD', replyToMessageId: f.nativeReply })).toBe('Your answer was sent.')
    expect(execute).toHaveBeenCalledExactlyOnceWith({ version: 7, answer: 'prod' }, expect.objectContaining({ channelType }))
  })
})
