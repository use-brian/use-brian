import { describe, expect, it } from 'vitest'
import type { LLMProvider, ProviderRequest, ThinkingLevel } from '../../providers/types.js'
import { buildToolSelectionQuestions } from '../../engine/tool-selection.js'
import type { DecisionRequest } from '../types.js'
import { buildLlmDecisionMessages, createLlmDecisionProvider, decisionLlmOutputBudget } from '../adapters/llm.js'
import { decisionRequest, llmProviderWithJson } from './fixtures.js'

type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  enum?: string[]
  $defs?: Record<string, Schema>
  $ref?: string
}

/** Inspect the entire emitted JSON tree, not just its top-level envelope. */
function inspectSchema(schema: Schema) {
  let enumValues = 0
  const active = new Set<object>()
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    expect(active.has(value), 'schema must have no object cycles').toBe(false)
    active.add(value)
    if (Array.isArray(value)) value.forEach(walk)
    else {
      const node = value as Schema
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false)
        expect(node.required).toEqual(Object.keys(node.properties!))
      }
      if (node.enum) enumValues += node.enum.length
      if (node.$ref) {
        expect(Object.keys(node)).toEqual(['$ref'])
        expect(node.$ref).toMatch(/^#\/\$defs\/choice\d+$/)
        const leaf = schema.$defs?.[node.$ref.split('/')[2]!]
        expect(leaf).toBeDefined()
        // All generated refs terminate at primitive enum leaves, never cycles.
        expect(leaf).toEqual({ type: 'string', enum: expect.any(Array) })
      }
      Object.values(value).forEach(walk)
    }
    active.delete(value)
  }
  walk(schema)
  expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  return enumValues
}

function mixedRequest(): DecisionRequest {
  const request = decisionRequest()
  request.questions.push(
    { kind: 'boolean', id: 'eligible', prompt: 'Is this eligible?' },
    { kind: 'score', id: 'quality', prompt: 'Rate quality.', rubric: [
      { value: 0, description: 'Low' }, { value: 1, description: 'High' },
    ] },
  )
  return request
}

async function captureCall(request: DecisionRequest, name = 'fixture-llm'): Promise<ProviderRequest> {
  const calls: ProviderRequest[] = []
  const answers = Object.fromEntries(request.questions.map(question => [question.id, {
    value: question.kind === 'choice' ? question.options[0]!.value : question.kind === 'boolean' ? false : 0,
    confidence: null,
    ...(question.kind === 'boolean' ? { pTrue: null } : {}),
  }]))
  const llm = llmProviderWithJson({ answers }, calls)
  llm.name = name
  await createLlmDecisionProvider({ provider: llm }).evaluate(request)
  return calls[0]!
}

async function captureSchema(request: DecisionRequest, name = 'fixture-llm'): Promise<Schema> {
  return (await captureCall(request, name)).responseSchema as Schema
}

function originalPrompt(request: DecisionRequest): string {
  return JSON.stringify({ state: request.state, questions: request.questions,
    output: 'Return one answers entry per question. Do not add prose.' })
}

function expandPrompt(content: string) {
  const parsed = JSON.parse(content) as { state: unknown; questions: Record<string, unknown>[]; choiceOptions?: Record<string, unknown>;
    rowTables?: Array<{ path: Array<string | number>; columns: string[] }> }
  for (const table of parsed.rowTables ?? []) {
    let target = parsed as unknown as Record<string | number, unknown>
    for (const key of table.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>
    const key = table.path.at(-1)!
    target[key] = (target[key] as unknown[][]).map(row => Object.fromEntries(table.columns.map((column, i) => [column, row[i]])))
  }
  return { state: parsed.state, questions: parsed.questions.map(question => {
    const options = question.options as { $ref?: string } | undefined
    return options?.$ref ? { ...question, options: parsed.choiceOptions![options.$ref.split('/')[2]!] } : question
  }) }
}

function resolvedValue(schema: Schema, id: string): Schema {
  const value = schema.properties!.answers!.properties![id]!.properties!.value!
  return value.$ref ? schema.$defs![value.$ref.split('/')[2]!]! : value
}

describe('[COMP:decisions/llm] constrained LLM adapter', () => {
  it.each(['fixture', 'gemini'])('keeps a bounded answer budget with reasoning space for %s', async name => {
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({ answers: { intent: { value: 'ordinary' } } }, calls)
    llm.name = name
    await createLlmDecisionProvider({ provider: llm }).evaluate(decisionRequest())
    expect(calls[0]!.maxTokens).toBe(name === 'gemini' ? 1024 : 256)
    expect(calls[0]!.thinkingLevel).toBe(name === 'gemini' ? 'low' : undefined)
  })
  it.each([
    ['low', ['low'], 'low'],
    ['both', ['low', 'high'], 'low'],
    ['high only', ['high'], undefined],
    ['none', [], undefined],
    ['missing', undefined, undefined],
  ] as const)('requests low only with explicit support: %s', async (_label, levels, expected) => {
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({ answers: { intent: { value: 'ordinary' } } }, calls)
    const models: string[] = []
    const routes: unknown[] = []
    if (levels) llm.supportedThinkingLevels = function (this: LLMProvider, model, route): readonly ThinkingLevel[] {
      expect(this).toBe(llm)
      models.push(model)
      routes.push(route)
      return levels
    }
    const request = decisionRequest()
    await createLlmDecisionProvider({ provider: llm }).evaluate(request)
    expect(calls[0]!.thinkingLevel).toBe(expected)
    expect(calls[0]!.maxTokens).toBe(256)
    expect(models).toEqual(levels ? [request.model.wireId] : [])
    expect(routes).toEqual(levels ? [{ allowProviderFallback: false }] : [])
  })

  it('does not let broken optional metadata fail an otherwise valid decision', async () => {
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({ answers: { intent: { value: 'ordinary' } } }, calls)
    llm.supportedThinkingLevels = () => { throw new Error('Synthetic metadata unavailable') }
    await createLlmDecisionProvider({ provider: llm }).evaluate(decisionRequest())
    expect(calls[0]!.thinkingLevel).toBeUndefined()
    expect(calls[0]!.maxTokens).toBe(256)
  })

  it('does not swallow an authority refusal from metadata or dispatch after it', async () => {
    const calls: ProviderRequest[] = []
    const refusal = Object.assign(new Error('Synthetic authority refusal'), { reason: 'authority_changed' })
    const llm = llmProviderWithJson({}, calls)
    llm.supportedThinkingLevels = () => { throw refusal }
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(decisionRequest())).rejects.toBe(refusal)
    expect(calls).toHaveLength(0)
  })

  it('does not guess support from unknown wire names and preserves answer caps', () => {
    for (const wireId of ['unknown-thinking-model', 'gpt-unknown', 'claude-unknown']) {
      expect(decisionLlmOutputBudget({ name: 'fixture' }, { wireId }, 1500)).toEqual({ maxTokens: 1500 })
    }
    expect(decisionLlmOutputBudget({ name: 'gemini', supportedThinkingLevels: () => ['high'] },
      { wireId: 'unknown' }, 1500)).toEqual({ maxTokens: 1500, thinkingLevel: 'low' })
  })

  it('keeps original bytes when references would not save space or no domains repeat', () => {
    for (const repeated of [false, true]) {
      const request = decisionRequest()
      request.questions = [{ kind: 'choice', id: 'a', prompt: '?', options: [{ value: 'x' }] }]
      if (repeated) request.questions.push({ ...request.questions[0]!, id: 'b' })
      expect(buildLlmDecisionMessages(request)[0]!.content).toBe(originalPrompt(request))
    }
  })

  it('losslessly shares only identical full ordered options, leaving all other data intact', () => {
    const request = mixedRequest()
    const options = [
      { value: '__proto__/~雪😀', description: 'Quoted "description" with Unicode 雪'.repeat(30), metadata: { nested: ['α', 1] } },
      { value: 'constructor', description: 'Second choice'.repeat(30) },
    ]
    request.state = { special: { '__proto__/雪': ['😀', false] } }
    request.questions.unshift(...Array.from({ length: 3 }, (_, i) => ({
      kind: 'choice' as const, id: `special/~雪😀${i}`, prompt: `Keep wording ${i}.`, options: structuredClone(options),
    })))
    request.questions.push(
      { kind: 'choice', id: 'reordered', prompt: 'Order differs', options: [...options].reverse() },
      { kind: 'choice', id: 'description', prompt: 'Description differs', options: options.map(o => ({ ...o, description: `${o.description}!` })) },
      { kind: 'choice', id: 'metadata', prompt: 'Metadata differs', options: options.map(o => ({ ...o, metadata: { nested: ['β', 1] } })) },
    )
    const before = structuredClone(request)
    const messages = buildLlmDecisionMessages(request)
    const content = messages[0]!.content
    expect(content.length).toBeLessThan(originalPrompt(request).length)
    expect(expandPrompt(content)).toEqual({ state: request.state, questions: request.questions })
    const prompt = JSON.parse(content)
    expect(Object.keys(prompt.choiceOptions)).toEqual(['choice0'])
    expect(prompt.choiceOptions.choice0).toEqual(options)
    for (const id of ['reordered', 'description', 'metadata']) {
      expect(Array.isArray(prompt.questions.find((q: { id: string }) => q.id === id).options)).toBe(true)
    }
    expect(messages).toEqual(buildLlmDecisionMessages(request))
    expect(request).toEqual(before)
  })

  it('preserves a provider authority refusal without transport reclassification', async () => {
    const refusal = Object.assign(new Error('Synthetic provider authority refusal'), { reason: 'authority_changed', retrySafe: false })
    const llm = llmProviderWithJson({})
    llm.stream = async function* () { throw refusal }
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(decisionRequest())).rejects.toBe(refusal)
  })

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

  it.each(['fixture-llm', 'openai-codex', 'gemini'])('emits recursively strict, nullable uncertainty for %s', async name => {
    const schema = await captureSchema(mixedRequest(), name)
    expect(inspectSchema(schema)).toBe(2)
    const rows = schema.properties!.answers!.properties!
    for (const id of ['intent', 'eligible', 'quality']) {
      expect(rows[id]!.properties!.confidence).toEqual({ type: ['number', 'null'] })
    }
    expect(rows.eligible!.properties!.pTrue).toEqual({ type: ['number', 'null'] })
    expect(rows.intent!.properties).not.toHaveProperty('pTrue')
    expect(rows.quality!.properties).not.toHaveProperty('pTrue')
    expect(resolvedValue(schema, 'intent')).toEqual({ type: 'string', enum: ['ordinary', 'research'] })
    expect(resolvedValue(schema, 'eligible')).toEqual({ type: 'boolean' })
    expect(resolvedValue(schema, 'quality')).toEqual({ type: 'number' })
    expect(schema).toEqual(await captureSchema(mixedRequest(), name))
  })

  it.each([null, undefined, false, true, '0.9'])('does not fabricate uncertainty from non-number %s', async metadata => {
    const llm = llmProviderWithJson({ answers: {
      intent: { value: 'ordinary', confidence: metadata, pTrue: 0.9 },
      eligible: { value: false, confidence: metadata, pTrue: metadata },
      quality: { value: 1, confidence: metadata, pTrue: 0.9 },
    } })
    const response = await createLlmDecisionProvider({ provider: llm }).evaluate(mixedRequest())
    expect(response.answers).toMatchObject([
      { kind: 'choice', value: 'ordinary', evidence: { source: 'unavailable' } },
      { kind: 'boolean', value: false, evidence: { source: 'unavailable' } },
      { kind: 'score', value: 1, evidence: { source: 'unavailable' } },
    ])
    for (const answer of response.answers) {
      expect(answer.evidence).toEqual({ source: 'unavailable' })
      expect(answer).not.toHaveProperty('pTrue')
    }
  })

  it.each([0, 0.61, 1])('retains numeric self-report %s without synthesizing distributions', async probability => {
    const llm = llmProviderWithJson({ answers: {
      intent: { value: 'research', confidence: probability },
      eligible: { value: true, confidence: probability, pTrue: probability },
      quality: { value: 0, confidence: probability },
    } })
    const response = await createLlmDecisionProvider({ provider: llm }).evaluate(mixedRequest())
    for (const answer of response.answers) {
      expect(answer.evidence).toMatchObject({ source: 'self_reported', confidence: probability })
      expect(answer.evidence).not.toHaveProperty('probabilities')
    }
    expect(response.answers[1]).toHaveProperty('pTrue', probability)
  })

  it('does not derive confidence from pTrue or pTrue from a boolean label', async () => {
    for (const pTrue of [null, 0.7]) {
      const request = mixedRequest()
      request.questions = [request.questions[1]!]
      const llm = llmProviderWithJson({ answers: { eligible: { value: true, confidence: null, pTrue } } })
      const response = await createLlmDecisionProvider({ provider: llm }).evaluate(request)
      expect(response.answers[0]!.evidence).toEqual({ source: 'unavailable' })
      if (pTrue === null) expect(response.answers[0]).not.toHaveProperty('pTrue')
      else expect(response.answers[0]).toHaveProperty('pTrue', pTrue)
    }
  })

  it.each([
    ['eligible', { value: null, confidence: null, pTrue: null }],
    ['eligible', { value: 'false', confidence: null, pTrue: null }],
    ['eligible', { value: false, confidence: null, pTrue: 1.01 }],
    ['quality', { value: null, confidence: null }],
    ['quality', { value: true, confidence: null }],
    ['quality', { value: 2, confidence: null }],
    ['intent', { value: 'ordinary', confidence: -0.1 }],
  ])('rejects malformed or out-of-range %s answers', async (id, row) => {
    const llm = llmProviderWithJson({ answers: {
      intent: { value: 'ordinary', confidence: null },
      eligible: { value: false, confidence: null, pTrue: null },
      quality: { value: 0, confidence: null },
      [id]: row,
    } })
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(mixedRequest()))
      .rejects.toMatchObject({ kind: 'invalid_response' })
  })

  it.each([357, 508])('deduplicates ranked enums for %s fictional tools without changing semantics', async count => {
    const plan = buildToolSelectionQuestions(Array.from({ length: count }, (_, i) => ({
      name: `fictional_tool_${i}`, description: `Fictional capability ${i}`,
    })))!
    const request = decisionRequest()
    request.questions[0] = { kind: 'choice', id: 'intent', prompt: 'Choose intent.', options:
      ['ordinary', 'research_focused', 'research', 'research_deep', 'operate_site'].map(value => ({ value })) }
    request.questions.push(...plan.questions)
    // Include the full catalog as the real combined classifier does; measuring
    // only the repeated question options would overstate the total saving.
    request.state = { currentMessage: 'Compare fictional capabilities.', recentConversation: [], tools: plan.catalog }
    const before = structuredClone(request)
    expect(request.questions).toHaveLength(7)
    const inlineEnums = request.questions.reduce((sum, question) => sum + (question.kind === 'choice' ? question.options.length : 0), 0)
    if (count === 357) expect(inlineEnums).toBe(1082)
    const call = await captureCall(request, 'openai-codex')
    const schema = call.responseSchema as Schema
    expect(call.messages).toEqual(buildLlmDecisionMessages(request))
    const content = buildLlmDecisionMessages(request)[0]!.content
    expect(expandPrompt(content)).toEqual({ state: request.state, questions: request.questions })
    expect(content.length).toBeLessThan(originalPrompt(request).length)
    // Descriptions do not affect the wire schema. Make each array distinct to
    // force the original prompt representation and compare the entire schema.
    const unshared = structuredClone(request)
    for (const question of unshared.questions) {
      if (question.kind === 'choice') question.options = question.options.map(option => ({
        ...option, description: `${option.description ?? ''} (${question.id})`,
      }))
    }
    expect(expandPrompt(buildLlmDecisionMessages(unshared)[0]!.content)).toEqual({ state: unshared.state, questions: unshared.questions })
    expect(await captureSchema(unshared, 'openai-codex')).toEqual(schema)
    if (count === 357) console.info('Synthetic prompt size metadata', {
      tools: count, questions: request.questions.length,
      beforeChars: originalPrompt(request).length, afterChars: content.length,
    })
    expect(inspectSchema(schema)).toBe(count + 7) // two domains with "none", plus five intent labels
    expect(inspectSchema(schema)).toBeLessThanOrEqual(1000)
    expect(Object.keys(schema.$defs!)).toEqual(['choice0', 'choice1'])
    expect(schema.properties!.answers!.required).toEqual(request.questions.map(question => question.id))
    for (const question of request.questions) {
      if (question.kind === 'choice') expect(resolvedValue(schema, question.id).enum).toEqual(question.options.map(option => option.value))
    }
    expect(request).toEqual(before)
    expect(JSON.stringify(schema)).toBe(JSON.stringify(await captureSchema(request, 'gemini')))
  })

  it('does not merge domains with different option orders', async () => {
    const request = decisionRequest()
    const question = request.questions[0]!
    if (question.kind !== 'choice') throw new Error('fixture must be choice')
    request.questions.push({ ...question, id: 'reversed', options: [...question.options].reverse() })
    const schema = await captureSchema(request)
    expect(schema.$defs).toBeUndefined()
    expect(resolvedValue(schema, 'reversed').enum).toEqual(['research', 'ordinary'])
    expect(inspectSchema(schema)).toBe(4)
  })

  it.each(['openai-codex', 'openai'])('rejects oversized distinct enum domains before dispatch to %s', async name => {
    const request = decisionRequest()
    request.questions = Array.from({ length: 4 }, (_, group) => ({
      kind: 'choice' as const, id: `q${group}`, prompt: 'Choose one.',
      options: Array.from({ length: 251 }, (_, option) => ({ value: `g${group}_${option}` })),
    }))
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({}, calls)
    llm.name = name
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(request))
      .rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
    // This is target admission, not a global reduction in common capabilities.
    expect(inspectSchema(await captureSchema(request, 'fixture-llm'))).toBe(1004)
  })

  it('retains target schema admission through the real routing provider name', async () => {
    const request = decisionRequest()
    request.model = { catalogId: 'gpt-6-luna', wireId: 'gpt-6-luna' }
    request.questions = Array.from({ length: 4 }, (_, group) => ({
      kind: 'choice' as const, id: `q${group}`, prompt: 'Choose one.',
      options: Array.from({ length: 251 }, (_, option) => ({ value: `g${group}_${option}` })),
    }))
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({}, calls)
    llm.name = 'routing'
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(request))
      .rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
  })

  it('admits the exact strict enum budget and rejects oversized long enum strings', async () => {
    const request = decisionRequest()
    request.questions = Array.from({ length: 4 }, (_, group) => ({
      kind: 'choice' as const, id: `q${group}`, prompt: 'Choose one.',
      options: Array.from({ length: 250 }, (_, option) => ({ value: `g${group}_${option}` })),
    }))
    expect(inspectSchema(await captureSchema(request, 'openai-codex'))).toBe(1000)
    request.questions = [{ kind: 'choice', id: 'long', prompt: 'Choose one.',
      options: Array.from({ length: 251 }, (_, i) => ({ value: `${i}_${'x'.repeat(30)}` })),
    }]
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({}, calls)
    llm.name = 'openai-codex'
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(request))
      .rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
  })

  it('rejects excessive target vocabulary even when individual enum limits are satisfied', async () => {
    const request = decisionRequest()
    request.questions = [{ kind: 'choice', id: 'large', prompt: 'Choose one.', options:
      Array.from({ length: 250 }, (_, i) => ({ value: `${i}_${'x'.repeat(500)}` })) }]
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({}, calls)
    llm.name = 'openai-codex'
    await expect(createLlmDecisionProvider({ provider: llm }).evaluate(request))
      .rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
    expect(inspectSchema(await captureSchema(request, 'fixture-llm'))).toBe(250)
  })

  it('validates target property budgets even with explicitly expanded question capabilities', async () => {
    const request = decisionRequest()
    request.questions = Array.from({ length: 1700 }, (_, i) => ({
      kind: 'boolean', id: `q${i}`, prompt: 'Is this eligible?',
    }))
    const calls: ProviderRequest[] = []
    const llm = llmProviderWithJson({}, calls)
    llm.name = 'openai-codex'
    const base = createLlmDecisionProvider({ provider: llm })
    await expect(createLlmDecisionProvider({ provider: llm,
      capabilities: { ...base.capabilities, maxQuestions: 2000 },
    }).evaluate(request)).rejects.toMatchObject({ kind: 'unsupported_capability', dispatched: false })
    expect(calls).toEqual([])
  })

  it('rejects cyclic state as a validation failure before prompt serialization or dispatch', async () => {
    const request = decisionRequest()
    const state: Record<string, unknown> = {}
    state.self = state
    request.state = state as DecisionRequest['state']
    const calls: ProviderRequest[] = []
    await expect(createLlmDecisionProvider({ provider: llmProviderWithJson({}, calls) }).evaluate(request))
      .rejects.toMatchObject({ kind: 'invalid_request', dispatched: false })
    expect(calls).toEqual([])
  })
})
