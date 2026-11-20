/**
 * LLM provider stack, decision runtime and the final media-backend rung.
 *
 * Boot register module registerProviders: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ProvidersScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { createAnthropicProvider } from '@use-brian/agent-runtime/providers/anthropic.js'
import { wrapCredentialPoolProvider } from '@use-brian/agent-runtime/providers/credential-pool.js'
import type {
  DocumentDistillPort,
  DistillateCachePort,
} from '@use-brian/agent-runtime/providers/document-adaptation.js'
import { createGeminiProvider } from '@use-brian/agent-runtime/providers/gemini.js'
import {
  DASHSCOPE_INTL_LABEL,
  createOpenAICompatProvider,
} from '@use-brian/agent-runtime/providers/openai-compat.js'
import { createRoutingProvider } from '@use-brian/agent-runtime/providers/routing.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { wrapProvider } from '@use-brian/agent-runtime/providers/wrappers.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { distillFileToText } from '@use-brian/core/files/distill.js'
import {
  distillConfigKey,
  DASHSCOPE_RENDER_WIDTH,
  PROVIDER_RENDER_WIDTH,
  DASHSCOPE_CHUNK_PAGES,
  PROVIDER_CHUNK_PAGES,
} from '@use-brian/core/files/pdf-distill.js'
import { documentModelForMediaBackend } from '@use-brian/core/media/backend.js'
import { isSelfManagedProviderEnv } from '../edition.js'
import {
  MutableProviderAvailability, menuForClass, modelRates, registryRow, isDecisionModelRow,
} from '@use-brian/shared/model-registry'
import { BACKGROUND_MODEL, ensureServableModel, backgroundModelFor } from '../model-resolution.js'
import { EXTRACTION_MODEL } from '../build-episode-ingestors.js'
import { createWorkspaceDecisionRoutingStore } from '../db/workspace-decision-routing.js'
import { createDecisionEvaluationProfileStore } from '../db/decision-evaluation-profiles.js'
import { type CodexProviderManager, startCodexProviderManager } from '../codex-provider-manager.js'
import { saveLocalProviderPreference } from '../local-provider-preference.js'
import { getPdfDistillate, savePdfDistillate } from '../db/pdf-distillate-store.js'
import {
  createDecisionAttemptUsageRecorder, type DecisionRuntime, createDecisionRuntime,
} from '../decision-runtime.js'
import {
  parseOperatorDecisionDefault, createWorkspaceDecisionRouteResolver,
} from '../workspace-decision-routing.js'
import type { ProvidersScope } from './scope.js'

export async function registerProviders(scope: ProvidersScope) {
  const {
    opts, ports, env, externalCredentialPool, vertexTx, hasGeminiCredential, geminiTransport,
    dashscopeBaseUrl, dashscopeMediaBackend, googleMediaBackend, analytics, hasAnthropicCredential,
    hasDashscopeCredential, selectMediaBackend, usageStore, late,
  } = scope
  // ── LLM provider stack ──
  //
  // Registry-routed (docs/architecture/platform/model-registry.md): one
  // wrapped instance per configured provider key; the routing provider
  // dispatches per request on the model's registry row. A missing key means
  // that provider's models are simply absent (plan L12) — the ONLY env
  // gates here are the provider API keys (+ the pre-existing
  // FALLBACK_PROVIDER_ENABLED toggle for the Claude outage fallback).
  // Same-class fallback (registry `fallbackAlias`, plan L2) replaces the
  // old whole-provider wrapFallback: standard-pro Gemini models fall back
  // to Claude Haiku; Max/Research/background rows have no same-class
  // fallback and now surface outages instead of silently swapping class.
  // `geminiTransport` (Vertex or AI Studio) was resolved once above and is
  // shared with the embedder + media backend. The registry still names this
  // provider `gemini`; a Vertex-backed instance serves the same rows.
  console.log(
    `[provider] gemini transport: ${vertexTx ? `vertex (${env.VERTEX_LOCATION || 'asia-east2'})` : 'ai-studio'}`,
  )

  // Gemini is registered only when it has a real credential (AI Studio key or
  // a Vertex project). Registering a keyless `gemini` would defeat the
  // registry's L12 rule — it would appear "configured", its models would show
  // in menus and be picked as the tier default, then 401 at call time. A
  // pure-Qwen deployment leaves it out entirely.
  const providerInstances: Record<string, LLMProvider> = {}
  const configuredProviders = new MutableProviderAvailability()
  late.configuredProviders = configuredProviders
  configuredProviders.setPreferredProvider(
    normalizeOssPreferredProvider(env.USEBRIAN_PREFERRED_PROVIDER),
  )
  let codexProviderManager: CodexProviderManager | undefined
  if (hasGeminiCredential) {
    const geminiProvider = vertexTx
      ? createGeminiProvider(vertexTx)
      : externalCredentialPool
        ? wrapCredentialPoolProvider({
            providerId: 'gemini',
            pool: externalCredentialPool,
            systemFallback: env.GEMINI_API_KEY,
            create: (secret) => createGeminiProvider(secret),
          })
        : createGeminiProvider(geminiTransport)
    providerInstances['gemini'] = wrapProvider(geminiProvider)
    configuredProviders.setStaticProvider('gemini', true)
  }
  if (env.FALLBACK_PROVIDER_ENABLED) {
    if (hasAnthropicCredential) {
      const anthropicProvider = externalCredentialPool
        ? wrapCredentialPoolProvider({
            providerId: 'anthropic',
            pool: externalCredentialPool,
            systemFallback: env.ANTHROPIC_API_KEY,
            create: (secret) => createAnthropicProvider({ apiKey: secret }),
          })
        : createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY! })
      providerInstances['anthropic'] = wrapProvider(anthropicProvider)
      configuredProviders.setStaticProvider('anthropic', true)
    } else {
      console.warn('[provider] FALLBACK_PROVIDER_ENABLED=true but ANTHROPIC_API_KEY is empty — running without the Claude fallback.')
    }
  }
  if (hasDashscopeCredential) {
    const dashscopeProviderId = `openai-compat:${DASHSCOPE_INTL_LABEL}`
    providerInstances[dashscopeProviderId] = wrapProvider(
      externalCredentialPool
        ? wrapCredentialPoolProvider({
            providerId: 'dashscope',
            pool: externalCredentialPool,
            systemFallback: env.DASHSCOPE_API_KEY,
            create: (secret) => createOpenAICompatProvider({
              apiKey: secret,
              baseURL: dashscopeBaseUrl,
              label: DASHSCOPE_INTL_LABEL,
              supportsVision: false,
            }),
          })
        : createOpenAICompatProvider({
            apiKey: env.DASHSCOPE_API_KEY!,
            baseURL: dashscopeBaseUrl,
            label: DASHSCOPE_INTL_LABEL,
            supportsVision: false,
          }),
    )
    configuredProviders.setStaticProvider(dashscopeProviderId, true)
  }
  if (isSelfManagedProviderEnv() && opts.startLocalSubscriptionProvider !== false) {
    try {
      codexProviderManager = await startCodexProviderManager({
        availability: configuredProviders,
        savePreferredProvider: saveLocalProviderPreference,
      })
      providerInstances['openai-codex'] = wrapProvider(codexProviderManager.provider)
    } catch {
      // Codex is optional: a package/platform/runtime failure disables only
      // the subscription lane and leaves every API-key provider usable.
      console.warn('[provider] ChatGPT subscription runtime unavailable — continuing without it.')
      configuredProviders.setModelCatalog('openai-codex', null)
    }
  }
  // Selection-surface derivations (model-registry.md L10/L12): which
  // provider keys exist decides which models exist — menus and the chat
  // route's metered gate both consume these, so a keyless model is absent
  // everywhere at once.
  const meteredModelsAvailable: ReadonlySet<string> = new Set(
    menuForClass('metered', configuredProviders).map((r) => r.alias),
  )
  // The background lane is internal routing with no menu, so L12 can't drop a
  // keyless model out of it the way it does for chat: the id is baked into the
  // call sites. Resolve it once here and inject the result, or a deployment
  // without a Google credential loses every background job — auto-title, memory
  // splitting, classification, digests, themes, skill review. Logged because
  // this lane spends real money and shapes what the brain extracts, so which
  // model serves it should never be implicit.
  // Keep the injected identity logical. The routing provider resolves the live
  // serving background model per operation, so hot preference changes cannot
  // leave long-lived workers pinned to the boot-time provider.
  const backgroundModel = BACKGROUND_MODEL
  // Pipeline B's extraction model is chat-class, not background-class, but it
  // is hardcoded the same way and dies the same way without a Google key.
  const extractionModel = configuredProviders.size > 0
    ? ensureServableModel(EXTRACTION_MODEL, configuredProviders)
    : EXTRACTION_MODEL
  if (extractionModel !== EXTRACTION_MODEL) {
    console.log(`[provider] extraction: ${extractionModel} (${EXTRACTION_MODEL} not servable)`)
  }
  // Always construct synthesis lanes. A custom-only deployment resolves its
  // workspace runtime at execution time; without either runtime, the provider
  // call fails honestly instead of the feature disappearing at boot.
  const synthesisModel = BACKGROUND_MODEL
  // Every PDF is swapped for a page-complete validated distillate HERE, at the
  // provider boundary — so web chat, every channel adapter, the outage
  // fallback firing mid-turn, and replayed history all inherit it with no
  // per-route wiring. `nativePdf` is only an emergency path when this port is
  // absent. Ports keep core DB-free.
  //
  // `mediaBackend` is read lazily inside `distill` because the provider-backed
  // rung is resolved AFTER this provider exists (it needs `provider` itself).
  const documentDistill: DocumentDistillPort = {
    get configKey() {
      const backend = selectMediaBackend('application/pdf')
      return distillConfigKey({
        renderWidth: backend.kind === 'dashscope' ? DASHSCOPE_RENDER_WIDTH : PROVIDER_RENDER_WIDTH,
        chunkPages: backend.kind === 'dashscope' ? DASHSCOPE_CHUNK_PAGES : PROVIDER_CHUNK_PAGES,
        model: documentModelForMediaBackend(backend),
      })
    },
    distill: async ({ buffer, mime }) => {
      const result = await distillFileToText(
        { buffer, mime },
        { backend: selectMediaBackend(mime) },
      )
      return {
        text: result.text,
        model: result.model,
        usage: result.usage,
        ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
      }
    },
  }
  const distillateCache: DistillateCachePort = {
    get: (contentHash, configKey) => getPdfDistillate(contentHash, configKey),
    set: (row) => savePdfDistillate(row),
  }
  /**
   * Does distillation cost anything per token on this deployment? A ChatGPT
   * subscription is `FREE_RATES` in the registry, so there is nothing to
   * confirm and the >30-page warning is noise. Read lazily: the
   * provider-backed rung is resolved after this point.
   */
  const mediaBackendIsFreeRated = (): boolean => {
    const backend = selectMediaBackend('application/pdf')
    if (backend.kind !== 'provider') return false
    const rates = modelRates(backend.model)
    return !!rates && rates.brackets.every((b) => b.inPerMTok === 0 && b.outPerMTok === 0)
  }

  const provider: LLMProvider = createRoutingProvider(providerInstances, {
    availability: configuredProviders,
    documentAdaptation: { distill: documentDistill, cache: distillateCache },
    // Re-evaluate at request time as well as boot. The ChatGPT catalog is
    // empty until OAuth completes, so boot-selected background/extraction
    // model ids must be able to move onto the newly available provider
    // without requiring a Brian restart.
    resolveModel: (model) => registryRow(model)?.class === 'background'
      ? backgroundModelFor(configuredProviders)
      : ensureServableModel(model, configuredProviders),
    analytics: {
      onFallback({ primaryModel, fallbackModel, errorKind, errorStatus }) {
        analytics.logEvent({
          userId: 'system',
          eventName: 'llm_provider_fallback',
          metadata: {
            primary_model: sanitizeAnalytics(primaryModel),
            fallback_model: sanitizeAnalytics(fallbackModel),
            error_kind: sanitizeAnalytics(errorKind),
            error_status: errorStatus ?? undefined,
          },
        })
      },
    },
  })
  late.provider = provider

  const workspaceDecisionRoutingStore = createWorkspaceDecisionRoutingStore()
  const decisionEvaluationProfileStore = createDecisionEvaluationProfileStore()
  const recordDecisionUsage = createDecisionAttemptUsageRecorder(usageStore)
  const operatorDecisionDefault = parseOperatorDecisionDefault(
    env.DECISION_DEFAULT_MODE,
    env.DECISION_DEFAULT_MODEL,
    env.DECISION_DEFAULT_OPERATIONS,
  )
  let decisionRuntime!: DecisionRuntime
  const workspaceDecisionRouteResolver = createWorkspaceDecisionRouteResolver({
    store: workspaceDecisionRoutingStore,
    profileStore: decisionEvaluationProfileStore,
    configuredAdapterIds: () => decisionRuntime.configuredAdapterIds(),
    operatorDefault: operatorDecisionDefault,
    fallback: ports.resolveDecisionRoute,
    onError: (error, context) => {
      console.warn('[decision-routing] route resolution degraded safely', {
        workspaceId: context.workspaceId,
        operationId: context.operation.id,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  decisionRuntime = createDecisionRuntime({
    llmProvider: provider,
    defaultLlmModel: () => backgroundModelFor(configuredProviders),
    typesafeApiKey: env.TYPESAFE_API_KEY,
    openaiDecisionsApiKey: env.OPENAI_DECISIONS_API_KEY,
    configureAdapters: ports.configureDecisionAdapters,
    resolveRoute: workspaceDecisionRouteResolver,
    onAttempt: ports.recordDecisionAttempt ? async (attempt) => {
      await recordDecisionUsage(attempt)
      await ports.recordDecisionAttempt?.(attempt)
    } : recordDecisionUsage,
    onOutcome: ports.recordDecisionOutcome,
  })
  if (operatorDecisionDefault) {
    const row = registryRow(operatorDecisionDefault.modelAlias)
    if (
      !row
      || !isDecisionModelRow(row)
      || !decisionRuntime.configuredAdapterIds().includes(row.decisionCapabilities.adapterId)
    ) {
      throw new Error(
        `decision-routing: operator default '${operatorDecisionDefault.modelAlias}' has no configured adapter`,
      )
    }
    console.warn('[decision-routing] deployment operator override active', {
      mode: operatorDecisionDefault.mode,
      modelAlias: operatorDecisionDefault.modelAlias,
      scope: operatorDecisionDefault.mode === 'classifier_first'
        ? 'unset_or_matching_hybrid_workspaces'
        : 'workspaces_without_explicit_setting',
      operations: operatorDecisionDefault.operationIds ?? 'all',
      llmFailover: true,
    })
  }

  // ── Media backend, final rung ──
  //
  // With no Google and no DashScope credential, distillation runs through the
  // deployment's OWN chat model (`{ kind: 'provider' }`): pages render to
  // images and ride ordinary `image` blocks, so any adapter that accepts them
  // works and a ChatGPT subscription pays nothing per token. Before this, the
  // chain fell through to `{ kind: 'dashscope', apiKey: '' }` and every
  // distill attempt 401'd on a Codex-only box.
  if (!googleMediaBackend && !dashscopeMediaBackend && configuredProviders.size > 0) {
    const mediaModel = ensureServableModel(BACKGROUND_MODEL, configuredProviders)
    const mediaModelRow = registryRow(mediaModel)
    if (mediaModelRow?.capabilities.vision) {
      late.providerMediaBackend = { kind: 'provider', provider, model: mediaModel }
      console.log(`[media] backend: chat provider (${mediaModel}) — no Google or DashScope credential`)
    } else {
      console.warn(
        `[media] no media backend: no Google/DashScope credential and the servable model ` +
        `'${mediaModel}' has no vision capability. Documents will fall back to local text extraction.`,
      )
    }
  }

  return {
    configuredProviders, provider, codexProviderManager, extractionModel, documentDistill, distillateCache,
    workspaceDecisionRoutingStore, decisionEvaluationProfileStore, decisionRuntime, operatorDecisionDefault,
    backgroundModel, synthesisModel, meteredModelsAvailable, mediaBackendIsFreeRated,
    providerMediaBackend: late.providerMediaBackend,
  } as const
}

function normalizeOssPreferredProvider(value: string | undefined): string | null {
  return value === 'gemini' ||
    value === 'openai-codex' ||
    value === 'dashscope-intl' ||
    value === 'auto'
    ? value
    : null
}
