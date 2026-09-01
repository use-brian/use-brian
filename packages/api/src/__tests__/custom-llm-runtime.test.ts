import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceCustomLlmResolver,
  customLlmAlias,
  customLlmEndpointIdFromAlias,
  normalizeCustomLlmBaseUrl,
  decideImageTurnRoute,
  probeCustomLlmEndpoint,
  probeCustomLlmVision,
} from '../custom-llm-runtime.js'
import type { WorkspaceCustomLlmEndpointStore } from '../db/workspace-custom-llm-endpoints.js'
import type { LLMProvider, ProviderRequest } from '@use-brian/core'
import { MutableProviderAvailability } from '@use-brian/shared/model-registry'
import { resolveChatModelSelection } from '../model-resolution.js'

function toolSse(): Response {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'connectionCheck', arguments: '{"ok":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
}

function visionSse(color: string): Response {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v', function: { name: 'describeImage', arguments: `{"color":"` } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `${color}"}` } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
}

function textSse(): Response {
  const events = [
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    '[DONE]',
  ]
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
}

describe('[COMP:api/custom-llm-endpoints] custom endpoint runtime', () => {
  it('normalizes an API base URL and rejects a full chat-completions URL', () => {
    expect(normalizeCustomLlmBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1')
    expect(() => normalizeCustomLlmBaseUrl('http://127.0.0.1:11434/v1/chat/completions'))
      .toThrow('API base URL')
    expect(customLlmEndpointIdFromAlias(customLlmAlias('00000000-0000-4000-8000-000000000001')))
      .toBe('00000000-0000-4000-8000-000000000001')
  })

  it('requires HTTPS only for the hosted public-network policy', () => {
    expect(() => normalizeCustomLlmBaseUrl('http://models.example.com/v1', 'public-only'))
      .toThrow('public HTTPS')
    expect(normalizeCustomLlmBaseUrl('https://models.example.com/v1/', 'public-only'))
      .toBe('https://models.example.com/v1')
    expect(normalizeCustomLlmBaseUrl('http://127.0.0.1:11434/v1', 'private-network'))
      .toBe('http://127.0.0.1:11434/v1')
  })

  it('accepts only a streamed connectionCheck tool call', async () => {
    const fetchFn = vi.fn().mockResolvedValue(toolSse())
    const result = await probeCustomLlmEndpoint({
      baseUrl: 'http://model.example/v1',
      modelId: 'local-model',
      apiKey: null,
    }, { fetchFn, timeoutMs: 1000 })
    expect(result.supportsTools).toBe(true)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'local-model', stream: true })
  })

  it('fails a text-only endpoint instead of saving an agent-incompatible profile', async () => {
    const body = [
      { choices: [{ delta: { content: 'connected' }, finish_reason: 'stop' }] },
      '[DONE]',
    ].map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
    await expect(probeCustomLlmEndpoint({
      baseUrl: 'http://model.example/v1',
      modelId: 'text-only',
    }, { fetchFn: vi.fn().mockResolvedValue(new Response(body)), timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'endpoint_tools_unsupported' })
  })

  it('resolves an explicit workspace profile to a fixed-model, text-only provider', async () => {
    const endpointId = '00000000-0000-4000-8000-000000000001'
    const runtime = {
      id: endpointId,
      endpointId,
      workspaceId: '00000000-0000-4000-8000-000000000010',
      name: 'Local',
      endpointName: 'Gateway',
      baseUrl: 'http://model.example/v1',
      apiKey: null,
      modelId: 'llama-local',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      supportsTools: true,
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const fetchFn = vi.fn().mockResolvedValue(textSse())
    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(endpointId),
    })
    expect(resolved).toMatchObject({
      selector: customLlmAlias(endpointId),
      inputTokenLimit: 32768,
      maxTokens: 4096,
      modelTier: 'standard',
      providerKeySource: 'user',
      routeKind: 'custom',
    })
    expect(store.getRuntimeSystem).toHaveBeenCalledWith({ workspaceId: runtime.workspaceId, profileId: endpointId })
    expect(store.getTierRuntimeSystem).not.toHaveBeenCalled()

    if (!resolved) throw new Error('expected a resolved custom provider')
    for await (const _chunk of resolved.provider.stream({
      model: resolved.selector,
      systemPrompt: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'text', text: 'Continue.' },
        ],
      }],
    })) {
      // Drain the stream so the request body can be inspected below.
    }
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    const requestBody = JSON.parse(init.body as string) as { messages: unknown; stream_options?: unknown; max_tokens?: number }
    expect(JSON.stringify(requestBody.messages)).not.toContain('image_url')
    expect(JSON.stringify(requestBody.messages)).toContain('text-only model cannot inspect it')
    expect(requestBody.stream_options).toEqual({ include_usage: true })
    expect(requestBody.max_tokens).toBe(4096)
  })

  it('resolves the assigned profile for the already-resolved Brian tier', async () => {
    const profileId = '00000000-0000-4000-8000-000000000002'
    const runtime = {
      id: profileId,
      endpointId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000010',
      name: 'Max',
      endpointName: 'Gateway',
      baseUrl: 'http://model.example/v1',
      apiKey: null,
      modelId: 'sol-max',
      contextWindow: 200000,
      maxOutputTokens: 32768,
      supportsTools: true,
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn().mockResolvedValue({
        workspaceId: runtime.workspaceId,
        tier: 'max',
        profileId,
        modelAlias: null,
        updatedAt: new Date(),
      }),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const resolved = await createWorkspaceCustomLlmResolver(store)({
      workspaceId: runtime.workspaceId,
      requestedTier: 'max',
    })
    expect(resolved).toMatchObject({ selector: customLlmAlias(profileId), maxTokens: 32768, modelTier: 'max' })
    expect(store.getTierRouteSystem).toHaveBeenCalledWith({ workspaceId: runtime.workspaceId, tier: 'max' })
  })

  it('uses each logical tier default even when DashScope serves every application alias', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000010'
    const mixed = new MutableProviderAvailability()
    mixed.setStaticProvider('gemini', true)
    mixed.setStaticProvider('openai-compat:dashscope-intl', true)
    mixed.setPreferredProvider('dashscope-intl')
    const profileIdForTier = (tier: string) =>
      `00000000-0000-4000-8000-00000000000${tier === 'standard' ? 1 : tier === 'pro' ? 2 : tier === 'max' ? 3 : 4}`
    const getTierRouteSystem = vi.fn().mockImplementation(async ({ tier }: { tier: string }) => ({
      workspaceId,
      tier,
      profileId: profileIdForTier(tier),
      modelAlias: null,
      updatedAt: new Date(),
    }))
    const getRuntimeSystem = vi.fn().mockImplementation(async ({ profileId }: { profileId: string }) => ({
      id: profileId,
      endpointId: '00000000-0000-4000-8000-000000000099',
      workspaceId,
      name: 'Custom model',
      endpointName: 'Gateway',
      baseUrl: 'https://model.example/v1',
      apiKey: null,
      modelId: 'custom-model',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      supportsTools: true,
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    const resolver = createWorkspaceCustomLlmResolver({
      getRuntimeSystem,
      getTierRouteSystem,
    } as unknown as WorkspaceCustomLlmEndpointStore)

    for (const tier of ['standard', 'pro', 'max', 'research'] as const) {
      const selection = resolveChatModelSelection(tier, 'max_5x', 'ok', mixed)
      expect(selection.servingModel).toBe('qwen3.7-plus')
      const runtime = await resolver({ workspaceId, requestedTier: selection.logicalTier })
      expect(runtime?.modelTier).toBe(tier)
    }
    expect(getTierRouteSystem.mock.calls.map(([arg]) => arg.tier))
      .toEqual(['standard', 'pro', 'max', 'research'])
  })

  it('retries once without streamed usage for older compatible endpoints', async () => {
    const profileId = '00000000-0000-4000-8000-000000000004'
    const runtime = {
      id: profileId, endpointId: profileId,
      workspaceId: '00000000-0000-4000-8000-000000000010',
      name: 'Legacy', endpointName: 'Gateway', baseUrl: 'https://model.example/v1',
      apiKey: null, modelId: 'legacy-model', contextWindow: 32768, maxOutputTokens: 4096,
      supportsTools: true, verifiedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('unsupported stream_options', { status: 400 }))
      .mockResolvedValueOnce(textSse())
    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(profileId),
    })
    if (!resolved) throw new Error('expected runtime')

    for await (const _chunk of resolved.provider.stream({
      model: resolved.selector,
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }],
    })) { /* drain */ }

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string)).toHaveProperty('stream_options')
    expect(JSON.parse((fetchFn.mock.calls[1]![1] as RequestInit).body as string)).not.toHaveProperty('stream_options')
  })

  it('uses another configured tier default for background work when Standard is unset', async () => {
    const profileId = '00000000-0000-4000-8000-000000000003'
    const runtime = {
      id: profileId,
      endpointId: profileId,
      workspaceId: '00000000-0000-4000-8000-000000000010',
      name: 'Pro gateway', endpointName: 'Gateway', baseUrl: 'https://model.example/v1',
      apiKey: null, modelId: 'pro-model', contextWindow: 100000, maxOutputTokens: 8192,
      supportsTools: true, verifiedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }
    const getTierRouteSystem = vi.fn(async ({ tier }: { tier: string }) => tier === 'pro'
      ? { workspaceId: runtime.workspaceId, tier: 'pro', profileId, modelAlias: null, updatedAt: new Date() }
      : null)
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem,
    } as unknown as WorkspaceCustomLlmEndpointStore

    const resolved = await createWorkspaceCustomLlmResolver(store)({
      workspaceId: runtime.workspaceId,
      requestedTier: 'standard',
      allowAnyDefault: true,
    })

    expect(resolved).toMatchObject({ selector: customLlmAlias(profileId), modelTier: 'standard' })
    expect(getTierRouteSystem.mock.calls.map(([arg]) => arg.tier)).toEqual(['standard', 'pro'])
  })

  it('forces an exact managed route and disables provider substitution', async () => {
    const requests: ProviderRequest[] = []
    const managedProvider: LLMProvider = {
      name: 'routing',
      models: [],
      async *stream(request) {
        requests.push(request)
      },
      createSession(options) {
        return { send: (messages) => this.stream({ ...options, messages }) }
      },
    }
    const store = {
      getRuntimeSystem: vi.fn(),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn().mockResolvedValue({
        workspaceId: '00000000-0000-4000-8000-000000000010',
        tier: 'max',
        profileId: null,
        modelAlias: 'gpt-5.6-sol',
        updatedAt: new Date(),
      }),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const resolved = await createWorkspaceCustomLlmResolver(store, { managedProvider })({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      requestedTier: 'max',
    })
    expect(resolved).toMatchObject({
      selector: 'gpt-5.6-sol',
      modelTier: 'max',
      providerKeySource: 'platform',
      routeKind: 'managed',
    })
    if (!resolved) throw new Error('expected a managed route')
    for await (const _chunk of resolved.provider.stream({
      model: 'gemini-3.6-flash',
      systemPrompt: '',
      messages: [],
    })) { /* drain */ }
    expect(requests[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      allowProviderFallback: false,
    })
  })

  it('leaves the internal background lane alone when managed routes are disabled', async () => {
    const store = {
      getRuntimeSystem: vi.fn(),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn().mockResolvedValue({
        workspaceId: '00000000-0000-4000-8000-000000000010',
        tier: 'standard',
        profileId: null,
        modelAlias: 'gpt-5.6-luna',
        updatedAt: new Date(),
      }),
    } as unknown as WorkspaceCustomLlmEndpointStore

    await expect(createWorkspaceCustomLlmResolver(store)({
      workspaceId: '00000000-0000-4000-8000-000000000010',
      requestedTier: 'standard',
      allowManagedRoutes: false,
    })).resolves.toBeNull()
  })
})

describe('[COMP:api/custom-llm-endpoints] endpoint vision probe', () => {
  const connection = { baseUrl: 'http://model.example/v1', modelId: 'local-model', apiKey: null }

  // The probe asks a question the prompt cannot answer: the image is a solid
  // red square and nothing in the text says so. Naming the color is therefore
  // evidence the bytes arrived AND were read.
  it('reports vision when the endpoint names the color of the probe image', async () => {
    const fetchFn = vi.fn().mockResolvedValue(visionSse('red'))
    expect(await probeCustomLlmVision(connection, { fetchFn, timeoutMs: 1000 })).toBe(true)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(JSON.stringify(JSON.parse(init.body as string).messages)).toContain('image_url')
  })

  // A gateway in front of a text-only model can accept the image_url part and
  // drop it. That answers without an error, which is worse than a rejection,
  // so a wrong answer has to count as "no vision" exactly like a refusal.
  it('treats an accepted-but-unread image as no vision', async () => {
    const fetchFn = vi.fn().mockResolvedValue(visionSse('blue'))
    expect(await probeCustomLlmVision(connection, { fetchFn, timeoutMs: 1000 })).toBe(false)
  })

  it('never throws when the endpoint refuses the image', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }))
    expect(await probeCustomLlmVision(connection, { fetchFn, timeoutMs: 1000 })).toBe(false)
  })

  // Vision is an extra, never a gate: an endpoint that streams and calls tools
  // is a usable Brian model whether or not it can see.
  it('still verifies a text-only endpoint, recording it as sightless', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(toolSse())
      .mockResolvedValueOnce(new Response('no image support', { status: 400 }))
    const result = await probeCustomLlmEndpoint(connection, { fetchFn, timeoutMs: 1000 })
    expect(result).toMatchObject({ supportsTools: true, supportsVision: false })
  })

  it('carries a probed vision profile through to image_url parts on the wire', async () => {
    const profileId = '00000000-0000-4000-8000-000000000003'
    const runtime = {
      id: profileId,
      endpointId: profileId,
      workspaceId: '00000000-0000-4000-8000-000000000010',
      name: 'Seeing',
      endpointName: 'Gateway',
      baseUrl: 'http://model.example/v1',
      apiKey: null,
      modelId: 'vision-local',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const fetchFn = vi.fn().mockResolvedValue(textSse())
    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(profileId),
    })
    expect(resolved).toMatchObject({ routeKind: 'custom', supportsVision: true })
    if (!resolved) throw new Error('expected a resolved custom provider')
    for await (const _chunk of resolved.provider.stream({
      model: resolved.selector,
      systemPrompt: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'text', text: 'What is in this screenshot?' },
        ],
      }],
    })) {
      // Drain so the request body can be inspected.
    }
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    const messages = JSON.stringify(JSON.parse(init.body as string).messages)
    expect(messages).toContain('image_url')
    expect(messages).not.toContain('text-only model cannot inspect it')
  })
})

describe('[COMP:api/custom-llm-endpoints] image turn routing policy', () => {
  const sightless = { supportsVision: false }
  const seeing = { supportsVision: true }
  const base = { turnHasImage: true, explicitCustomSelection: false, builtInServable: true }

  it('serves on the route whenever the route can see, or the turn has no image', () => {
    expect(decideImageTurnRoute({ ...base, route: seeing })).toBe('serve_on_route')
    expect(decideImageTurnRoute({ ...base, route: sightless, turnHasImage: false })).toBe('serve_on_route')
    expect(decideImageTurnRoute({ ...base, route: null })).toBe('serve_on_route')
  })

  // The 2026-08-19 incident: every tier in the workspace routed to a
  // text-only endpoint, so refusing sent the user to a model picker where
  // every entry lands back on the same endpoint. There was a built-in model
  // available the whole time.
  it('falls back to a built-in model for a tier-routed workspace', () => {
    expect(decideImageTurnRoute({ ...base, route: sightless })).toBe('fall_back_to_builtin')
  })

  // Answering on a model the user just declined for this message is a worse
  // answer than saying why the one they picked cannot be used.
  it('refuses when the user picked this endpoint for this very message', () => {
    expect(decideImageTurnRoute({ ...base, route: sightless, explicitCustomSelection: true }))
      .toBe('refuse')
  })

  // A self-host whose only configured model IS the endpoint. Falling back
  // would hand the turn to a provider that is not there.
  it('refuses when there is no built-in model to fall back to', () => {
    expect(decideImageTurnRoute({ ...base, route: sightless, builtInServable: false }))
      .toBe('refuse')
  })

  it('never refuses a sighted route, whatever else is true', () => {
    expect(decideImageTurnRoute({
      route: seeing, turnHasImage: true, explicitCustomSelection: true, builtInServable: false,
    })).toBe('serve_on_route')
  })
})

// ── Endpoint failure fallback (migration 491) ──────────────────
// byo-llm-key.md -> "Endpoint failure fallback". The wrapper's own behavior is
// covered by [COMP:providers/endpoint-fallback]; what matters here is the
// WIRING: that the opt-in actually gates it, that the state object the turn
// owner reads is written, and that the platform provider is only reachable
// with consent.

function fallbackRuntime(overrides: Record<string, unknown> = {}) {
  const endpointId = '00000000-0000-4000-8000-000000000031'
  return {
    id: endpointId,
    endpointId,
    workspaceId: '00000000-0000-4000-8000-000000000030',
    name: 'Max',
    endpointName: 'hosted-gateway',
    baseUrl: 'https://model.example/v1',
    apiKey: null,
    modelId: 'sol-high',
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    fallbackToDefaultOnFailure: false,
    verifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function platformProvider(text: string): LLMProvider {
  return {
    name: 'platform',
    models: ['gemini-pro'],
    async *stream(request: ProviderRequest) {
      yield { type: 'message_start' as const, model: request.model }
      yield { type: 'text_delta' as const, text }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
    },
    createSession() {
      throw new Error('not used')
    },
  }
}

async function drain(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const seen: string[] = []
  for await (const chunk of stream) seen.push(chunk.type)
  return seen
}

describe('[COMP:api/custom-llm-endpoints] endpoint failure fallback', () => {
  it('fails the turn when the connection has not opted in', async () => {
    const runtime = fallbackRuntime()
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const managedProvider = platformProvider('platform answer')
    const managedSpy = vi.spyOn(managedProvider, 'stream')
    const fetchFn = vi.fn().mockResolvedValue(new Response('tunnel down', { status: 530 }))

    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn, managedProvider })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(runtime.id),
      allowFailureFallback: true,
    })
    if (!resolved) throw new Error('expected a resolved custom provider')

    expect(resolved.fallback.enabled).toBe(false)
    await expect(drain(resolved.provider.stream({
      model: 'gemini-max',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    }))).rejects.toThrow('HTTP 530')
    expect(managedSpy).not.toHaveBeenCalled()
    expect(resolved.fallback.used).toBe(false)
    expect(resolved.providerKeySource).toBe('user')
  })

  it('stays off for a lane that did not claim it, even with the connection opted in', async () => {
    // Fail-closed: a lane inherits the fallback only by asking, because the
    // fallback is only permissible where the reader can be TOLD it happened.
    // Background classifiers, consolidation and auto-titles have no reader.
    const runtime = fallbackRuntime({ fallbackToDefaultOnFailure: true })
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const managedProvider = platformProvider('platform answer')
    const managedSpy = vi.spyOn(managedProvider, 'stream')
    const fetchFn = vi.fn().mockResolvedValue(new Response('tunnel down', { status: 530 }))

    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn, managedProvider })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(runtime.id),
    })
    if (!resolved) throw new Error('expected a resolved custom provider')

    expect(resolved.fallback.enabled).toBe(false)
    await expect(drain(resolved.provider.stream({
      model: 'gemini-max',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    }))).rejects.toThrow('HTTP 530')
    expect(managedSpy).not.toHaveBeenCalled()
  })

  it('serves the turn on the platform model once the admin opts in, and records it', async () => {
    const runtime = fallbackRuntime({ fallbackToDefaultOnFailure: true })
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const managedProvider = platformProvider('platform answer')
    const managedSpy = vi.spyOn(managedProvider, 'stream')
    const fetchFn = vi.fn().mockResolvedValue(new Response('tunnel down', { status: 530 }))

    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn, managedProvider })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(runtime.id),
      allowFailureFallback: true,
    })
    if (!resolved) throw new Error('expected a resolved custom provider')

    expect(resolved.fallback.enabled).toBe(true)
    expect(resolved.providerKeySource).toBe('user')
    const seen = await drain(resolved.provider.stream({
      model: 'gemini-max',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    }))

    expect(seen).toEqual(['message_start', 'text_delta', 'message_end'])
    // The resolved Brian serving alias travels through untouched, so the
    // platform side routes the tier it would have served anyway.
    expect(managedSpy.mock.calls[0]?.[0]?.model).toBe('gemini-max')
    // What the turn owner reads to announce, log, and bill the turn.
    expect(resolved.fallback).toMatchObject({ used: true, reason: 'http_status', status: 530, endpointName: 'hosted-gateway' })
    // Derived, so every one of the ~20 usage-recording sites that reads this
    // field at record time bills the fallback turn as platform capacity. Left
    // at 'user' it would be free platform serving.
    expect(resolved.providerKeySource).toBe('platform')
  })

  it('stays off when no platform provider is configured to fall back to', async () => {
    const runtime = fallbackRuntime({ fallbackToDefaultOnFailure: true })
    const store = {
      getRuntimeSystem: vi.fn().mockResolvedValue(runtime),
      getTierRuntimeSystem: vi.fn(),
      getTierRouteSystem: vi.fn(),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const fetchFn = vi.fn().mockResolvedValue(new Response('tunnel down', { status: 530 }))

    const resolved = await createWorkspaceCustomLlmResolver(store, { fetchFn })({
      workspaceId: runtime.workspaceId,
      requestedModel: customLlmAlias(runtime.id),
      allowFailureFallback: true,
    })
    if (!resolved) throw new Error('expected a resolved custom provider')

    expect(resolved.fallback.enabled).toBe(false)
    await expect(drain(resolved.provider.stream({
      model: 'gemini-max',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    }))).rejects.toThrow('HTTP 530')
  })
})
