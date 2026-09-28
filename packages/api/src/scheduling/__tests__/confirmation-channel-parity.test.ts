import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { send, role } = vi.hoisted(() => ({ send: vi.fn(async () => 'prompt-id'), role: vi.fn(async () => 'member') }))
vi.mock('@use-brian/channels', async (original) => ({ ...(await original<typeof import('@use-brian/channels')>()),
  createTelegramAdapter: vi.fn(() => ({ sendMessage: send })), createSlackAdapter: vi.fn(() => ({ sendMessage: send })),
  createFeishuAdapter: vi.fn(() => ({ sendMessage: send })), createMsTeamsAdapter: vi.fn(() => ({ sendMessage: send })),
  createCustomAdapter: vi.fn(() => ({ sendMessage: send })), createWhatsAppAdapter: vi.fn(() => ({ sendMessage: send })),
}))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: role }))
vi.mock('../../feishu/client.js', () => ({ createFeishuApi: vi.fn(() => ({})) }))
import { sendConfirmationPrompt } from '../confirmation-prompt.js'
import { registerSchedulerResolver, unregisterSchedulerResolver, SHARED_TELEGRAM_CONFIRMATION_INTEGRATION } from '../confirmation-registry.js'
import { maybeHandleChannelWorkflowContext, type ChannelWorkflowContextParams } from '../../routes/channel-workflow-context.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { DeferredConfirmationStore } from '../../db/deferred-confirmation-store.js'
import type { ToolConfirmationRequest } from '@use-brian/core'
const req: ToolConfirmationRequest = { toolCallId: 'call', toolName: 'send', serverName: 'connector', description: 'Send', input: {}, classification: null }
const questionStore = { isQuestionMessage: vi.fn(async () => false), find: vi.fn(async () => []) } as unknown as NonNullable<ChannelWorkflowContextParams['questionStore']>
function fixture(channelType: ChannelWorkflowContextParams['channelType'] = 'slack', shared = false) {
  const channelId = channelType === 'whatsapp' ? 'peer@s.whatsapp.net' : 'peer'
  const threadRef = channelType === 'slack' || channelType === 'feishu' ? 'root' : undefined
  const integrationId = shared ? SHARED_TELEGRAM_CONFIRMATION_INTEGRATION : 'integration'
  const resolver = { resolve: vi.fn() }
  registerSchedulerResolver('call', resolver as never, { userId: 'actor', workspaceId: 'workspace', assistantId: 'assistant', channelType, channelId })
  const row = { userId: 'actor', assistantId: 'assistant', channelType, channelId, status: 'pending', expiresAt: new Date(Date.now() + 60_000) }
  const store = { findByToolCallId: vi.fn(async () => row), markResolved: vi.fn(async () => {}) } as unknown as DeferredConfirmationStore
  const integrationStore = { getCredentialsForAssistantSystem: vi.fn(async () => shared ? null : ({ id: integrationId, channelId: 'account', credentials: { bot_token: 'token' }, config: { msteamsServiceUrl: 'https://teams.example' } })) } as unknown as ChannelIntegrationStore
  const params: ChannelWorkflowContextParams = { userId: 'actor', isIdentified: true, channelType, channelId, integrationId,
    assistant: { id: 'assistant', workspaceId: 'workspace', ownerUserId: 'owner', name: 'A', kind: 'standard', systemPrompt: null, clearance: 'internal' },
    messageText: 'yes', sessionChannelId: threadRef ? `${channelId}:thread:${threadRef}` : channelId,
    deferredConfirmationStore: store, questionStore,
  }
  const deliver = () => sendConfirmationPrompt({ workspaceId: 'workspace', assistantId: 'assistant', channelType, channelId, threadRef }, req,
    { integrationStore, defaultTelegramBotToken: 'official', waConnectorUrl: 'http://connector', waConnectorSecret: 'secret', customChannelStore: { enqueue: vi.fn() } })
  return { params, resolver, store, deliver }
}
beforeEach(() => { vi.clearAllMocks(); send.mockResolvedValue('prompt-id'); role.mockResolvedValue('member') })
afterEach(() => { unregisterSchedulerResolver('call') })
describe('real scheduler prompt → shared inbound context', () => {
  it.each(['telegram', 'slack', 'feishu', 'msteams', 'custom', 'whatsapp'] as const)('resolves %s with actor/integration/thread provenance', async (channelType) => {
    const f = fixture(channelType)
    expect(await f.deliver()).toMatchObject({ delivered: true })
    const params = ['telegram', 'feishu', 'msteams'].includes(channelType)
      ? { ...f.params, callback: { data: 'mcp_confirm:call:allow', messageId: 'prompt-id' } } : f.params
    expect(await maybeHandleChannelWorkflowContext(params)).toBe('Allowed')
    expect(f.resolver.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow')
    expect(f.store.markResolved).toHaveBeenCalledWith('call', 'allow')
    if (channelType === 'slack' || channelType === 'feishu') expect(send).toHaveBeenCalledWith('peer', expect.any(Object), { threadTs: 'root' })
  })
  it('supports shared-bot Telegram callbacks using the trusted transport sentinel', async () => {
    const f = fixture('telegram', true)
    await f.deliver()
    expect(await maybeHandleChannelWorkflowContext({ ...f.params, callback: { data: 'mcp_confirm:call:allow', messageId: 'prompt-id' } })).toBe('Allowed')
    expect(f.resolver.resolve).toHaveBeenCalledOnce()
  })
  it.each(['userId', 'integrationId', 'channelId'] as const)('refuses a forged or wrong %s without consuming the resolver', async (key) => {
    const f = fixture()
    await f.deliver()
    expect(await maybeHandleChannelWorkflowContext({ ...f.params, [key]: 'other', callback: { data: 'mcp_confirm:call:allow', messageId: 'prompt-id' } })).toContain('unavailable')
    expect(f.resolver.resolve).not.toHaveBeenCalled()
    expect(await maybeHandleChannelWorkflowContext(f.params)).toBe('Allowed')
  })
  it('recovers a Feishu callback thread only from its exact source card', async () => {
    const f = fixture('feishu')
    await f.deliver()
    const params = { ...f.params, sessionChannelId: 'peer:thread:prompt-id' }
    expect(await maybeHandleChannelWorkflowContext(params)).toBeNull()
    expect(await maybeHandleChannelWorkflowContext({ ...params, callback: { data: 'mcp_confirm:call:allow', messageId: 'other-card' } })).toContain('unavailable')
    expect(f.resolver.resolve).not.toHaveBeenCalled()
    expect(await maybeHandleChannelWorkflowContext({ ...params, callback: { data: 'mcp_confirm:call:allow', messageId: 'prompt-id' } })).toBe('Allowed')
    expect(f.resolver.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow')
  })
  it('rechecks membership and refuses another prompt message', async () => {
    const f = fixture('telegram')
    await f.deliver()
    role.mockResolvedValueOnce(null as never)
    expect(await maybeHandleChannelWorkflowContext(f.params)).toContain('not authorized')
    expect(await maybeHandleChannelWorkflowContext({ ...f.params, callback: { data: 'mcp_confirm:call:allow', messageId: 'wrong' } })).toContain('unavailable')
    expect(f.resolver.resolve).not.toHaveBeenCalled()
  })
  it('clears delivery authority on push failure and consumes stale callback syntax', async () => {
    const f = fixture('telegram')
    send.mockRejectedValueOnce(new Error('provider unavailable'))
    expect(await f.deliver()).toMatchObject({ delivered: false })
    expect(await maybeHandleChannelWorkflowContext({ ...f.params, callback: { data: 'mcp_confirm:call:allow', messageId: 'prompt-id' } })).toContain('unavailable')
    expect(f.resolver.resolve).not.toHaveBeenCalled()
  })
  it('claims only once across concurrent callback deliveries', async () => {
    const f = fixture('telegram')
    await f.deliver()
    const params = { ...f.params, callback: { data: 'mcp_confirm:call:allow', messageId: 'prompt-id' } }
    const replies = await Promise.all([maybeHandleChannelWorkflowContext(params), maybeHandleChannelWorkflowContext(params)])
    expect(replies.filter(reply => reply === 'Allowed')).toHaveLength(1)
    expect(f.resolver.resolve).toHaveBeenCalledOnce()
  })
})
