import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool } from '@use-brian/core'
import type { query } from '../../db/client.js'
import { createChannelQuestionStore } from '../../workflow/channel-questions.js'
import { maybeHandleChannelWorkflowContext, type ChannelWorkflowContextParams } from '../channel-workflow-context.js'
import { resolveSlackThreadScope } from '../slack.js'
import { resolveFeishuThreadScope } from '../feishu.js'

const mocks = vi.hoisted(() => ({ registry: vi.fn(), execute: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: async () => 'member' }))
vi.mock('../../context-scope/resolve-turn-scope.js', () => ({ resolveTurnScopeSystem: async () => ({
  access: { clearance: 'internal' }, effectiveCompartments: [], writeCompartments: [], effectiveProjectIds: [], writeProjectIds: [],
}) }))
vi.mock('../../workflow/mcp-bridge.js', () => ({ buildWorkflowToolRegistry: mocks.registry }))
const address = {
  integrationId: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002',
  assistantId: '00000000-0000-4000-8000-000000000003', userId: '00000000-0000-4000-8000-000000000004', channelId: 'conversation',
}
let db: PGlite
const store = createChannelQuestionStore((async (sql, args) => db.query(sql, args)) as typeof query)
beforeAll(async () => {
  db = new PGlite()
  for (const [table, id] of [['channel_integrations', address.integrationId], ['workspaces', address.workspaceId],
    ['assistants', address.assistantId], ['users', address.userId]]) {
    await db.exec(`CREATE TABLE ${table} (id uuid PRIMARY KEY)`)
    await db.query(`INSERT INTO ${table} VALUES ($1)`, [id])
  }
  await db.exec(readFileSync(new URL('../../../migrations/561_workflow_channel_questions.sql', import.meta.url), 'utf8'))
}, 30_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('TRUNCATE workflow_channel_questions')
  vi.clearAllMocks()
  mocks.execute.mockResolvedValue({ data: 'ok' })
  mocks.registry.mockResolvedValue(new Map([['answer', buildTool({ name: 'answer', description: '',
    inputSchema: z.object({ questionId: z.string(), answer: z.string() }),
    isConcurrencySafe: false, isReadOnly: false, requiresConfirmation: false, execute: mocks.execute,
  })]]))
})
async function question(messageId: string, threadRef?: string) {
  const token = await store.create({ ...address, threadRef, question: { question: 'Where?', options: ['dev', 'prod'], allowCustom: false },
    response: { toolName: 'answer', arguments: { questionId: messageId }, answerField: 'answer' } })
  await store.attach(token, messageId)
  return (await store.find(address, { token }))[0]!
}
function input(channelType: 'slack' | 'feishu', replyToMessageId?: string): ChannelWorkflowContextParams {
  const incoming = { text: '2', messageId: 'answer-message', replyToMessageId, raw: {}, channelId: address.channelId }
  const session = channelType === 'slack' ? resolveSlackThreadScope(incoming, true)
    : resolveFeishuThreadScope({ ...incoming, chatId: address.channelId }, true)
  return { ...address, channelType, messageText: '2', incoming, sessionChannelId: session.sessionChannelId,
    isIdentified: true, assistant: { id: address.assistantId, workspaceId: address.workspaceId, ownerUserId: address.userId,
      name: 'Assistant', kind: 'standard', systemPrompt: null, clearance: 'internal' }, questionStore: store,
    connectorStore: {} as never, mcpSettingsStore: {} as never }
}
describe('native inbound thread → durable SQL → response action', () => {
  it.each(['slack', 'feishu'] as const)('accepts top-level %s answers despite outbound thread allocation', async channel => {
    await question('top-level-prompt')
    const params = input(channel)
    expect(params.sessionChannelId).toBe('conversation:thread:answer-message')
    expect(await maybeHandleChannelWorkflowContext(params)).toBe('Your answer was sent.')
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith({ questionId: 'top-level-prompt', answer: 'prod' }, expect.any(Object))
  })
  it.each(['consumed', 'expired'])('answers a child Slack question after its root is %s', async status => {
    const root = await question('root-question')
    if (status === 'consumed') await store.consume(root, 'old-answer')
    else await db.query("UPDATE workflow_channel_questions SET expires_at=now()-interval '1 second' WHERE token=$1", [root.token])
    await question('child-question', 'root-question')
    expect(await maybeHandleChannelWorkflowContext(input('slack', 'root-question'))).toBe('Your answer was sent.')
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith({ questionId: 'child-question', answer: 'prod' }, expect.any(Object))
  })
  it('does not arbitrarily execute either action when root and child Slack questions are both active', async () => {
    await question('root-question'); await question('child-question', 'root-question')
    expect(await maybeHandleChannelWorkflowContext(input('slack', 'root-question'))).toContain('ambiguous')
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('keeps exact Feishu quote tombstones distinct from implicit Slack thread replies', async () => {
    await store.consume(await question('root-question'), 'old-answer')
    await question('child-question', 'root-question')
    expect(await maybeHandleChannelWorkflowContext(input('feishu', 'root-question'))).toContain('expired or was already answered')
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
