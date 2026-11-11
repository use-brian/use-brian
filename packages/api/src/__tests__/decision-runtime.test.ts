import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DecisionAdapterRegistry,
  classifyResearchIntent,
  classifyTopic,
  createTypeSafeDecisionProvider,
  createGeminiProvider,
  createRoutingProvider,
  wrapProvider,
  bindScopeSources,
  boundScopeSources,
  ContextScopeAccumulator,
  createExecutionContext,
  type DecisionProvider,
  type DecisionResponse,
  type LLMProvider,
  type SessionContextAuthority,
} from '@use-brian/core'
import {
  createDecisionAttemptUsageRecorder,
  createDecisionRuntime,
  type DecisionRuntimeAttempt,
  type DecisionRuntimeOperation,
  type CreateDecisionRuntimeOptions,
} from '../decision-runtime.js'

import { createWorkspaceDecisionRouteResolver } from '../workspace-decision-routing.js'
import { createWorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'
import type { WorkspaceCustomLlmEndpointStore } from '../db/workspace-custom-llm-endpoints.js'

type Result = { verdict: 'ordinary' | 'research' | 'safe' }

function classifierRuntime(extra: Partial<CreateDecisionRuntimeOptions> = {}) {
  return createDecisionRuntime({
    llmProvider: fixtureLlm(),
    defaultLlmModel: 'fixture-llm',
    typesafeApiKey: 'fixture-key',
    resolveRoute: context => ({
      mode: 'hybrid', primaryModelId: 'typesafe-jev-1.13', allowSyntheticProfile: true,
      profile: {
        ...profile(), operationId: context.operation.id,
        operationVersion: context.operation.version, stateVersion: context.operation.stateVersion,
        questionVersion: context.operation.questionVersion, totalTimeoutMs: 60_000, primaryTimeoutMs: 20_000,
      },
    }),
    ...extra,
  })
}

function classifierResponse(kind: 'research' | 'topic' = 'research') {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: kind === 'research' ? {
      intent: { type: 'choice', choice: 'ordinary', probabilities: {
        ordinary: 1, research_focused: 0, research: 0, research_deep: 0, operate_site: 0,
      } },
    } : {
      state: { type: 'choice', choice: 'continue', probabilities: { continue: 1, shift: 0, resume: 0, 'cross-topic': 0 } },
      topic: { type: 'choice', choice: 'calendar', probabilities: { calendar: 1, __new_topic__: 0, __uncategorized__: 0 } },
    },
    usage: { input_tokens: 8, output_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function authorityRefusal() {
  return Object.assign(new Error('Fictional source withdrawn'), { reason: 'authority_changed', retrySafe: false })
}

function typedCompletionResponse() {
  const answers = { intent: { value: 'ordinary' }, group0_rank1: { value: 't0' }, group0_rank2: { value: 'none' }, group0_rank3: { value: 'none' } }
  const packet = { candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }
  return new Response('data: ' + JSON.stringify(packet) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
}

function researchCompletionResponse() {
  const packet = { candidates: [{ content: { parts: [{ text: '{"research":true,"effort":"focused"}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }
  return new Response('data: ' + JSON.stringify(packet) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
}

function classifierAuthority(assertCurrent: () => Promise<void>): SessionContextAuthority {
  return {
    accumulator: new ContextScopeAccumulator(),
    execution: createExecutionContext({
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'fictional-actor' } },
      ownership: { kind: 'workspace', workspaceId: 'fictional-workspace' },
      access: { userId: 'fictional-actor', workspaceId: 'fictional-workspace', assistantId: 'fictional-assistant',
        assistantKind: 'standard', clearance: 'internal', compartments: [], mutationCompartments: [],
        projectIds: [], visibilityAssistantIds: ['fictional-assistant'] },
      writeDefaults: { compartments: [], projectIds: [] },
      authority: { assertCurrent, execute: async operation => operation() },
      lifecycle: { sessionId: 'fictional-session', channelId: 'web', channelType: 'web', abortSignal: new AbortController().signal },
    }),
  }
}

const classifierSource = { workspaceId: 'fictional-workspace', userId: null, assistantId: null,
  sensitivity: 'internal' as const, compartments: [], projectIds: [],
  resourceKind: 'memory' as const, resourceId: 'fictional-source', version: '1' }

describe('[COMP:decisions/runtime] certified classifier admission', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['llm_only', 'fallback'] as const)('admits the actual managed research-only request at dispatch and final return (%s)', async mode => {
    const full = vi.fn(async () => {})
    const raw = createGeminiProvider({ kind: 'ai-studio', endpoint: model => `https://fictional.example/${model}`, headers: async () => ({}) })
    const routed = createRoutingProvider({ gemini: wrapProvider(raw) })
    const recentConversation = Array.from({ length: 8 }, (_, index) => ({ role: 'user' as const, text: `  Fictional prior ${index} ${'x'.repeat(2100)}  ` }))
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('typesafe.ai')) return new Response('{}', { status: 503 })
      expect(full).toHaveBeenCalledTimes(mode === 'fallback' ? 2 : 1)
      expect(String(url)).toContain('gemini-3.6-flash')
      const body = JSON.parse(String(init?.body))
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: JSON.stringify({
        currentMessage: 'Compare fictional battery recycling methods',
        recentConversation: recentConversation.slice(-6).map(turn => ({ role: turn.role, text: turn.text.trim().slice(0, 2000) })),
      }) }] }])
      expect(JSON.stringify(body.systemInstruction)).toContain('MULTI-SOURCE INVESTIGATION')
      return researchCompletionResponse()
    })
    vi.stubGlobal('fetch', fetch)
    const result = await classifyResearchIntent(bindScopeSources({ provider: routed, model: 'gemini-3.6-flash-standard',
      message: 'Compare fictional battery recycling methods', recentConversation, authority: classifierAuthority(async () => {}),
      decisionRuntime: classifierRuntime({ llmProvider: routed,
        ...(mode === 'llm_only' ? { resolveRoute: () => ({ mode: 'llm_only' as const }) } : {}) }), assertInputAuthority: full }, [classifierSource]))
    expect(result).toMatchObject({ research: true, effort: 'focused' })
    expect(boundScopeSources(result)).toEqual([classifierSource])
    expect(result).not.toHaveProperty('toolNames')
    // Legacy decoding retains its extra source check after collecting the response.
    expect(full).toHaveBeenCalledTimes(mode === 'fallback' ? 4 : 3)
    expect(fetch).toHaveBeenCalledTimes(mode === 'fallback' ? 2 : 1)
  })

  it.each(['dispatch', 'collected', 'final'] as const)('refuses research-only source withdrawal at %s', async boundary => {
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { if (full.mock.calls.length === (boundary === 'dispatch' ? 1 : boundary === 'collected' ? 2 : 3)) throw refusal })
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const fetch = vi.fn(async () => researchCompletionResponse())
    vi.stubGlobal('fetch', fetch)
    await expect(classifyResearchIntent({ provider, model: 'gemini-3.5-flash-lite', message: 'Compare fictional energy storage methods',
      decisionRuntime: classifierRuntime({ llmProvider: provider, resolveRoute: () => ({ mode: 'llm_only' }) }), assertInputAuthority: full })).rejects.toBe(refusal)
    expect(fetch).toHaveBeenCalledTimes(boundary === 'dispatch' ? 0 : 1)
  })

  it.each(['before', 'after'] as const)('handles research-only provider replacement %s qualification', async timing => {
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const original = provider.stream.bind(provider)
    const replacement = vi.fn(async function* (request: Parameters<LLMProvider['stream']>[0]) { yield* original(request) })
    const full = vi.fn(async () => { await Promise.resolve(); if (timing === 'after') provider.stream = replacement })
    vi.stubGlobal('fetch', vi.fn(async () => researchCompletionResponse()))
    const result = await classifyResearchIntent({ provider, model: 'gemini-3.5-flash-lite', message: 'Compare fictional energy storage methods',
      decisionRuntime: classifierRuntime({ llmProvider: provider, resolveRoute: async () => {
        await Promise.resolve(); if (timing === 'before') provider.stream = replacement
        return { mode: 'llm_only' }
      } }), assertInputAuthority: full })
    expect(result.research).toBe(true)
    if (timing === 'before') { expect(replacement).toHaveBeenCalledOnce(); expect(full.mock.calls.length).toBeGreaterThan(3) }
    else { expect(replacement).not.toHaveBeenCalled(); expect(full).toHaveBeenCalledTimes(3) }
  })

  it.each(['runtime', 'accounting'] as const)('keeps conservative research-only checks for changed %s callbacks', async changed => {
    const full = vi.fn(async () => {})
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    vi.stubGlobal('fetch', vi.fn(async () => researchCompletionResponse()))
    const hook = vi.fn(async () => {})
    const runtime = classifierRuntime({ llmProvider: provider, resolveRoute: () => ({ mode: 'llm_only' }),
      ...(changed === 'accounting' ? { onAttempt: hook } : {}) })
    if (changed === 'runtime') {
      const original = runtime.run.bind(runtime)
      runtime.run = options => { hook(); return original(options) }
    }
    expect(await classifyResearchIntent({ provider, model: 'gemini-3.5-flash-lite', message: 'Compare fictional energy storage methods',
      decisionRuntime: runtime, assertInputAuthority: full })).toMatchObject({ research: true })
    expect(hook).toHaveBeenCalledOnce()
    expect(full.mock.calls.length).toBeGreaterThan(3)
  })

  it.each([false, true])('preserves research-only routing fallback and freshly admits its unowned child (withdrawn=%s)', async withdrawn => {
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { if (withdrawn && full.mock.calls.length === 2) throw refusal })
    const primary = fixtureLlm(), fallback = fixtureLlm()
    primary.stream = vi.fn(async function* () { throw Object.assign(new Error('Fictional outage'), { status: 503 }) })
    fallback.stream = vi.fn(async function* (request) {
      expect(full).toHaveBeenCalledTimes(2)
      expect(request.model).toBe('claude-haiku-4-5')
      expect(request).not.toHaveProperty('allowProviderFallback')
      expect(JSON.parse(String(request.messages[0]?.content)).currentMessage).toBe('Compare fictional energy storage methods')
      yield { type: 'text_delta' as const, text: '{"research":false}' }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const routed = createRoutingProvider({ gemini: primary, anthropic: fallback })
    const result = classifyResearchIntent({ provider: routed, model: 'gemini-3.6-flash-standard', message: 'Compare fictional energy storage methods',
      decisionRuntime: classifierRuntime({ llmProvider: routed, resolveRoute: () => ({ mode: 'llm_only' }) }), assertInputAuthority: full })
    if (withdrawn) { await expect(result).rejects.toBe(refusal); expect(fallback.stream).not.toHaveBeenCalled() }
    else { expect(await result).toMatchObject({ research: false }); expect(fallback.stream).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledTimes(4) }
    expect(primary.stream).toHaveBeenCalledOnce()
  })

  it('prevents late research-only dispatch after cancellation during physical admission', async () => {
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const controller = new AbortController(), full = vi.fn(async () => { entered(); await pending })
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const fetch = vi.fn(async () => researchCompletionResponse()); vi.stubGlobal('fetch', fetch)
    const result = classifyResearchIntent({ provider, model: 'gemini-3.5-flash-lite', message: 'Compare fictional energy storage methods', signal: controller.signal,
      decisionRuntime: classifierRuntime({ llmProvider: provider, resolveRoute: () => ({ mode: 'llm_only' }) }), assertInputAuthority: full })
    const rejected = expect(result).rejects.toBeDefined()
    await started; controller.abort(new Error('Fictional cancellation')); release(); await rejected
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['llm_only', 'fallback'] as const)('preserves owned admission through the actual managed resolver and boot provider factories (%s)', async mode => {
    const full = vi.fn(async () => {})
    const raw = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const routed = createRoutingProvider({ gemini: wrapProvider(raw) })
    const route = await createWorkspaceCustomLlmResolver({
      getTierRouteSystem: async () => ({ modelAlias: 'gemini-3.6-flash-standard' }),
    } as unknown as WorkspaceCustomLlmEndpointStore, { managedProvider: routed })({ workspaceId: 'fictional-workspace', requestedTier: 'standard' })
    expect(route?.routeKind).toBe('managed')
    const fetch = vi.fn(async (url: unknown) => String(url).includes('typesafe.ai') ? new Response('{}', { status: 503 }) : typedCompletionResponse())
    vi.stubGlobal('fetch', fetch)
    const result = await classifyResearchIntent({ provider: route!.provider, model: route!.selector, message: 'Check my calendar today',
      workspaceId: 'fictional-workspace', toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ llmProvider: routed, defaultLlmModel: 'gemini-3.5-flash-lite',
        ...(mode === 'llm_only' ? { resolveRoute: () => ({ mode: 'llm_only' as const }) } : {}) }), assertInputAuthority: full })
    expect(result.toolNames).toEqual(['calendarListEvents'])
    expect(fetch).toHaveBeenCalledTimes(mode === 'fallback' ? 2 : 1)
    expect(full).toHaveBeenCalledTimes(mode === 'fallback' ? 3 : 2)
  })

  it.each(['dispatch', 'final', 'method'] as const)('keeps the actual managed route guarded against %s changes', async boundary => {
    const refusal = authorityRefusal(), replacement = vi.fn(async function* () { throw new Error('Unexpected replacement') })
    const raw = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const routed = createRoutingProvider({ gemini: wrapProvider(raw) })
    const route = await createWorkspaceCustomLlmResolver({ getTierRouteSystem: async () => ({ modelAlias: 'gemini-3.6-flash-standard' }) } as unknown as WorkspaceCustomLlmEndpointStore, { managedProvider: routed })({ workspaceId: 'fictional-workspace', requestedTier: 'standard' })
    const full = vi.fn(async () => {
      await Promise.resolve()
      if (boundary === 'method') routed.stream = replacement
      else if (full.mock.calls.length === (boundary === 'dispatch' ? 1 : 2)) throw refusal
    })
    const fetch = vi.fn(async () => typedCompletionResponse())
    vi.stubGlobal('fetch', fetch)
    const result = classifyResearchIntent({ provider: route!.provider, model: route!.selector, message: 'Check my calendar today',
      toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ llmProvider: routed, resolveRoute: () => ({ mode: 'llm_only' }) }), assertInputAuthority: full })
    if (boundary === 'method') await expect(result).resolves.toMatchObject({ toolNames: ['calendarListEvents'] })
    else await expect(result).rejects.toBe(refusal)
    expect(fetch).toHaveBeenCalledTimes(boundary === 'dispatch' ? 0 : 1)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('does not enroll research in the routine-only capacity route', async () => {
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const fetch = vi.fn(async () => typedCompletionResponse())
    vi.stubGlobal('fetch', fetch)
    const result = await classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Fictional research context. '.repeat(6000),
      toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ llmProvider: provider }), assertInputAuthority: async () => {} })
    expect(result.research).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['llm_only', 'fallback'] as const)('admits a fixed typed %s completion only at physical dispatch and final return', async mode => {
    const full = vi.fn(async () => {})
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('typesafe.ai')) { expect(full).toHaveBeenCalledTimes(1); return new Response('{}', { status: 503 }) }
      expect(full).toHaveBeenCalledTimes(mode === 'fallback' ? 2 : 1)
      return typedCompletionResponse()
    })
    vi.stubGlobal('fetch', fetch)
    const runtime = classifierRuntime({ llmProvider: provider, defaultLlmModel: 'gemini-2.5-flash',
      ...(mode === 'llm_only' ? { resolveRoute: () => ({ mode: 'llm_only' as const }) } : {}) })
    const result = await classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Check my calendar today',
      workspaceId: 'fictional-workspace', toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: runtime, assertInputAuthority: full })
    expect(result).toMatchObject({ research: false, toolNames: ['calendarListEvents'] })
    expect(fetch).toHaveBeenCalledTimes(mode === 'fallback' ? 2 : 1)
    expect(full).toHaveBeenCalledTimes(mode === 'fallback' ? 3 : 2)
  })

  it.each(['primary', 'dispatch', 'final'] as const)('keeps a source refusal sticky at the typed fallback %s boundary', async boundary => {
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { if (full.mock.calls.length === (boundary === 'primary' ? 1 : boundary === 'dispatch' ? 2 : 3)) throw refusal })
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const fetch = vi.fn(async (url: unknown) => String(url).includes('typesafe.ai') ? new Response('{}', { status: 503 }) : typedCompletionResponse())
    vi.stubGlobal('fetch', fetch)
    await expect(classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Check my calendar today',
      workspaceId: 'fictional-workspace', toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ llmProvider: provider, defaultLlmModel: 'gemini-2.5-flash' }), assertInputAuthority: full })).rejects.toBe(refusal)
    expect(fetch).toHaveBeenCalledTimes(boundary === 'primary' ? 0 : boundary === 'dispatch' ? 1 : 2)
  })

  it('pins the qualified provider methods before an awaited physical proof', async () => {
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const replacement = vi.fn(async function* () { throw new Error('Replacement must not execute') })
    const full = vi.fn(async () => { await Promise.resolve(); provider.stream = replacement })
    vi.stubGlobal('fetch', vi.fn(async () => typedCompletionResponse()))
    const result = await classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Check my calendar today',
      toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ resolveRoute: () => ({ mode: 'llm_only' }), llmProvider: provider }), assertInputAuthority: full })
    expect(result.toolNames).toEqual(['calendarListEvents']);expect(full).toHaveBeenCalledTimes(2)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('does not certify a provider replaced while route resolution is pending', async () => {
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const full = vi.fn(async () => {}), original = provider.stream.bind(provider)
    const replacement = vi.fn(async function* (request: Parameters<LLMProvider['stream']>[0]) {
      expect(full.mock.calls.length).toBeGreaterThan(1)
      yield* original(request)
    })
    vi.stubGlobal('fetch', vi.fn(async () => typedCompletionResponse()))
    await classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Check my calendar today',
      toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ resolveRoute: async () => { await Promise.resolve();provider.stream = replacement;return { mode: 'llm_only' } }, llmProvider: provider }), assertInputAuthority: full })
    expect(replacement).toHaveBeenCalledOnce();expect(full.mock.calls.length).toBeGreaterThan(2)
  })

  it('does not dispatch a certified completion after cancellation during its physical proof', async () => {
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const controller = new AbortController()
    const full = vi.fn(async () => { entered(); await pending })
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    const fetch = vi.fn(async () => typedCompletionResponse())
    vi.stubGlobal('fetch', fetch)
    const work = classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Check my calendar today',
      toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }], signal: controller.signal,
      decisionRuntime: classifierRuntime({ resolveRoute: () => ({ mode: 'llm_only' }), llmProvider: provider }), assertInputAuthority: full })
    const rejected = expect(work).rejects.toBeDefined()
    await started
    controller.abort(new Error('Fictional cancellation'))
    release()
    await rejected
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains conservative completion checks for an arbitrary accounting hook', async () => {
    const full = vi.fn(async () => {})
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/completion', headers: async () => ({}) })
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => String(url).includes('typesafe.ai') ? new Response('{}', { status: 503 }) : typedCompletionResponse()))
    await classifyResearchIntent({ provider, model: 'gemini-2.5-flash', message: 'Check my calendar today',
      workspaceId: 'fictional-workspace', toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: classifierRuntime({ llmProvider: provider, defaultLlmModel: 'gemini-2.5-flash', onAttempt: async () => {} }), assertInputAuthority: full })
    expect(full.mock.calls.length).toBeGreaterThan(3)
  })

  it.each(['ordinary', 'research_focused'])('admits the merged %s decision at physical dispatch and final return only', async intent => {
    const full = vi.fn(async () => {})
    const recordUsage = vi.fn(async () => {})
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(full).toHaveBeenCalledTimes(1)
      expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(['model', 'questions', 'state'])
      const body = await classifierResponse().json() as {
        answers: Record<string, { type: string; choice: string; probabilities: Record<string, number> }>
      }
      body.answers.intent!.choice = intent
      body.answers.intent!.probabilities = { ordinary: 0, research_focused: 0, research: 0, research_deep: 0, operate_site: 0, [intent]: 1 }
      for (let rank = 1; rank <= 3; rank++) body.answers[`group0_rank${rank}`] = {
        type: 'choice', choice: rank === 1 ? 't0' : 'none',
        probabilities: { t0: rank === 1 ? 1 : 0, none: rank === 1 ? 0 : 1 },
      }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const runtime = classifierRuntime({ onAttempt: createDecisionAttemptUsageRecorder({ recordUsage } as never) })
    const result = await classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      workspaceId: 'fictional-workspace', toolCandidates: [{ name: 'calendarListEvents', description: 'Read calendar events' }],
      decisionRuntime: runtime, assertInputAuthority: full })
    expect(result).toMatchObject({ research: intent !== 'ordinary', toolNames: ['calendarListEvents'] })
    expect(full).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledOnce()
    expect(recordUsage).toHaveBeenCalledOnce()
  })

  it('keeps a fresh final proof for a topic resolved by the built-in decision transport', async () => {
    const full = vi.fn(async () => {})
    const fetch = vi.fn(async () => { expect(full).toHaveBeenCalledTimes(1); return classifierResponse('topic') })
    vi.stubGlobal('fetch', fetch)
    const result = await classifyTopic({ provider: fixtureLlm(), model: 'fixture-llm',
      currentMessage: 'Check my calendar today', recentUserTurns: [{ text: 'Plan tomorrow', topicLabel: 'calendar' }],
      replyToText: null, knownTopicsThisSession: ['calendar'], decisionRuntime: classifierRuntime(), assertInputAuthority: full })
    expect(result).toMatchObject({ topic_label: 'calendar', state: 'continue', confidence: 1 })
    expect(full).toHaveBeenCalledTimes(2)
  })

  it('refuses withdrawn input before the first physical request', async () => {
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { throw refusal })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      decisionRuntime: classifierRuntime(), assertInputAuthority: full })).rejects.toBe(refusal)
    expect(full).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('withholds a successful result when the final fresh proof detects revocation', async () => {
    let withdrawn = false
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { if (withdrawn) throw refusal })
    const fetch = vi.fn(async () => { withdrawn = true; return classifierResponse() })
    const llm = fixtureLlm()
    llm.stream = vi.fn(llm.stream)
    vi.stubGlobal('fetch', fetch)
    await expect(classifyResearchIntent({ provider: llm, message: 'Check my calendar today',
      decisionRuntime: classifierRuntime(), assertInputAuthority: full })).rejects.toBe(refusal)
    expect(full).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledOnce()
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('keeps conservative checks when a registered runtime method is replaced before capture', async () => {
    const full = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => classifierResponse()))
    const runtime = classifierRuntime(), original = runtime.run.bind(runtime)
    const replacement = vi.fn()
    runtime.run = options => { replacement(); return original(options) }
    await classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      decisionRuntime: runtime, assertInputAuthority: full })
    expect(replacement).toHaveBeenCalledOnce()
    expect(full.mock.calls.length).toBeGreaterThan(2)
  })

  it('pins the runtime and transport methods across awaited admission', async () => {
    const fetch = vi.fn(async () => classifierResponse())
    vi.stubGlobal('fetch', fetch)
    const provider = createTypeSafeDecisionProvider({ apiKey: 'fixture-key' })
    const runtime = classifierRuntime({ adapters: new DecisionAdapterRegistry().register('typesafe', () => provider) })
    const originalRun = runtime.run.bind(runtime)
    const replacementRun = vi.fn(), replacementEvaluate = vi.fn(provider.evaluate)
    const full = vi.fn(async () => {
      runtime.run = options => { replacementRun(); return originalRun(options) }
      provider.evaluate = replacementEvaluate
    })
    await classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      decisionRuntime: runtime, assertInputAuthority: full })
    expect(full).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledOnce()
    expect(replacementRun).not.toHaveBeenCalled()
    expect(replacementEvaluate).not.toHaveBeenCalled()
  })

  it('does not certify an injected custom transport', async () => {
    const full = vi.fn(async () => {})
    const transport = vi.fn(async () => {
      expect(full.mock.calls.length).toBeGreaterThanOrEqual(2)
      return { status: 200, body: await classifierResponse().json() }
    })
    const runtime = classifierRuntime({ adapters: new DecisionAdapterRegistry().register('typesafe',
      () => createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport })) })
    await classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      decisionRuntime: runtime, assertInputAuthority: full })
    expect(full.mock.calls.length).toBeGreaterThan(2)
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(['onAttempt', 'onOutcome'] as const)('retains full checks around an arbitrary %s hook', async hookName => {
    let withdrawn = false
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { if (withdrawn) throw refusal })
    const hook = vi.fn(async () => { withdrawn = true })
    vi.stubGlobal('fetch', vi.fn(async () => classifierResponse()))
    await expect(classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      decisionRuntime: classifierRuntime({ [hookName]: hook }), assertInputAuthority: full })).rejects.toBe(refusal)
    expect(hook).toHaveBeenCalledOnce()
    expect(full.mock.calls.length).toBeGreaterThan(2)
  })

  it('restores conservative admission before an LLM fallback and its result', async () => {
    const full = vi.fn(async () => {})
    let checksAtFallback = 0
    const llm = fixtureLlm()
    llm.stream = vi.fn(async function* () {
      checksAtFallback = full.mock.calls.length
      yield { type: 'message_start' as const, model: 'fixture-llm' }
      yield { type: 'text_delta' as const, text: '{"research":true,"effort":"focused"}' }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 10, outputTokens: 3 } }
    })
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const result = await classifyResearchIntent({ provider: llm, message: 'Compare the options using fresh evidence',
      decisionRuntime: classifierRuntime({ llmProvider: llm }), assertInputAuthority: full })
    expect(result).toMatchObject({ research: true, effort: 'focused' })
    expect(checksAtFallback).toBeGreaterThan(1)
    expect(full.mock.calls.length).toBeGreaterThan(checksAtFallback)
    expect(fetch).toHaveBeenCalledOnce()
    expect(llm.stream).toHaveBeenCalledOnce()
  })

  it('keeps a refusal sticky during operational fallback', async () => {
    const refusal = authorityRefusal()
    const full = vi.fn(async () => { if (full.mock.calls.length === 2) throw refusal })
    const llm = fixtureLlm()
    llm.stream = vi.fn(llm.stream)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await expect(classifyResearchIntent({ provider: llm, message: 'Compare the options using fresh evidence',
      decisionRuntime: classifierRuntime({ llmProvider: llm }), assertInputAuthority: full })).rejects.toBe(refusal)
    expect(full).toHaveBeenCalledTimes(2)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('cancels response processing without dispatching a fallback', async () => {
    const controller = new AbortController()
    const llm = fixtureLlm()
    llm.stream = vi.fn(llm.stream)
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return classifierResponse() }))
    await expect(classifyResearchIntent({ provider: llm, message: 'Check my calendar today', signal: controller.signal,
      decisionRuntime: classifierRuntime({ llmProvider: llm }), assertInputAuthority: async () => {} })).rejects.toThrow()
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('closes late authority callbacks after an unregistered runtime returns', async () => {
    const full = vi.fn(async () => {})
    const runtime = classifierRuntime()
    let lateCheck: (() => Promise<void>) | undefined
    const original = runtime.run.bind(runtime)
    runtime.run = options => { lateCheck = options.operation.assertInputAuthority; return original(options) }
    vi.stubGlobal('fetch', vi.fn(async () => classifierResponse()))
    await classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today',
      decisionRuntime: runtime, assertInputAuthority: full })
    const count = full.mock.calls.length
    await expect(lateCheck!()).rejects.toThrow('authority window has closed')
    expect(full).toHaveBeenCalledTimes(count)
  })

  it.each(['research', 'topic'] as const)('pins %s bytes, source callback and canonical lease before the first await', async kind => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const originalLease = vi.fn(async () => { if (originalLease.mock.calls.length === 1) await pending })
    const replacementLease = vi.fn(async () => {})
    const full = vi.fn(async () => {}), replacementFull = vi.fn(async () => {})
    const authority = classifierAuthority(originalLease)
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).state.currentMessage).toBe('Check my calendar today')
      return classifierResponse(kind)
    })
    vi.stubGlobal('fetch', fetch)
    const common = { provider: fixtureLlm(), model: 'fixture-llm', authority, assertInputAuthority: full,
      decisionRuntime: classifierRuntime() }
    const research = bindScopeSources({ ...common, message: 'Check my calendar today',
      recentConversation: [{ role: 'user' as const, text: 'Plan tomorrow' }] }, [classifierSource])
    const topic = bindScopeSources({ ...common, currentMessage: 'Check my calendar today',
      recentUserTurns: [{ text: 'Plan tomorrow', topicLabel: 'calendar' }], replyToText: null, knownTopicsThisSession: ['calendar'] }, [classifierSource])
    const work = kind === 'research' ? classifyResearchIntent(research) : classifyTopic(topic)
    research.assertInputAuthority = replacementFull
    research.message = 'Replacement payload'
    research.recentConversation[0]!.text = 'Replacement history'
    topic.assertInputAuthority = replacementFull
    topic.currentMessage = 'Replacement payload'
    topic.recentUserTurns[0]!.text = 'Replacement history'
    research.authority = topic.authority = classifierAuthority(replacementLease)
    release()
    await work
    expect(full).toHaveBeenCalledTimes(2)
    expect(originalLease.mock.calls.length).toBeGreaterThan(2)
    expect(replacementFull).not.toHaveBeenCalled()
    expect(replacementLease).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps lease checks active between physical dispatch and final source validation', async () => {
    let revoked = false
    const refusal = authorityRefusal()
    const lease = vi.fn(async () => { if (revoked) throw refusal })
    const full = vi.fn(async () => {})
    const fetch = vi.fn(async () => { revoked = true; return classifierResponse() })
    vi.stubGlobal('fetch', fetch)
    const options = bindScopeSources({ provider: fixtureLlm(), message: 'Check my calendar today',
      authority: classifierAuthority(lease), decisionRuntime: classifierRuntime(), assertInputAuthority: full }, [classifierSource])
    await expect(classifyResearchIntent(options)).rejects.toBe(refusal)
    expect(full).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('pins the registered usage-store method rather than accepting a replacement after dispatch', async () => {
    const recordUsage = vi.fn(async () => {}), replacement = vi.fn(async () => {})
    const usageStore = { recordUsage }
    const recorder = createDecisionAttemptUsageRecorder(usageStore as never)
    const full = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => { usageStore.recordUsage = replacement; return classifierResponse() }))
    await classifyResearchIntent({ provider: fixtureLlm(), message: 'Check my calendar today', workspaceId: 'fictional-workspace',
      decisionRuntime: classifierRuntime({ onAttempt: recorder }), assertInputAuthority: full })
    expect(full).toHaveBeenCalledTimes(2)
    expect(recordUsage).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
  })
})

const operationRef = {
  id: 'fixture.intent',
  version: '1',
  stateVersion: '1',
  questionVersion: '1',
}

function fixtureLlm(): LLMProvider {
  return {
    name: 'fixture-llm',
    models: ['fixture-llm'],
    stream: async function* () {
      yield { type: 'message_start', model: 'fixture-llm' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
    },
    createSession: () => ({ send: async function* () {} }),
  }
}

function request() {
  return {
    runId: 'runtime-fictional-1',
    operation: operationRef,
    state: { message: 'Compare the fictional Acorn and Birch plans.' },
    questions: [{
      kind: 'choice' as const,
      id: 'intent',
      prompt: 'Which bounded intent matches?',
      options: [{ value: 'ordinary' }, { value: 'research' }],
    }],
  }
}

function resultOperation(
  complete = vi.fn<DecisionRuntimeOperation<Result>['completeWithLlm']>(async (context) => ({
    result: { verdict: 'research' },
    providerId: context.llm.provider.name,
    model: { catalogId: context.llm.modelId, wireId: context.llm.modelId },
    usage: { inputTokens: 20, outputTokens: 5 },
  })),
): DecisionRuntimeOperation<Result> {
  return {
    decide(response) {
      const answer = response.answers[0]
      return answer?.kind === 'choice'
        ? { kind: 'complete', result: { verdict: answer.value as Result['verdict'] } }
        : { kind: 'unavailable', reason: 'invalid_response' }
    },
    validateResult(result) {
      if (!['ordinary', 'research', 'safe'].includes(result.verdict)) throw new Error('invalid result')
      return result
    },
    safeFailure: () => ({ verdict: 'safe' }),
    completeWithLlm: complete,
  }
}

function primaryProvider(): DecisionProvider {
  return {
    id: 'fixture-typesafe',
    capabilities: {
      primitives: ['choice'],
      batch: true,
      maxOptions: 255,
      maxQuestions: 64,
      maxRubricLevels: 10,
      maxInputTokens: 64_000,
      uncertainty: ['native_distribution'],
    },
    async evaluate(decisionRequest): Promise<DecisionResponse> {
      return {
        providerId: 'fixture-typesafe',
        model: decisionRequest.model,
        answers: [{
          kind: 'choice',
          questionId: 'intent',
          value: 'ordinary',
          evidence: {
            source: 'native_distribution',
            probabilities: { ordinary: 0.9, research: 0.1 },
          },
        }],
        usage: { inputTokens: 8, outputTokens: 0 },
      }
    },
  }
}

function profile() {
  return {
    id: 'fixture-profile',
    version: '1',
    mode: 'hybrid' as const,
    operationId: operationRef.id,
    operationVersion: operationRef.version,
    stateVersion: operationRef.stateVersion,
    questionVersion: operationRef.questionVersion,
    modelCatalogId: 'typesafe-jev-1.13',
    modelWireId: 'jev-1.13.0',
    evaluationSegment: 'global',
    status: 'approved' as const,
    evidence: 'synthetic' as const,
    totalTimeoutMs: 100,
    primaryTimeoutMs: 50,
    maxAttempts: 2 as const,
  }
}

describe('[COMP:decisions/runtime] decision composition', () => {
  it('defaults to one LLM-only completion and supplies the boot LLM lane', async () => {
    const llm = fixtureLlm()
    const complete = vi.fn<DecisionRuntimeOperation<Result>['completeWithLlm']>(async (context) => ({
      result: { verdict: 'research' },
      providerId: context.llm.provider.name,
      model: { catalogId: context.llm.modelId, wireId: context.llm.modelId },
    }))
    const runtime = createDecisionRuntime({ llmProvider: llm, defaultLlmModel: 'fixture-llm' })

    const result = await runtime.run({ request: request(), operation: resultOperation(complete) })

    expect(result).toMatchObject({ path: 'llm_only', attempts: 1, result: { verdict: 'research' } })
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]![0].llm).toEqual({ provider: llm, modelId: 'fixture-llm' })
  })

  it('treats a missing decision credential as configuration absence and stays functional', async () => {
    const complete = vi.fn(resultOperation().completeWithLlm)
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: profile(),
        allowSyntheticProfile: true,
      }),
    })

    const result = await runtime.run({ request: request(), operation: resultOperation(complete) })

    expect(result).toMatchObject({ path: 'llm_only', attempts: 1 })
    expect(runtime.configuredAdapterIds()).not.toContain('typesafe')
    expect(complete).toHaveBeenCalledOnce()
  })

  it('skips observation in llm-only mode without invoking an LLM completion', async () => {
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
    })
    const complete = vi.fn(resultOperation().completeWithLlm)

    const result = await runtime.observe({
      request: request(),
      operation: {
        decide: resultOperation(complete).decide,
        validateResult: resultOperation(complete).validateResult,
      },
    })

    expect(result).toMatchObject({ path: 'skipped', attempts: 0 })
    expect(complete).not.toHaveBeenCalled()
  })

  it('runs one configured primary observation without an LLM completion', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const complete = vi.fn(resultOperation().completeWithLlm)
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      onAttempt: createDecisionAttemptUsageRecorder({ recordUsage } as never),
      resolveRoute: () => ({
        mode: 'shadow',
        primaryModelId: 'typesafe-jev-1.13',
        profile: {
          ...profile(),
          mode: 'shadow',
          status: 'evaluation',
          shadowSampleRate: 1,
        },
      }),
    })

    const op = resultOperation(complete)
    const result = await runtime.observe({
      workspaceId: 'workspace-fictional',
      request: request(),
      operation: { decide: op.decide, validateResult: op.validateResult },
    })

    expect(result).toMatchObject({
      path: 'observed_complete',
      attempts: 1,
      disposition: { kind: 'complete', result: { verdict: 'ordinary' } },
    })
    expect(complete).not.toHaveBeenCalled()
    expect(recordUsage).toHaveBeenCalledOnce()
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-fictional',
      model: 'jev-1.13.0',
      triggerKey: 'decision_fixture_intent',
    }))
  })

  it('resolves workspace policy to an injected adapter with no vendor branch in Hydra', async () => {
    const adapters = new DecisionAdapterRegistry()
      .register('typesafe', () => primaryProvider())
    const resolveRoute = vi.fn(() => ({
      mode: 'hybrid' as const,
      primaryModelId: 'typesafe-jev-1.13',
      profile: profile(),
      allowSyntheticProfile: true,
    }))
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: () => 'fixture-llm',
      adapters,
      resolveRoute,
    })

    const result = await runtime.run({
      workspaceId: 'workspace-fictional',
      request: request(),
      operation: resultOperation(),
    })

    expect(result).toMatchObject({ path: 'primary_complete', attempts: 1, result: { verdict: 'ordinary' } })
    expect(resolveRoute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-fictional',
      operation: operationRef,
      questionKinds: ['choice'],
    }))
  })

  it('attributes each attempt and prices known decision usage from the shared catalog', async () => {
    const attempts: Array<{ usage?: { costUsd?: number }; effectiveMode: string; operatorOverride: boolean }> = []
    const outcomes: Array<{ path: string; effectiveMode: string; operatorOverride: boolean }> = []
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid', primaryModelId: 'typesafe-jev-1.13', profile: profile(), allowSyntheticProfile: true,
      }),
      onAttempt: (attempt) => { attempts.push(attempt) },
      onOutcome: (outcome) => { outcomes.push(outcome) },
    })

    await runtime.run({ request: request(), operation: resultOperation() })

    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ effectiveMode: 'hybrid', operatorOverride: false, usage: { costUsd: 8 * 0.042 / 1_000_000 } })
    expect(outcomes).toEqual([expect.objectContaining({ path: 'primary_complete', effectiveMode: 'hybrid', operatorOverride: false })])
  })

  it('records a successful Jev attempt in the shared usage ledger exactly once', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const requestWithKnownOperation = {
      ...request(),
      operation: { ...operationRef, id: 'research.intent' },
    }
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: { ...profile(), operationId: 'research.intent' },
        allowSyntheticProfile: true,
      }),
      onAttempt: createDecisionAttemptUsageRecorder({ recordUsage } as never),
    })

    await runtime.run({
      workspaceId: 'workspace-fictional',
      request: requestWithKnownOperation,
      operation: resultOperation(),
    })

    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith({
      userId: '',
      assistantId: '',
      workspaceId: 'workspace-fictional',
      sessionId: null,
      model: 'jev-1.13.0',
      inputTokens: 8,
      outputTokens: 0,
      actualCostUsd: 8 * 0.042 / 1_000_000,
      source: 'overhead:classifier',
      triggerKey: 'adaptive_research_classifier',
      providerKeySource: 'platform',
    })
  })

  it('meters every priced primary attempt but ignores LLM stages and unattributed attempts', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    const record = createDecisionAttemptUsageRecorder({ recordUsage } as never)
    const primaryAttempt: DecisionRuntimeAttempt = {
      runId: 'runtime-fictional-metering',
      operationId: 'ingest.sensitivity',
      attempt: 1,
      stage: 'primary_decision',
      providerId: 'fixture-typesafe',
      modelCatalogId: 'typesafe-jev-1.13',
      modelWireId: 'jev-1.13.0',
      latencyMs: 4,
      outcome: 'success',
      disposition: 'complete',
      usage: { inputTokens: 100, outputTokens: 0 },
      workspaceId: 'workspace-fictional',
      configuredMode: 'shadow',
      effectiveMode: 'shadow',
      operatorOverride: false,
    }

    await record(primaryAttempt)
    await record({ ...primaryAttempt, attempt: 2, outcome: 'error', disposition: undefined })
    await record({ ...primaryAttempt, stage: 'generation', modelCatalogId: 'gemini-3.5-flash-lite', modelWireId: 'gemini-3.5-flash-lite' })
    await record({ ...primaryAttempt, workspaceId: undefined })
    await record({ ...primaryAttempt, usage: undefined })

    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'overhead:classifier',
      triggerKey: 'sensitivity_classifier',
      actualCostUsd: 100 * 0.042 / 1_000_000,
    }))
  })

  it('swallows decision usage-store failures so metering never changes the result', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const record = createDecisionAttemptUsageRecorder({
      recordUsage: vi.fn().mockRejectedValue(new Error('ledger unavailable')),
    } as never)
    const attempt: DecisionRuntimeAttempt = {
      runId: 'runtime-fictional-metering-error',
      operationId: 'fixture.unknown',
      attempt: 1,
      stage: 'primary_decision',
      providerId: 'fixture-typesafe',
      modelCatalogId: 'typesafe-jev-1.13',
      modelWireId: 'jev-1.13.0',
      latencyMs: 4,
      outcome: 'success',
      disposition: 'complete',
      usage: { inputTokens: 8, outputTokens: 0 },
      workspaceId: 'workspace-fictional',
      configuredMode: 'hybrid',
      effectiveMode: 'hybrid',
      operatorOverride: false,
    }

    await expect(record(attempt)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      '[decision-metering] failed to record provider usage',
      expect.objectContaining({
        runId: 'runtime-fictional-metering-error',
        error: 'ledger unavailable',
      }),
    )
    error.mockRestore()
  })

  it('attributes deployment operator override attempts and outcomes', async () => {
    const attempts: Array<{ operatorOverride: boolean }> = []
    const outcomes: Array<{ operatorOverride: boolean }> = []
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: {
          ...profile(),
          status: 'operator_override',
          evidence: 'operator_override',
        },
        operatorOverride: true,
      }),
      onAttempt: (attempt) => { attempts.push(attempt) },
      onOutcome: (outcome) => { outcomes.push(outcome) },
    })

    await runtime.run({ request: request(), operation: resultOperation() })

    expect(attempts).toEqual([expect.objectContaining({ operatorOverride: true })])
    expect(outcomes).toEqual([expect.objectContaining({ operatorOverride: true })])
  })

  it('rejects unknown models, missing model ids, denied LLM lanes, and mismatched profiles before dispatch', async () => {
    const llm = fixtureLlm()
    const base = { llmProvider: llm, defaultLlmModel: 'fixture-llm' }
    const run = (runtime: ReturnType<typeof createDecisionRuntime>) => runtime.run({
      request: request(), operation: resultOperation(),
    })

    await expect(run(createDecisionRuntime({
      ...base, resolveRoute: () => ({ mode: 'hybrid', profile: profile() }),
    }))).rejects.toThrow(/primaryModelId/)
    await expect(run(createDecisionRuntime({
      ...base, resolveRoute: () => ({ mode: 'hybrid', primaryModelId: 'unknown', profile: profile() }),
    }))).rejects.toThrow(/not an active decision model/)
    await expect(run(createDecisionRuntime({
      ...base, resolveRoute: () => ({ mode: 'llm_only', llm: null }),
    }))).rejects.toThrow(/no permitted LLM/)

    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    await expect(run(createDecisionRuntime({
      ...base,
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: { ...profile(), questionVersion: 'wrong' },
        allowSyntheticProfile: true,
      }),
    }))).rejects.toThrow(/versions/)
  })
})

describe('[COMP:decisions/runtime] complete invocation deadlines', () => {
  it('times out a pending route lookup and prevents its late result from dispatching', async () => {
    vi.useFakeTimers()
    let resolveRoute!: (route: { mode: 'llm_only' }) => void
    const pending = new Promise<{ mode: 'llm_only' }>(resolve => { resolveRoute = resolve })
    const complete = vi.fn(resultOperation().completeWithLlm)
    const outcome = vi.fn()
    try {
      const runtime = createDecisionRuntime({ llmProvider: fixtureLlm(), defaultLlmModel: 'fixture-llm',
        resolveRoute: () => pending, onOutcome: outcome })
      const start = Date.now()
      const run = runtime.run({ request: { ...request(), deadlineAt: start + 100 }, operation: resultOperation(complete) })
      const refusal = expect(run).rejects.toMatchObject({ kind: 'timeout' })
      await Promise.all([refusal, vi.advanceTimersByTimeAsync(100)])
      expect(Date.now() - start).toBe(100)
      resolveRoute({ mode: 'llm_only' }); await vi.runAllTimersAsync()
      expect(complete).not.toHaveBeenCalled(); expect(outcome).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('does not start a second accounting callback after the first outlives the deadline', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const first = vi.fn(() => pending), second = vi.fn()
    try {
      const runtime = createDecisionRuntime({ llmProvider: fixtureLlm(), defaultLlmModel: 'fixture-llm', onAttempt: first })
      const run = runtime.run({ request: { ...request(), deadlineAt: Date.now() + 100 },
        operation: resultOperation(), onAttempt: second })
      const refusal = expect(run).rejects.toMatchObject({ kind: 'timeout' })
      await Promise.all([refusal, vi.advanceTimersByTimeAsync(100)])
      expect(first).toHaveBeenCalledOnce()
      release(); await vi.runAllTimersAsync()
      expect(second).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('does not release a verdict while an outcome callback hangs past the total deadline', async () => {
    vi.useFakeTimers()
    try {
      const outcome = vi.fn(() => new Promise<void>(() => {}))
      const runtime = createDecisionRuntime({ llmProvider: fixtureLlm(), defaultLlmModel: 'fixture-llm', onOutcome: outcome })
      const run = runtime.run({ request: { ...request(), deadlineAt: Date.now() + 100 }, operation: resultOperation() })
      const refusal = expect(run).rejects.toMatchObject({ kind: 'timeout' })
      await Promise.all([refusal, vi.advanceTimersByTimeAsync(100)])
      expect(outcome).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})


describe('[COMP:decisions/runtime] workspace classifier-first integration', () => {
  afterEach(() => vi.unstubAllGlobals())
  const workspaceId = 'workspace-fictional'
  const modelAlias = 'typesafe-jev-1.13'
  const operatorDefault = { mode: 'classifier_first' as const, modelAlias }

  function integratedRuntime(extra: Partial<CreateDecisionRuntimeOptions> = {}, saved = true) {
    return createDecisionRuntime({
      llmProvider: fixtureLlm(), defaultLlmModel: 'fixture-llm', typesafeApiKey: 'fictional-test-only-key',
      resolveRoute: createWorkspaceDecisionRouteResolver({
        store: { getSystem: vi.fn(async () => saved ? ({ workspaceId, mode: 'hybrid' as const, modelAlias, updatedAt: 'now' }) : null) },
        configuredAdapterIds: () => ['typesafe'], operatorDefault,
      }),
      ...extra,
    })
  }

  function jevResponse() {
    return new Response(JSON.stringify({
      model: 'jev-1.13.0', answers: {
        intent: { type: 'choice', choice: 'ordinary', probabilities: { ordinary: 1, research: 0 } },
      }, usage: { input_tokens: 8, output_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it.each([false, true])('dispatches Jev for every successful typed execution, never LLM (saved hybrid=%s)', async saved => {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain('typesafe.ai')
      expect(JSON.parse(String(init?.body)).model).toBe('jev-1.13.0')
      return jevResponse()
    })
    vi.stubGlobal('fetch', fetch)
    const complete = vi.fn(resultOperation().completeWithLlm)
    const onAttempt = vi.fn(), onOutcome = vi.fn()
    const llm = fixtureLlm()
    llm.stream = vi.fn(llm.stream)
    const runtime = integratedRuntime({ llmProvider: llm, onAttempt, onOutcome }, saved)
    for (let index = 0; index < 20; index++) {
      const result = await runtime.run({ workspaceId, request: { ...request(), runId: `classifier-first-${index}` }, operation: resultOperation(complete) })
      expect(result).toMatchObject({ path: 'primary_complete', attempts: 1, result: { verdict: 'ordinary' } })
    }
    expect(fetch).toHaveBeenCalledTimes(20)
    expect(onAttempt).toHaveBeenCalledTimes(20)
    expect(onOutcome).toHaveBeenCalledTimes(20)
    for (const [attempt] of onAttempt.mock.calls) expect(attempt).toMatchObject({ effectiveMode: 'hybrid', operatorOverride: true })
    for (const [outcome] of onOutcome.mock.calls) expect(outcome).toMatchObject({ path: 'primary_complete', operatorOverride: true })
    expect(complete).not.toHaveBeenCalled()
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('does not turn the API key alone into classifier authority', async () => {
    const fetch = vi.fn(async () => jevResponse())
    vi.stubGlobal('fetch', fetch)
    const complete = vi.fn(resultOperation().completeWithLlm)
    const runtime = integratedRuntime({ resolveRoute: createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => null) }, configuredAdapterIds: () => ['typesafe'],
    }) })
    expect(runtime.configuredAdapterIds()).toContain('typesafe')
    const result = await runtime.run({ workspaceId, request: request(), operation: resultOperation(complete) })
    expect(result).toMatchObject({ path: 'llm_only', attempts: 1 })
    expect(complete).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows only one generation follow-up after the typed decision', async () => {
    const fetch = vi.fn(async () => jevResponse())
    vi.stubGlobal('fetch', fetch)
    const complete = vi.fn(resultOperation().completeWithLlm)
    const operation: DecisionRuntimeOperation<Result> = {
      ...resultOperation(complete), decide: () => ({ kind: 'follow_up', reason: 'generation_required' }),
    }
    const result = await integratedRuntime().run({ workspaceId, request: request(), operation })
    expect(result).toMatchObject({ path: 'generation', attempts: 2, result: { verdict: 'research' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]![0]).toMatchObject({ kind: 'generation', followUpReason: 'generation_required' })
  })

  it.each(['transport', 'invalid_response'] as const)('bounds %s recovery to one Jev and one LLM completion', async failure => {
    const fetch = vi.fn(async () => failure === 'transport'
      ? new Response('{}', { status: 503 })
      : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const complete = vi.fn(resultOperation().completeWithLlm)
    const result = await integratedRuntime().run({ workspaceId, request: request(), operation: resultOperation(complete) })
    expect(result).toMatchObject({ path: 'operational_failover', attempts: 2, result: { verdict: 'research' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })

  it('does not retry or dispatch a third attempt if the single LLM fallback fails', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const complete = vi.fn<DecisionRuntimeOperation<Result>['completeWithLlm']>(async () => { throw new Error('fictional LLM outage') })
    const result = await integratedRuntime().run({ workspaceId, request: request(), operation: resultOperation(complete) })
    expect(result).toMatchObject({ path: 'safe_default', attempts: 2, result: { verdict: 'safe' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })

  it.each(['before', 'after'] as const)('propagates authority refusal %s Jev without LLM recovery', async boundary => {
    let dispatched = false
    const fetch = vi.fn(async () => { dispatched = true; return jevResponse() })
    vi.stubGlobal('fetch', fetch)
    const refusal = authorityRefusal()
    const complete = vi.fn(resultOperation().completeWithLlm)
    const operation = { ...resultOperation(complete), assertInputAuthority: async () => {
      if (boundary === 'before' || dispatched) throw refusal
    } }
    await expect(integratedRuntime().run({ workspaceId, request: request(), operation })).rejects.toBe(refusal)
    expect(fetch).toHaveBeenCalledTimes(boundary === 'before' ? 0 : 1)
    expect(complete).not.toHaveBeenCalled()
  })
})
