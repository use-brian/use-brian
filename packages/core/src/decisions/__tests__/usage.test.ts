import { describe, expect, it, vi } from 'vitest'
import { registryRow } from '@use-brian/shared/model-registry'
import { decisionUsageModelId } from '../usage.js'
import type { DecisionModelRef, DecisionRequest } from '../types.js'
import { executionFixture, fixtureDecisionProvider } from './execution-fixture.js'
import { llmProviderWithJson } from './fixtures.js'
import { classifyResearchIntent } from '../../workers/research-classifier.js'
import { selectInitialToolSchemas } from '../../engine/tool-selection.js'

const apiModel = { catalogId: 'openai-decisions-gpt-6-luna', wireId: 'gpt-6-luna' }
const cases: Array<{ label: string; model: DecisionModelRef; expected: string }> = [
  { label: 'decision API alias despite the Codex wire collision', model: apiModel, expected: apiModel.catalogId },
  { label: 'Codex subscription wire', model: { catalogId: 'gpt-6-luna', wireId: 'gpt-6-luna' }, expected: 'gpt-6-luna' },
  { label: 'existing Jev native ID', model: { catalogId: 'typesafe-jev-1.13', wireId: 'jev-1.13.0' }, expected: 'jev-1.13.0' },
  { label: 'unknown catalog reference', model: { catalogId: 'unknown-decision', wireId: 'unknown-native-v2' }, expected: 'unknown-native-v2' },
  { label: 'unknown catalog even with a colliding native wire', model: { catalogId: 'unknown-decision', wireId: 'gpt-6-luna' }, expected: 'gpt-6-luna' },
  { label: 'chat recordAlias row', model: { catalogId: 'gemini-3.6-flash-standard', wireId: 'gemini-3.6-flash' }, expected: 'gemini-3.6-flash' },
  { label: 'legacy fixture reference', model: { catalogId: 'fixture-decision', wireId: 'fixture-decision-v1' }, expected: 'fixture-decision-v1' },
]

describe('[COMP:decisions/usage] domain result attribution', () => {
  it.each(cases)('preserves $label without rewriting the model reference', ({ model, expected }) => {
    const snapshot = { ...model }
    expect(decisionUsageModelId(Object.freeze(model))).toBe(expected)
    expect(model).toEqual(snapshot)
  })

  it('exercises a real chat recordAlias row, not an unknown reference', () => {
    expect(registryRow('gemini-3.6-flash-standard')).toMatchObject({ recordAlias: true, apiModelId: 'gemini-3.6-flash' })
    expect(registryRow('gpt-6-luna')).toMatchObject({ provider: 'openai-codex', apiModelId: apiModel.wireId })
  })

  it.each(cases)('exposes $label in classifier and tool-selection results with unchanged usage and wire requests', async ({ model, expected }) => {
    const llm = llmProviderWithJson('{}')
    const stream = vi.spyOn(llm, 'stream')
    const usage = { inputTokens: 31, outputTokens: 7 }
    const evaluate = vi.fn(async (request: DecisionRequest) => ({
      providerId: 'fixture-decision', model: request.model, usage,
      answers: request.questions.map((question, index) => ({
        kind: 'choice' as const, questionId: question.id,
        value: question.id === 'intent' ? 'research_focused' : index === 0 ? 't0' : 'none',
        evidence: { source: 'unavailable' as const },
      })),
    }))
    const runtime = executionFixture({ llm, model, primary: fixtureDecisionProvider(evaluate) })
    const check = vi.fn(async () => {})
    const classification = await classifyResearchIntent({ provider: llm, message: 'Compare current battery suppliers',
      decisionRuntime: runtime, assertInputAuthority: check })
    expect(classification).toMatchObject({ research: true, effort: 'focused', model: expected, usage })
    const selection = await selectInitialToolSchemas({ runtime, llm: { provider: llm, modelId: 'fixture' },
      definitions: [{ name: 'listTasks', description: 'Read tasks', parameters: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'Read my tasks' }], runId: 'usage-attribution',
      signal: new AbortController().signal, assertInputAuthority: check })
    expect(selection).toMatchObject({ names: ['listTasks'], path: 'primary_complete', model: expected, usage })
    expect(evaluate).toHaveBeenCalledTimes(2)
    for (const [request] of evaluate.mock.calls) expect(request.model).toEqual(model)
    expect(check).toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })
})
