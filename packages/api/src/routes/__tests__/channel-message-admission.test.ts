import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelPipelineParams } from '../channel-pipeline.js'
import { admitChannelMessage, resolveChannelAnswerContext } from '../channel-message-admission.js'
import { resolveChannelAnswerContext as interpret } from '../channel-answer-context.js'
import { channelConfirmations } from '../channel-interactions.js'

vi.mock('../channel-answer-context.js', () => ({ resolveChannelAnswerContext: vi.fn() }))

function params(): ChannelPipelineParams {
  // Only admission's dependencies are needed; no pipeline/media services run.
  return {
    assistant: { id: 'assistant' }, userId: 'user',
    interactionScope: { channelType: 'telegram', integrationId: 'integration', conversationId: '42', senderId: '42' },
    incomingMessage: { messageId: '900', text: 'caption' },
    abortController: new AbortController(), hooks: { sendResponse: vi.fn(async () => {}) },
  } as unknown as ChannelPipelineParams
}

beforeEach(() => vi.resetAllMocks())

describe('pre-media channel admission', () => {
  it.each([{ kind: 'continue' as const }, { kind: 'continue' as const, questionAnswer: 'Approve' }])(
    'reuses admitted %j without consuming again', async answer => {
      const input = params()
      vi.mocked(interpret).mockResolvedValue(answer)
      const admittedAnswerContext = await admitChannelMessage(input)
      expect(await resolveChannelAnswerContext({ ...input, admittedAnswerContext })).toBe(answer)
      expect(interpret).toHaveBeenCalledTimes(1)
      expect(interpret).toHaveBeenCalledWith(input, expect.objectContaining({
        integrationId: 'integration', assistantId: 'assistant', userId: 'user', incoming: input.incomingMessage,
      }))
      expect(input.hooks.sendResponse).not.toHaveBeenCalled()
      expect(channelConfirmations.handle(input.interactionScope!, { kind: 'text', text: 'Stop' }).handled).toBe(false)
    },
  )

  it('interprets unsplit pipeline turns normally', async () => {
    const input = params()
    vi.mocked(interpret).mockResolvedValue({ kind: 'continue' })
    await resolveChannelAnswerContext(input)
    expect(interpret).toHaveBeenCalledWith(input, undefined)
  })

  it('sends handled replies once and removes the active turn', async () => {
    const input = params()
    vi.mocked(interpret).mockResolvedValue({ kind: 'handled', reply: 'Answered.' })
    expect(await admitChannelMessage(input)).toEqual({ kind: 'handled', reply: 'Answered.' })
    expect(input.hooks.sendResponse).toHaveBeenCalledExactlyOnceWith('Answered.')
    expect(channelConfirmations.handle(input.interactionScope!, { kind: 'text', text: 'Stop' }).handled).toBe(false)
  })

  it.each(['continue', 'handled'] as const)('Stop cancels pending %s admission with one acknowledgement', async kind => {
    const input = params()
    let release!: () => void
    vi.mocked(interpret).mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return kind === 'handled' ? { kind, reply: 'Late reply' } : { kind }
    })
    const pending = admitChannelMessage(input)
    expect(channelConfirmations.handle(input.interactionScope!, { kind: 'text', text: 'Stop' }).handled).toBe(true)
    expect(input.abortController.signal.aborted).toBe(true)
    release()
    await pending
    expect(input.hooks.sendResponse).toHaveBeenCalledExactlyOnceWith('Stopped.')
  })

  it('skips interpretation for an already aborted turn', async () => {
    const input = params()
    input.abortController.abort()
    await admitChannelMessage(input)
    expect(interpret).not.toHaveBeenCalled()
    expect(input.hooks.sendResponse).not.toHaveBeenCalled()
  })

  it('removes active registration on failure', async () => {
    const input = params()
    vi.mocked(interpret).mockRejectedValue(new Error('offline'))
    await expect(admitChannelMessage(input)).rejects.toThrow('offline')
    expect(channelConfirmations.handle(input.interactionScope!, { kind: 'text', text: 'Stop' }).handled).toBe(false)
  })
})
