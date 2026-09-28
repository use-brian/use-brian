import { describe, expect, it } from 'vitest'
import { createLlmDecisionProvider } from '../adapters/llm.js'
import { createTypeSafeDecisionProvider } from '../adapters/typesafe.js'
import { DecisionAdapterRegistry } from '../registry.js'
import type { DecisionProvider } from '../types.js'
import { assertDecisionCapabilities } from '../validate.js'
import { decisionRequest, llmProviderWithJson } from './fixtures.js'

function thirdProvider(): DecisionProvider {
  return {
    id: 'fixture-third',
    capabilities: {
      primitives: ['choice'],
      batch: true,
      maxOptions: 8,
      maxQuestions: 8,
      maxRubricLevels: 2,
      maxInputTokens: 8_000,
      uncertainty: ['unavailable'],
    },
    async evaluate(request) {
      assertDecisionCapabilities(request, this.capabilities)
      return {
        providerId: this.id,
        model: request.model,
        answers: [{
          kind: 'choice',
          questionId: 'intent',
          value: 'ordinary',
          evidence: { source: 'unavailable' },
        }],
      }
    },
  }
}

async function expectConformance(provider: DecisionProvider): Promise<void> {
  const response = await provider.evaluate(decisionRequest())
  expect(response.providerId).toBe(provider.id)
  expect(response.answers).toHaveLength(1)
  expect(response.answers[0]).toMatchObject({ kind: 'choice', questionId: 'intent' })
}

describe('[COMP:decisions/registry] adapter extension seam', () => {
  it('runs the same contract through TypeSafe, LLM, and a third provider', async () => {
    const registry = new DecisionAdapterRegistry()
      .register('typesafe', () => createTypeSafeDecisionProvider({
        apiKey: 'fixture-key',
        transport: async () => ({
          status: 200,
          body: {
            model: 'fixture-wire-v1',
            answers: {
              intent: {
                type: 'choice',
                choice: 'research',
                probabilities: { ordinary: 0.2, research: 0.8 },
                confidence: 0.7,
              },
            },
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        }),
      }))
      .register('llm', () => createLlmDecisionProvider({
        provider: llmProviderWithJson({ answers: { intent: { value: 'research' } } }),
      }))
      .register('fixture-third', thirdProvider)

    await expectConformance(registry.create('typesafe', {}))
    await expectConformance(registry.create('llm', {}))
    await expectConformance(registry.create('fixture-third', {}))
    expect(registry.ids()).toEqual(['typesafe', 'llm', 'fixture-third'])
  })

  it('routes a second compatible model without changing the operation or executor', async () => {
    const registry = new DecisionAdapterRegistry()
      .register<{ model: string }>('fixture', () => thirdProvider())
    const operationRequest = decisionRequest()
    const a = await registry.create('fixture', { model: 'fixture-a' }).evaluate({
      ...operationRequest,
      model: { catalogId: 'fixture-a', wireId: 'fixture-a-v1' },
    })
    const b = await registry.create('fixture', { model: 'fixture-b' }).evaluate({
      ...operationRequest,
      model: { catalogId: 'fixture-b', wireId: 'fixture-b-v1' },
    })
    expect([a.model.catalogId, b.model.catalogId]).toEqual(['fixture-a', 'fixture-b'])
  })

  it('rejects duplicate/unknown adapters and unsupported capabilities honestly', async () => {
    const registry = new DecisionAdapterRegistry().register('fixture', thirdProvider)
    expect(() => registry.register('fixture', thirdProvider)).toThrow(/already registered/)
    expect(() => registry.create('missing', {})).toThrow(/not registered/)
    const booleanRequest = {
      ...decisionRequest(),
      questions: [{ kind: 'boolean' as const, id: 'needed', prompt: 'Is this needed?' }],
    }
    await expect(registry.create('fixture', {}).evaluate(booleanRequest))
      .rejects.toMatchObject({ kind: 'unsupported_capability' })
  })
})
