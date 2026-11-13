import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'
import { bindScopeSources, boundScopeSources } from '../../security/source-evidence.js'
import { ContextScopeAccumulator } from '../../security/context-scope.js'
import type { SessionContextAuthority } from '../../memory/session-state-types.js'
import { classifySplit } from '../splitter.js'

const MESSAGE = 'Compare the fictional Acorn and Birch markets, then separately map their regulatory risks.'

function providerWith(rawText: string): LLMProvider {
  async function* stream(): AsyncIterable<StreamChunk> {
    yield { type: 'message_start', model: 'fixture-llm' }
    yield { type: 'text_delta', text: rawText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 8 },
    }
  }
  return {
    name: 'fixture-llm',
    models: ['fixture-llm'],
    stream: vi.fn(() => stream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

describe('[COMP:workers/splitter] classifySplit', () => {
  it('preserves the LLM-only split result shape', async () => {
    const provider = providerWith('{"split":true,"tasks":["Research Acorn.","Research Birch."]}')
    const result = await classifySplit({ provider, message: MESSAGE })
    expect(result).toEqual({
      tasks: ['Research Acorn.', 'Research Birch.'],
      usage: { inputTokens: 20, outputTokens: 8 },
      model: 'fixture-llm',
    })
  })

  it('accepts a terminal no-split decision without an LLM call', async () => {
    const llm = providerWith('{"split":true,"tasks":["A","B"]}')
    const runtime = executionFixture({
      llm,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{
          kind: 'boolean',
          questionId: 'split',
          value: false,
          pTrue: 0.03,
          evidence: { source: 'native_distribution' },
        }],
      })),
    })

    const result = await classifySplit({ provider: llm, message: MESSAGE, decisionRuntime: runtime })

    expect(result.tasks).toBeNull()
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('uses exactly one LLM generation when the decision says to split', async () => {
    const llm = providerWith('{"split":true,"tasks":["Research Acorn.","Research Birch."]}')
    const runtime = executionFixture({
      llm,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{
          kind: 'boolean',
          questionId: 'split',
          value: true,
          pTrue: 0.96,
          evidence: { source: 'native_distribution' },
        }],
      })),
    })

    const result = await classifySplit({ provider: llm, message: MESSAGE, decisionRuntime: runtime })

    expect(result.tasks).toEqual(['Research Acorn.', 'Research Birch.'])
    expect(llm.stream).toHaveBeenCalledOnce()
  })

  it('rejects unbounded generated task lists', async () => {
    const provider = providerWith('{"split":true,"tasks":["A","B","C","D"]}')
    const result = await classifySplit({ provider, message: MESSAGE })
    expect(result.tasks).toBeNull()
  })
})


function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function hangingProvider() {
  const provider = providerWith('')
  const aborted = vi.fn()
  provider.stream = vi.fn(async function* (request) {
    await new Promise<void>((_, reject) => {
      request.signal!.addEventListener('abort', () => { aborted(); reject(request.signal!.reason) }, { once: true })
    })
  })
  return { provider, aborted }
}

const refusal = () => Object.assign(new Error('source changed'), { reason: 'authority_changed', retrySafe: false })
afterEach(() => vi.useRealTimers())

describe('splitter continuous authority and cancellation', () => {
  it('keeps the historical literal model and generation settings', async () => {
    const provider = providerWith('{"split":false}')
    await classifySplit({ provider, message: MESSAGE })
    expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.5-flash-lite', maxTokens: 512, temperature: 0 }))
  })

  it('snapshots authored input and provider implementation before an awaited proof', async () => {
    const gate = deferred(), provider = providerWith('{"split":false}')
    const original = provider.stream
    const check = vi.fn(async () => { await gate.promise })
    const options = { provider, message: MESSAGE, model: 'original', assertInputAuthority: check }
    const result = classifySplit(options)
    options.message = 'tampered'; options.model = 'tampered'
    const replacement = vi.fn(); provider.stream = replacement
    gate.resolve()
    await result
    expect(replacement).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalledWith(expect.objectContaining({ model: 'original', messages: [{ role: 'user', content: MESSAGE }] }))
  })

  it('returns no split at the exact host deadline, aborting a delayed legacy stream', async () => {
    vi.useFakeTimers()
    const { provider, aborted } = hangingProvider(), check = vi.fn(async () => {})
    const result = classifySplit({ provider, message: MESSAGE, assertInputAuthority: check, deadlineAt: Date.now() + 8000 })
    let settled = false; void result.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(7999)
    expect(settled).toBe(false)
    const checks = check.mock.calls.length
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ tasks: null, usage: null, model: null })
    expect(check.mock.calls.length).toBeGreaterThan(checks)
    expect(aborted).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['primary', 'fallback'])('aborts delayed %s and closes callback entries after terminal', async phase => {
    vi.useFakeTimers()
    const { provider, aborted } = hangingProvider()
    let lateCheck: (() => Promise<void>) | undefined
    const primaryAborted = vi.fn(), check = vi.fn(async () => {})
    const primary = fixtureDecisionProvider(async request => {
      lateCheck = request.assertInputAuthority
      if (phase === 'fallback') throw new Error('primary unavailable')
      await new Promise<void>((_, reject) => request.signal!.addEventListener('abort', () => {
        primaryAborted(); reject(request.signal!.reason)
      }, { once: true }))
      throw new Error('unreachable')
    })
    const result = classifySplit({ provider, message: MESSAGE, assertInputAuthority: check,
      deadlineAt: Date.now() + 8000,
      decisionRuntime: executionFixture({ llm: provider, primary, totalTimeoutMs: 60000, primaryTimeoutMs: 20000 }) })
    await vi.advanceTimersByTimeAsync(8000)
    expect((await result).tasks).toBeNull()
    expect(phase === 'primary' ? primaryAborted : aborted).toHaveBeenCalledOnce()
    const count = check.mock.calls.length
    await expect(lateCheck!()).rejects.toThrow()
    expect(check).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['primary', 'fallback'])('propagates caller cancellation during %s', async phase => {
    vi.useFakeTimers()
    const { provider } = hangingProvider(), caller = new AbortController()
    const primary = fixtureDecisionProvider(async request => {
      if (phase === 'fallback') throw new Error('unavailable')
      await new Promise<void>((_, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }))
      throw new Error('unreachable')
    })
    const result = classifySplit({ provider, message: MESSAGE, signal: caller.signal,
      decisionRuntime: executionFixture({ llm: provider, primary, totalTimeoutMs: 60000, primaryTimeoutMs: 20000 }) })
    const reason = new Error('explicit adaptive cancel')
    const rejected = expect(result).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(1)
    caller.abort(reason)
    await rejected
  })

  it.each(['deadline', 'caller'])('joins a pending sticky source refusal before %s completion', async kind => {
    vi.useFakeTimers()
    const gate = deferred(), entered = deferred(), caller = new AbortController()
    const error = refusal()
    const check = vi.fn(async () => { entered.resolve(); await gate.promise; throw error })
    const provider = providerWith('{"split":false}')
    const result = classifySplit({ provider, message: MESSAGE, signal: caller.signal, assertInputAuthority: check, deadlineAt: Date.now() + 8 })
    const rejected = expect(result).rejects.toBe(error)
    await entered.promise
    let settled = false; void result.catch(() => { settled = true })
    if (kind === 'caller') caller.abort(new Error('explicit cancel'))
    await vi.advanceTimersByTimeAsync(8)
    expect(settled).toBe(false)
    gate.resolve()
    await rejected
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('rejects changed primary source authority instead of accepting no split', async () => {
    const provider = providerWith('{"split":false}'); let revoked = false
    const primary = fixtureDecisionProvider(async request => {
      revoked = true
      await request.assertInputAuthority!()
      throw new Error('unreachable')
    })
    await expect(classifySplit({ provider, message: MESSAGE,
      assertInputAuthority: async () => { if (revoked) throw refusal() },
      decisionRuntime: executionFixture({ llm: provider, primary }) })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('rejects a source change during fallback generation', async () => {
    const provider = providerWith('{"split":false}'); let revoked = false
    const original = provider.stream
    provider.stream = vi.fn(request => { revoked = true; return original(request) })
    await expect(classifySplit({ provider, message: MESSAGE,
      assertInputAuthority: async () => { if (revoked) throw refusal() },
      decisionRuntime: executionFixture({ llm: provider, primary: fixtureDecisionProvider(async () => { throw new Error('unavailable') }) })
    })).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it('uses live canonical lifecycle authority and preserves the initial source snapshot', async () => {
    vi.useFakeTimers()
    const lifecycle = new AbortController(), accumulator = new ContextScopeAccumulator()
    const authority = { execution: { security: { authority: { assertCurrent: async () => {} } },
      lifecycle: { abortSignal: lifecycle.signal } }, accumulator } as unknown as SessionContextAuthority
    const source = { workspaceId: 'fixture-workspace', userId: null, assistantId: null, sensitivity: 'confidential' as const,
      compartments: ['finance'], projectIds: [], resourceKind: 'memory', resourceId: 'original', version: '1' }
    const { provider } = hangingProvider()
    const options = bindScopeSources({ provider, message: MESSAGE, authority, assertInputAuthority: async () => {}, deadlineAt: Date.now() + 8 }, [source])
    const result = classifySplit(options)
    await vi.advanceTimersByTimeAsync(1)
    accumulator.note({ sources: [{ ...source, resourceId: 'later' }] })
    await vi.advanceTimersByTimeAsync(7)
    expect(boundScopeSources(await result)).toEqual([source])
    const next = classifySplit(options)
    const rejected = expect(next).rejects.toMatchObject({ reason: 'authority_changed' })
    lifecycle.abort()
    await rejected
  })
})


it('joins a successful in-flight proof and validates fresh before propagating explicit cancellation', async () => {
  const gate = deferred(), entered = deferred(), caller = new AbortController()
  const check = vi.fn(async () => { entered.resolve(); await gate.promise })
  const provider = providerWith('{"split":false}')
  const result = classifySplit({ provider, message: MESSAGE, signal: caller.signal, assertInputAuthority: check })
  const reason = new Error('explicit adaptive cancel')
  const rejected = expect(result).rejects.toBe(reason)
  await entered.promise
  caller.abort(reason)
  await Promise.resolve()
  expect(check).toHaveBeenCalledOnce()
  gate.resolve()
  await rejected
  expect(check).toHaveBeenCalledTimes(2)
  expect(provider.stream).not.toHaveBeenCalled()
})

it('never swallows an ordinary host proof rejection as no split', async () => {
  const provider = providerWith('{"split":false}')
  await expect(classifySplit({ provider, message: MESSAGE, assertInputAuthority: async () => { throw new Error('revoked') } }))
    .rejects.toMatchObject({ reason: 'authority_changed' })
  expect(provider.stream).not.toHaveBeenCalled()
})
