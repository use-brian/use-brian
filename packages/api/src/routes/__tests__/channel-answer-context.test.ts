import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelQuestions, type QuestionBinding } from '../channel-questions.js'
import type { ChannelPipelineParams } from '../channel-pipeline.js'

const business = vi.hoisted(() => ({ approval: vi.fn(), durableAnswer: vi.fn(), deferred: vi.fn() }))
vi.mock('../channel-workflow-context.js', () => ({
  maybeHandleChannelWorkflowContext: vi.fn(async () => {
    business.approval(); business.durableAnswer(); business.deferred()
    return 'business handler invoked'
  }),
}))
import { resolveChannelAnswerContext } from '../channel-answer-context.js'

function setup(channelType: string, text = 'approve abc123') {
  const binding: QuestionBinding = {
    integrationId: 'channel-row', assistantId: 'assistant', userId: 'resolved-actor',
    incoming: { channelId: channelType, userId: 'provider-actor', text, isGroupChat: false, timestamp: 1, raw: {} },
  }
  const store = { isQuestionMessage: vi.fn(async () => false) }
  const params = {
    channelType, channelId: channelType, userId: binding.userId, assistant: { id: binding.assistantId },
    messageText: text, incomingMessage: binding.incoming,
    interactionScope: { channelType, integrationId: binding.integrationId, conversationId: channelType, senderId: binding.incoming.userId },
    questionIntegrationId: 'integration-uuid', questionStore: store,
  } as unknown as ChannelPipelineParams
  return { binding, params, store }
}

afterEach(() => vi.clearAllMocks())

describe('conversational answer provenance at pipeline admission', () => {
  for (const provider of ['telegram', 'discord', 'feishu']) {
    it(`${provider}: a consumed native choice never reaches approval, deferred, or durable interpreters`, async () => {
      const { binding, params, store } = setup(provider)
      const [action] = channelQuestions.create(binding, ['approve abc123'])
      const answer = channelQuestions.resolve(binding, action.data)
      expect(answer?.answer).toBe('approve abc123')
      expect(channelQuestions.has(binding)).toBe(false) // route already consumed the binding
      params.conversationalAnswer = true
      // Even a reply to a durable message must not reinterpret native provenance.
      binding.incoming.replyToMessageId = 'durable-message'
      store.isQuestionMessage.mockResolvedValue(true)
      expect(await resolveChannelAnswerContext(params, binding)).toEqual({ kind: 'continue', questionAnswer: 'approve abc123' })
      expect(store.isQuestionMessage).not.toHaveBeenCalled()
      for (const handler of Object.values(business)) expect(handler).not.toHaveBeenCalled()
    })
  }
  for (const text of ['approve abc123', 'APPROVE ABC123', '1']) {
    it(`typed choice ${text} has the same conversational meaning as a native click`, async () => {
      const { binding, params } = setup('slack', text)
      channelQuestions.create(binding, ['approve abc123'])
      expect(await resolveChannelAnswerContext(params, binding)).toEqual({ kind: 'continue', questionAnswer: 'approve abc123' })
      for (const handler of Object.values(business)) expect(handler).not.toHaveBeenCalled()
    })
  }
  for (const target of ['reply', 'quoted reference', 'explicit token', 'workflow callback']) {
    it(`preserves durable targeting via ${target} instead of consuming the conversational choice`, async () => {
      const { binding, params, store } = setup('telegram')
      channelQuestions.create(binding, ['approve abc123'])
      if (target === 'reply') {
        binding.incoming.replyToMessageId = 'durable-message'; store.isQuestionMessage.mockResolvedValue(true)
      } else if (target === 'quoted reference') {
        binding.incoming.raw = { reply_to_message: { text: `Question reference: wq:${'a'.repeat(24)}` } }
      } else if (target === 'explicit token') {
        binding.incoming.text = `wq:${'a'.repeat(24)} answer`
      } else params.workflowCallback = { data: `wq:${'a'.repeat(24)}:0`, messageId: 'durable-message' }
      expect(await resolveChannelAnswerContext(params, binding)).toEqual({ kind: 'handled', reply: 'business handler invoked' })
      expect(business.durableAnswer).toHaveBeenCalledOnce()
      expect(channelQuestions.has(binding)).toBe(true)
      channelQuestions.invalidate(binding.integrationId, binding.incoming)
    })
  }
  it('fails closed when durable reply-target lookup fails', async () => {
    const { binding, params, store } = setup('telegram')
    channelQuestions.create(binding, ['approve abc123'])
    binding.incoming.replyToMessageId = 'unknown'
    store.isQuestionMessage.mockRejectedValue(new Error('offline'))
    expect(await resolveChannelAnswerContext(params, binding)).toEqual({ kind: 'handled', reply: 'Workflow replies are temporarily unavailable.' })
    expect(channelQuestions.has(binding)).toBe(true)
    for (const handler of Object.values(business)) expect(handler).not.toHaveBeenCalled()
    channelQuestions.invalidate(binding.integrationId, binding.incoming)
  })
})
