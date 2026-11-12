import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiDecisionProvider, createFetchOpenAiDecisionTransport, OPENAI_DECISION_CAPABILITIES,
  type OpenAiDecisionTransport, type OpenAiDecisionTransportRequest } from '../adapters/openai.js'
import type { DecisionQuestion, DecisionRequest, JsonValue } from '../types.js'
import { decisionRequest } from './fixtures.js'
import { bindDecisionTransportBudget, captureDecisionTransport, ownsDecisionInputCapacity, ownsDecisionTransportBudget } from '../transport-budget.js'
import { estimateDecisionInputCapacity } from '../validate.js'

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return { ...decisionRequest(), model: { catalogId: 'openai-decisions-gpt-6-luna', wireId: 'gpt-6-luna' }, ...overrides }
}
function body() {
  return { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'intent', choice: 'research',
    probabilities: [{ value: 'ordinary', probability: 0.2 }, { value: 'research', probability: 0.8 }], confidence: 0.7 }],
  usage: { input_tokens: 80, output_tokens: 12 } }
}
function setup(value: unknown = body(), status = 200) {
  const transport = vi.fn(async (_request: OpenAiDecisionTransportRequest) => ({ status, body: value }))
  return { transport, provider: createOpenAiDecisionProvider({ apiKey: 'synthetic-secret', transport }) }
}
const booleanQuestion: DecisionQuestion = { kind: 'boolean', id: 'useful', prompt: 'Is this useful?' }
const scoreQuestion: DecisionQuestion = { kind: 'score', id: 'severity', prompt: 'How severe?',
  rubric: [{ value: 0, description: 'None' }, { value: 1, description: 'Some' }, { value: 2, description: 'Severe' }] }
function scoreAnswer() {
  return { type: 'score', name: 'severity', score: 1.3, confidence: 0.45,
    probabilities: [{ label: '2', value: 2, probability: 0.5 }, { label: '0', value: 0, probability: 0.2 }, { label: '1', value: 1, probability: 0.3 }] }
}
function authorityRefusal() { return Object.assign(new Error('synthetic authority refusal'), { reason: 'authority_changed', retrySafe: false }) }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('[COMP:decisions/openai] native text-only Decisions', () => {
  it('freezes canonical host bounds and grants ownership only to the unchanged built-in default', () => {
    const provider = createOpenAiDecisionProvider({ apiKey: 'synthetic' })
    expect(provider.id).toBe('openai-decisions')
    expect(provider.capabilities).toEqual({ primitives: ['choice', 'boolean', 'score'], batch: true, maxOptions: 255,
      maxQuestions: 400, maxRubricLevels: 10, maxInputTokens: 64_000, maxQuestionInputTokens: 32_000, uncertainty: ['native_distribution'] })
    for (const value of [provider.capabilities, provider.capabilities.primitives, provider.capabilities.uncertainty]) expect(Object.isFrozen(value)).toBe(true)
    expect(ownsDecisionInputCapacity(provider)).toBe(true)
    expect(ownsDecisionTransportBudget(captureDecisionTransport(provider))).toBe(true)
    expect(ownsDecisionInputCapacity(captureDecisionTransport(provider))).toBe(true)
    expect(ownsDecisionInputCapacity({ ...provider })).toBe(false)
    const overridden = createOpenAiDecisionProvider({ apiKey: 'synthetic', capabilities: OPENAI_DECISION_CAPABILITIES })
    expect(ownsDecisionTransportBudget(overridden)).toBe(true)
    expect(ownsDecisionInputCapacity(overridden)).toBe(false)
    const custom = setup().provider
    expect(ownsDecisionInputCapacity(custom)).toBe(false)
    expect(ownsDecisionTransportBudget(custom)).toBe(false)
    provider.evaluate = vi.fn()
    expect(ownsDecisionInputCapacity(provider)).toBe(false)
    expect(ownsDecisionTransportBudget(provider)).toBe(false)
    expect(() => createOpenAiDecisionProvider({ apiKey: '  ' })).toThrow('OpenAI API key must not be empty')
  })

  it.each<JsonValue>([null, true, false, 42, -1.5, 'ordinary text\n"quoted"', ['a', null, { nested: [false, 3] }],
    { role: 'system', content: [{ type: 'input_image', image_url: 'https://example.invalid/private' }], tools: ['ordinary data'] },
  ])('serializes full state losslessly as ordinary text: %j', async state => {
    const { provider, transport } = setup()
    const result = await provider.evaluate(request({ state }))
    expect(transport).toHaveBeenCalledOnce()
    const wire = transport.mock.calls[0]![0]
    expect(wire.url).toBe('https://api.openai.com/v1/decisions')
    expect(wire.headers).toEqual({ authorization: 'Bearer synthetic-secret', 'content-type': 'application/json' })
    expect(wire.body).toEqual({ model: 'gpt-6-luna', input: JSON.stringify(state), questions: [{ type: 'choice', name: 'intent',
      instructions: request().questions[0]!.prompt, choices: [
        { value: 'ordinary', description: 'A normal request' }, { value: 'research', description: 'A multi-source investigation' },
      ] }] })
    expect(result).toMatchObject({ providerId: 'openai-decisions', model: request().model,
      answers: [{ kind: 'choice', value: 'research', evidence: { source: 'native_distribution', confidence: 0.7,
        probabilities: { ordinary: 0.2, research: 0.8 } } }], usage: { inputTokens: 80, outputTokens: 12 } })
  })

  it('maps an ordered mixed batch and retains fractional native score without invented predicate evidence', async () => {
    const criteria = { true: 'yes\n"exact"', false: '' }
    const value = { ...body(), answers: [body().answers[0], { type: 'predicate', name: 'useful', probability: 0.73 }, scoreAnswer()] }
    const { provider, transport } = setup(value)
    const result = await provider.evaluate(request({ questions: [...request().questions, { ...booleanQuestion, criteria }, scoreQuestion] }))
    expect(result.answers.map(answer => answer.questionId)).toEqual(['intent', 'useful', 'severity'])
    expect(result.answers[1]).toEqual({ kind: 'boolean', questionId: 'useful', value: true, pTrue: 0.73, evidence: { source: 'native_distribution' } })
    expect(result.answers[2]).toEqual({ kind: 'score', questionId: 'severity', value: 1.3,
      evidence: { source: 'native_distribution', confidence: 0.45, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } } })
    const wire = transport.mock.calls[0]![0].body as { questions: Record<string, unknown>[] }
    expect(wire.questions[1]).toEqual({ type: 'predicate', name: 'useful', instructions:
      `Is this useful?\n\nBoolean criteria (JSON; keys true and false identify the outcome):\n${JSON.stringify(criteria)}` })
    expect(wire.questions[2]).toEqual({ type: 'score', name: 'severity', instructions: 'How severe?', levels: [
      { label: '0', description: 'None' }, { label: '1', description: 'Some' }, { label: '2', description: 'Severe' },
    ] })
  })

  it.each([0, 0.49, 0.5, 1])('keeps native predicate probability %s', async p => {
    const { provider, transport } = setup({ ...body(), answers: [{ type: 'predicate', name: 'useful', probability: p }] })
    expect((await provider.evaluate(request({ questions: [booleanQuestion] }))).answers[0]).toEqual({
      kind: 'boolean', questionId: 'useful', value: p >= 0.5, pTrue: p, evidence: { source: 'native_distribution' },
    })
    expect((transport.mock.calls[0]![0].body as { questions: unknown[] }).questions[0]).toEqual({ type: 'predicate', name: 'useful', instructions: 'Is this useful?' })
  })

  it.each([[255, true], [256, false]])('enforces choice option bound %s', async (count, accepted) => {
    const options = Array.from({ length: count }, (_, i) => ({ value: String(i) }))
    const { provider, transport } = setup({ ...body(), answers: [{ type: 'choice', name: 'intent', choice: '0', confidence: 1,
      probabilities: options.map((option, i) => ({ value: option.value, probability: i === 0 ? 1 : 0 })) }] })
    const pending = provider.evaluate(request({ questions: [{ kind: 'choice', id: 'intent', prompt: 'Choose', options }] }))
    if (accepted) await expect(pending).resolves.toBeDefined()
    else await expect(pending).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(transport).toHaveBeenCalledTimes(accepted ? 1 : 0)
  })
  it.each([[400, true], [401, false]])('enforces question bound %s', async (count, accepted) => {
    const questions = Array.from({ length: count }, (_, i) => ({ ...booleanQuestion, id: `q${i}` }))
    const { provider, transport } = setup({ ...body(), answers: questions.map(q => ({ type: 'predicate', name: q.id, probability: 0.5 })) })
    const pending = provider.evaluate(request({ questions }))
    if (accepted) await expect(pending).resolves.toBeDefined()
    else await expect(pending).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(transport).toHaveBeenCalledTimes(accepted ? 1 : 0)
  })
  it.each([[10, true], [11, false]])('enforces rubric bound %s', async (count, accepted) => {
    const rubric = Array.from({ length: count }, (_, value) => ({ value, description: 'Level' }))
    const { provider, transport } = setup({ ...body(), answers: [{ type: 'score', name: 'severity', score: 0, confidence: 1,
      probabilities: rubric.map((level, i) => ({ label: String(level.value), value: i, probability: i === 0 ? 1 : 0 })) }] })
    const pending = provider.evaluate(request({ questions: [{ ...scoreQuestion, kind: 'score', rubric }] }))
    if (accepted) await expect(pending).resolves.toBeDefined()
    else await expect(pending).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(transport).toHaveBeenCalledTimes(accepted ? 1 : 0)
  })
  it('enforces separate host whole and per-question capacity without truncation or override enlargement', async () => {
    const { provider, transport } = setup()
    const perQuestion = request({ state: 'x'.repeat(160_000) })
    expect(estimateDecisionInputCapacity(perQuestion).perQuestion).toBeGreaterThan(32_000)
    await expect(provider.evaluate(perQuestion)).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    const whole = request({ state: '', questions: Array.from({ length: 20 }, (_, i) => ({ ...booleanQuestion, id: `q${i}`, prompt: 'x'.repeat(15_000) })) })
    const estimate = estimateDecisionInputCapacity(whole)
    expect(estimate.whole).toBeGreaterThan(64_000)
    expect(estimate.perQuestion).toBeLessThan(32_000)
    await expect(provider.evaluate(whole)).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    const enlarged = createOpenAiDecisionProvider({ apiKey: 'synthetic', transport, capabilities: { ...OPENAI_DECISION_CAPABILITIES, maxInputTokens: 1e9, maxQuestionInputTokens: 1e9 } })
    await expect(enlarged.evaluate(perQuestion)).rejects.toMatchObject({ kind: 'unsupported_capability' })
    expect(transport).not.toHaveBeenCalled()
  })
  it.each([
    [undefined, { inputTokens: 80, outputTokens: 12 }],
    [{}, { inputTokens: 80, outputTokens: 12 }],
    [{ cached_tokens: 0 }, { inputTokens: 80, outputTokens: 12, cacheReadTokens: 0 }],
    [{ cache_write_tokens: 0 }, { inputTokens: 80, outputTokens: 12, cacheWriteTokens: 0 }],
    [{ cached_tokens: 0, cache_write_tokens: 0 }, { inputTokens: 80, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    [{ cached_tokens: 30 }, { inputTokens: 50, outputTokens: 12, cacheReadTokens: 30 }],
    [{ cache_write_tokens: 20 }, { inputTokens: 60, outputTokens: 12, cacheWriteTokens: 20 }],
    [{ cached_tokens: 30, cache_write_tokens: 20 }, { inputTokens: 30, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 20 }],
    [{ cached_tokens: 30, cache_write_tokens: 50 }, { inputTokens: 0, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 50 }],
  ])('normalizes fresh/read/write counters without inventing missing cache data: %j', async (details, expected) => {
    const value = { ...body(), usage: { ...body().usage, total_tokens: 92,
      ...(details !== undefined ? { input_tokens_details: details } : {}) } }
    const { provider, transport } = setup(value)
    const response = await provider.evaluate(request())
    expect(response.usage).toEqual(expected)
    expect(response.usage!.inputTokens + (response.usage!.cacheReadTokens ?? 0) + (response.usage!.cacheWriteTokens ?? 0)).toBe(80)
    expect(transport).toHaveBeenCalledOnce()
    expect(Object.keys(transport.mock.calls[0]![0].body as object)).toEqual(['model', 'input', 'questions'])
  })
  it.each(['cached_tokens', 'cache_write_tokens'])('rejects malformed %s cache counts', async field => {
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '20', null, true, undefined]) {
      const value = { ...body(), usage: { ...body().usage, input_tokens_details: { [field]: count } } }
      const { provider, transport } = setup(value)
      const error = await provider.evaluate(request()).catch(error => error)
      expect(error).toMatchObject({ kind: 'invalid_response', dispatched: true, message: 'OpenAI decision response is invalid' })
      expect(error.cause).toBeUndefined()
      expect(transport).toHaveBeenCalledOnce()
    }
  })
  it.each([
    { input_tokens_details: { cached_tokens: 81 } },
    { input_tokens_details: { cache_write_tokens: 81 } },
    { input_tokens_details: { cached_tokens: 50, cache_write_tokens: 31 } },
    { input_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: Number.MAX_SAFE_INTEGER } },
    { input_tokens_details: null },
    { input_tokens_details: [] },
    { total_tokens: 91 }, { total_tokens: 93 }, { total_tokens: -1 }, { total_tokens: 92.5 },
    { total_tokens: Infinity }, { total_tokens: NaN }, { total_tokens: '92' }, { total_tokens: null },
    { total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 },
    { input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects cache overcounts, unsafe totals and inconsistent reported totals: %j', async patch => {
    const { provider, transport } = setup({ ...body(), usage: { ...body().usage, ...patch } })
    await expect(provider.evaluate(request())).rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('accepts zero usage and the safe integer total boundary without inventing cache counters', async () => {
    for (const usage of [
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      { input_tokens: Number.MAX_SAFE_INTEGER - 12, output_tokens: 12, total_tokens: Number.MAX_SAFE_INTEGER },
    ]) {
      const result = await setup({ ...body(), usage }).provider.evaluate(request())
      expect(result.usage).toEqual({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens })
    }
  })
  it('accounts independently for every response instead of retaining previous cache counters', async () => {
    const transport = vi.fn<OpenAiDecisionTransport>()
      .mockResolvedValueOnce({ status: 200, body: { ...body(), usage: { ...body().usage,
        input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } } } })
      .mockResolvedValueOnce({ status: 200, body: body() })
    const provider = createOpenAiDecisionProvider({ apiKey: 'synthetic', transport })
    const check = vi.fn(async () => {})
    expect((await provider.evaluate(request({ assertInputAuthority: check }))).usage)
      .toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 20 })
    expect((await provider.evaluate(request({ assertInputAuthority: check }))).usage).toEqual({ inputTokens: 80, outputTokens: 12 })
    expect(check).toHaveBeenCalledTimes(4)
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('rejects unsupported models before dispatch', async () => {
    const { provider, transport } = setup()
    await expect(provider.evaluate(request({ model: { catalogId: 'other', wireId: 'gpt-other' } }))).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(transport).not.toHaveBeenCalled()
  })

  const malformed: [string, (value: ReturnType<typeof body>) => void][] = [
    ['missing model', b => { delete (b as Partial<typeof b>).model }],
    ['wrong model', b => { b.model = 'other' }],
    ['missing answer', b => { b.answers = [] }],
    ['extra answer', b => { b.answers.push(b.answers[0]!) }],
    ['wrong name', b => { b.answers[0]!.name = 'secret arbitrary remote text' }],
    ['wrong type', b => { b.answers[0]!.type = 'predicate' }],
    ['boolean choice', b => { Object.assign(b.answers[0]!, { choice: true }) }],
    ['unknown choice', b => { b.answers[0]!.choice = 'secret arbitrary remote text' }],
    ['missing confidence', b => { delete (b.answers[0] as Partial<typeof b.answers[0]>).confidence }],
    ['string confidence', b => { Object.assign(b.answers[0]!, { confidence: '0.7' }) }],
    ['nan confidence', b => { b.answers[0]!.confidence = NaN }],
    ['negative confidence', b => { b.answers[0]!.confidence = -0.1 }],
    ['high confidence', b => { b.answers[0]!.confidence = 1.1 }],
    ['missing distribution', b => { Object.assign(b.answers[0]!, { probabilities: undefined }) }],
    ['object distribution', b => { Object.assign(b.answers[0]!, { probabilities: { research: 1 } }) }],
    ['missing entry', b => { b.answers[0]!.probabilities.pop() }],
    ['duplicate entry', b => { b.answers[0]!.probabilities[1]!.value = 'ordinary' }],
    ['unknown entry', b => { b.answers[0]!.probabilities[1]!.value = 'other' }],
    ['boolean entry', b => { Object.assign(b.answers[0]!.probabilities[1]!, { value: true }) }],
    ['string probability', b => { Object.assign(b.answers[0]!.probabilities[1]!, { probability: '0.8' }) }],
    ['nan probability', b => { b.answers[0]!.probabilities[1]!.probability = NaN }],
    ['infinite probability', b => { b.answers[0]!.probabilities[1]!.probability = Infinity }],
    ['negative probability', b => { b.answers[0]!.probabilities[1]!.probability = -0.1 }],
    ['high probability', b => { b.answers[0]!.probabilities[1]!.probability = 1.1 }],
    ['nonunit sum', b => { b.answers[0]!.probabilities[1]!.probability = 0.1 }],
    ['missing usage', b => { delete (b as Partial<typeof b>).usage }],
    ['fractional input usage', b => { b.usage.input_tokens = 0.5 }],
    ['negative output usage', b => { b.usage.output_tokens = -1 }],
    ['infinite usage', b => { b.usage.input_tokens = Infinity }],
    ['string usage', b => { Object.assign(b.usage, { input_tokens: '80' }) }],
    ['bad detail usage', b => { Object.assign(b.usage, { input_tokens_details: { cached_tokens: -1 } }) }],
    ['bad total usage', b => { Object.assign(b.usage, { total_tokens: NaN }) }],
  ]
  it.each(malformed)('rejects %s safely after dispatch', async (_name, mutate) => {
    const value = body(); mutate(value)
    const { provider, transport } = setup(value)
    const error = await provider.evaluate(request()).catch(error => error)
    expect(error).toMatchObject({ kind: 'invalid_response', dispatched: true })
    expect(error.message).toBe('OpenAI decision response is invalid')
    expect(error.cause).toBeUndefined()
    expect(transport).toHaveBeenCalledOnce()
  })
  it.each([null, [], 'secret arbitrary remote text', 1])('rejects malformed body %j', async value => {
    await expect(setup(value).provider.evaluate(request())).rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
  })
  it.each([null, '0.5', true, NaN, Infinity, -0.01, 1.01])('rejects malformed predicate probability %j', async probability => {
    await expect(setup({ ...body(), answers: [{ type: 'predicate', name: 'useful', probability }] }).provider
      .evaluate(request({ questions: [booleanQuestion] }))).rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
  })
  it.each([
    { score: '1.3' }, { score: NaN }, { score: Infinity }, { score: -0.1 }, { score: 2.1 },
    { probabilities: [{ label: '0', value: 0, probability: 1 }] },
    { probabilities: [{ label: '0', value: 0, probability: 0.2 }, { label: '1', value: 1, probability: 0.3 }, { label: '2', value: 1, probability: 0.5 }] },
    { probabilities: [{ label: '0', value: 0, probability: 0.2 }, { label: '1', value: 1, probability: 0.3 }, { label: '2', value: '2', probability: 0.5 }] },
    { probabilities: [{ label: '0', value: 0, probability: 0.2 }, { label: '1', value: 1, probability: 0.3 }, { label: '1', value: 1, probability: 0.5 }] },
  ])('rejects malformed score %j', async patch => {
    await expect(setup({ ...body(), answers: [{ ...scoreAnswer(), ...patch }] }).provider.evaluate(request({ questions: [scoreQuestion] })))
      .rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
  })
  it('requires exact answer order even when all names exist', async () => {
    const questions = [{ ...booleanQuestion, id: 'a' }, { ...booleanQuestion, id: 'b' }]
    await expect(setup({ ...body(), answers: [{ type: 'predicate', name: 'b', probability: 1 }, { type: 'predicate', name: 'a', probability: 1 }] }).provider
      .evaluate(request({ questions }))).rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
  })
  it('treats any refusal as whole-call denial without remote text or partial answers', async () => {
    const { provider, transport } = setup({ ...body(), answers: [body().answers[0], { type: 'refusal', name: 'useful', refusal: 'synthetic-secret' }] })
    const error = await provider.evaluate(request({ questions: [...request().questions, booleanQuestion] })).catch(error => error)
    expect(error).toMatchObject({ kind: 'policy_denied', dispatched: true })
    expect(error.message).toBe('OpenAI decision request denied by policy')
    expect(error.cause).toBeUndefined()
    expect(transport).toHaveBeenCalledOnce()
  })
  it.each([[401, 'authentication'], [403, 'authentication'], [400, 'invalid_request'], [422, 'invalid_request'], [429, 'rate_limit'],
    [529, 'overloaded'], [503, 'overloaded'], [500, 'transport'], [408, 'timeout'], [504, 'timeout'], [302, 'transport']])('normalizes HTTP %s without retries', async (status, kind) => {
    const transport = vi.fn(async () => ({ status, body: { error: 'synthetic-secret' }, headers: { 'retry-after': '2' } }))
    const provider = createOpenAiDecisionProvider({ apiKey: 'synthetic-secret', transport })
    const error = await provider.evaluate(request()).catch(error => error)
    expect(error).toMatchObject({ kind, status, retryAfterMs: 2000, dispatched: true })
    expect(error.message).not.toContain('synthetic-secret')
    expect(transport).toHaveBeenCalledOnce()
  })
  it('does not turn an overflowing retry hint into an unbounded deadline', async () => {
    const transport = vi.fn(async () => ({ status: 429, body: {}, headers: { 'retry-after': '1e308' } }))
    const error = await createOpenAiDecisionProvider({ apiKey: 'synthetic', transport }).evaluate(request()).catch(error => error)
    expect(error).toMatchObject({ kind: 'rate_limit', dispatched: true })
    expect(error.retryAfterMs).toBeUndefined()
    expect(transport).toHaveBeenCalledOnce()
  })

  it('sanitizes arbitrary transport errors without retaining a secret cause', async () => {
    const transport = vi.fn(async () => { throw new Error('synthetic-secret prompt and arbitrary remote text') })
    const error = await createOpenAiDecisionProvider({ apiKey: 'synthetic-secret', transport }).evaluate(request()).catch(error => error)
    expect(error).toMatchObject({ kind: 'transport', dispatched: true, message: 'OpenAI decision transport failed' })
    expect(error.cause).toBeUndefined()
    expect(transport).toHaveBeenCalledOnce()
  })
  it('sanitizes request validation errors containing private question identifiers', async () => {
    const { provider, transport } = setup()
    const question = { ...booleanQuestion, id: 'synthetic-secret', prompt: '' }
    const error = await provider.evaluate(request({ questions: [question] })).catch(error => error)
    expect(error).toMatchObject({ kind: 'invalid_request', dispatched: false })
    expect(error.message).not.toContain('synthetic-secret')
    expect(transport).not.toHaveBeenCalled()
  })

  it('uses injected fetch only and normalizes malformed JSON after dispatch', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 }))
    const transport = createFetchOpenAiDecisionTransport(fetchFn as typeof fetch)
    await createOpenAiDecisionProvider({ apiKey: 'synthetic', transport }).evaluate(request())
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/decisions')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body as string).input).toBe(JSON.stringify(request().state))
    const malformedFetch = vi.fn(async () => new Response('synthetic-secret invalid JSON', { status: 200 }))
    await expect(createOpenAiDecisionProvider({ apiKey: 'synthetic', transport: createFetchOpenAiDecisionTransport(malformedFetch as typeof fetch) })
      .evaluate(request())).rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
  })

  it.each(['cancelled', 'timeout'] as const)('rejects pre-dispatch %s', async kind => {
    const { provider, transport } = setup()
    const controller = new AbortController(); controller.abort()
    await expect(provider.evaluate(request(kind === 'cancelled' ? { signal: controller.signal } : { deadlineAt: Date.now() - 1 })))
      .rejects.toMatchObject({ kind, dispatched: false })
    expect(transport).not.toHaveBeenCalled()
  })
  it.each(['cancelled', 'timeout', 'budget'] as const)('aborts active transport for %s', async mode => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const transport = vi.fn<OpenAiDecisionTransport>(async wire => new Promise((_resolve, reject) => {
      wire.signal!.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true })
    }))
    const provider = createOpenAiDecisionProvider({ apiKey: 'synthetic', transport })
    const req = request({ signal: controller.signal, ...(mode === 'timeout' ? { deadlineAt: Date.now() + 20 } : {}) })
    if (mode === 'budget') bindDecisionTransportBudget(req, 20)
    const result = provider.evaluate(req).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    if (mode === 'cancelled') controller.abort()
    else await vi.advanceTimersByTimeAsync(21)
    expect(await result).toMatchObject({ kind: mode === 'cancelled' ? 'cancelled' : 'timeout', dispatched: true })
    expect(transport).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a late response even if the custom transport ignores abort', async () => {
    vi.useFakeTimers()
    const transport = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { status: 200, body: body() } })
    const result = createOpenAiDecisionProvider({ apiKey: 'synthetic', transport }).evaluate(request({ deadlineAt: Date.now() + 20 })).catch(error => error)
    await vi.advanceTimersByTimeAsync(31)
    expect(await result).toMatchObject({ kind: 'timeout', dispatched: true })
  })
  it('ends primary budget before final authority proof while retaining the total deadline', async () => {
    vi.useFakeTimers()
    let checks = 0
    const check = vi.fn(async () => { if (++checks === 2) await new Promise(resolve => setTimeout(resolve, 40)) })
    const { provider } = setup()
    const req = bindDecisionTransportBudget(request({ assertInputAuthority: check, deadlineAt: Date.now() + 100 }), 10)
    const pending = provider.evaluate(req)
    await vi.advanceTimersByTimeAsync(41)
    await expect(pending).resolves.toBeDefined()
    expect(check).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    checks = 0
    const expired = provider.evaluate(bindDecisionTransportBudget(request({ assertInputAuthority: check, deadlineAt: Date.now() + 20 }), 10)).catch(error => error)
    await vi.advanceTimersByTimeAsync(41)
    expect(await expired).toMatchObject({ kind: 'timeout', dispatched: true })
  })
  it('performs fresh authority before each physical fetch and again after the response', async () => {
    const events: string[] = []
    const fetchFn = vi.fn(async () => { events.push('fetch'); return new Response(JSON.stringify(body())) })
    vi.stubGlobal('fetch', fetchFn)
    const provider = createOpenAiDecisionProvider({ apiKey: 'synthetic' })
    const check = async () => { events.push('authority') }
    await provider.evaluate(request({ assertInputAuthority: check }))
    await provider.evaluate(request({ assertInputAuthority: check }))
    expect(events).toEqual(['authority', 'fetch', 'authority', 'authority', 'fetch', 'authority'])
    expect(ownsDecisionTransportBudget(provider)).toBe(true)
  })
  it('preserves authority refusal from injected fetch response acquisition unchanged', async () => {
    const refusal = authorityRefusal()
    const fetchFn = vi.fn(async () => ({ json: async () => { throw refusal } }) as unknown as Response)
    await expect(createOpenAiDecisionProvider({ apiKey: 'synthetic', transport: createFetchOpenAiDecisionTransport(fetchFn as typeof fetch) })
      .evaluate(request())).rejects.toBe(refusal)
    expect(fetchFn).toHaveBeenCalledOnce()
  })
  it.each([null, undefined, { status: '200' }, { status: 600 }])('normalizes malformed transport envelope %j', async wire => {
    const transport = vi.fn(async () => wire) as unknown as OpenAiDecisionTransport
    await expect(createOpenAiDecisionProvider({ apiKey: 'synthetic', transport }).evaluate(request()))
      .rejects.toMatchObject({ kind: 'invalid_response', dispatched: true })
  })
  it('preserves authority errors unchanged before dispatch, from transport, and after even refusal responses', async () => {
    const refusal = authorityRefusal()
    const before = setup()
    await expect(before.provider.evaluate(request({ assertInputAuthority: async () => { throw refusal } }))).rejects.toBe(refusal)
    expect(before.transport).not.toHaveBeenCalled()
    const transport = vi.fn(async () => { throw refusal })
    await expect(createOpenAiDecisionProvider({ apiKey: 'synthetic', transport }).evaluate(request())).rejects.toBe(refusal)
    expect(transport).toHaveBeenCalledOnce()
    for (const value of [body(), { ...body(), answers: [{ type: 'refusal', name: 'intent' }] }]) {
      let checks = 0
      const after = setup(value)
      await expect(after.provider.evaluate(request({ assertInputAuthority: async () => { if (++checks === 2) throw refusal } }))).rejects.toBe(refusal)
      expect(after.transport).toHaveBeenCalledOnce()
      expect(checks).toBe(2)
    }
  })
})
