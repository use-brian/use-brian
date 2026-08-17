/** Runtime construction and verification for workspace custom LLM endpoints. */

import {
  createOpenAICompatProvider,
  wrapProvider,
  type LLMProvider,
} from '@use-brian/core'
import { registryRow } from '@use-brian/shared/model-registry'
import type {
  WorkspaceCustomLlmProfileRuntime,
  WorkspaceCustomLlmEndpointStore,
} from './db/workspace-custom-llm-endpoints.js'
import { CUSTOM_LLM_TIERS, isCustomLlmTier } from './db/workspace-custom-llm-endpoints.js'
import {
  createPublicCustomLlmFetch,
  CustomLlmPublicEndpointError,
} from './custom-llm-public-fetch.js'

export const CUSTOM_LLM_ALIAS_PREFIX = 'custom:'
export type CustomLlmNetworkPolicy = 'private-network' | 'public-only'

export function customLlmAlias(endpointId: string): string {
  return `${CUSTOM_LLM_ALIAS_PREFIX}${endpointId}`
}

export function customLlmEndpointIdFromAlias(alias: string | undefined): string | null {
  if (!alias?.startsWith(CUSTOM_LLM_ALIAS_PREFIX)) return null
  const id = alias.slice(CUSTOM_LLM_ALIAS_PREFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null
}

export function normalizeCustomLlmBaseUrl(
  raw: string,
  networkPolicy: CustomLlmNetworkPolicy = 'private-network',
): string {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new CustomLlmProbeError('endpoint_invalid_url', 'Enter a valid HTTP or HTTPS endpoint URL', 400)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CustomLlmProbeError(
      'endpoint_invalid_url',
      'The endpoint must be an HTTP or HTTPS base URL without credentials, query parameters, or a fragment',
      400,
    )
  }
  if (networkPolicy === 'public-only' && parsed.protocol !== 'https:') {
    throw new CustomLlmProbeError(
      'endpoint_public_https_required',
      'Hosted Brian requires a public HTTPS endpoint URL',
      400,
    )
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith('/chat/completions')) {
    throw new CustomLlmProbeError('endpoint_invalid_url', 'Enter the API base URL, not the /chat/completions URL', 400)
  }
  parsed.pathname = normalizedPath
  return parsed.toString().replace(/\/$/, '')
}

export type CustomLlmProbeErrorCode =
  | 'endpoint_invalid_url'
  | 'endpoint_public_https_required'
  | 'endpoint_public_address_required'
  | 'endpoint_unreachable'
  | 'endpoint_auth_failed'
  | 'endpoint_model_missing'
  | 'endpoint_tools_unsupported'
  | 'endpoint_invalid_response'
  | 'endpoint_timeout'

export class CustomLlmProbeError extends Error {
  constructor(
    readonly code: CustomLlmProbeErrorCode,
    message: string,
    readonly httpStatus = 422,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CustomLlmProbeError'
  }
}

export type CustomLlmConnectionInput = {
  baseUrl: string
  apiKey?: string | null
  modelId: string
}

function providerFor(
  profile: CustomLlmConnectionInput & { profileId: string },
  fetchFn: typeof fetch = fetch,
): LLMProvider {
  const recordedModel = customLlmAlias(profile.profileId)
  const usageCompatibleFetch: typeof fetch = async (input, init) => {
    const response = await fetchFn(input, init)
    if (response.status !== 400 || typeof init?.body !== 'string') return response
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (!('stream_options' in body)) return response
      delete body.stream_options
      return fetchFn(input, { ...init, body: JSON.stringify(body) })
    } catch {
      return response
    }
  }
  return createOpenAICompatProvider({
    apiKey: profile.apiKey?.trim() || undefined,
    baseURL: profile.baseUrl,
    label: `workspace-${profile.profileId}`,
    wireModel: profile.modelId,
    recordedModel,
    models: [recordedModel],
    fetchFn: usageCompatibleFetch,
    includeStreamUsage: true,
    enableThinkingField: false,
    supportsJsonMode: false,
    supportsVision: false,
    includeErrorDetail: false,
  })
}

/**
 * One bounded live call proves the endpoint can stream and emit a tool call.
 * That is the minimum protocol Brian's agent loop requires; a text-only 200 is
 * intentionally not accepted.
 */
export async function probeCustomLlmEndpoint(
  input: CustomLlmConnectionInput,
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    networkPolicy?: CustomLlmNetworkPolicy
  },
): Promise<{ supportsTools: true; verifiedAt: Date }> {
  const networkPolicy = options?.networkPolicy ?? 'private-network'
  const baseUrl = normalizeCustomLlmBaseUrl(input.baseUrl, networkPolicy)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 30_000)
  const provider = providerFor(
    { ...input, baseUrl, profileId: '00000000-0000-4000-8000-000000000000' },
    options?.fetchFn ?? (networkPolicy === 'public-only' ? createPublicCustomLlmFetch() : fetch),
  )
  let toolName = ''
  let toolInput = ''
  let ended = false

  try {
    for await (const chunk of provider.stream({
      model: 'custom-probe',
      systemPrompt: 'You are verifying an API connection. Call connectionCheck exactly once. Do not answer with text.',
      messages: [{ role: 'user', content: 'Call connectionCheck with ok set to true.' }],
      tools: [{
        name: 'connectionCheck',
        description: 'Verify streamed function calling.',
        parameters: {
          type: 'object',
          properties: { ok: { type: 'boolean', description: 'Must be true.' } },
          required: ['ok'],
        },
      }],
      maxTokens: 128,
      signal: controller.signal,
    })) {
      if (chunk.type === 'tool_use_start') toolName = chunk.name
      if (chunk.type === 'tool_use_delta') toolInput += chunk.input
      if (chunk.type === 'tool_use_end') ended = true
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new CustomLlmProbeError('endpoint_timeout', 'The endpoint did not complete the verification call in time', 504, { cause: err })
    }
    if (err instanceof CustomLlmPublicEndpointError) {
      throw new CustomLlmProbeError(err.code, err.message, 422, { cause: err })
    }
    const status = typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined
    if (status === 401 || status === 403) {
      throw new CustomLlmProbeError('endpoint_auth_failed', 'The endpoint rejected the bearer credential', 422, { cause: err })
    }
    if (status === 404) {
      throw new CustomLlmProbeError('endpoint_model_missing', 'The endpoint or configured model was not found', 422, { cause: err })
    }
    if (status !== undefined) {
      throw new CustomLlmProbeError('endpoint_invalid_response', `The endpoint rejected the verification request (HTTP ${status})`, 422, { cause: err })
    }
    throw new CustomLlmProbeError('endpoint_unreachable', 'Brian could not reach the endpoint from the API server', 422, { cause: err })
  } finally {
    clearTimeout(timeout)
  }

  if (!ended || toolName !== 'connectionCheck') {
    throw new CustomLlmProbeError('endpoint_tools_unsupported', 'The endpoint did not return the required streamed tool call')
  }
  try {
    const parsed = JSON.parse(toolInput) as { ok?: unknown }
    if (parsed.ok !== true) throw new Error('ok was not true')
  } catch (err) {
    throw new CustomLlmProbeError('endpoint_invalid_response', 'The endpoint returned invalid tool-call arguments', 422, { cause: err })
  }
  return { supportsTools: true, verifiedAt: new Date() }
}

export type ResolvedWorkspaceCustomLlm = {
  provider: LLMProvider
  selector: string
  profileId: string | null
  modelTier: import('./db/workspace-custom-llm-endpoints.js').CustomLlmTier
  inputTokenLimit: number
  maxTokens: number
  providerKeySource: 'user' | 'platform'
  routeKind: 'custom' | 'managed'
  /** Per-run connection for the isolated browser-use process. Never serialize. */
  browserUse?: {
    apiKeyEnvName: 'OPENAI_API_KEY'
    apiKey: string
    model: string
    baseUrl: string
  }
}

export type WorkspaceCustomLlmResolver = (params: {
  workspaceId: string
  requestedModel?: string
  requestedTier?: string
  allowDefault?: boolean
  allowAnyDefault?: boolean
  allowManagedRoutes?: boolean
}) => Promise<ResolvedWorkspaceCustomLlm | null>

export function createWorkspaceCustomLlmResolver(
  store: WorkspaceCustomLlmEndpointStore,
  options?: {
    networkPolicy?: CustomLlmNetworkPolicy
    fetchFn?: typeof fetch
    managedProvider?: LLMProvider
  },
): WorkspaceCustomLlmResolver {
  const networkPolicy = options?.networkPolicy ?? 'private-network'
  return async ({
    workspaceId,
    requestedModel,
    requestedTier,
    allowDefault = true,
    allowAnyDefault = false,
    allowManagedRoutes = true,
  }) => {
    const explicitId = customLlmEndpointIdFromAlias(requestedModel)
    let profile: WorkspaceCustomLlmProfileRuntime | null = explicitId
      ? await store.getRuntimeSystem({ workspaceId, profileId: explicitId })
      : null
    let managedModel: string | null = null
    const modelTier = requestedTier && isCustomLlmTier(requestedTier) ? requestedTier : 'standard'
    let routeTier = modelTier

    const resolveTierRoute = async (tier: (typeof CUSTOM_LLM_TIERS)[number]) => {
      const route = await store.getTierRouteSystem({ workspaceId, tier })
      if (!route) return false
      routeTier = tier
      if (route.modelAlias) {
        if (!allowManagedRoutes) return false
        managedModel = route.modelAlias
        return true
      }
      if (route.profileId) {
        profile = await store.getRuntimeSystem({ workspaceId, profileId: route.profileId })
        return profile !== null
      }
      return false
    }

    if (!explicitId && allowDefault && requestedTier && isCustomLlmTier(requestedTier)) {
      await resolveTierRoute(requestedTier)
    }
    if (!profile && !managedModel && allowDefault && allowAnyDefault) {
      for (const tier of CUSTOM_LLM_TIERS) {
        if (tier === requestedTier) continue
        if (await resolveTierRoute(tier)) break
      }
    }

    if (managedModel) {
      const row = registryRow(managedModel)
      if (!row || row.status !== 'active' || !row.menu) {
        throw new Error(`[workspace-model-route] '${managedModel}' is not an active selectable registry model`)
      }
      if (row.tier !== routeTier) {
        throw new Error(`[workspace-model-route] '${managedModel}' cannot serve the '${routeTier}' tier`)
      }
      if (!options?.managedProvider) {
        throw new Error('[workspace-model-route] managed provider routing is unavailable')
      }
      const exactProvider: LLMProvider = {
        ...options.managedProvider,
        stream: (request) => options.managedProvider!.stream({
          ...request,
          model: managedModel!,
          allowProviderFallback: false,
        }),
        createSession: (sessionOptions) => options.managedProvider!.createSession({
          ...sessionOptions,
          model: managedModel!,
          allowProviderFallback: false,
        }),
      }
      return {
        provider: exactProvider,
        selector: managedModel,
        profileId: null,
        modelTier,
        inputTokenLimit: row.contextWindow,
        maxTokens: row.maxOutput,
        providerKeySource: 'platform',
        routeKind: 'managed',
      }
    }

    if (!profile) return null
    const selectedProfile = profile
    const selector = customLlmAlias(selectedProfile.id)
    const fetchFn = options?.fetchFn ?? (networkPolicy === 'public-only' ? createPublicCustomLlmFetch() : fetch)
    const provider = wrapProvider(providerFor({
      profileId: selectedProfile.id,
      baseUrl: selectedProfile.baseUrl,
      apiKey: selectedProfile.apiKey,
      modelId: selectedProfile.modelId,
    }, fetchFn))
    const limitedProvider: LLMProvider = {
      ...provider,
      stream: (request) => provider.stream({
        ...request,
        maxTokens: Math.min(request.maxTokens ?? selectedProfile.maxOutputTokens, selectedProfile.maxOutputTokens),
        inputTokenLimit: Math.min(request.inputTokenLimit ?? selectedProfile.contextWindow, selectedProfile.contextWindow),
      }),
      createSession: (sessionOptions) => provider.createSession({
        ...sessionOptions,
        maxTokens: Math.min(sessionOptions.maxTokens ?? selectedProfile.maxOutputTokens, selectedProfile.maxOutputTokens),
        inputTokenLimit: Math.min(sessionOptions.inputTokenLimit ?? selectedProfile.contextWindow, selectedProfile.contextWindow),
      }),
    }
    return {
      provider: limitedProvider,
      selector,
      profileId: selectedProfile.id,
      modelTier,
      inputTokenLimit: selectedProfile.contextWindow,
      maxTokens: selectedProfile.maxOutputTokens,
      providerKeySource: 'user',
      routeKind: 'custom',
      browserUse: {
        apiKeyEnvName: 'OPENAI_API_KEY',
        apiKey: selectedProfile.apiKey?.trim() || 'not-required',
        model: selectedProfile.modelId,
        baseUrl: selectedProfile.baseUrl,
      },
    }
  }
}
