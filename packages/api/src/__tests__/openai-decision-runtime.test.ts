import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  calculateCost, classifyResearchIntent, classifyTopic, createOpenAiDecisionProvider,
  decisionUsageModelId, type DecisionEvaluationProfile, type DecisionRequest,
  type DecisionResponse, type LLMProvider,
} from '@use-brian/core'
import { isDecisionModelRow, modelRates, registryRow } from '@use-brian/shared/model-registry'
import {
  createDecisionAttemptUsageRecorder, createDecisionRuntime,
  type CreateDecisionRuntimeOptions, type DecisionRouteContext, type DecisionRuntimeOperation,
} from '../decision-runtime.js'
import { classifierFirstGrant, createWorkspaceDecisionRouteResolver, parseOperatorDecisionDefault } from '../workspace-decision-routing.js'
import { recordOverheadUsage } from '../routes/_overhead-usage.js'
import { modelMenuRoutes, type ModelMenuRouteOptions } from '../routes/model-menu.js'

const NATIVE = 'openai-decisions-gpt-6-luna'
const WIRE = 'gpt-6-luna'
const JEV = 'typesafe-jev-1.13'
const workspaceId = '00000000-0000-0000-0000-000000000001'
const nativeKey = 'fictional-decisions-only-key'
const jevKey = 'fictional-jev-only-key'
const operationRef = { id: 'research.intent', version: '2', stateVersion: '1', questionVersion: '2' }
const context: DecisionRouteContext = { workspaceId, kind: 'execution', evaluationSegment: 'global', operation: operationRef, questionKinds: ['choice'] }
type Result = { verdict: string }

// All HTTP is mocked, including unexpected calls. No SDK or real account is used.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected HTTP request') })) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function llm(): LLMProvider {
  return {
    name: 'fictional-llm', models: ['fictional-llm'],
    stream: vi.fn(async function* () {
      yield { type: 'message_start' as const, model: 'fictional-llm' }
      yield { type: 'text_delta' as const, text: '{"research":true,"effort":"focused"}' }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 20, outputTokens: 5 } }
    }),
    createSession: () => ({ send: async function* () {} }),
  }
}
function decisionRequest(): Omit<DecisionRequest, 'model'> {
  return { runId: 'fictional-native-runtime', operation: operationRef,
    state: { message: 'Compare fictional Acorn and Birch plans.', nested: ['exact\n"text"', null, false] },
    questions: [{ kind: 'choice', id: 'intent', prompt: 'Choose the bounded intent.', options: [{ value: 'ordinary' }, { value: 'research' }] }],
  }
}
function resultOperation() {
  const complete = vi.fn<DecisionRuntimeOperation<Result>['completeWithLlm']>(async ({ llm }) => ({
    result: { verdict: 'llm' }, providerId: llm.provider.name,
    model: { catalogId: llm.modelId, wireId: llm.modelId }, usage: { inputTokens: 20, outputTokens: 5 },
  }))
  const operation: DecisionRuntimeOperation<Result> = {
    decide: response => ({ kind: 'complete', result: { verdict: String(response.answers[0] && 'value' in response.answers[0] ? response.answers[0].value : 'missing') } }),
    validateResult: result => result, safeFailure: () => ({ verdict: 'safe' }), completeWithLlm: complete,
  }
  return { operation, complete }
}
function approved(modelCatalogId = NATIVE): DecisionEvaluationProfile {
  return { id: 'fictional-approved-profile', version: '1', mode: 'hybrid',
    operationId: operationRef.id, operationVersion: operationRef.version, stateVersion: operationRef.stateVersion, questionVersion: operationRef.questionVersion,
    modelCatalogId, modelWireId: modelCatalogId === JEV ? 'jev-1.13.0' : WIRE,
    evaluationSegment: 'global', status: 'approved', evidence: 'recorded',
    totalTimeoutMs: 120_000, primaryTimeoutMs: 1_000, maxAttempts: 2,
  }
}
function runtime(extra: Partial<CreateDecisionRuntimeOptions> = {}, selected = NATIVE) {
  return createDecisionRuntime({ llmProvider: llm(), defaultLlmModel: 'fictional-llm',
    openaiDecisionsApiKey: nativeKey, typesafeApiKey: jevKey,
    resolveRoute: createWorkspaceDecisionRouteResolver({ store: { getSystem: async () => null },
      configuredAdapterIds: () => ['typesafe', 'openai-decisions'],
      operatorDefault: { mode: 'classifier_first', modelAlias: selected },
    }), ...extra,
  })
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function choice(name: string, values: string[], selected: string) {
  return { type: 'choice', name, choice: selected, confidence: 1,
    probabilities: values.map(value => ({ value, probability: value === selected ? 1 : 0 })),
  }
}
function nativeResponse(answers: unknown[] = [choice('intent', ['ordinary', 'research'], 'ordinary')]) {
  return json({ model: WIRE, answers, usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } } })
}
function jevResponse() {
  return json({ model: 'jev-1.13.0', answers: { intent: { type: 'choice', choice: 'ordinary', probabilities: { ordinary: 1, research: 0 } } }, usage: { input_tokens: 8, output_tokens: 0 } })
}
function refusal() { return Object.assign(new Error('Fictional source withdrawn'), { reason: 'authority_changed', retrySafe: false }) }

// Native answer fixtures follow the outgoing schema rather than inventing a chat completion.
type NativeQuestion = { name: string; type: string; instructions: string; choices: Array<{ value: string; description?: string }> }
function answerQuestions(init?: RequestInit, selected: Record<string, string> = {}) {
  const body = JSON.parse(String(init?.body)) as { questions: NativeQuestion[] }
  return nativeResponse(body.questions.map(q => q.type === 'predicate'
    ? { name: q.name, type: 'predicate', probability: 1 }
    : choice(q.name, q.choices.map(c => c.value), selected[q.name] ?? (q.name === 'intent' ? 'ordinary' : q.name === 'state' ? 'continue' : q.name === 'topic' ? 'k0' : 'none'))))
}

describe('OpenAI Decisions API runtime registration and isolated routing', () => {
  it.each([undefined, '', '   ', '\t\n'])('does not register absent/blank dedicated key %j, even with a Jev key', async key => {
    const { operation, complete } = resultOperation()
    const rt = runtime({ openaiDecisionsApiKey: key })
    expect(rt.configuredAdapterIds()).toEqual(['typesafe'])
    expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'llm_only', attempts: 1, result: { verdict: 'llm' } })
    expect(complete).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('registers a dedicated key without startup calls, route activation, or changing the default LLM', async () => {
    const provider = llm(), { operation, complete } = resultOperation()
    const rt = createDecisionRuntime({ llmProvider: provider, defaultLlmModel: 'fictional-default', openaiDecisionsApiKey: nativeKey })
    expect(rt.configuredAdapterIds()).toEqual(['openai-decisions'])
    expect(fetch).not.toHaveBeenCalled()
    expect(await rt.resolveRoute(context)).toEqual({ mode: 'llm_only' })
    expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'llm_only', attempts: 1 })
    expect(complete.mock.calls[0]![0].llm).toEqual({ provider, modelId: 'fictional-default' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([NATIVE, JEV])('coexists with Jev and dispatches only the explicitly selected adapter: %s', async selected => {
    const mockedFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(String(url)).toBe(selected === NATIVE ? 'https://api.openai.com/v1/decisions' : 'https://api.typesafe.ai/v1/systemone')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${selected === NATIVE ? nativeKey : jevKey}`)
      expect(body.model).toBe(selected === NATIVE ? WIRE : 'jev-1.13.0')
      return selected === NATIVE ? nativeResponse() : jevResponse()
    })
    vi.stubGlobal('fetch', mockedFetch)
    const provider = llm(), { operation, complete } = resultOperation(), rt = runtime({ llmProvider: provider }, selected)
    expect(new Set(rt.configuredAdapterIds())).toEqual(new Set(['typesafe', 'openai-decisions']))
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'primary_complete', attempts: 1, result: { verdict: 'ordinary' } })
    expect(mockedFetch).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('does not auto-activate either adapter when both dedicated credentials are configured', async () => {
    const provider = llm(), { operation, complete } = resultOperation()
    const rt = createDecisionRuntime({ llmProvider: provider, defaultLlmModel: 'fictional-default', typesafeApiKey: jevKey, openaiDecisionsApiKey: nativeKey })
    expect(new Set(rt.configuredAdapterIds())).toEqual(new Set(['typesafe', 'openai-decisions']))
    expect(await rt.resolveRoute(context)).toEqual({ mode: 'llm_only' })
    expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'llm_only', attempts: 1 })
    expect(complete.mock.calls[0]![0].llm.modelId).toBe('fictional-default')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a native key cannot substitute for missing Jev credentials or select a different model', async () => {
    const { operation, complete } = resultOperation(), rt = runtime({ typesafeApiKey: undefined }, JEV)
    expect(rt.configuredAdapterIds()).toEqual(['openai-decisions'])
    expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'llm_only', attempts: 1 })
    expect(complete).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    const wrong = runtime({ resolveRoute: () => ({ mode: 'hybrid', primaryModelId: WIRE, profile: approved() }) })
    await expect(wrong.run({ workspaceId, request: decisionRequest(), operation })).rejects.toMatchObject({ kind: 'policy_denied' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('routes ordered native choice/predicate/score and preserves both raw model identities', async () => {
    const req = decisionRequest()
    req.questions.push({ kind: 'boolean', id: 'useful', prompt: 'Useful?', criteria: { true: 'yes\n"exact"', false: '' } },
      { kind: 'score', id: 'severity', prompt: 'Severity?', rubric: [{ value: 0, description: 'None' }, { value: 1, description: 'Some' }] })
    const mockedFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/decisions')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${nativeKey}`)
      expect(JSON.parse(String(init?.body))).toEqual({ model: WIRE, input: JSON.stringify(req.state), questions: [
        { type: 'choice', name: 'intent', instructions: 'Choose the bounded intent.', choices: [{ value: 'ordinary' }, { value: 'research' }] },
        { type: 'predicate', name: 'useful', instructions: 'Useful?\n\nBoolean criteria (JSON; keys true and false identify the outcome):\n' + JSON.stringify({ true: 'yes\n"exact"', false: '' }) },
        { type: 'score', name: 'severity', instructions: 'Severity?', levels: [{ label: '0', description: 'None' }, { label: '1', description: 'Some' }] },
      ] })
      return nativeResponse([choice('intent', ['ordinary', 'research'], 'ordinary'), { type: 'predicate', name: 'useful', probability: 0.73 },
        { type: 'score', name: 'severity', score: 0.7, confidence: 0.7, probabilities: [{ label: '0', value: 0, probability: 0.3 }, { label: '1', value: 1, probability: 0.7 }] }])
    })
    vi.stubGlobal('fetch', mockedFetch)
    const { operation, complete } = resultOperation()
    let raw: DecisionResponse | undefined
    operation.decide = response => { raw = response; return { kind: 'complete', result: { verdict: 'mixed' } } }
    expect(await runtime().run({ workspaceId, request: req, operation })).toMatchObject({ path: 'primary_complete', attempts: 1 })
    expect(raw).toMatchObject({ providerId: 'openai-decisions', model: { catalogId: NATIVE, wireId: WIRE },
      answers: [{ kind: 'choice', questionId: 'intent', value: 'ordinary' }, { kind: 'boolean', questionId: 'useful', value: true, pTrue: 0.73 }, { kind: 'score', questionId: 'severity', value: 0.7 }] })
    expect(complete).not.toHaveBeenCalled()
    expect(mockedFetch).toHaveBeenCalledOnce()
  })
})

describe('native catalog identity, exact authority, and usage accounting', () => {
  it('keeps paid native alias distinct from the zero-cost Codex wire and retains host admission caps', () => {
    expect(registryRow(NATIVE)).toMatchObject({ alias: NATIVE, provider: 'openai-decisions', apiModelId: WIRE, recordAlias: true,
      decisionCapabilities: { adapterId: 'openai-decisions', wireModelId: WIRE, maxInputTokens: 64_000, maxQuestionInputTokens: 32_000, maxQuestions: 400, maxOptions: 255, maxRubricLevels: 10 } })
    expect(isDecisionModelRow(registryRow(NATIVE)!)).toBe(true)
    expect(isDecisionModelRow(registryRow(WIRE)!)).toBe(false)
    expect(registryRow(WIRE)).toMatchObject({ provider: 'openai-codex', apiModelId: WIRE })
    expect(modelRates(NATIVE)).toMatchObject({ brackets: [{ inPerMTok: 0.1, outPerMTok: 0 }], cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 })
    const usage = { inputTokens: 50, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 20 }
    expect(calculateCost(NATIVE, usage)).toBeCloseTo((50 * 0.1 + 30 * 0.01 + 20 * 0.125) / 1_000_000, 12)
    expect(calculateCost(WIRE, usage)).toBe(0)
    expect(decisionUsageModelId({ catalogId: NATIVE, wireId: WIRE })).toBe(NATIVE)
    expect(decisionUsageModelId({ catalogId: WIRE, wireId: WIRE })).toBe(WIRE)
    expect(decisionUsageModelId({ catalogId: JEV, wireId: 'jev-1.13.0' })).toBe('jev-1.13.0')
    const { adapterId: _adapter, wireModelId: _wire, ...caps } = registryRow(NATIVE)!.decisionCapabilities!
    expect(createOpenAiDecisionProvider({ apiKey: nativeKey }).capabilities).toEqual(caps)
  })

  it.each([NATIVE, JEV])('requires exact approved model metadata, not a %s profile for another model', async profileModel => {
    const getApprovedExact = vi.fn(async () => approved(profileModel))
    const resolver = createWorkspaceDecisionRouteResolver({ store: { getSystem: async () => ({ workspaceId, mode: 'hybrid', modelAlias: NATIVE, updatedAt: 'now' }) },
      profileStore: { getApprovedExact }, configuredAdapterIds: () => ['openai-decisions'] })
    vi.stubGlobal('fetch', vi.fn(async () => nativeResponse()))
    const { operation, complete } = resultOperation(), rt = runtime({ resolveRoute: resolver })
    const result = rt.run({ workspaceId, request: decisionRequest(), operation })
    if (profileModel === NATIVE) expect(await result).toMatchObject({ path: 'primary_complete', attempts: 1 })
    else await expect(result).rejects.toMatchObject({ kind: 'policy_denied' })
    expect(getApprovedExact).toHaveBeenCalledWith({ operation: operationRef, modelCatalogId: NATIVE, modelWireId: WIRE, evaluationSegment: 'global' })
    expect(fetch).toHaveBeenCalledTimes(profileModel === NATIVE ? 1 : 0)
    expect(complete).not.toHaveBeenCalled()
  })

  it('prices normalized primary attempt cache buckets at the runtime boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => nativeResponse()))
    const onAttempt = vi.fn(), { operation } = resultOperation()
    await runtime({ onAttempt }).run({ workspaceId, request: decisionRequest(), operation })
    expect(onAttempt).toHaveBeenCalledOnce()
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({
      modelCatalogId: NATIVE, modelWireId: WIRE, providerId: 'openai-decisions', stage: 'primary_decision',
      usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 20, costUsd: expect.closeTo(0.0000078, 12) },
    }))
  })

  it('meters native success ONCE with normalized cache and alias; skips duplicate overhead but not Codex', async () => {
    const recordUsage = vi.fn(async (_usage: Record<string, unknown>) => {}), usageStore = { recordUsage }
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => answerQuestions(init)))
    const provider = llm()
    const result = await classifyResearchIntent({ provider, message: 'Compare fictional battery designs using fresh evidence.', workspaceId,
      decisionRuntime: runtime({ llmProvider: provider, onAttempt: createDecisionAttemptUsageRecorder(usageStore as never) }), assertInputAuthority: async () => {} })
    expect(result).toMatchObject({ research: false, model: NATIVE, usage: { inputTokens: 50, outputTokens: 7 } })
    expect(recordUsage).toHaveBeenCalledOnce()
    expect(recordUsage).toHaveBeenCalledWith({ userId: '', assistantId: '', workspaceId, sessionId: null, model: NATIVE,
      inputTokens: 50, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 20,
      actualCostUsd: expect.closeTo(0.0000078, 12), source: 'overhead:classifier', triggerKey: 'adaptive_research_classifier', providerKeySource: 'platform' })
    const overhead = { usageStore: usageStore as never, userId: 'fictional-user', assistantId: 'fictional-assistant', sessionId: 'fictional-session',
      model: result.model, usage: result.usage, source: 'overhead:classifier', triggerKey: 'adaptive_research_classifier' }
    await recordOverheadUsage(overhead)
    expect(recordUsage).toHaveBeenCalledOnce()
    await recordOverheadUsage({ ...overhead, model: WIRE })
    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(recordUsage.mock.calls[1]![0]).toMatchObject({ model: WIRE, inputTokens: 50, outputTokens: 7, actualCostUsd: 0 })
    expect(provider.stream).not.toHaveBeenCalled()
  })
})

describe('native runtime recovery and sticky refusal boundaries', () => {
  it.each(['transport', 'invalid_response', 'answer_order', 'answer_name', 'wrong_model', 'llm_failure'] as const)('bounds %s to at most one native call and one LLM call', async failure => {
    const req = decisionRequest()
    if (failure === 'answer_order') req.questions.push({ kind: 'boolean', id: 'useful', prompt: 'Useful?' })
    const mockedFetch = vi.fn(async () => failure === 'transport' || failure === 'llm_failure' ? json({}, 503)
      : failure === 'answer_order' ? nativeResponse([{ type: 'predicate', name: 'useful', probability: 1 }, choice('intent', ['ordinary', 'research'], 'ordinary')])
      : failure === 'answer_name' ? nativeResponse([choice('wrong', ['ordinary', 'research'], 'ordinary')])
      : failure === 'wrong_model' ? json({ model: 'jev-1.13.0', answers: [], usage: { input_tokens: 8, output_tokens: 0 } }) : json({}))
    vi.stubGlobal('fetch', mockedFetch)
    const { operation, complete } = resultOperation()
    if (failure === 'llm_failure') complete.mockRejectedValue(new Error('Fictional LLM outage'))
    expect(await runtime().run({ workspaceId, request: req, operation })).toMatchObject({
      path: failure === 'llm_failure' ? 'safe_default' : 'operational_failover', attempts: 2, result: { verdict: failure === 'llm_failure' ? 'safe' : 'llm' },
    })
    expect(mockedFetch).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })

  it('allows only one LLM generation follow-up after a successful native decision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => nativeResponse()))
    const { operation, complete } = resultOperation()
    operation.decide = () => ({ kind: 'follow_up', reason: 'generation_required' })
    expect(await runtime().run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'generation', attempts: 2, result: { verdict: 'llm' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]![0]).toMatchObject({ kind: 'generation', followUpReason: 'generation_required' })
  })

  it('treats native refusal as policy_denied, with no LLM fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ model: WIRE, answers: [{ type: 'refusal', name: 'intent', reason: 'fictional refusal' }] })))
    const { operation, complete } = resultOperation()
    expect(await runtime().run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'safe_default', attempts: 1, failureKind: 'policy_denied', result: { verdict: 'safe' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
  })

  it.each(['before', 'after'] as const)('propagates source refusal %s native dispatch without LLM recovery', async boundary => {
    let dispatched = false
    const denied = refusal(), provider = llm()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => { dispatched = true; return answerQuestions(init) }))
    await expect(classifyResearchIntent({ provider, workspaceId, message: 'Compare fictional battery designs using fresh evidence.',
      decisionRuntime: runtime({ llmProvider: provider }), assertInputAuthority: async () => { if (boundary === 'before' || dispatched) throw denied },
    })).rejects.toBe(denied)
    expect(fetch).toHaveBeenCalledTimes(boundary === 'before' ? 0 : 1)
    expect(provider.stream).not.toHaveBeenCalled()
  })
})

describe('practical primary domain results preserve native alias and admitted state', () => {
  it('classifies research plus all 357 tools in one ordered native batch, without dropping the final tool', async () => {
    const tools = Array.from({ length: 357 }, (_, i) => ({ name: `fictionalTool${i}`, description: `Fictional capability ${i}` }))
    const message = 'Compare fictional calendar providers and check my scheduled events. Preserve Ω and "quotes".\nFinal message sentinel.'
    const recentConversation = [{ role: 'user' as const, text: 'Prior fictional context Ω\nDo not lose this.' }, { role: 'assistant' as const, text: 'Prior answer with final sentinel.' }]
    const provider = llm()
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/decisions')
      const body = JSON.parse(String(init?.body))
      expect(JSON.parse(body.input)).toEqual({ currentMessage: message, recentConversation,
        tools: tools.map((tool, i) => ({ id: `t${i}`, ...tool })) })
      expect(body.questions.map((q: NativeQuestion) => q.name)).toEqual(['intent', 'group0_rank1', 'group0_rank2', 'group0_rank3', 'group1_rank1', 'group1_rank2', 'group1_rank3'])
      expect(body.questions.map((q: NativeQuestion) => q.choices.length)).toEqual([5, 255, 255, 255, 104, 104, 104])
      return answerQuestions(init, { intent: 'research_focused', group0_rank1: 't0', group1_rank1: 't356' })
    }))
    const result = await classifyResearchIntent({ provider, workspaceId, message, recentConversation, toolCandidates: tools,
      decisionRuntime: runtime({ llmProvider: provider }), assertInputAuthority: async () => {} })
    expect(result).toMatchObject({ research: true, effort: 'focused', model: NATIVE, toolNames: ['fictionalTool0', 'fictionalTool356'] })
    expect(fetch).toHaveBeenCalledOnce()
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('returns known-label topic success with native alias and complete domain state', async () => {
    const provider = llm(), currentMessage = 'Check my calendar today, including Ω and "quoted" details.\nFinal sentinel.'
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)), state = JSON.parse(body.input)
      expect(state).toEqual({ currentMessage, recentUserTurns: [{ text: 'Plan tomorrow', topicLabel: 'calendar' }], replyToText: null,
        priorTopicToken: 'k0', topicCatalog: [{ token: 'k0', topicLabel: 'calendar' }], topicAnchors: [] })
      expect(body.questions.map((q: NativeQuestion) => q.name)).toEqual(['state', 'topic', 'related_k0'])
      return answerQuestions(init)
    }))
    expect(await classifyTopic({ provider, workspaceId, model: 'fictional-llm', currentMessage,
      recentUserTurns: [{ text: 'Plan tomorrow', topicLabel: 'calendar' }], replyToText: null,
      knownTopicsThisSession: ['calendar'], decisionRuntime: runtime({ llmProvider: provider }), assertInputAuthority: async () => {},
    })).toMatchObject({ topic_label: 'calendar', state: 'continue', confidence: 1, model: NATIVE })
    expect(fetch).toHaveBeenCalledOnce()
    expect(provider.stream).not.toHaveBeenCalled()
  })
})

function menuApp(extra: Partial<ModelMenuRouteOptions> = {}, role: string | null = 'owner') {
  const app = express(), set = vi.fn(async (setting: unknown) => setting)
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'fictional-user'; next() })
  app.use('/api', modelMenuRoutes({ workspaceStore: { getRole: async () => role } as never,
    meteredProfileStore: { list: async () => [] } as never, modelDefaultsStore: { list: async () => [] } as never,
    configuredProviders: new Set(['openai-codex']), configuredDecisionAdapters: new Set(['typesafe', 'openai-decisions']),
    decisionRoutingStore: { get: async () => null, set } as never,
    decisionEvaluationProfileStore: { listApproved: async () => [] }, ...extra,
  }))
  return { app, set }
}

describe('native model menu availability and exact classifier-first authority', () => {
  it.each([[], ['typesafe'], ['openai-decisions'], ['typesafe', 'openai-decisions']].map(adapters => ({ adapters })))('lists native only for its configured adapter ($adapters)', async ({ adapters }) => {
    const { app } = menuApp({ configuredDecisionAdapters: new Set(adapters) })
    const res = await request(app).get(`/api/models/menu?workspaceId=${workspaceId}`).expect(200)
    const aliases = res.body.decisionRouting.models.map((model: { alias: string }) => model.alias)
    expect(aliases.includes(NATIVE)).toBe(adapters.includes('openai-decisions'))
    expect(aliases.includes(JEV)).toBe(adapters.includes('typesafe'))
    expect(aliases).not.toContain(WIRE)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('separates exact native classifierFirst scope from Jev grants and approved evidence', async () => {
    const grant = parseOperatorDecisionDefault('classifier_first', NATIVE, 'research.intent,memory.topic,research.intent')!
    expect(grant.operationIds).toEqual(['research.intent', 'memory.topic'])
    expect(classifierFirstGrant(grant, JEV)).toBeNull()
    const jevProfile = { ...approved(JEV), id: 'fictional-jev-approved', reportSha256: 'fictional-sha256', approvedAt: '2026-01-01T00:00:00.000Z' }
    const { app } = menuApp({ operatorDecisionDefault: grant,
      decisionEvaluationProfileStore: { listApproved: async () => [jevProfile] } })
    const res = await request(app).get(`/api/models/menu?workspaceId=${workspaceId}`).expect(200)
    expect(res.body.decisionRouting.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: NATIVE, provider: 'openai-decisions', adapterId: 'openai-decisions', classifierFirst: { operationIds: ['research.intent', 'memory.topic'] }, hybridOperations: [] }),
      expect.objectContaining({ alias: JEV, classifierFirst: null, hybridOperations: [expect.objectContaining({ profileId: 'fictional-jev-approved' })] }),
    ]))
    const resolver = createWorkspaceDecisionRouteResolver({ store: { getSystem: async () => null }, configuredAdapterIds: () => ['typesafe', 'openai-decisions'], operatorDefault: grant })
    expect(await resolver(context)).toMatchObject({ mode: 'hybrid', primaryModelId: NATIVE, operatorOverride: true })
    expect(await resolver({ ...context, operation: { ...operationRef, id: 'research.split' } })).toEqual({ mode: 'llm_only' })
  })

  it.each(['member', null, 'owner', 'admin'])('gates native hybrid selection on owner/admin (%s)', async role => {
    const { app, set } = menuApp({ operatorDecisionDefault: { mode: 'classifier_first', modelAlias: NATIVE, operationIds: ['research.intent'] } }, role)
    await request(app).put(`/api/workspaces/${workspaceId}/decision-routing`).send({ mode: 'hybrid', modelAlias: NATIVE }).expect(role === 'owner' || role === 'admin' ? 200 : 403)
    expect(set).toHaveBeenCalledTimes(role === 'owner' || role === 'admin' ? 1 : 0)
  })

  it('a Jev classifier-first grant cannot authorize a saved native hybrid route', async () => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: async () => ({ workspaceId, mode: 'hybrid', modelAlias: NATIVE, updatedAt: 'now' }) },
      configuredAdapterIds: () => ['typesafe', 'openai-decisions'], operatorDefault: { mode: 'classifier_first', modelAlias: JEV },
      profileStore: { getApprovedExact: async () => null },
    })
    const route = await resolver(context)
    expect(route).toMatchObject({ mode: 'shadow', primaryModelId: NATIVE })
    expect(route).not.toHaveProperty('operatorOverride')
  })

  it('cannot use Jev grant or Jev approval to save native hybrid; exact native evidence permits it', async () => {
    for (const profileModel of [JEV, NATIVE]) {
      const { app, set } = menuApp({ operatorDecisionDefault: { mode: 'classifier_first', modelAlias: JEV },
        decisionEvaluationProfileStore: { listApproved: async () => [{ ...approved(profileModel), reportSha256: 'fictional-sha256', approvedAt: '2026-01-01T00:00:00.000Z' }] } })
      await request(app).put(`/api/workspaces/${workspaceId}/decision-routing`).send({ mode: 'hybrid', modelAlias: NATIVE }).expect(profileModel === NATIVE ? 200 : 400)
      expect(set).toHaveBeenCalledTimes(profileModel === NATIVE ? 1 : 0)
    }
  })

  it('refuses unavailable native adapter even with an exact classifier-first grant', async () => {
    const { app, set } = menuApp({ configuredDecisionAdapters: new Set(['typesafe']), operatorDecisionDefault: { mode: 'classifier_first', modelAlias: NATIVE } })
    await request(app).put(`/api/workspaces/${workspaceId}/decision-routing`).send({ mode: 'hybrid', modelAlias: NATIVE }).expect(400)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('persisted workspace classifier-first native execution', () => {
  it.each([NATIVE, JEV])('executes the saved %s without an env grant and ignores a conflicting default', async selected => {
    for (const operatorDefault of [undefined, { mode: 'classifier_first' as const, modelAlias: selected === NATIVE ? JEV : NATIVE }]) {
      const mockedFetch = vi.fn(async (url: unknown) => {
        expect(String(url)).toBe(selected === NATIVE ? 'https://api.openai.com/v1/decisions' : 'https://api.typesafe.ai/v1/systemone')
        return selected === NATIVE ? nativeResponse() : jevResponse()
      })
      vi.stubGlobal('fetch', mockedFetch)
      const provider = llm(), { operation, complete } = resultOperation()
      const rt = runtime({ llmProvider: provider, resolveRoute: createWorkspaceDecisionRouteResolver({
        store: { getSystem: async () => ({ workspaceId, mode: 'classifier_first', modelAlias: selected, updatedAt: 'now' }) },
        configuredAdapterIds: () => ['typesafe', 'openai-decisions'], operatorDefault,
      }) })
      expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: 'primary_complete', attempts: 1, result: { verdict: 'ordinary' } })
      expect(mockedFetch).toHaveBeenCalledOnce()
      expect(complete).not.toHaveBeenCalled()
      expect(provider.stream).not.toHaveBeenCalled()
    }
  })

  it.each(['generation', 'failure'] as const)('permits bounded LLM %s only after the native attempt', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'failure' ? json({}, 503) : nativeResponse()))
    const { operation, complete } = resultOperation()
    if (kind === 'generation') operation.decide = () => ({ kind: 'follow_up', reason: 'generation_required' })
    const rt = runtime({ resolveRoute: createWorkspaceDecisionRouteResolver({
      store: { getSystem: async () => ({ workspaceId, mode: 'classifier_first', modelAlias: NATIVE, updatedAt: 'now' }) },
      configuredAdapterIds: () => ['openai-decisions'],
    }) })
    expect(await rt.run({ workspaceId, request: decisionRequest(), operation })).toMatchObject({ path: kind === 'generation' ? 'generation' : 'operational_failover', attempts: 2, result: { verdict: 'llm' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })
})
