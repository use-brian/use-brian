import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceCustomLlmResolver,
  customLlmAlias,
  customLlmEndpointIdFromAlias,
  normalizeCustomLlmBaseUrl,
  probeCustomLlmEndpoint,
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
