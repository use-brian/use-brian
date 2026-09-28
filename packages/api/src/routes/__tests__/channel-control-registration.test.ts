import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ answer: vi.fn() }))
vi.mock('../channel-answer-context.js', () => ({ resolveChannelAnswerContext: mocks.answer }))
import { processChannelMessage, type ChannelPipelineParams } from '../channel-pipeline.js'
import { channelConfirmations } from '../channel-interactions.js'

const scope = { channelType: 'telegram', integrationId: 'integration', conversationId: 'conversation', senderId: 'sender' }
afterEach(() => vi.restoreAllMocks())

describe('pipeline active turn lifetime', () => {
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
