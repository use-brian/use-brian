import { describe, expect, it, vi } from 'vitest'
import { createFetchTypeSafeTransport, createTypeSafeDecisionProvider, type TypeSafeTransportRequest } from '../adapters/typesafe.js'
import { decisionRequest } from './fixtures.js'

describe('[COMP:decisions/typesafe] Jev HTTP adapter', () => {
  it('maps Choice to the System One envelope and retains native uncertainty', async () => {
    const transport = vi.fn(async (_request: TypeSafeTransportRequest) => ({
      status: 200,
      body: {
        model: 'jev-1.13.0',
        answers: {
          intent: {
            type: 'choice',
            choice: 'research',
            probabilities: { ordinary: 0.08, research: 0.92 },
            confidence: 0.86,
          },
        },
        usage: { input_tokens: 80, output_tokens: 12 },
      },
    }))
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })
    const request = { ...decisionRequest(), model: { catalogId: 'typesafe-jev-1.13', wireId: 'jev-1.13.0' } }
    const response = await provider.evaluate(request)

    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0]![0].body).toMatchObject({
      model: 'jev-1.13.0',
      questions: { intent: { type: 'choice' } },
    })
    expect(response.answers[0]).toMatchObject({
      kind: 'choice',
      value: 'research',
      evidence: {
        source: 'native_distribution',
        probabilities: { ordinary: 0.08, research: 0.92 },
      },
    })
    expect(response.usage).toEqual({ inputTokens: 80, outputTokens: 12 })
  })

  it.each([
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [401, 'authentication'],
    [422, 'invalid_request'],
  ])('normalizes HTTP %s as %s without an adapter retry', async (status, kind) => {
    const transport = vi.fn(async () => ({ status, body: {}, headers: { 'retry-after': '2' } }))
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })
    await expect(provider.evaluate(decisionRequest())).rejects.toMatchObject({ kind })
    expect(transport).toHaveBeenCalledOnce()
  })

  it('does not synthesize a Boolean distribution from native pTrue', async () => {
    const provider = createTypeSafeDecisionProvider({
      apiKey: 'fixture-key',
      transport: async () => ({
        status: 200,
        body: {
          model: 'jev-1.13.0',
          answers: { useful: { type: 'noul', noul: 0.73 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    })
    const response = await provider.evaluate({
      ...decisionRequest(),
      questions: [{ kind: 'boolean', id: 'useful', prompt: 'Was this memory useful?' }],
    })
    expect(response.answers[0]).toMatchObject({ kind: 'boolean', pTrue: 0.73, value: true })
    expect(response.answers[0]!.evidence.probabilities).toBeUndefined()
    expect(response.answers[0]!.evidence.confidence).toBeUndefined()
  })

  it.each([
    ['valid', 'jev-1.13.0', { input_tokens: 8, output_tokens: 2 }, 'jev-1.13.0', { inputTokens: 8, outputTokens: 2 }],
    ['zero', 'jev-1.13.0', { input_tokens: 0, output_tokens: 0 }, 'jev-1.13.0', { inputTokens: 0, outputTokens: 0 }],
    ['missing model', undefined, { input_tokens: 8, output_tokens: 2 }, null, { inputTokens: 8, outputTokens: 2 }],
    ['missing usage', 'jev-1.13.0', undefined, 'jev-1.13.0', null],
    ['missing counter', 'jev-1.13.0', { input_tokens: 8 }, null, null],
    ['fractional', 'jev-1.13.0', { input_tokens: 1.5, output_tokens: 2 }, null, null],
    ['negative', 'jev-1.13.0', { input_tokens: -1, output_tokens: 2 }, null, null],
    ['unsafe counter', 'jev-1.13.0', { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 }, null, null],
    ['invalid model', 'https://secret.example', { input_tokens: 8, output_tokens: 2 }, null, null],
    ['different model', 'upstream-other-model', { input_tokens: 8, output_tokens: 2 }, 'upstream-other-model', { inputTokens: 8, outputTokens: 2 }],
  ])('native %s preserves only upstream provenance', async (_label, model, usage, actualModel, expectedUsage) => {
    const transport = vi.fn(async () => ({ status: 200, body: { model, usage,
      answers: { intent: { type: 'choice', choice: 'research', probabilities: { ordinary: 0, research: 1 } } } } }))
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })
    const response = await provider.evaluate({ ...decisionRequest(), nativeStrict: true })
    expect(response.nativeMetadata).toEqual({ actualModel, usage: expectedUsage })
    expect(response.model.wireId).toBe(actualModel ?? 'unknown')
    expect(response.model.catalogId).not.toBe('fixture-model')
    expect(response.usage).toEqual(expectedUsage ?? undefined)
    expect(transport).toHaveBeenCalledOnce()
  })
  it('preserves legacy requested identity fallback only outside native mode', async () => {
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport: async () => ({ status: 200,
      body: { answers: { intent: { type: 'choice', choice: 'research', probabilities: { ordinary: 0, research: 1 } } } } }) })
    const request = decisionRequest(), response = await provider.evaluate(request)
    expect(response.model).toEqual(request.model)
    expect(response.nativeMetadata).toBeUndefined()
  })
  it.each([307, 308])('native HTTP %s cannot redirect or replay the POST', async status => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('private-redirect-body', {
      status, headers: { location: 'https://private.invalid/redirect' },
    }))
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport: createFetchTypeSafeTransport(fetchFn) })
    const error = await provider.evaluate({ ...decisionRequest(), nativeStrict: true }).catch(error => error)
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(error).toMatchObject({ kind: 'transport', message: 'TypeSafe native request failed', dispatched: true })
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain('private')
  })
  it.each([true, false])('fetch failure has native redaction=%s without a second call', async native => {
    const cause = new Error('raw-upstream-cause-marker')
    const fetchFn = vi.fn<typeof fetch>(async () => { throw cause })
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport: createFetchTypeSafeTransport(fetchFn) })
    const error = await provider.evaluate({ ...decisionRequest(), ...(native ? { nativeStrict: true as const } : {}) }).catch(error => error)
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0]![1]?.redirect).toBe(native ? 'error' : undefined)
    expect(error).toMatchObject({ kind: 'transport', message: native ? 'TypeSafe native request failed' : 'TypeSafe transport failed' })
    expect(error.cause).toBe(native ? undefined : cause)
    if (native) expect(JSON.stringify(error)).not.toContain('raw-upstream-cause-marker')
  })
  it.each([true, false])('injected transport receives trusted policy and cancellation cause redaction=%s', async native => {
    const controller = new AbortController(), cause = new Error('private-cancellation-cause')
    const transport = vi.fn(async (request: TypeSafeTransportRequest) => {
      expect(request.nativeStrict).toBe(native ? true : undefined)
      controller.abort(cause)
      throw cause
    })
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })
    const request = { ...decisionRequest(), signal: controller.signal, state: { nativeStrict: true } }
    const error = await provider.evaluate({ ...request, ...(native ? { nativeStrict: true as const } : {}) }).catch(error => error)
    expect(transport).toHaveBeenCalledOnce()
    expect(error).toMatchObject({ kind: 'cancelled', dispatched: true })
    expect(error.cause).toBe(native ? undefined : cause)
    if (native) expect(error.message).toBe('TypeSafe native request failed')
  })
  it.each([true, false])('response validation content is redacted only for native=%s', async native => {
    const marker = 'private-probability-key'
    const transport = vi.fn(async () => ({ status: 200, body: {
      model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 },
      answers: { intent: { type: 'choice', choice: marker, probabilities: { [marker]: -1, other: 2 } } },
    } }))
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })
    const request = decisionRequest()
    request.questions = [{ kind: 'choice', id: 'intent', prompt: 'Choose', options: [{ value: marker }, { value: 'other' }] }]
    const error = await provider.evaluate({ ...request, ...(native ? { nativeStrict: true as const } : {}) }).catch(error => error)
    expect(transport).toHaveBeenCalledOnce()
    expect(error.kind).toBe('invalid_response')
    expect(error.cause).toBeUndefined()
    if (native) {
      expect(error.message).toBe('TypeSafe native request failed')
      expect(error.stack).not.toContain(marker)
      expect(JSON.stringify(error)).not.toContain(marker)
    } else expect(error.message).toContain(marker)
  })
  it('honors caller cancellation before transport dispatch', async () => {
    const transport = vi.fn()
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.evaluate({ ...decisionRequest(), signal: controller.signal }))
      .rejects.toMatchObject({ kind: 'cancelled' })
    expect(transport).not.toHaveBeenCalled()
  })
})
