import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../workflow/channel-questions.js', () => ({ createChannelQuestionStore: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn() }))
vi.mock('../../context-scope/resolve-turn-scope.js', () => ({ resolveTurnScopeSystem: vi.fn(), resolveLiveAccessCeilingSystem: vi.fn() }))
vi.mock('../../workflow/mcp-bridge.js', () => ({ buildWorkflowToolRegistry: vi.fn() }))
vi.mock('../channel-workflow-replies.js', () => ({ maybeHandleChannelWorkflowReply: vi.fn(async () => null) }))
import { configureChannelWorkflowReplies, maybeHandleChannelWorkflowContext, type ChannelWorkflowContextParams } from '../channel-workflow-context.js'
import { maybeHandleChannelWorkflowReply } from '../channel-workflow-replies.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { resolveTurnScopeSystem, resolveLiveAccessCeilingSystem } from '../../context-scope/resolve-turn-scope.js'
import { buildWorkflowToolRegistry } from '../../workflow/mcp-bridge.js'
import type { ApprovalBridgeDeps } from '../../workflow/approval.js'
import type { ChannelQuestion } from '../../workflow/channel-questions.js'
const params = (): ChannelWorkflowContextParams => ({
  userId: 'actor', assistant: { id: 'assistant', workspaceId: 'workspace', ownerUserId: 'owner', name: 'Assistant',
    kind: 'standard', systemPrompt: null, clearance: 'internal' },
  isIdentified: true, channelType: 'slack', channelId: 'channel', integrationId: 'integration', messageText: 'hello',
  connectorStore: {} as never, mcpSettingsStore: {} as never,
  questionStore: { isQuestionMessage: vi.fn(async () => false) } as never,
})
beforeEach(() => { vi.clearAllMocks(); configureChannelWorkflowReplies(undefined) })
describe('production workflow context assembly', () => {
  it('leaves ordinary text unaffected without a bound integration or workspace', async () => {
    expect(await maybeHandleChannelWorkflowContext({ ...params(), integrationId: undefined })).toBeNull()
    expect(maybeHandleChannelWorkflowReply).not.toHaveBeenCalled()
    expect(await maybeHandleChannelWorkflowContext({ ...params(), integrationId: undefined, messageText: 'approve abc123' })).toContain('unavailable')
  })
  it('injects the boot approval service, not a separately constructed executor', async () => {
    const bridge = { approvalsStore: {} } as ApprovalBridgeDeps
    configureChannelWorkflowReplies(bridge)
    await maybeHandleChannelWorkflowContext(params())
    expect(vi.mocked(maybeHandleChannelWorkflowReply).mock.calls[0][0].approvals?.bridgeDeps).toBe(bridge)
  })
  it.each(['slack', 'telegram', 'whatsapp', 'feishu', 'msteams', 'custom', 'email', 'discord', 'wechat'] as const)('assembles scoped %s input and checks membership as actor, never owner', async (channelType) => {
    vi.mocked(getWorkspaceRoleSystem).mockResolvedValue('member')
    await maybeHandleChannelWorkflowContext({ ...params(), channelType, incoming: { text: 'answer', messageId: 'reply', replyToMessageId: 'question', raw: {} } })
    const input = vi.mocked(maybeHandleChannelWorkflowReply).mock.calls[0][0]
    expect(input).toMatchObject({ text: 'answer', answerMessageId: 'reply',
      replyToMessageId: channelType === 'slack' ? undefined : 'question',
      address: { userId: 'actor', workspaceId: 'workspace', integrationId: 'integration' } })
    expect(await input.authorized()).toBe(true)
    expect(getWorkspaceRoleSystem).toHaveBeenCalledWith('actor', 'workspace')
    vi.mocked(getWorkspaceRoleSystem).mockResolvedValue(null)
    expect(await input.authorized()).toBe(false)
  })
  it.each([{ isIdentified: false }, { externalGuest: true }])('rejects untrusted identity %j without role fallback', async (identity) => {
    await maybeHandleChannelWorkflowContext({ ...params(), ...identity })
    expect(await vi.mocked(maybeHandleChannelWorkflowReply).mock.calls[0][0].authorized()).toBe(false)
    expect(getWorkspaceRoleSystem).not.toHaveBeenCalled()
  })
  it('rebuilds the sender-scoped policy registry and context for each response', async () => {
    const access = { userId: 'actor', workspaceId: 'workspace', assistantId: 'assistant', assistantKind: 'standard' as const,
      clearance: 'internal' as const, compartments: ['a'], mutationCompartments: [], projectIds: ['p'], visibilityAssistantIds: ['assistant'] }
    vi.mocked(resolveLiveAccessCeilingSystem).mockResolvedValue(access)
    vi.mocked(resolveTurnScopeSystem).mockResolvedValue({ access, effectiveCompartments: ['a'], writeCompartments: [], effectiveProjectIds: ['p'], writeProjectIds: [] } as never)
    vi.mocked(buildWorkflowToolRegistry).mockResolvedValue(new Map())
    const p = { ...params(), connectorAuthority: 'assistant' as const, abortController: new AbortController() }
    await maybeHandleChannelWorkflowContext(p)
    const input = vi.mocked(maybeHandleChannelWorkflowReply).mock.calls[0][0]
    const binding = { token: 'token', channelId: 'channel' } as ChannelQuestion
    const first = await input.loadResponseContext(binding)
    await input.loadResponseContext(binding)
    expect(resolveTurnScopeSystem).toHaveBeenCalledTimes(2)
    expect(resolveTurnScopeSystem).toHaveBeenCalledWith(expect.objectContaining({ userId: 'actor', assistant: { ...p.assistant, compartments: [] }, workspaceId: 'workspace',
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor' } },
    }), expect.any(Object))
    expect(first.context.executionContext).toBeDefined()
    expect(first.context.abortSignal).toBe(p.abortController.signal)
    expect(first.context.sessionId).toBe('question:token')
    expect(vi.mocked(resolveTurnScopeSystem).mock.calls[0][0].session).toBeUndefined()
    expect(first.context.mutationCompartments).toEqual([])
    expect(first.context.visibilityAssistantIds).toEqual(['assistant'])
    expect(first.context.authority).toBeDefined()
    expect(buildWorkflowToolRegistry).toHaveBeenCalledWith(expect.objectContaining({ firstParty: new Map() }), expect.objectContaining({ userId: 'actor', assistantId: 'assistant' }))
    expect(first.context).toMatchObject({ userId: 'actor', assistantId: 'assistant', channelType: 'slack', channelId: 'channel', compartments: ['a'] })
  })
})

it.each(['slack', 'feishu'] as const)('never mistakes a new %s outbound thread for inbound answer provenance', async (channelType) => {
  await maybeHandleChannelWorkflowContext({ ...params(), channelType, sessionChannelId: 'channel:thread:answer',
    incoming: { text: '2', messageId: 'answer', raw: {} } })
  expect(maybeHandleChannelWorkflowReply).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: undefined, replyToMessageId: undefined }))
  await maybeHandleChannelWorkflowContext({ ...params(), channelType, threadId: 'verified-root' })
  expect(maybeHandleChannelWorkflowReply).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'verified-root' }))
})
it('treats Slack thread_ts as thread provenance, never an exact question reference', async () => {
  await maybeHandleChannelWorkflowContext({ ...params(), sessionChannelId: 'channel',
    incoming: { text: '2', messageId: 'answer', replyToMessageId: 'root-question', raw: {} } })
  expect(maybeHandleChannelWorkflowReply).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'root-question', replyToMessageId: undefined }))
})
it.each([
  [{ rootId: 'root', threadId: 'topic' }, 'root'],
  [{ threadId: 'topic' }, 'topic'],
  [{}, 'prompt'],
] as const)('preserves Feishu ancestry %j separately from an exact quote', async (raw, threadId) => {
  await maybeHandleChannelWorkflowContext({ ...params(), channelType: 'feishu', sessionChannelId: 'channel:thread:outbound',
    incoming: { text: 'answer', replyToMessageId: 'prompt', raw } })
  expect(maybeHandleChannelWorkflowReply).toHaveBeenLastCalledWith(expect.objectContaining({ threadId, replyToMessageId: 'prompt' }))
})
