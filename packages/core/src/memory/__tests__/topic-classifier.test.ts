import { afterEach, describe, it, expect, vi } from 'vitest'
import { classifyTopic } from '../topic-classifier.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'

/**
 * Build a minimal mock provider whose stream emits the given JSON as a
 * single text_delta. Used to exercise classifyTopic's parsing without
 * hitting a real model.
 */
function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
    },
  } as unknown as LLMProvider
}

/** A transport that makes progress until its upstream cancellation fires. */
function slowProvider(onAbort: (signal: AbortSignal) => void): LLMProvider {
  const provider = mockProvider('unused')
  provider.stream = async function* (request) {
    const signal = request.signal!
    while (true) {
      yield { type: 'thinking_delta', text: '.' } as StreamChunk
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, 100)
        const abort = () => {
          clearTimeout(timer)
          onAbort(signal)
          reject(signal.reason)
        }
        signal.addEventListener('abort', abort, { once: true })
      })
    }
  }
  return provider
}

describe('[COMP:memory/topic-classifier] classifyTopic', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requests low thinking and cancels a progressing direct transport after two seconds', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aborted = vi.fn()
    const provider = slowProvider(aborted)
    const stream = vi.spyOn(provider, 'stream')
    const classification = classifyTopic({ provider, model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [] })

    await vi.advanceTimersByTimeAsync(1_999)
    expect(aborted).not.toHaveBeenCalled()
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'low', signal: expect.any(AbortSignal) }))
    await vi.advanceTimersByTimeAsync(1)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', state: 'continue', confidence: 0 })
    expect(aborted).toHaveBeenCalledOnce()
    expect(aborted.mock.calls[0]![0].aborted).toBe(true)
    expect(warning).toHaveBeenCalledWith('[topic-classifier] deadline exceeded; using uncategorized fallback', { timeoutMs: 2_000 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes the same total budget through the decision runtime to its LLM transport', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aborted = vi.fn()
    const provider = slowProvider(aborted)
    const decisionRuntime = executionFixture({ mode: 'llm_only', llm: provider })
    const run = vi.spyOn(decisionRuntime, 'run')
    const startedAt = Date.now()
    const classification = classifyTopic({ provider, model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], decisionRuntime })

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      signal: expect.any(AbortSignal), deadlineAt: startedAt + 2_000,
    }) }))
    expect(aborted).toHaveBeenCalledOnce()
    expect(aborted.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the transport with the caller and propagates its current authority refusal', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = Object.assign(new Error('Synthetic turn authority revoked'), { reason: 'authority_changed', retrySafe: false })
    const controller = new AbortController()
    const aborted = vi.fn()
    const classification = classifyTopic({ provider: slowProvider(aborted), model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], signal: controller.signal,
      assertInputAuthority: async () => { if (controller.signal.aborted) throw refusal } })
    const rejected = expect(classification).rejects.toBe(refusal)

    await vi.advanceTimersByTimeAsync(100)
    controller.abort(refusal)
    await rejected
    expect(aborted).toHaveBeenCalledOnce()
    expect(warning).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels decision-provider and follow-up transports at shorter cascade deadlines', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const decisionAborted = vi.fn()
    const llmAborted = vi.fn()
    const provider = slowProvider(llmAborted)
    const decisionRuntime = executionFixture({
      llm: provider,
      primary: fixtureDecisionProvider(async (request) => new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => {
          decisionAborted(request.signal)
          reject(request.signal!.reason)
        }, { once: true })
      })),
    })
    const classification = classifyTopic({ provider, model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], decisionRuntime })

    await vi.advanceTimersByTimeAsync(100)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(decisionAborted).toHaveBeenCalledOnce()
    expect(llmAborted).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('[topic-classifier] decision deadline exceeded; using uncategorized fallback')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for an in-flight authority refusal when the classification deadline expires', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = Object.assign(new Error('Synthetic input authority revoked'), { reason: 'authority_changed', retrySafe: false })
    let rejectAuthority!: (error: Error) => void
    const pendingAuthority = new Promise<void>((_resolve, reject) => { rejectAuthority = reject })
    let providerComplete = false
    const provider = mockProvider('unused')
    provider.stream = async function* () {
      yield { type: 'text_delta', text: '{"topic_label":"planning","state":"continue","confidence":0.9}' } as StreamChunk
      providerComplete = true
    }
    const check = vi.fn(async () => { if (providerComplete) await pendingAuthority })
    const classification = classifyTopic({ provider, model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], assertInputAuthority: check })
    const rejected = expect(classification).rejects.toBe(refusal)
    let settled = false
    void classification.then(() => { settled = true }, () => { settled = true })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
    expect(check).toHaveBeenCalledTimes(3)
    rejectAuthority(refusal)
    await rejected
    expect(warning).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a wrapped provider authority refusal rather than an uncategorized fallback', async () => {
    const refusal = Object.assign(new Error('Synthetic provider refused current input'), { reason: 'authority_changed', retrySafe: false })
    const provider = mockProvider('unused')
    provider.stream = async function* () { throw new Error('Synthetic provider wrapper', { cause: refusal }) }
    await expect(classifyTopic({ provider, model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [] })).rejects.toMatchObject({ cause: refusal })
  })

  it('accepts a terminal exact known-label decision without an LLM call', async () => {
    let llmCalls = 0
    const llm = mockProvider('{"topic_label":"wrong","state":"shift","confidence":1}')
    const originalStream = llm.stream.bind(llm)
    llm.stream = ((...args: Parameters<LLMProvider['stream']>) => {
      llmCalls++
      return originalStream(...args)
    }) as LLMProvider['stream']
    const decisionRuntime = executionFixture({
      llm,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [
          { questionId: 'state', kind: 'choice', value: 'resume', evidence: { source: 'native_distribution', confidence: 0.94 } },
          { questionId: 'topic', kind: 'choice', value: 'pricing review', evidence: { source: 'native_distribution', confidence: 0.91 } },
        ],
      })),
    })
    const result = await classifyTopic({
      provider: llm,
      model: 'mock',
      recentUserTurns: [{ text: 'Earlier pricing discussion', topicLabel: 'pricing review' }],
      replyToText: null,
      currentMessage: 'Back to that pricing point',
      knownTopicsThisSession: ['pricing review'],
      decisionRuntime,
    })
    expect(result).toMatchObject({ topic_label: 'pricing review', state: 'resume', confidence: 0.91 })
    expect(llmCalls).toBe(0)
  })

  it('uses one LLM completion to generate a new topic label', async () => {
    let llmCalls = 0
    const base = mockProvider('{"topic_label":"launch planning","state":"shift","confidence":0.8}')
    const originalStream = base.stream.bind(base)
    base.stream = ((...args: Parameters<LLMProvider['stream']>) => {
      llmCalls++
      return originalStream(...args)
    }) as LLMProvider['stream']
    const decisionRuntime = executionFixture({
      llm: base,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [
          { questionId: 'state', kind: 'choice', value: 'shift', evidence: { source: 'native_distribution', confidence: 0.9 } },
          { questionId: 'topic', kind: 'choice', value: '__new_topic__', evidence: { source: 'native_distribution', confidence: 0.9 } },
        ],
      })),
    })
    const result = await classifyTopic({
      provider: base,
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'Plan our product launch',
      knownTopicsThisSession: [],
      decisionRuntime,
    })
    expect(result).toMatchObject({ topic_label: 'launch planning', state: 'shift' })
    expect(llmCalls).toBe(1)
  })

  it('parses a continue classification', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"brian cheng research","state":"continue","confidence":0.9}'),
      model: 'mock',
      recentUserTurns: [{ text: 'Tell me about Brian', topicLabel: 'brian cheng research' }],
      replyToText: null,
      currentMessage: 'what else does he do?',
      knownTopicsThisSession: ['brian cheng research'],
    })
    expect(result.topic_label).toBe('brian cheng research')
    expect(result.state).toBe('continue')
    expect(result.confidence).toBe(0.9)
  })

  it('parses shift state', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"movie discussion","state":"shift","confidence":0.8}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'what do you know about Eternal Sunshine?',
      knownTopicsThisSession: [],
    })
    expect(result.state).toBe('shift')
    expect(result.topic_label).toBe('movie discussion')
  })

  it('parses cross-topic and keeps related_topics', async () => {
    const result = await classifyTopic({
      provider: mockProvider(
        '{"topic_label":"brian cheng research","state":"cross-topic","confidence":0.85,"related_topics":["cyn birthday"]}',
      ),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'should I introduce Brian to Cyn?',
      knownTopicsThisSession: ['brian cheng research', 'cyn birthday'],
    })
    expect(result.state).toBe('cross-topic')
    expect(result.related_topics).toEqual(['cyn birthday'])
  })

  it('normalizes labels (lowercase + strip trailing punctuation)', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"  Brian Cheng Research!  ","state":"continue","confidence":0.7}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.topic_label).toBe('brian cheng research')
  })

  it('tolerates markdown fences around JSON', async () => {
    const result = await classifyTopic({
      provider: mockProvider('```json\n{"topic_label":"x","state":"continue","confidence":0.5}\n```'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.topic_label).toBe('x')
    expect(result.confidence).toBe(0.5)
  })

  it('falls back on parse failure', async () => {
    const result = await classifyTopic({
      provider: mockProvider('sorry, I cannot classify this'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.topic_label).toBe('(uncategorized)')
    expect(result.state).toBe('continue')
    expect(result.confidence).toBe(0)
  })

  it('clamps out-of-range confidence', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"x","state":"continue","confidence":2.5}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.confidence).toBe(1)
  })

  it('ignores unknown state and defaults to continue', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"x","state":"nonsense","confidence":0.6}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.state).toBe('continue')
  })

  it('falls back when the provider throws', async () => {
    const provider = {
      createSession() {
        return { thoughtSignature: undefined } as never
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamChunk> {
        throw new Error('model unavailable')
      },
    } as unknown as LLMProvider
    const result = await classifyTopic({
      provider,
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.confidence).toBe(0)
  })
})
