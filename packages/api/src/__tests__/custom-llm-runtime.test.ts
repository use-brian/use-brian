import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceCustomLlmResolver,
  customLlmAlias,
  customLlmEndpointIdFromAlias,
  normalizeCustomLlmBaseUrl,
  probeCustomLlmEndpoint,
} from '../custom-llm-runtime.js'
import type { WorkspaceCustomLlmEndpointStore } from '../db/workspace-custom-llm-endpoints.js'

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
      providerKeySource: 'user',
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
    const requestBody = JSON.parse(init.body as string) as { messages: unknown }
    expect(JSON.stringify(requestBody.messages)).not.toContain('image_url')
    expect(JSON.stringify(requestBody.messages)).toContain('text-only model cannot inspect it')
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
      getRuntimeSystem: vi.fn(),
      getTierRuntimeSystem: vi.fn().mockResolvedValue(runtime),
    } as unknown as WorkspaceCustomLlmEndpointStore
    const resolved = await createWorkspaceCustomLlmResolver(store)({
      workspaceId: runtime.workspaceId,
      requestedTier: 'max',
    })
    expect(resolved).toMatchObject({ selector: customLlmAlias(profileId), maxTokens: 32768 })
    expect(store.getTierRuntimeSystem).toHaveBeenCalledWith({ workspaceId: runtime.workspaceId, tier: 'max' })
  })
})
