/**
 * Routing provider — model id → provider instance, per request.
 *
 * `createRoutingProvider(providers)` implements `LLMProvider` and dispatches
 * every `stream()` / `createSession()` call on the request's model id via
 * the model registry (docs/architecture/platform/model-registry.md): the
 * model's registry row names its provider; the routing table holds one
 * ALREADY-WRAPPED instance per configured provider (wrapper composition is
 * per-provider — plan L2 — boot wraps each instance before handing it in).
 *
 * Unknown model id → loud error (never a silent pass-through to some
 * default vendor). Provider configured in the registry but absent from the
 * table (missing API key) → loud error too; menus must never offer such a
 * model in the first place (plan L12 — keyless models are absent, and the
 * boot-time menu derivation enforces it).
 *
 * Fallback is same-class only (plan L2): a registry row may name a
 * `fallbackAlias`; the routing provider wraps that row's dispatch in
 * `wrapFallback` targeting the fallback row's provider — but ONLY when the
 * fallback row shares the primary row's class (an outage never upgrades or
 * downgrades a billing class silently) and its provider is configured.
 * Rows without a same-class fallback simply fail over nothing — a Max
 * outage surfaces as an error rather than billing Max revenue for
 * standard-class serving.
 */
import {
  isRegistryModelAvailable,
  registryRow,
  type ModelRegistryRow,
  type ProviderAvailability,
} from '@use-brian/shared/model-registry'
import type { LLMProvider, ProviderRequest, ProviderSession, SessionOptions, StreamChunk } from './types.js'
import { wrapFallback, type FallbackAnalytics } from './wrap-fallback.js'
import {
  wrapDocumentAdaptation,
  type DistillateCachePort,
  type DocumentDistillPort,
} from './document-adaptation.js'

export type RoutingProviderOptions = {
  /** Forwarded to `wrapFallback` for every routed same-class fallback pair —
   * keeps the `llm_provider_fallback` analytics event emitting. */
  analytics?: FallbackAnalytics
  /** Live provider/model availability. Plain provider Sets retain static
   * behavior; the OSS Codex lane adds account-scoped model entitlement. */
  availability?: ProviderAvailability
  /** Optional late-bound model resolver. OSS uses this so a provider that
   * becomes available after OAuth can serve boot-selected background lanes
   * without restarting the process. Explicit unavailable Codex ids remain
   * unchanged by `ensureServableModel` and still fail closed. */
  resolveModel?: (model: string, options?: { allowProviderFallback?: boolean }) => string
  /**
   * Ports for `wrapDocumentAdaptation`. Wired here rather than at each call
   * site because this is the only place that knows the CONCRETE model — and
   * therefore its `capabilities.nativePdf` — for both the primary and its
   * fallback. Omitted ⇒ non-native providers receive an honest "no
   * distillation backend" note instead of a malformed PDF part.
   */
  documentAdaptation?: {
    distill?: DocumentDistillPort
    cache?: DistillateCachePort
  }
}

export function createRoutingProvider(
  providers: Record<string, LLMProvider>,
  options?: RoutingProviderOptions,
): LLMProvider {
  // Effective provider per registry row and routing mode. Exact routes omit
  // the outage fallback; Auto routes keep the row's fallback policy.
  const effectiveByRoute = new Map<string, LLMProvider>()

  function effectiveFor(model: string, allowProviderFallback = true): LLMProvider {
    const row = registryRow(model)
    if (!row) {
      throw new Error(
        `[routing] unknown model id '${model}' — no model-registry row. ` +
        `Add one to packages/shared/src/model-registry.ts (docs/architecture/platform/model-registry.md).`,
      )
    }
    if (!isRegistryModelAvailable(row, options?.availability)) {
      throw new Error(
        `[routing] model '${model}' is not available for provider '${row.provider}' ` +
        `(the account may need to reconnect or choose another model).`,
      )
    }
    const cacheKey = `${row.alias}:${allowProviderFallback ? 'fallback' : 'exact'}`
    const cached = effectiveByRoute.get(cacheKey)
    if (cached) return cached

    const base = providers[row.provider]
    if (!base) {
      throw new Error(
        `[routing] model '${model}' routes to provider '${row.provider}', which is not configured ` +
        `(missing API key?). Keyless models must be absent from every menu (plan L12).`,
      )
    }

    const adapted = withDocumentAdaptation(row, base)
    const effective = allowProviderFallback ? withFallback(row, adapted) : adapted
    effectiveByRoute.set(cacheKey, effective)
    return effective
  }

  /**
   * Applied per CONCRETE row, not per provider key: `nativePdf` is a model
   * capability, and the primary and its fallback can differ. Wrapping inside
   * `withFallback` (rather than around it) is what makes an Anthropic
   * fallback firing mid-PDF-turn receive the distillate instead of dropping
   * the block — wrapping outside would consult the PRIMARY's capability and
   * hand the fallback a PDF it cannot read.
   */
  function withDocumentAdaptation(row: ModelRegistryRow, base: LLMProvider): LLMProvider {
    return wrapDocumentAdaptation(base, {
      nativePdf: row.capabilities.nativePdf,
      ...(options?.documentAdaptation?.distill ? { distill: options.documentAdaptation.distill } : {}),
      ...(options?.documentAdaptation?.cache ? { cache: options.documentAdaptation.cache } : {}),
    })
  }

  function withFallback(row: ModelRegistryRow, base: LLMProvider): LLMProvider {
    if (!row.fallbackAlias) return base
    const fbRow = registryRow(row.fallbackAlias)
    if (!fbRow) {
      throw new Error(`[routing] '${row.alias}' names unknown fallbackAlias '${row.fallbackAlias}'`)
    }
    if (fbRow.class !== row.class) {
      // Same-class only — a mis-declared registry row fails loud at first
      // use rather than silently swapping billing classes during an outage.
      throw new Error(
        `[routing] '${row.alias}' (class ${row.class}) declares cross-class fallback '${fbRow.alias}' (class ${fbRow.class}) — same-class only (plan L2)`,
      )
    }
    const fbProvider = providers[fbRow.provider]
    // Fallback provider not configured (no key) → run without fallback.
    // Availability is key presence (L12); the primary keeps serving.
    if (!fbProvider || !isRegistryModelAvailable(fbRow, options?.availability)) return base
    return wrapFallback(base, withDocumentAdaptation(fbRow, fbProvider), {
      fallbackModel: row.fallbackAlias,
      ...(options?.analytics ? { analytics: options.analytics } : {}),
    })
  }

  return {
    name: 'routing',
    models: Object.values(providers).flatMap((p) => p.models),

    stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      const model = request.allowProviderFallback === false
        ? request.model
        : options?.resolveModel?.(request.model, {
            allowProviderFallback: request.allowProviderFallback,
          }) ?? request.model
      return effectiveFor(model, request.allowProviderFallback !== false).stream(
        model === request.model ? request : { ...request, model },
      )
    },

    createSession(sessionOpts: SessionOptions): ProviderSession {
      const model = sessionOpts.allowProviderFallback === false
        ? sessionOpts.model
        : options?.resolveModel?.(sessionOpts.model, {
            allowProviderFallback: sessionOpts.allowProviderFallback,
          }) ?? sessionOpts.model
      return effectiveFor(model, sessionOpts.allowProviderFallback !== false).createSession(
        model === sessionOpts.model ? sessionOpts : { ...sessionOpts, model },
      )
    },
  }
}
