import { afterEach, describe, it, expect, vi } from 'vitest'
import { createTopicIdentity, isTopicIdentity } from '../topic-identity.js'
import { classifyTopic } from '../topic-classifier.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { createRoutingProvider } from '../../providers/routing.js'
import { bindScopeSources, boundScopeSources } from '../../security/source-evidence.js'
import { ContextScopeAccumulator } from '../../security/context-scope.js'
import type { SessionContextAuthority } from '../session-state-types.js'
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

/** Delayed complete JSON, with no model or account traffic. */
function delayedProvider(name: string, delayMs: number): LLMProvider {
  const provider = mockProvider('unused')
  provider.name = name
  provider.models = []
  provider.stream = async function* (request) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(request.signal!.reason) }
      const timer = setTimeout(() => {
        request.signal?.removeEventListener('abort', abort)
        resolve()
      }, delayMs)
      request.signal?.addEventListener('abort', abort, { once: true })
    })
    yield { type: 'text_delta', text: '{"topic_label":"planning","state":"continue","confidence":0.9}' }
  }
  return provider
}

describe('[COMP:memory/topic-classifier] classifyTopic', () => {
  it.each(['yes', 'no', 'sure', 'okay'])('classifies contextual confirmation %s normally', async currentMessage => {
    const provider = mockProvider(JSON.stringify({topic_label:'planning',state:'continue',confidence:0.9}))
    const stream = vi.spyOn(provider, 'stream')
    await classifyTopic({provider,model:'mock',currentMessage,recentUserTurns:[],replyToText:null,knownTopicsThisSession:[]})
    expect(stream).toHaveBeenCalledOnce()
  })
  it('honors host exclusion for a greeting with non-text context', async () => {
    const provider = mockProvider(JSON.stringify({topic_label:'planning',state:'continue',confidence:0.9}))
    const stream = vi.spyOn(provider, 'stream')
    await classifyTopic({provider,model:'mock',currentMessage:'hi',recentUserTurns:[],replyToText:null,
      knownTopicsThisSession:[],allowTrivialShortcut:false})
    expect(stream).toHaveBeenCalledOnce()
  })

  it('continues an admitted topic for a connectivity probe without a provider call', async () => {
    const provider = mockProvider('unused'), stream = vi.spyOn(provider, 'stream'), check = vi.fn(async () => {})
    const result = await classifyTopic({provider,model:'mock',recentUserTurns:[{text:'Fictional topic',topicLabel:'planning'}],
      replyToText:null,currentMessage:'test',knownTopicsThisSession:['planning'],assertInputAuthority:check})
    expect(result).toMatchObject({topic_label:'planning',state:'continue',confidence:0,usage:null})
    expect(stream).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('still refuses a trivial result when the final authority check fails', async () => {
    let checks = 0
    const provider = mockProvider('unused'), stream = vi.spyOn(provider, 'stream')
    await expect(classifyTopic({provider,model:'mock',recentUserTurns:[],replyToText:null,currentMessage:'ping',knownTopicsThisSession:[],
      assertInputAuthority:async()=>{if(++checks===2)throw Object.assign(new Error('revoked'),{reason:'authority_changed',retrySafe:false})}}))
      .rejects.toMatchObject({reason:'authority_changed'})
    expect(stream).not.toHaveBeenCalled()
  })

  it('keeps the provider path for an explicit reply target even with a short acknowledgment', async () => {
    const provider = mockProvider('{"topic_label":"other","state":"continue","confidence":0.8}'), stream = vi.spyOn(provider,'stream')
    await classifyTopic({provider,model:'mock',recentUserTurns:[],replyToText:'Fictional distinct subject',currentMessage:'yes',knownTopicsThisSession:[]})
    expect(stream).toHaveBeenCalledOnce()
  })

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

  it.each([
    ['openai-codex', 'gpt-6-luna'],
    ['routing', 'gpt-6-luna'],
    // An explicit configured endpoint can serve the standard fallback id.
    ['openai-compat:workspace', 'gpt-6-luna'],
  ])('allows delayed %s standard classification within the bounded budget', async (name, model) => {
    vi.useFakeTimers()
    const provider = delayedProvider(name, 4_500)
    const stream = vi.spyOn(provider, 'stream')
    const returned = vi.fn()
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [] })
    void classification.then(returned)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(returned).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_499)
    await expect(classification).resolves.toMatchObject({ topic_label: 'planning', confidence: 0.9 })
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'low' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['openai-codex', 'gpt-6-luna', 8_000],
    ['routing', 'gpt-6-luna', 8_000],
    ['gemini', 'gemini-3.6-flash-standard', 2_000],
    ['routing', 'gemini-3.6-flash-standard', 2_000],
    ['routing', 'unknown-codex-looking-model', 2_000],
    ['openai-compat:workspace', 'unknown-model', 2_000],
    ['routing', 'qwen3.5-flash', 2_000],
  ])('enforces exact budget for %s / %s', async (name, model, budget) => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aborted = vi.fn()
    const provider = slowProvider(aborted)
    provider.name = name
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [] })
    await vi.advanceTimersByTimeAsync(budget - 1)
    expect(aborted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(aborted).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('[topic-classifier] deadline exceeded; using uncategorized fallback', { timeoutMs: budget })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('retains fallback when the Codex registry route is unavailable (entitlement=%s)', async entitlement => {
    vi.useFakeTimers()
    const codex = delayedProvider('openai-codex', 4_500)
    const stream = vi.spyOn(codex, 'stream')
    const availability = Object.assign(new Set(['openai-codex']), { isModelAvailable: () => false })
    const provider = createRoutingProvider(entitlement ? { 'openai-codex': codex } : {},
      entitlement ? { availability } : undefined)
    await expect(classifyTopic({ provider, model: 'gpt-6-luna', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [] }))
      .resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(stream).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a delayed Codex answer through the real generic router', async () => {
    vi.useFakeTimers()
    const provider = createRoutingProvider({ 'openai-codex': delayedProvider('openai-codex', 3_500) })
    const classification = classifyTopic({ provider, model: 'gpt-6-luna', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [] })
    await vi.advanceTimersByTimeAsync(3_500)
    await expect(classification).resolves.toMatchObject({ topic_label: 'planning', confidence: 0.9 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels Codex with the canonical lifecycle and preserves the authority refusal', async () => {
    vi.useFakeTimers()
    const controller = new AbortController(), aborted = vi.fn()
    const provider = Object.assign(slowProvider(aborted), { name: 'openai-codex' })
    const assertCurrent = vi.fn(async () => {})
    const authority = {
      execution: { security: { authority: { assertCurrent } }, lifecycle: { abortSignal: controller.signal } },
      accumulator: new ContextScopeAccumulator(),
    } as unknown as SessionContextAuthority
    const options = bindScopeSources({ provider, model: 'gpt-6-luna', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], authority, assertInputAuthority: async () => {} }, [{
      workspaceId: 'fixture-workspace', userId: null, assistantId: null, sensitivity: 'confidential',
      compartments: ['finance'], projectIds: [], resourceKind: 'memory', resourceId: 'fixture-memory', version: '1',
    }])
    const classification = classifyTopic(options)
    const rejected = expect(classification).rejects.toMatchObject({ reason: 'authority_changed' })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await rejected
    expect(aborted).toHaveBeenCalledOnce()
    expect(assertCurrent).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the bound source snapshot and fresh final admission after the Codex timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = Object.assign(slowProvider(vi.fn()), { name: 'openai-codex' })
    const accumulator = new ContextScopeAccumulator()
    const authority = {
      execution: { security: { authority: { assertCurrent: async () => {} } },
        lifecycle: { abortSignal: new AbortController().signal } }, accumulator,
    } as unknown as SessionContextAuthority
    const source = { workspaceId: 'fixture-workspace', userId: null, assistantId: null, sensitivity: 'confidential' as const,
      compartments: ['finance'], projectIds: [], resourceKind: 'memory', resourceId: 'fixture-memory', version: '1' }
    const check = vi.fn(async () => {})
    const options = bindScopeSources({ provider, model: 'gpt-6-luna', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], authority, assertInputAuthority: check }, [source])
    const classification = classifyTopic(options)
    await vi.advanceTimersByTimeAsync(7_999)
    const checksBeforeTimeout = check.mock.calls.length
    // Later evidence must not replace the admitted classifier's source snapshot.
    accumulator.note({ sources: [{ ...source, resourceId: 'later-evidence' }] })
    await vi.advanceTimersByTimeAsync(1)
    const result = await classification
    expect(result).toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(check.mock.calls.length).toBeGreaterThan(checksBeforeTimeout)
    expect(boundScopeSources(result)).toEqual([source])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('narrows the Codex budget to an explicit host deadline', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aborted = vi.fn(), provider = slowProvider(aborted)
    provider.name = 'openai-codex'
    const deadlineAt = Date.now() + 700
    const decisionRuntime = executionFixture({ mode: 'llm_only', llm: provider })
    const run = vi.spyOn(decisionRuntime, 'run')
    const classification = classifyTopic({ provider, model: 'gpt-6-luna', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], deadlineAt, decisionRuntime })
    await vi.advanceTimersByTimeAsync(699)
    expect(aborted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ deadlineAt }) }))
    expect(aborted).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['gemini-3.6-flash-standard', 2_000], ['gpt-6-luna', 8_000]] as const)('does not re-enter the original authority window after a timed-out classifier returns (%s)', async (model, budget) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const assertInputAuthority = vi.fn(async () => {})
    let releaseTransport!: () => void
    const transport = new Promise<void>((resolve) => { releaseTransport = resolve })
    let signal: AbortSignal | undefined
    const provider = mockProvider('unused')
    provider.name = 'routing'
    provider.stream = async function* (request) {
      signal = request.signal
      // A transport can finish unwinding after cancellation and fallback.
      // Hold that completion until the caller has started its next phase.
      await transport
      throw request.signal?.reason ?? new Error('Fictional delayed transport cancellation')
    }
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], assertInputAuthority })

    await vi.advanceTimersByTimeAsync(budget)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(signal?.aborted).toBe(true)
    const checksAtReturn = assertInputAuthority.mock.calls.length

    releaseTransport()
    await vi.advanceTimersByTimeAsync(0)

    expect(assertInputAuthority).toHaveBeenCalledTimes(checksAtReturn)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['gemini-3.6-flash-standard', 2_000], ['gpt-6-luna', 8_000]] as const)('drains a losing cascade authority check before returning the timeout fallback (%s)', async (model, budget) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let checksStarted = 0
    let activeChecks = 0
    const assertInputAuthority = vi.fn(async () => {
      if (++checksStarted === 1) return
      activeChecks++
      try { await new Promise(resolve => setTimeout(resolve, 20)) }
      finally { activeChecks-- }
    })
    const provider = mockProvider('unused')
    provider.name = 'routing'
    const decisionRuntime = executionFixture({ mode: 'llm_only', llm: provider })
    decisionRuntime.run = async ({ request, operation }) => {
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }))
      // A canceled cascade can have several authority boundaries while it
      // unwinds. Its next continuation can run before the host's await resumes.
      for (let i = 0; i < 10; i++) await operation.assertInputAuthority!()
      return { runId: request.runId, result: operation.safeFailure('timeout'), path: 'safe_default', attempts: 0, failureKind: 'timeout' }
    }
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], decisionRuntime, assertInputAuthority })

    await vi.advanceTimersByTimeAsync(budget + 40)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    const activeChecksAtReturn = activeChecks
    const checksAtReturn = assertInputAuthority.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)

    expect(activeChecksAtReturn).toBe(0)
    expect(assertInputAuthority).toHaveBeenCalledTimes(checksAtReturn)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one slow final admission for timeout recovery instead of checking twice', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = mockProvider('unused')
    const decisionRuntime = executionFixture({ mode: 'llm_only', llm: provider })
    decisionRuntime.run = () => new Promise(() => {})
    const check = vi.fn(async () => {
      if (check.mock.calls.length > 1) await new Promise(resolve => setTimeout(resolve, 5_000))
    })
    const returned = vi.fn()
    const classification = classifyTopic({ provider, model: 'mock', recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], decisionRuntime, assertInputAuthority: check })
    void classification.then(returned)

    await vi.advanceTimersByTimeAsync(6_999)
    expect(returned).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(returned).toHaveBeenCalledWith(expect.objectContaining({ topic_label: '(uncategorized)', confidence: 0 }))
    expect(check).toHaveBeenCalledTimes(2) // Initial admission plus one fresh final check.
    expect(warning).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['gemini-3.6-flash-standard', 2_000], ['gpt-6-luna', 8_000]] as const)('passes the same total budget through the decision runtime to its LLM transport (%s)', async (model, budget) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aborted = vi.fn()
    const provider = Object.assign(slowProvider(aborted), { name: 'routing' })
    const decisionRuntime = executionFixture({ mode: 'llm_only', llm: provider })
    const run = vi.spyOn(decisionRuntime, 'run')
    const startedAt = Date.now()
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], decisionRuntime })

    await vi.advanceTimersByTimeAsync(budget)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      signal: expect.any(AbortSignal), deadlineAt: startedAt + budget,
    }) }))
    expect(aborted).toHaveBeenCalledOnce()
    expect(aborted.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['gemini-3.6-flash-standard', 2_000], ['gpt-6-luna', 8_000]] as const)('cancels the transport with the caller and propagates its current authority refusal (%s)', async (model, budget) => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = Object.assign(new Error('Synthetic turn authority revoked'), { reason: 'authority_changed', retrySafe: false })
    const controller = new AbortController()
    const aborted = vi.fn()
    const classification = classifyTopic({ provider: Object.assign(slowProvider(aborted), { name: 'routing' }), model, recentUserTurns: [], replyToText: null,
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

  it.each([['gemini-3.6-flash-standard', 2_000], ['gpt-6-luna', 8_000]] as const)('cancels decision-provider and follow-up transports at shorter cascade deadlines (%s)', async (model, budget) => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const decisionAborted = vi.fn()
    const llmAborted = vi.fn()
    const provider = slowProvider(llmAborted)
    provider.name = 'routing'
    const decisionRuntime = executionFixture({
      llm: provider,
      primary: fixtureDecisionProvider(async (request) => new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => {
          decisionAborted(request.signal)
          reject(request.signal!.reason)
        }, { once: true })
      })),
    })
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], decisionRuntime })

    await vi.advanceTimersByTimeAsync(100)
    await expect(classification).resolves.toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(decisionAborted).toHaveBeenCalledOnce()
    expect(llmAborted).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('[topic-classifier] decision deadline exceeded; using uncategorized fallback')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['gemini-3.6-flash-standard', 2_000], ['gpt-6-luna', 8_000]] as const)('waits for an in-flight authority refusal when the classification deadline expires (%s)', async (model, budget) => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = Object.assign(new Error('Synthetic input authority revoked'), { reason: 'authority_changed', retrySafe: false })
    let rejectAuthority!: (error: Error) => void
    const pendingAuthority = new Promise<void>((_resolve, reject) => { rejectAuthority = reject })
    let providerComplete = false
    const provider = mockProvider('unused')
    provider.name = 'routing'
    provider.stream = async function* () {
      yield { type: 'text_delta', text: '{"topic_label":"planning","state":"continue","confidence":0.9}' } as StreamChunk
      providerComplete = true
    }
    const check = vi.fn(async () => { if (providerComplete) await pendingAuthority })
    const classification = classifyTopic({ provider, model, recentUserTurns: [], replyToText: null,
      currentMessage: 'Fictional request', knownTopicsThisSession: [], assertInputAuthority: check })
    const rejected = expect(classification).rejects.toBe(refusal)
    let settled = false
    void classification.then(() => { settled = true }, () => { settled = true })

    await vi.advanceTimersByTimeAsync(budget)
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
          { questionId: 'topic', kind: 'choice', value: 'k1', evidence: { source: 'native_distribution', confidence: 0.91 } },
        ],
      })),
    })
    const result = await classifyTopic({
      provider: llm,
      model: 'mock',
      recentUserTurns: [{ text: 'Earlier pricing discussion', topicLabel: 'other topic' }],
      replyToText: null,
      currentMessage: 'Back to that pricing point',
      knownTopicsThisSession: ['pricing review'],
      decisionRuntime,
    })
    expect(result).toMatchObject({ topic_label: 'pricing review', state: 'resume', confidence: 0.91 })
    expect(llmCalls).toBe(0)
  })

  describe('insufficient topic signal decisions', () => {
    const cases = ['continue', 'resume'].flatMap(state =>
      [[], ['pricing review']].map(knownTopics => ({ state, knownTopics })))

    it.each(cases)('terminates $state with known topics $knownTopics and retains native usage', async ({ state, knownTopics }) => {
      const llm = mockProvider('unused')
      const stream = vi.spyOn(llm, 'stream')
      const decisionRuntime = executionFixture({
        llm,
        primary: fixtureDecisionProvider(async request => ({
          providerId: 'fixture-decision', model: request.model,
          usage: { inputTokens: 37, outputTokens: 4 },
          answers: [
            { questionId: 'state', kind: 'choice', value: state, evidence: { source: 'native_distribution', confidence: 0.9 } },
            { questionId: 'topic', kind: 'choice', value: 'unknown', evidence: { source: 'native_distribution', confidence: 0.9 } },
          ],
        })),
      })
      const run = decisionRuntime.run.bind(decisionRuntime)
      const outcomes: unknown[] = []
      decisionRuntime.run = async input => {
        const outcome = await run(input)
        outcomes.push(outcome)
        return outcome
      }
      const result = await classifyTopic({ provider: llm, model: 'mock', recentUserTurns: [],
        replyToText: null, currentMessage: 'Fictional ambiguous request', knownTopicsThisSession: knownTopics, decisionRuntime })
      expect(result).toMatchObject({ topic_label: '(uncategorized)', state: 'continue', confidence: 0,
        usage: { inputTokens: 37, outputTokens: 4 }, model: 'fixture-decision-v1' })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).not.toHaveProperty('failureKind')
      expect(stream).not.toHaveBeenCalled()
    })

    it.each([
      { state: 'continue', topic: 'unknown', confidence: 0.2, policy: { reviewBelow: 0.5 }, reason: 'uncertain' },
      { state: 'resume', topic: 'unknown', confidence: 0.2, policy: { reviewBelow: 0.5 }, reason: 'uncertain' },
      { state: 'shift', topic: 'unknown', confidence: 0.9, policy: null, reason: 'invalid_response' },
      { state: 'cross-topic', topic: 'unknown', confidence: 0.9, policy: null, reason: 'invalid_response' },
      { state: 'continue', topic: 'new', confidence: 0.9, policy: null, reason: 'invalid_response' },
      { state: 'resume', topic: 'new', confidence: 0.9, policy: null, reason: 'invalid_response' },
    ])('preserves $reason for $state / $topic', async ({ state, topic, confidence, policy, reason }) => {
      const llm = mockProvider('{"topic":"new","state":"shift","confidence":0.8}')
      const stream = vi.spyOn(llm, 'stream')
      const decisionRuntime = executionFixture({ llm, profilePolicy: policy,
        primary: fixtureDecisionProvider(async request => ({ providerId: 'fixture-decision', model: request.model,
          answers: [
            { questionId: 'state', kind: 'choice', value: state, evidence: { source: 'native_distribution', confidence } },
            { questionId: 'topic', kind: 'choice', value: topic, evidence: { source: 'native_distribution', confidence } },
          ],
        })),
      })
      const run = decisionRuntime.run.bind(decisionRuntime)
      const decisions: unknown[] = []
      decisionRuntime.run = input => {
        const decide = input.operation.decide
        input.operation.decide = (response, context) => {
          const decision = decide(response, context)
          decisions.push(decision)
          return decision
        }
        return run(input)
      }
      const result = await classifyTopic({ provider: llm, model: 'mock', recentUserTurns: [], replyToText: null,
        currentMessage: 'Fictional ambiguous request', knownTopicsThisSession: [], decisionRuntime })
      expect(decisions).toContainEqual({ kind: reason === 'uncertain' ? 'follow_up' : 'unavailable', reason })
      if (reason === 'uncertain') {
        expect(isTopicIdentity(result.topic_label)).toBe(true)
        expect(stream).toHaveBeenCalledTimes(1)
      } else {
        expect(result.confidence).toBe(0)
        expect(stream).not.toHaveBeenCalled()
      }
    })

    it('does not turn a native insufficient-signal answer into an authority bypass', async () => {
      const llm = mockProvider('unused')
      const stream = vi.spyOn(llm, 'stream')
      const refusal = Object.assign(new Error('Synthetic authority revoked'), { reason: 'authority_changed', retrySafe: false })
      let revoked = false
      const decisionRuntime = executionFixture({ llm,
        primary: fixtureDecisionProvider(async request => {
          revoked = true
          return { providerId: 'fixture-decision', model: request.model, answers: [
            { questionId: 'state', kind: 'choice', value: 'continue', evidence: { source: 'native_distribution', confidence: 0.9 } },
            { questionId: 'topic', kind: 'choice', value: 'unknown', evidence: { source: 'native_distribution', confidence: 0.9 } },
          ] }
        }),
      })
      await expect(classifyTopic({ provider: llm, model: 'mock', recentUserTurns: [], replyToText: null,
        currentMessage: 'Fictional ambiguous request', knownTopicsThisSession: [], decisionRuntime,
        assertInputAuthority: async () => { if (revoked) throw refusal },
      })).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(stream).not.toHaveBeenCalled()
    })

    it('keeps missing, wrong-kind, and unknown combinations unavailable', async () => {
      const llm = mockProvider('unused')
      const decisionRuntime = executionFixture({ llm, mode: 'llm_only' })
      const run = decisionRuntime.run.bind(decisionRuntime)
      decisionRuntime.run = input => {
        const choice = (questionId: string, value: string) => ({ questionId, kind: 'choice' as const, value,
          evidence: { source: 'native_distribution' as const, confidence: 0.9 } })
        const state = choice('state', 'continue'), topic = choice('topic', 'unknown')
        const malformed = [[], [state], [topic],
          [{ questionId: 'state', kind: 'boolean' as const, value: true, evidence: state.evidence }, topic],
          [state, { questionId: 'topic', kind: 'boolean' as const, value: true, evidence: topic.evidence }],
          [choice('state', 'unknown'), topic], [state, choice('topic', 'not-a-token')]]
        for (const answers of malformed) {
          expect(input.operation.decide({ providerId: 'fixture-decision',
            model: { catalogId: 'fixture-decision', wireId: 'fixture-decision-v1' }, answers }, {}))
            .toEqual({ kind: 'unavailable', reason: 'invalid_response' })
        }
        return run(input)
      }
      await classifyTopic({ provider: llm, model: 'mock', recentUserTurns: [], replyToText: null,
        currentMessage: 'Fictional ambiguous request', knownTopicsThisSession: [], decisionRuntime })
    })
  })

  it('allocates a native new topic without an LLM call', async () => {
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
          { questionId: 'topic', kind: 'choice', value: 'new', evidence: { source: 'native_distribution', confidence: 0.9 } },
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
    expect(result.state).toBe('shift')
    expect(isTopicIdentity(result.topic_label)).toBe(true)
    expect(llmCalls).toBe(0)
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
      currentMessage: 'Fictional classification request',
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
      currentMessage: 'Fictional classification request',
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
      currentMessage: 'Fictional classification request',
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
      currentMessage: 'Fictional classification request',
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
      currentMessage: 'Fictional classification request',
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
      currentMessage: 'Fictional classification request',
      knownTopicsThisSession: [],
    })
    expect(result.confidence).toBe(0)
  })
})
