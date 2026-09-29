import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ answer: vi.fn(), session: vi.fn() }))
vi.mock('../channel-answer-context.js', () => ({ resolveChannelAnswerContext: mocks.answer }))
vi.mock('../../db/sessions.js', async original => ({
  ...(await original<typeof import('../../db/sessions.js')>()), findOrCreateSession: mocks.session,
}))
import { processChannelMessage, type ChannelPipelineParams } from '../channel-pipeline.js'
import { channelConfirmations } from '../channel-interactions.js'

const scope = { channelType: 'telegram', integrationId: 'integration', conversationId: 'conversation', senderId: 'sender' }
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe('pipeline active turn lifetime', () => {
  it.each([{ kind: 'continue' as const }, { kind: 'continue' as const, questionAnswer: 'Approve' }])(
    'reuses pre-media admission %j instead of consuming the reply twice', async admittedAnswerContext => {
      const sentinel = new Error('reached conversation session')
      mocks.session.mockRejectedValueOnce(sentinel)
      mocks.answer.mockImplementation(() => { throw new Error('must not reinterpret an admitted reply') })
      const params = { admittedAnswerContext, interactionScope: scope, abortController: new AbortController(),
        assistant: { id: 'assistant' }, userId: 'user', channelType: 'telegram', channelId: 'conversation',
        messageText: '1', userContentBlocks: [{ type: 'text', text: '1' }], hooks: { sendResponse: vi.fn() },
      } as unknown as ChannelPipelineParams
      await expect(processChannelMessage(params)).rejects.toBe(sentinel)
      expect(mocks.answer).not.toHaveBeenCalled()
      expect(mocks.session).toHaveBeenCalledOnce()
      expect(channelConfirmations.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(false)
    },
  )

  it.each(['handled', 'aborted'] as const)('does no work for a previously %s turn', async state => {
    const abortController = new AbortController()
    if (state === 'aborted') abortController.abort()
    const sendResponse = vi.fn()
    await processChannelMessage({ abortController, hooks: { sendResponse },
      ...(state === 'handled' ? { admittedAnswerContext: { kind: 'handled', reply: 'Already sent' } } : {}),
    } as unknown as ChannelPipelineParams)
    expect(mocks.answer).not.toHaveBeenCalled()
    expect(mocks.session).not.toHaveBeenCalled()
    expect(sendResponse).not.toHaveBeenCalled()
  })

  it.each([false, true])('registers centrally and cleans up on early completion/error=%s', async fails => {
    const abortController = new AbortController()
    const sendResponse = vi.fn(async () => {})
    const register = vi.spyOn(channelConfirmations, 'registerTurn')
    mocks.answer.mockImplementation(async () => {
      expect(register).toHaveBeenCalledOnce()
      if (fails) throw new Error('admission failed')
      return { kind: 'handled', reply: 'done' }
    })
    const params = { interactionScope: scope, abortController, assistant: { id: 'assistant' }, hooks: { sendResponse } } as unknown as ChannelPipelineParams
    if (fails) await expect(processChannelMessage(params)).rejects.toThrow('admission failed')
    else await processChannelMessage(params)
    expect(channelConfirmations.handle(scope, { kind: 'text', text: '/stop' }).handled).toBe(false)
    expect(abortController.signal.aborted).toBe(false)
  })

  it('acknowledges through the registered transport response hook', async () => {
    const abortController = new AbortController()
    const sendResponse = vi.fn(async () => {})
    mocks.answer.mockImplementation(async () => {
      expect(channelConfirmations.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(true)
      return { kind: 'handled', reply: 'done' }
    })
    await processChannelMessage({ interactionScope: scope, abortController, assistant: { id: 'assistant' }, hooks: { sendResponse } } as unknown as ChannelPipelineParams)
    expect(sendResponse).toHaveBeenCalledWith('Stopped.')
    expect(abortController.signal.aborted).toBe(true)
  })
})
