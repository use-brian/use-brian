import { describe, expect, it, vi } from 'vitest'
import { buildLlmDecisionMessages, createLlmDecisionProvider, type LlmDecisionAnswerFormat } from '../adapters/llm.js'
import { buildToolSelectionQuestions } from '../../engine/tool-selection.js'
import type { ProviderRequest } from '../../providers/types.js'
import { decisionRequest, llmProviderWithJson } from './fixtures.js'

function rankedRequest() {
  const request = decisionRequest()
  const plan = buildToolSelectionQuestions(Array.from({ length: 357 }, (_, i) => ({
    name: `fictional_tool_${i}`, description: `Complete fictional capability ${i}`,
  })))!
  request.state = { currentMessage: 'Assess the fictional Acorn proposal.', tools: plan.catalog }
  request.questions.push(...plan.questions)
  return request
}

function valuesFor(request: ReturnType<typeof decisionRequest>) {
  return Object.fromEntries(request.questions.map(q => [q.id, q.id === 'intent' ? 'ordinary'
    : q.id === 'group1_rank1' ? 't356' : 'none']))
}

describe('compact LLM choice completions', () => {
  it('preserves every question/domain and canonical result without inventing uncertainty', async () => {
    const request = rankedRequest(), calls: ProviderRequest[] = []
    const answers = valuesFor(request)
    const result = await createLlmDecisionProvider({ provider: llmProviderWithJson({ answers }, calls), answerFormat: 'choice_values' }).evaluate(request)
    expect(result.answers).toEqual(request.questions.map(q => ({
      questionId: q.id, kind: 'choice', value: answers[q.id], evidence: { source: 'unavailable' },
    })))
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
    const schema = calls[0]!.responseSchema as any
    expect(schema.properties.answers.required).toEqual(request.questions.map(q => q.id))
    for (const q of request.questions) {
      if (q.kind !== 'choice') throw new Error('Expected a choice fixture')
      const leaf = schema.properties.answers.properties[q.id]
      const value = leaf.$ref ? schema.$defs[leaf.$ref.split('/')[2]] : leaf
      expect(value).toEqual({ type: 'string', enum: q.options.map(o => o.value) })
      expect(leaf.properties).toBeUndefined()
    }
    expect(calls[0]!.messages).toEqual(buildLlmDecisionMessages(request, 'choice_values'))
    expect(JSON.parse(String(calls[0]!.messages[0]!.content)).rowTables).toBeDefined()
    const detailed = Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { value, confidence: null }]))
    expect(JSON.stringify({ answers }).length).toBeLessThan(JSON.stringify({ answers: detailed }).length * 0.65)
  })

  it('keeps the default detailed codec and preserves genuine custom-provider self-report', async () => {
    const calls: ProviderRequest[] = []
    const detailed = { answers: { intent: { value: 'ordinary', confidence: 0.61 } } }
    const original = await createLlmDecisionProvider({ provider: llmProviderWithJson(detailed, calls) }).evaluate(decisionRequest())
    const compatible = await createLlmDecisionProvider({ provider: llmProviderWithJson(detailed), answerFormat: 'choice_values' }).evaluate(decisionRequest())
    expect(compatible).toEqual(original)
    expect(original.answers[0]!.evidence).toEqual({ source: 'self_reported', confidence: 0.61, definition: 'LLM self-reported confidence' })
    expect((calls[0]!.responseSchema as any).properties.answers.properties.intent.required).toEqual(['value', 'confidence'])
  })

  it.each([
    { answers: {} },
    { answers: { intent: 'ordinary', extra: 'ordinary' } },
    { answers: { intent: 'ordinary' }, extra: true },
    { answers: { intent: 'invented' } },
    { answers: { intent: 1 } },
    { answers: { intent: false } },
    { answers: { intent: null } },
    { answers: { intent: ['ordinary'] } },
    { answers: { intent: { value: 1 } } },
    { answers: { intent: { value: 'ordinary', confidence: true } } },
    { answers: { intent: { value: 'ordinary', confidence: -0.1 } } },
    { answers: { intent: { value: 'ordinary', confidence: 1.1 } } },
    { answers: { intent: { value: 'ordinary', pTrue: 1 } } },
  ])('rejects malformed, missing, extra or out-of-domain compact selections %#', async json => {
    const calls: ProviderRequest[] = []
    await expect(createLlmDecisionProvider({ provider: llmProviderWithJson(json, calls), answerFormat: 'choice_values' }).evaluate(decisionRequest()))
      .rejects.toMatchObject({ kind: 'invalid_response' })
    expect(calls).toHaveLength(1)
  })

  it.each(['boolean', 'score'] as const)('does not use compact choices for %s decisions', async kind => {
    const request = decisionRequest(), calls: ProviderRequest[] = []
    request.questions.push(kind === 'boolean' ? { id: 'flag', kind, prompt: 'Is the flag enabled?' }
      : { id: 'score', kind, prompt: 'Rate quality.', rubric: [{ value: 0, description: 'Absent' }, { value: 1, description: 'Present' }] })
    await expect(createLlmDecisionProvider({ provider: llmProviderWithJson({}, calls), answerFormat: 'choice_values' }).evaluate(request))
      .rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
  })

  it('pins the host-selected format before authority awaits and retains fresh final checks', async () => {
    const calls: ProviderRequest[] = [], request = decisionRequest()
    const options = { provider: llmProviderWithJson({ answers: { intent: 'ordinary' } }, calls), answerFormat: 'choice_values' as LlmDecisionAnswerFormat }
    const provider = createLlmDecisionProvider(options)
    request.assertInputAuthority = vi.fn(async () => { options.answerFormat = 'detailed' })
    expect((await provider.evaluate(request)).answers[0]!.value).toBe('ordinary')
    expect(request.assertInputAuthority).toHaveBeenCalledTimes(2)
    expect((calls[0]!.responseSchema as any).properties.answers.properties.intent).toEqual({ type: 'string', enum: ['ordinary', 'research'] })
  })

  it('propagates a fresh final refusal instead of publishing compact answers', async () => {
    const request = decisionRequest(), calls: ProviderRequest[] = []
    const refusal = Object.assign(new Error('Synthetic source revoked'), { reason: 'authority_changed', retrySafe: false })
    let checks = 0
    request.assertInputAuthority = async () => { if (++checks === 2) throw refusal }
    await expect(createLlmDecisionProvider({ provider: llmProviderWithJson({ answers: { intent: 'ordinary' } }, calls), answerFormat: 'choice_values' }).evaluate(request))
      .rejects.toBe(refusal)
    expect(calls).toHaveLength(1)
  })

  it('keeps the original target enum capacity gate', async () => {
    const request = decisionRequest(), calls: ProviderRequest[] = []
    request.questions = Array.from({ length: 4 }, (_, group) => ({ kind: 'choice', id: `q${group}`, prompt: 'Choose one.',
      options: Array.from({ length: 251 }, (_, i) => ({ value: `g${group}_${i}` })),
    }))
    const provider = llmProviderWithJson({}, calls)
    provider.name = 'openai-codex'
    await expect(createLlmDecisionProvider({ provider, answerFormat: 'choice_values' }).evaluate(request))
      .rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
  })
})
