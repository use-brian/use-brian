import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, type ToolContext } from '@use-brian/core'
import { handleChannelQuestionReply, workflowQuestionActions, type ChannelQuestion, type ChannelQuestionStore } from '../channel-questions.js'
import { dispatchQuestionResponse } from '../question-response.js'

const binding: ChannelQuestion = {
  token: 'a'.repeat(24), integrationId: 'integration', channelId: '-100:topic:7', messageId: '42',
  workspaceId: 'workspace', assistantId: 'assistant', userId: 'user',
  question: { question: 'Which environment?', options: ['dev', 'prod'], allowCustom: true,
    actionId: 'action-9', version: 3, context: 'Workflow-authored context' },
  response: { toolName: 'answer_action', arguments: { action_id: 'action-9', version: 3 }, answerField: 'answer' },
}
function fixture(overrides: Partial<ChannelQuestion> = {}) {
  const row = { ...binding, ...overrides }
  let consumed = false
  const store: ChannelQuestionStore = {
    create: vi.fn(), attach: vi.fn(), isQuestionMessage: vi.fn(async () => true),
    find: vi.fn(async (address) => Object.entries(address).every(([k, v]) => row[k as keyof ChannelQuestion] === v) ? [row] : []),
    consume: vi.fn(async () => { if (consumed) return false; consumed = true; return true }),
  }
  const params = { store, address: { integrationId: row.integrationId, channelId: row.channelId,
    workspaceId: row.workspaceId, assistantId: row.assistantId, userId: row.userId },
  text: 'test', replyToMessageId: '42', authorized: vi.fn(async () => true), dispatch: vi.fn(async (_binding: ChannelQuestion, _answer: string, claim: () => Promise<boolean>) => await claim() ? 'sent' : 'This question has expired or was already answered.') }
  return { row, store, params }
}

describe('[COMP:workflow/channel-questions] bound replies', () => {
  it('uses opaque callback data and routes the selected answer with the full original context', async () => {
    const { params, row } = fixture()
    const actions = workflowQuestionActions(row.token, row.question)!
    expect(actions[0].data).toBe(`wq:${row.token}:0`)
    expect(actions[0].data).not.toContain('action-9')
    expect(await handleChannelQuestionReply({ ...params, callback: { data: actions[1].data, messageId: '42' } })).toBe('sent')
    expect(params.dispatch).toHaveBeenCalledWith(row, 'prod', expect.any(Function))
    expect(await handleChannelQuestionReply({ ...params, callback: { data: actions[1].data, messageId: '42' } })).toContain('already answered')
    expect(params.dispatch).toHaveBeenCalledTimes(2)
  })
  it('routes typed custom text unchanged rather than interpreting it or inferring approval', async () => {
    const { params, row } = fixture()
    expect(await handleChannelQuestionReply(params)).toBe('sent')
    expect(params.dispatch).toHaveBeenCalledWith(row, 'test', expect.any(Function))
  })
  it.each(['integrationId', 'channelId', 'workspaceId', 'assistantId', 'userId'] as const)('isolates %s without consuming', async (key) => {
    const { params, store } = fixture()
    expect(await handleChannelQuestionReply({ ...params, address: { ...params.address, [key]: 'other' } })).toContain('unavailable')
    expect(store.consume).not.toHaveBeenCalled()
    expect(params.dispatch).not.toHaveBeenCalled()
  })
  it('rejects revoked membership, stale messages, expired questions, invalid choices and disallowed custom text', async () => {
    const { params, store } = fixture()
    params.authorized.mockResolvedValueOnce(false)
    expect(await handleChannelQuestionReply(params)).toContain('not authorized')
    expect(store.consume).not.toHaveBeenCalled()
    expect(await handleChannelQuestionReply({ ...params, callback: { data: `wq:${binding.token}:0`, messageId: 'wrong' } })).toContain('unavailable')
    expect(await handleChannelQuestionReply({ ...params, callback: { data: `wq:${binding.token}:7`, messageId: '42' } })).toContain('valid answer')
    vi.mocked(store.consume).mockResolvedValueOnce(false)
    expect(await handleChannelQuestionReply(params)).toContain('expired')
    const closed = fixture({ question: { ...binding.question, allowCustom: false } })
    expect(await handleChannelQuestionReply(closed.params)).toContain('listed options')
    expect(closed.store.consume).not.toHaveBeenCalled()
  })
  it('fails closed for a quoted opaque reference if send succeeded but binding attachment did not', async () => {
    const { params, store } = fixture()
    vi.mocked(store.find).mockResolvedValueOnce([])
    vi.mocked(store.isQuestionMessage).mockResolvedValueOnce(false)
    expect(await handleChannelQuestionReply({ ...params, referenceToken: binding.token })).toContain('unavailable')
    expect(params.dispatch).not.toHaveBeenCalled()
  })

  it('never falls back to chat for missing response configuration or ambiguous questions', async () => {
    const { params, store } = fixture({ response: undefined })
    expect(await handleChannelQuestionReply(params)).toContain('no response action')
    expect(params.dispatch).not.toHaveBeenCalled()
    vi.mocked(store.find).mockResolvedValueOnce([binding, binding])
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined })).toContain('ambiguous')
  })
})

describe('[COMP:workflow/channel-questions] deterministic response action', () => {
  const context: ToolContext = { userId: 'user', assistantId: 'assistant', sessionId: 'question:token',
    workspaceId: 'workspace', appId: 'Use Brian', channelType: 'telegram', channelId: '-100:topic:7', abortSignal: new AbortController().signal }
  function registry() {
    const execute = vi.fn(async () => ({ data: 'secret backend output' }))
    const submit = vi.fn(async () => ({ data: 'wrong' }))
    const tool = buildTool({ name: 'answer_action', description: '', inputSchema: z.object({ action_id: z.string(), version: z.number(), answer: z.string() }),
      isConcurrencySafe: false, isReadOnly: false, requiresConfirmation: false, execute })
    return { tool, execute, submit, tools: new Map([['answer_action', tool], ['submit_change', { ...tool, name: 'submit_change', execute: submit }]]) }
  }
  it('calls only the authored tool once with fixed action/version and literal custom answer; exposes no backend payload', async () => {
    const { tools, execute, submit } = registry()
    expect(await dispatchQuestionResponse(binding, 'test', tools, context, async () => true)).toBe('Your answer was sent.')
    expect(execute).toHaveBeenCalledExactlyOnceWith({ action_id: 'action-9', version: 3, answer: 'test' }, expect.objectContaining({ channelId: '-100:topic:7' }))
    expect(submit).not.toHaveBeenCalled()
  })
  it('does not consume Ask answers and permits an explicit retry after policy becomes Allow', async () => {
    const { tool, tools, execute } = registry()
    const { params, store } = fixture()
    tool.requiresConfirmation = true // remote adapter's default; live policy overrides it
    tool.resolveConfirmation = async () => true
    const dispatch = (row: ChannelQuestion, answer: string, claim: () => Promise<boolean>) => dispatchQuestionResponse(row, answer, tools, context, claim)
    expect(await handleChannelQuestionReply({ ...params, dispatch })).toContain('question remains open')
    expect(store.consume).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    tool.resolveConfirmation = async () => false
    expect(await handleChannelQuestionReply({ ...params, dispatch })).toBe('Your answer was sent.')
    expect(store.consume).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each(['ask', 'blocked', 'policy-error', 'invalid-input'] as const)('fails closed for %s; never calls submit_change', async (policy) => {
    const { tool, tools, execute, submit } = registry()
    if (policy === 'ask') tool.resolveConfirmation = async () => true
    if (policy === 'blocked') tools.delete('answer_action')
    if (policy === 'policy-error') tool.resolveConfirmation = async () => { throw new Error('secret') }
    const row = policy === 'invalid-input' ? { ...binding, response: { ...binding.response!, arguments: { version: 'bad' } } } : binding
    expect(await dispatchQuestionResponse(row, 'test', tools, context, async () => true)).not.toBe('Your answer was sent.')
    expect(execute).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})

it('leaves unthreaded conversational asks alone when requested', async () => {
  const { params, store } = fixture()
  expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, allowUnthreaded: false })).toBeNull()
  expect(store.find).not.toHaveBeenCalled()
})
it('accepts an opaque reference without native reply metadata but rejects conflicting native metadata', async () => {
  const { params } = fixture()
  expect(await handleChannelQuestionReply({ ...params, referenceToken: binding.token, replyToMessageId: undefined })).toBe('sent')
  expect(await handleChannelQuestionReply({ ...params, referenceToken: binding.token, replyToMessageId: 'wrong' })).toContain('unavailable')
})

it('accepts quoted reference metadata pointing at the bound native thread root', async () => {
  const { params } = fixture({ threadRef: 'root' })
  expect(await handleChannelQuestionReply({ ...params, referenceToken: binding.token, replyToMessageId: 'root' })).toBe('sent')
})

it('persists native thread provenance separately from authored question data and scopes thread lookups', async () => {
  const { createChannelQuestionStore } = await import('../channel-questions.js')
  const runQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const store = createChannelQuestionStore(runQuery as never)
  await store.create({ ...binding, threadRef: 'root' })
  expect(JSON.parse((runQuery.mock.calls[0] as unknown as [string, unknown[]])[1][6] as string)).toMatchObject({ __channelThreadRef: 'root', question: binding.question.question })
  await store.find(binding, { messageId: 'root' })
  expect(runQuery).toHaveBeenLastCalledWith(expect.stringContaining("question - '__channelThreadRef' AS question"), expect.arrayContaining(['root']))
  await store.isQuestionMessage(binding.integrationId, binding.channelId, 'root')
  expect(runQuery).toHaveBeenLastCalledWith(expect.stringContaining("question->>'__channelThreadRef'=$3"), [binding.integrationId, binding.channelId, 'root'])
})

it.each(['2', 'prod', 'PROD', ' Prod '])('resolves portable choice %j to the canonical authored label', async (text) => {
  const { params, row } = fixture({ question: { ...binding.question, allowCustom: false } })
  expect(await handleChannelQuestionReply({ ...params, text })).toBe('sent')
  expect(params.dispatch).toHaveBeenCalledWith(row, 'prod', expect.any(Function))
})
it('accepts explicit typed references without quote metadata even while conversational ask owns plain text', async () => {
  const { params, row, store } = fixture({ question: { ...binding.question, allowCustom: false } })
  expect(await handleChannelQuestionReply({ ...params, text: `wq:${row.token} 2`, replyToMessageId: undefined, allowUnthreaded: false })).toBe('sent')
  expect(store.find).toHaveBeenCalledWith(params.address, expect.objectContaining({ token: row.token }))
  expect(params.dispatch).toHaveBeenCalledWith(row, 'prod', expect.any(Function))
})
it('never treats malformed or mismatched typed references as conversational text', async () => {
  const { params, store } = fixture()
  expect(await handleChannelQuestionReply({ ...params, text: 'wq:bad answer' })).toContain('invalid')
  expect(await handleChannelQuestionReply({ ...params, text: `wq:${binding.token} 2`, referenceToken: 'b'.repeat(24) })).toContain('unavailable')
  expect(store.consume).not.toHaveBeenCalled()
})

describe('implicit workflow question thread isolation', () => {
  it.each([undefined, 'other-root'])('does not consume a threaded question from %s', async (threadId) => {
    const { params, store } = fixture({ threadRef: 'root' })
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, threadId })).toBeNull()
    expect(params.dispatch).not.toHaveBeenCalled()
    expect(store.consume).not.toHaveBeenCalled()
    expect(store.find).toHaveBeenCalledWith(params.address, expect.objectContaining({ threadId }))
  })
  it('accepts implicit text in the original native thread', async () => {
    const { params, store } = fixture({ threadRef: 'root' })
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, threadId: 'root' })).toBe('sent')
    expect(store.consume).toHaveBeenCalledOnce()
  })
  it('keeps top-level questions out of unrelated threads but accepts replies rooted at their prompt', async () => {
    const { params, store } = fixture()
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, threadId: 'other-root' })).toBeNull()
    expect(store.consume).not.toHaveBeenCalled()
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, threadId: '42' })).toBe('sent')
  })
  it('still accepts top-level implicit answers for top-level prompts', async () => {
    const { params } = fixture()
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined })).toBe('sent')
  })
  it('preserves exact source-message callback recovery without the original thread metadata', async () => {
    const { params, row } = fixture({ threadRef: 'root' })
    expect(await handleChannelQuestionReply({ ...params, threadId: '42',
      callback: { data: `wq:${row.token}:0`, messageId: '42' } })).toBe('sent')
  })
  it('preserves explicit typed targeting from another thread without quote metadata', async () => {
    const { params, row } = fixture({ threadRef: 'root' })
    expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, threadId: 'other-root',
      text: `wq:${row.token} 2` })).toBe('sent')
  })
  it('preserves exact native source-message replies even when the thread root is unavailable', async () => {
    const { params } = fixture({ threadRef: 'root' })
    expect(await handleChannelQuestionReply({ ...params, threadId: '42' })).toBe('sent')
  })
  it('applies thread isolation to both active candidates and answer-message tombstones in SQL', async () => {
    const { createChannelQuestionStore } = await import('../channel-questions.js')
    const runQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const store = createChannelQuestionStore(runQuery as never)
    for (const threadId of [undefined, 'root']) {
      await store.find(binding, { threadId, answerMessageId: 'answer-id' })
      expect(runQuery).toHaveBeenLastCalledWith(expect.stringContaining(
        "ELSE (answer_message_id=$8 OR (consumed_at IS NULL AND expires_at > now()))\n                   AND (question->>'__channelThreadRef' IS NOT DISTINCT FROM $9::text\n                     OR (question->>'__channelThreadRef' IS NULL AND message_id=$9)) END"),
      [binding.integrationId, binding.channelId, binding.workspaceId, binding.assistantId, binding.userId,
        null, null, 'answer-id', threadId ?? null])
    }
  })
})

it('does not turn replies in an expired question thread into unrestricted chat', async () => {
  const { params, store } = fixture({ threadRef: 'root' })
  vi.mocked(store.find).mockResolvedValue([])
  expect(await handleChannelQuestionReply({ ...params, replyToMessageId: undefined, threadId: 'root' })).toContain('unavailable')
  expect(store.isQuestionMessage).toHaveBeenCalledWith(binding.integrationId, binding.channelId, 'root')
  expect(store.consume).not.toHaveBeenCalled()
})
