/** Runtime construction and verification for workspace custom LLM endpoints. */

import {
  createOpenAICompatProvider,
  wrapEndpointFallback,
  wrapProvider,
  type EndpointFallbackEvent,
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
  supportsVision = false,
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
    // Vision is a PROBED fact per profile, not a property of "custom
    // endpoints" as a class. An unprobed profile stays text-only: the
    // compat layer then degrades an image block to an honest note instead
    // of posting bytes an endpoint may reject or silently drop.
    supportsVision,
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
): Promise<{ supportsTools: true; supportsVision: boolean; verifiedAt: Date }> {
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
  return {
    supportsTools: true,
    supportsVision: await probeCustomLlmVision(input, options),
    verifiedAt: new Date(),
  }
}

/**
 * A solid #FF0000 8x8 PNG (100 base64 chars). Every pixel is the same color,
 * so a model that receives the bytes at all can name it, and a model that
 * cannot has nothing in the prompt to guess from - the question is
 * unanswerable from the text alone, which is exactly what makes the answer
 * evidence.
 */
const VISION_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAASUVORK5CYII='

const VISION_PROBE_ACCEPTED = /red|crimson|scarlet|maroon/i

/**
 * Does this endpoint actually READ an inline image?
 *
 * Accepting an `image_url` part without a 400 is not enough. An
 * OpenAI-compatible gateway in front of a text-only model can take the part
 * and drop it, and that failure is worse than a rejection: the turn succeeds,
 * the model answers confidently about an image it never saw, and nothing in
 * the response says so. So the probe asks a question only sight can answer
 * and checks the answer.
 *
 * It never throws. A refusal, a timeout, an unreachable host, a wrong color
 * all mean the same thing to the caller - treat this profile as text-only -
 * and none of them is a reason to fail a connection that already proved it
 * can stream and call tools.
 */
export async function probeCustomLlmVision(
  input: CustomLlmConnectionInput,
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    networkPolicy?: CustomLlmNetworkPolicy
  },
): Promise<boolean> {
  const networkPolicy = options?.networkPolicy ?? 'private-network'
  let baseUrl: string
  try {
    baseUrl = normalizeCustomLlmBaseUrl(input.baseUrl, networkPolicy)
  } catch {
    return false
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 30_000)
  const provider = providerFor(
    { ...input, baseUrl, profileId: '00000000-0000-4000-8000-000000000000' },
    options?.fetchFn ?? (networkPolicy === 'public-only' ? createPublicCustomLlmFetch() : fetch),
    true,
  )
  let toolName = ''
  let toolInput = ''
  try {
    for await (const chunk of provider.stream({
      model: 'custom-probe',
      systemPrompt: 'You are verifying image support. Call describeImage exactly once with the dominant color of the attached image. Do not answer with text.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mimeType: 'image/png', data: VISION_PROBE_PNG_BASE64 },
          { type: 'text', text: 'Call describeImage with the dominant color of this image, as one lowercase English word.' },
        ],
      }],
      tools: [{
        name: 'describeImage',
        description: 'Report what the attached image looks like.',
        parameters: {
          type: 'object',
          properties: { color: { type: 'string', description: 'Dominant color, one lowercase English word.' } },
          required: ['color'],
        },
      }],
      maxTokens: 128,
      signal: controller.signal,
    })) {
      if (chunk.type === 'tool_use_start') toolName = chunk.name
      if (chunk.type === 'tool_use_delta') toolInput += chunk.input
    }
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
  if (toolName !== 'describeImage') return false
  try {
    const parsed = JSON.parse(toolInput) as { color?: unknown }
    return typeof parsed.color === 'string' && VISION_PROBE_ACCEPTED.test(parsed.color)
  } catch {
    return false
  }
}

/**
 * Per-resolution record of whether this turn was actually served by the
 * endpoint or by the platform fallback.
 *
 * The wrapper lives in `packages/core` and has no user, assistant, or
 * workspace identity, so it cannot log analytics or speak to a user. It
 * writes here instead, and the turn's owner (channel pipeline, chat route)
 * reads it AFTER the loop to do three things the spec requires of a
 * non-silent fallback: tell the user, log the event, and bill the turn as
 * platform usage rather than as the free BYO lane.
 *
 * Mutable on purpose: one object per resolved turn, written at most once.
 */
export type CustomLlmFallbackState = {
  /** The connection's admin opt-in (migration 491). False ⇒ never written. */
  enabled: boolean
  /** True once any provider call in this turn was served by the fallback. */
  used: boolean
  reason: EndpointFallbackEvent['reason'] | null
  status: number | null
  /** Operator-facing. Never rendered to a user. */
  detail: string | null
  /** Connection name, for the user-facing note and the analytics event. */
  endpointName: string
}

export type ResolvedWorkspaceCustomLlm = {
  provider: LLMProvider
  selector: string
  /** Live for the duration of this turn - see `CustomLlmFallbackState`. */
  fallback: CustomLlmFallbackState
  profileId: string | null
  modelTier: import('./db/workspace-custom-llm-endpoints.js').CustomLlmTier
  inputTokenLimit: number
  maxTokens: number
  providerKeySource: 'user' | 'platform'
  routeKind: 'custom' | 'managed'
  /**
   * Can the model behind this route read an inline image?
   *
   * For a managed route it is the registry's answer about a Brian model. For
   * a custom endpoint it is what the connection probe measured, and it
   * defaults to false: an image turn on a text-only endpoint is served by a
   * built-in model rather than forwarding bytes the endpoint would reject or
   * quietly discard.
   */
  supportsVision: boolean
  /** Per-run connection for the isolated browser-use process. Never serialize. */
  browserUse?: {
    apiKeyEnvName: 'OPENAI_API_KEY'
    apiKey: string
    model: string
    baseUrl: string
  }
}

/**
 * What to do with a turn that carries an inline image.
 *
 * One policy, two call sites (the chat route and the channel pipeline), for
 * the reason forked surfaces keep teaching this codebase: the two used to
 * hold the same rule as two copies of one `if`, and the copies drifted the
 * moment the rule gained a third outcome. A channel turn cannot carry an
 * explicit `custom:<id>`, so it simply never produces that branch.
 *
 *   serve_on_route       - the route can see; nothing to decide.
 *   fall_back_to_builtin - the route is sightless but a built-in model can
 *                          answer. The caller MUST announce it (byo-llm-key.md
 *                          forbids a silent fallback, not a fallback).
 *   refuse               - either the user picked this endpoint for this very
 *                          message, or there is no built-in to fall back to.
 */
export type ImageTurnRouteDecision = 'serve_on_route' | 'fall_back_to_builtin' | 'refuse'

export function decideImageTurnRoute(params: {
  /** The resolved workspace route, or null when none applies. */
  route: { supportsVision: boolean } | null
  turnHasImage: boolean
  /** The request named `custom:<id>` itself, rather than resolving a tier. */
  explicitCustomSelection: boolean
  /** A built-in model is configured AND servable on this deployment. */
  builtInServable: boolean
}): ImageTurnRouteDecision {
  if (!params.route || !params.turnHasImage || params.route.supportsVision) return 'serve_on_route'
  if (params.explicitCustomSelection || !params.builtInServable) return 'refuse'
  return 'fall_back_to_builtin'
}

export type WorkspaceCustomLlmResolver = (params: {
  workspaceId: string
  requestedModel?: string
  requestedTier?: string
  allowDefault?: boolean
  allowAnyDefault?: boolean
  allowManagedRoutes?: boolean
  /**
   * Opt this lane in to the connection's endpoint-failure fallback. Default
   * FALSE, and fail-closed on purpose.
   *
   * The fallback is only permissible while BOTH of its promises hold: the
   * reader is told it happened, and the turn bills as platform usage. Billing
   * is safe everywhere (`providerKeySource` is derived), but the ANNOUNCEMENT
   * is not: a background classifier, a consolidation pass, or an auto-title
   * has no reader to tell, and the many background lanes snapshot their
   * attribution inside a port before the turn runs. So a lane must claim the
   * fallback rather than inherit it, and only a lane that can actually
   * announce may. Today that is the web chat route (an SSE `notice`) and the
   * channel pipeline (a sentence on the first message the user sees).
   *
   * Spec: docs/architecture/platform/byo-llm-key.md -> "Endpoint failure
   * fallback".
   */
  allowFailureFallback?: boolean
}) => Promise<ResolvedWorkspaceCustomLlm | null>

export type BackgroundRuntimeResolver = (
  workspaceId: string | null | undefined,
) => Promise<ResolvedWorkspaceCustomLlm | null>

function inertFallbackState(): CustomLlmFallbackState {
  return { enabled: false, used: false, reason: null, status: null, detail: null, endpointName: '' }
}

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
    allowFailureFallback = false,
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
        // A managed route already IS a platform model: there is nothing to
        // fall back FROM, and `allowProviderFallback: false` above keeps the
        // tier exact.
        fallback: inertFallbackState(),
        profileId: null,
        modelTier,
        inputTokenLimit: row.contextWindow,
        maxTokens: row.maxOutput,
        providerKeySource: 'platform',
        routeKind: 'managed',
        supportsVision: row.capabilities.vision,
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
    }, fetchFn, selectedProfile.supportsVision))
    const fallbackState: CustomLlmFallbackState = {
      enabled: allowFailureFallback
        && selectedProfile.fallbackToDefaultOnFailure
        && !!options?.managedProvider,
      used: false,
      reason: null,
      status: null,
      detail: null,
      endpointName: selectedProfile.endpointName,
    }
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
    // The fallback wraps OUTSIDE the profile clamp on purpose: the clamp
    // narrows maxTokens / inputTokenLimit to the endpoint's declared window
    // (often a fraction of the platform model's), and a fallback turn should
    // be bounded by what the caller actually asked for, not by the window of
    // the endpoint that just failed.
    const turnProvider = fallbackState.enabled && options?.managedProvider
      ? wrapEndpointFallback(limitedProvider, options.managedProvider, {
          onFallback: (event) => {
            if (fallbackState.used) return
            fallbackState.used = true
            fallbackState.reason = event.reason
            fallbackState.status = event.status
            fallbackState.detail = event.detail
            console.warn(
              `[custom-llm] endpoint '${fallbackState.endpointName}' failed (${event.reason}` +
              `${event.status === null ? '' : ` ${event.status}`}) - the platform model served the turn instead: ${event.detail}`,
            )
          },
        })
      : limitedProvider

    return {
      provider: turnProvider,
      selector,
      fallback: fallbackState,
      profileId: selectedProfile.id,
      modelTier,
      inputTokenLimit: selectedProfile.contextWindow,
      maxTokens: selectedProfile.maxOutputTokens,
      // DERIVED, not fixed. `providerKeySource: 'user'` is what makes a turn
      // cost 0 - the workspace pays its own endpoint's bill and Brian does
      // not repay it. A turn the endpoint FAILED to serve ran on platform
      // capacity instead, so leaving this at 'user' would be free platform
      // serving. There are ~20 usage-recording sites reading this field
      // (chat, every channel, public API, inter-assistant, resume-replay,
      // and the background lanes), and every one of them reads it when it
      // records usage, i.e. after the turn - so deriving it here fixes all
      // of them at once and cannot be forgotten at a new one. See
      // byo-llm-key.md -> "Endpoint failure fallback".
      get providerKeySource(): 'user' | 'platform' {
        return fallbackState.used ? 'platform' : 'user'
      },
      routeKind: 'custom',
      supportsVision: selectedProfile.supportsVision,
      browserUse: {
        apiKeyEnvName: 'OPENAI_API_KEY',
        apiKey: selectedProfile.apiKey?.trim() || 'not-required',
        model: selectedProfile.modelId,
        baseUrl: selectedProfile.baseUrl,
      },
    }
  }
}
