import { describe, expect, it } from 'vitest'
import type { ProviderRequest } from '../../providers/types.js'
import { createLlmDecisionProvider } from '../adapters/llm.js'
import { decisionRequest, llmProviderWithJson } from './fixtures.js'

describe('[COMP:decisions/llm] constrained LLM adapter', () => {
  it('compiles questions to one constrained call and keeps unavailable uncertainty honest', async () => {
    const calls: ProviderRequest[] = []
    const provider = createLlmDecisionProvider({
      provider: llmProviderWithJson({ answers: { intent: { value: 'research' } } }, calls),
    })
    const response = await provider.evaluate(decisionRequest())

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      responseFormat: 'json',
      allowProviderFallback: false,
      temperature: 0,
    })
    expect(calls[0]!.responseSchema).toBeDefined()
    expect(response.answers[0]).toMatchObject({
      kind: 'choice',
      value: 'research',
      evidence: { source: 'unavailable' },
    })
    expect(response.answers[0]!.evidence.probabilities).toBeUndefined()
  })

  it('marks confidence as self-reported and rejects invented labels', async () => {
    const accepted = createLlmDecisionProvider({
      provider: llmProviderWithJson({ answers: { intent: { value: 'ordinary', confidence: 0.61 } } }),
    })
    await expect(accepted.evaluate(decisionRequest())).resolves.toMatchObject({
      answers: [{ evidence: { source: 'self_reported', confidence: 0.61 } }],
    })

    const invalid = createLlmDecisionProvider({
      provider: llmProviderWithJson({ answers: { intent: { value: 'invented' } } }),
    })
    await expect(invalid.evaluate(decisionRequest())).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})
