import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ChatTurnRefusal, chatTurnErrorEvent, customModelMediaRefusal, resolveWorkspaceTurnLlm, routineCalendarReadDeclineReason } from '../chat.js'
import type { DecisionRouteConfig, DecisionRuntimeAttempt } from '../../decision-runtime.js'
import { CUSTOM_MODEL_IMAGE_REJECTION } from '../_channel-error-text.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'
import { DeliveryAudienceUnverifiedError } from '../../context-scope/delivery-authority.js'

describe('[COMP:api/chat-route] workspace provider precedence', () => {
  it('uses a valid custom endpoint without touching stale legacy BYO settings', async () => {
    const platformProvider = { name: 'platform' }
    const customProvider = { name: 'custom' }
    const resolveLegacyByoKey = vi.fn().mockRejectedValue(new Error('legacy decrypt failed'))
    const resolveWorkspaceCustomLlm = vi.fn().mockResolvedValue({
      provider: customProvider,
      selector: 'custom:profile-1',
      profileId: 'profile-1',
      modelTier: 'pro',
      providerKeySource: 'user',
      inputTokenLimit: 32000,
      maxTokens: 4000,
    })

    const result = await resolveWorkspaceTurnLlm({
      workspaceId: 'ws-1',
      requestedTier: 'pro',
      platformProvider: platformProvider as never,
      resolveWorkspaceCustomLlm: resolveWorkspaceCustomLlm as never,
      resolveLegacyByoKey,
      buildLegacyByoProvider: vi.fn() as never,
    })

    expect(result).toMatchObject({
      provider: customProvider,
      providerKeySource: 'user',
      usedLegacyByoKey: false,
    })
    expect(resolveLegacyByoKey).not.toHaveBeenCalled()
  })

  it('preserves fail-closed legacy decryption when no custom endpoint applies', async () => {
    const error = new Error('legacy decrypt failed')
    await expect(resolveWorkspaceTurnLlm({
      workspaceId: 'ws-1',
      requestedTier: 'pro',
      platformProvider: {} as never,
      resolveWorkspaceCustomLlm: vi.fn().mockResolvedValue(null) as never,
      resolveLegacyByoKey: vi.fn().mockRejectedValue(error),
      buildLegacyByoProvider: vi.fn() as never,
    })).rejects.toThrow(error)
  })
})

describe('[COMP:api/chat-route] post-SSE turn refusals', () => {
  // The chat route flushes `text/event-stream` headers a few lines into the
  // handler, so `res.status(...).json(...)` past that point is not a reply,
  // it is an ERR_HTTP_HEADERS_SENT throw that the outer catch flattens into
  // "Something went wrong". That is how a workspace whose tiers all route to
  // a text-only custom endpoint got a generic red banner instead of the one
  // sentence explaining why its screenshots were refused (2026-08-19).
  it('renders a refusal with its own code and sentence, not the generic banner', () => {
    const refusal = new ChatTurnRefusal('metered_at_cap', 'Add credits to use this model.', {
      usedCredits: 42,
    })
    expect(chatTurnErrorEvent(refusal)).toEqual({
      code: 'metered_at_cap',
      error: 'Add credits to use this model.',
      usedCredits: 42,
    })
  })

  it('still says nothing specific about an unknown crash', () => {
    expect(chatTurnErrorEvent(new Error('Cannot set headers after they are sent to the client')))
      .toEqual({ error: 'Something went wrong' })
    expect(chatTurnErrorEvent('not even an error')).toEqual({ error: 'Something went wrong' })
  })

  it('preserves typed live-authority and recipient refusals on the SSE wire', () => {
    expect(chatTurnErrorEvent(new AuthorityChangedError(true))).toMatchObject({
      code: 'authority_changed',
      operationMayHaveExecuted: true,
    })
    expect(chatTurnErrorEvent(new DeliveryAudienceUnverifiedError())).toEqual({
      code: 'delivery_audience_unverified',
      error: 'The current destination is not authorized for this response.',
    })
  })

  it('marks a refused delivery in a shared chat without exposing the refusing axis', () => {
    const event = chatTurnErrorEvent(
      new DeliveryAudienceUnverifiedError(undefined, 'user_visibility'),
      { sharedAudience: true },
    )
    expect(event).toEqual({
      code: 'delivery_audience_unverified',
      error: 'The current destination is not authorized for this response.',
      sharedChat: true,
    })
    expect(JSON.stringify(event)).not.toContain('user_visibility')
  })

  // A tier route captures every built-in in the model picker, so the old copy
  // ("choose a built-in model") named a recovery step that workspace does not
  // have. Only an explicit `custom:<id>` pick can be undone that way.
  it('points a tier-routed workspace at Settings rather than the model picker', () => {
    const viaTierRoute = customModelMediaRefusal(false)
    expect(viaTierRoute.code).toBe('custom_model_media_unsupported')
    expect(viaTierRoute.message).toMatch(/Settings > Models/)
    expect(viaTierRoute.message).not.toMatch(/choose a built-in model/)
    // One sentence across every surface: a channel turn reaches the endpoint
    // the same way (tier route) and must not learn a second wording.
    expect(viaTierRoute.message).toBe(CUSTOM_MODEL_IMAGE_REJECTION)
  })

  it('offers the model picker when the custom endpoint was picked for this turn', () => {
    expect(customModelMediaRefusal(true).message).toMatch(/choose a built-in model/)
  })

  // Every user-facing string in this file goes out verbatim over SSE.
  it('keeps em dashes out of the refusal copy', () => {
    for (const message of [
      customModelMediaRefusal(true).message,
      customModelMediaRefusal(false).message,
    ]) {
      expect(message).not.toContain('—')
    }
  })
})


describe('[COMP:api/chat-route] detached failure outcome', () => {
  // Exercise the actual catch publisher payload without starting unrelated
  // provider work or duplicating its outcome logic in the fixture.
  const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true)
  let payload: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'publishSessionEvent') {
      const event = node.arguments[0]
      if (event && ts.isObjectLiteralExpression(event) && event.properties.some(property =>
        ts.isPropertyAssignment(property) && property.name.getText(tree) === 'sessionId'
        && property.initializer.getText(tree) === 'sessionIdForError')) {
        const property = event.properties.find(property => ts.isPropertyAssignment(property)
          && property.name.getText(tree) === 'payload') as ts.PropertyAssignment
        payload = property.initializer
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!payload) throw new Error('Missing chat catch completion publisher')
  const evaluate = new Function('userIdForError', 'postReplyNotice', 'recoveryDelivered',
    ts.transpileModule(`return (${payload.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)

  it('publishes only a failed outcome, never exception details or a success', () => {
    expect(evaluate('actor', null, false)).toEqual({ senderUserId: 'actor', reason: 'failed' })
  })

  it.each([[null, true], [{ code: 'post_reply_authority_changed' }, false], [{ code: 'post_reply_authority_changed' }, true]])(
    'keeps delivered recovery and completed-reply notices as ordinary completion', (notice, recovered) => {
      expect(evaluate('actor', notice, recovered)).toEqual({ senderUserId: 'actor' })
    },
  )
})


describe('[COMP:api/chat-route] routine read model-route eligibility', () => {
  const tool = { name: 'googleCalendarListEvents' } as import('@use-brian/core').Tool
  const tools = new Map([[tool.name, tool]])
  const eligible = {
    nativeOutput: true, nativeTranscript: true, decisionRuntime: true,
    research: false, coordinator: false, site: false, document: false,
    modelRoute: null, calendarTools: tools, preparedTools: tools,
  }
  it('retains a resolved managed registry route rather than treating its runtime object as custom', async () => {
    const provider = { name: 'managed-fixture' } as import('@use-brian/core').LLMProvider
    const runtime = { provider, selector: 'gemini-3.6-flash-standard', profileId: null,
      modelTier: 'standard', providerKeySource: 'platform', routeKind: 'managed', inputTokenLimit: 1_048_576, maxTokens: 8192 } as import('../../custom-llm-runtime.js').ResolvedWorkspaceCustomLlm
    const resolved = await resolveWorkspaceTurnLlm({ workspaceId: 'fictional-workspace', requestedTier: 'standard', platformProvider: provider,
      resolveWorkspaceCustomLlm: vi.fn(async () => runtime), resolveLegacyByoKey: null, buildLegacyByoProvider: null })
    expect(resolved.customRuntime).toBe(runtime)
    expect(routineCalendarReadDeclineReason({ ...eligible, modelRoute: resolved.customRuntime })).toBeNull()
    expect(routineCalendarReadDeclineReason(eligible)).toBeNull()
  })
  it('keeps custom and unknown route kinds conservative', () => {
    expect(routineCalendarReadDeclineReason({ ...eligible, modelRoute: { routeKind: 'custom' } })).toBe('custom_model')
    expect(routineCalendarReadDeclineReason({ ...eligible, modelRoute: {} as never })).toBe('custom_model')
  })
  it.each(['nativeOutput', 'nativeTranscript', 'decisionRuntime'] as const)('still requires %s', key => {
    expect(routineCalendarReadDeclineReason({ ...eligible, [key]: false })).not.toBeNull()
  })
  it.each(['research', 'coordinator', 'site', 'document'] as const)('keeps the %s profile on its existing path', key => {
    expect(routineCalendarReadDeclineReason({ ...eligible, [key]: true })).toBe('specialized_mode')
  })
  it('requires exact bound tool identity independently of advisory schema selection', () => {
    expect(routineCalendarReadDeclineReason({ ...eligible, calendarTools: new Map() })).toBe('calendar_tools')
    expect(routineCalendarReadDeclineReason({ ...eligible, preparedTools: new Map([[tool.name, { ...tool }]]) })).toBe('tool_identity')
  })
})

// Exercise the real runtime and physical provider adapters, including the
// private routine planner, without contacting a provider or Calendar.
describe('[COMP:api/chat-route] routine completion admission', () => {
  async function fixture(mode: 'llm_only' | 'fallback' | 'primary', refuseAt?: number, customHook = false, extra: { large?: boolean; patch?: (config: DecisionRouteConfig) => DecisionRouteConfig; adapter?: 'unknown' | 'overridden' | 'primitive' } = {}) {
    const { createDecisionRuntime, createDecisionAttemptUsageRecorder } = await import('../../decision-runtime.js')
    const { createGeminiProvider, createGoogleCalendarTools, ContextScopeAccumulator, registerDecisionMetadataSink, DecisionAdapterRegistry, createTypeSafeDecisionProvider, TYPESAFE_JEV_CAPABILITIES } = await import('@use-brian/core')
    const { planRoutineCalendarRead } = await import('../../../../core/dist/engine/routine-read.js')
    const full = vi.fn(async () => {
      if (full.mock.calls.length === refuseAt) throw Object.assign(new Error('Fictional source withdrawn'), { reason: 'authority_changed', retrySafe: false })
    })
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/routine', headers: async () => ({}) })
    const calendarRead = vi.fn(async () => ({ items: [] }))
    const calendar = createGoogleCalendarTools({ listEvents: calendarRead } as never).find(tool => tool.name === 'googleCalendarListEvents')!
    const tools = new Map([[calendar.name, calendar]])
    const controller = new AbortController(), authority = { assertCurrent: async () => {}, execute: async <T>(fn: () => Promise<T>) => fn() }
    const execution = { security: { authority, ceiling: { clearance: 'public' }, provenance: {} }, lifecycle: { abortSignal: controller.signal } }
    const metered = vi.fn(async () => {})
    const meter = createDecisionAttemptUsageRecorder({ recordUsage: metered } as never)
    const events: unknown[] = [], sent: Array<{ state: { systemPrompt: string; messages: unknown[] }; questions: unknown[] }> = []
    const systemPrompt = extra.large ? 'Fictional governing instruction.\n'.repeat(4500) : 'Check the requested calendar scope.'
    const messages = [{ role: 'user' as const, content: 'Check my calendar today.' }]
    const runtime = createDecisionRuntime({ llmProvider: provider, defaultLlmModel: 'gemini-2.5-flash', typesafeApiKey: 'fictional-key',
      ...(extra.adapter ? { adapters: new DecisionAdapterRegistry().register('typesafe', () => createTypeSafeDecisionProvider({ apiKey: 'fictional-key',
        ...(extra.adapter === 'unknown' ? { transport: vi.fn() } : { capabilities: { ...TYPESAFE_JEV_CAPABILITIES, ...(extra.adapter === 'primitive' ? { primitives: ['score'] as const } : {}) } }) })) } : {}),
      onAttempt: customHook ? async () => {} : registerDecisionMetadataSink(async (event: DecisionRuntimeAttempt) => { events.push(event); await meter(event) }),
      resolveRoute: context => { const config: DecisionRouteConfig = mode === 'llm_only' ? { mode: 'llm_only' } : { mode: 'hybrid', primaryModelId: 'typesafe-jev-1.13', allowSyntheticProfile: true,
        profile: { id: 'fictional-routine', version: '1', mode: 'hybrid', operationId: context.operation.id,
          operationVersion: context.operation.version, stateVersion: context.operation.stateVersion, questionVersion: context.operation.questionVersion,
          modelCatalogId: 'typesafe-jev-1.13', modelWireId: 'jev-1.13.0', evaluationSegment: 'global', status: 'approved', evidence: 'synthetic',
          totalTimeoutMs: 30_000, primaryTimeoutMs: 10_000, maxAttempts: 2 } }; return extra.patch ? extra.patch(config) : config },
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('typesafe.ai')) {
        if (mode !== 'primary') return new Response('{}', { status: 503 })
        const request = JSON.parse(init!.body as string)
        const answers = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
          const question = value as { type: string; criteria?: Record<string, unknown> }
          if (question.type === 'noul') return [id, { type: 'noul', noul: 1 }]
          const choice = id === 'routine' ? 'calendar' : request.state.ranges[0].id
          return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria!).map(key => [key, key === choice ? 1 : 0])) }]
        }))
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 9, output_tokens: 0 } }), { status: 200 })
      }
      const body = JSON.parse(init!.body as string)
      const request = JSON.parse(body.contents[0].parts[0].text)
      sent.push(request)
      const answers = Object.fromEntries(request.questions.map((question: { id: string; kind: string }) => [question.id,
        { value: question.id === 'routine' ? 'calendar' : question.id === 'range' ? request.state.ranges[0].id : true }]))
      const packet = { candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }
      return new Response('data: ' + JSON.stringify(packet) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const run = () => planRoutineCalendarRead({ runtime, llm: { provider, modelId: 'gemini-2.5-flash' }, workspaceId: 'fictional-workspace',
      systemPrompt, messages, tools, calendarTools: tools,
      assertInputAuthority: full, now: Date.parse('2031-06-02T00:00:00Z'),
      context: { userId: 'fictional-user', assistantId: 'fictional-assistant', sessionId: 'fictional-session', appId: 'fixture', channelType: 'web', channelId: 'fixture',
        abortSignal: controller.signal, authority, executionContext: execution as never, scopeAccumulator: new ContextScopeAccumulator(), assertModelInputAuthority: full },
    })
    return { run, full, fetch, calendarRead, sent, events, systemPrompt, messages, metered, provider }
  }

  it('keeps primary Jev usage solely in central platform metering', async () => {
    const f = await fixture('primary')
    try {
      const result = await f.run()
      expect(result.plan).not.toBeNull()
      expect(result.usage).toBeNull()
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(f.metered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerKeySource: 'platform', inputTokens: 9, model: 'jev-1.13.0' }))
    } finally { f.fetch.mockRestore() }
  })

  it('routes the complete large routine input directly to the resolved LLM without a Jev request', async () => {
    const f = await fixture('fallback', undefined, false, { large: true })
    try {
      const result = await f.run()
      expect(result.plan).not.toBeNull()
      expect(result.usedRequestedLlm).toBe(true)
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(String(f.fetch.mock.calls[0]![0])).not.toContain('typesafe.ai')
      expect(f.full).toHaveBeenCalledTimes(2)
      expect(f.sent[0]!.state.systemPrompt).toBe(f.systemPrompt)
      expect(f.sent[0]!.state.messages).toEqual(f.messages)
      expect(f.events).toEqual([expect.objectContaining({ configuredMode: 'hybrid', effectiveMode: 'llm_only', routingReason: 'estimated_context_capacity', stage: 'llm_only', attempt: 1 })])
      expect(f.calendarRead).not.toHaveBeenCalled()
    } finally { f.fetch.mockRestore() }
  })

  it('pins explicit override dispatch and key attribution across a pending source proof', async () => {
    const { createGeminiProvider } = await import('@use-brian/core')
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/override', headers: async () => ({}) })
    const selected = { provider, modelId: 'gemini-2.5-flash' }
    const f = await fixture('fallback', undefined, false, { large: true,
      patch: config => ({ ...config, llm: selected }) })
    f.full.mockImplementationOnce(async () => { await Promise.resolve(); selected.provider = f.provider })
    try {
      const result = await f.run()
      expect(result.plan).not.toBeNull()
      expect(result.usedRequestedLlm).toBe(false)
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(String(f.fetch.mock.calls[0]![0])).toContain('/override')
      expect(f.full).toHaveBeenCalledTimes(2)
    } finally { f.fetch.mockRestore() }
  })

  it.each(['llm_denied', 'no_failover', 'unapproved', 'mismatch', 'malformed', 'unknown', 'overridden', 'primitive', 'custom_hook'] as const)('never uses capacity to bypass %s', async defect => {
    const f = await fixture('fallback', undefined, defect === 'custom_hook', { large: true,
      ...(['unknown', 'overridden', 'primitive'].includes(defect) ? { adapter: defect as 'unknown' | 'overridden' | 'primitive' } : {}),
      patch: config => defect === 'llm_denied' ? { ...config, llm: null } : defect === 'no_failover' ? { ...config, allowOperationalFailover: false }
        : defect === 'unapproved' ? { ...config, profile: { ...config.profile!, status: 'evaluation' } }
        : defect === 'mismatch' ? { ...config, profile: { ...config.profile!, operationVersion: 'different' } }
        : defect === 'malformed' ? { ...config, profile: { ...config.profile!, maxAttempts: 3 as 2 } } : config,
    })
    try { expect((await f.run()).plan).toBeNull(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.calendarRead).not.toHaveBeenCalled() }
    finally { f.fetch.mockRestore() }
  })

  it.each([1, 2])('keeps source proof %s mandatory on the capacity route', async refuseAt => {
    const f = await fixture('fallback', refuseAt, false, { large: true })
    try { await expect(f.run()).rejects.toMatchObject({ reason: 'authority_changed' }); expect(f.fetch).toHaveBeenCalledTimes(refuseAt - 1) }
    finally { f.fetch.mockRestore() }
  })

  it('keeps the original absolute profile deadline while capacity admission is pending', async () => {
    const f = await fixture('fallback', undefined, false, { large: true,
      patch: config => ({ ...config, profile: { ...config.profile!, totalTimeoutMs: 30, primaryTimeoutMs: 10 } }) })
    vi.useFakeTimers()
    let release!: () => void
    const proof = new Promise<void>(resolve => { release = resolve })
    f.full.mockImplementationOnce(() => proof)
    try {
      const work = f.run().then(result => result, error => error)
      await vi.advanceTimersByTimeAsync(50)
      expect(f.fetch).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(50)
      const result = await work
      expect(result?.plan ?? null).toBeNull()
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.calendarRead).not.toHaveBeenCalled()
    } finally { release(); vi.useRealTimers(); f.fetch.mockRestore() }
  })

  it.each(['llm_only', 'fallback'] as const)('keeps fresh physical and final checks for owned %s planning', async mode => {
    const f = await fixture(mode)
    try {
      expect((await f.run()).plan).not.toBeNull()
      expect(f.full).toHaveBeenCalledTimes(mode === 'fallback' ? 3 : 2)
      expect(f.fetch).toHaveBeenCalledTimes(mode === 'fallback' ? 2 : 1)
      expect(f.calendarRead).not.toHaveBeenCalled()
    } finally { f.fetch.mockRestore() }
  })

  it.each([1, 2, 3])('refuses the plan when source admission %s fails', async refuseAt => {
    const f = await fixture('fallback', refuseAt)
    try {
      await expect(f.run()).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(f.fetch).toHaveBeenCalledTimes(refuseAt - 1)
      expect(f.calendarRead).not.toHaveBeenCalled()
    } finally { f.fetch.mockRestore() }
  })

  it('retains conservative checks with an arbitrary metadata hook', async () => {
    const f = await fixture('llm_only', undefined, true)
    try {
      expect((await f.run()).plan).not.toBeNull()
      expect(f.full.mock.calls.length).toBeGreaterThan(2)
      expect(f.calendarRead).not.toHaveBeenCalled()
    } finally { f.fetch.mockRestore() }
  })
})
