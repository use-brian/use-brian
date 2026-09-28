import { describe, expect, it, vi } from 'vitest'
import { createTypeSafeDecisionProvider, type TypeSafeTransportRequest } from '../adapters/typesafe.js'
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
