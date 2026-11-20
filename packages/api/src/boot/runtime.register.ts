/**
 * Model transports, credential pool, shared embedder and media backends.
 *
 * Boot register module registerRuntime: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`RuntimeScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { resolveVertexTokenSource } from '@use-brian/agent-runtime/providers/google-auth.js'
import {
  type GoogleTransport,
  vertexTransport,
  credentialPoolAiStudioTransport,
  aiStudioTransport,
} from '@use-brian/agent-runtime/providers/google-transport.js'
import { DASHSCOPE_INTL_BASE_URL } from '@use-brian/agent-runtime/providers/openai-compat.js'
import {
  type EmbedderAdapterConfig,
  createEmbedderForAdapter,
} from '@use-brian/core/embeddings/adapters.js'
import type { MediaBackend } from '@use-brian/core/media/backend.js'
import { providerVisionModelFor } from '../model-resolution.js'
import type { RuntimeScope } from './scope.js'

export async function registerRuntime(scope: RuntimeScope) {
  const { ports, env, late } = scope
  // ════════════════════════════════════════════════════════════════
  // Shared infrastructure + stores
  // ════════════════════════════════════════════════════════════════
  // ── Google/Vertex transport + shared embedder (built once) ──
  // Vertex when a GCP project is configured (Google blocks AI Studio in some
  // regions, e.g. Hong Kong; Vertex reaches Gemini there), else the AI Studio
  // key. The same transport backs the `gemini` chat provider (below), the
  // shared embedder, and the media backend, so one OAuth-token cache serves
  // all three. See docs/architecture/engine/provider-abstraction.md.
  // DashScope host: international (Singapore) by default; override to the
  // Beijing endpoint for mainland China. Shared by Qwen chat, embeddings, media.
  const dashscopeBaseUrl = env.DASHSCOPE_BASE_URL || DASHSCOPE_INTL_BASE_URL
  const externalCredentialPool = ports.externalCredentialPool
  const vertexTx: GoogleTransport | undefined = env.VERTEX_PROJECT_ID
    ? vertexTransport({
        project: env.VERTEX_PROJECT_ID,
        location: env.VERTEX_LOCATION || 'asia-east2',
        tokenSource: resolveVertexTokenSource(env.VERTEX_SERVICE_ACCOUNT_JSON),
      })
    : undefined
  const bootGeminiCredential = externalCredentialPool
    ? await externalCredentialPool.resolve('gemini', env.GEMINI_API_KEY)
    : null
  const bootAnthropicCredential = externalCredentialPool
    ? await externalCredentialPool.resolve('anthropic', env.ANTHROPIC_API_KEY)
    : null
  const bootDashscopeCredential = externalCredentialPool
    ? await externalCredentialPool.resolve('dashscope', env.DASHSCOPE_API_KEY)
    : null
  const engineCredentialFallbacks = [
    ['engines-openai', process.env.ENGINES_OPENAI_API_KEY],
    ['engines-gemini', process.env.ENGINES_GEMINI_API_KEY],
    ['engines-perplexity', process.env.ENGINES_PERPLEXITY_API_KEY],
    ['engines-anthropic', process.env.ENGINES_ANTHROPIC_API_KEY],
  ] as const
  const managedEngineProviders = new Set<string>()
  if (externalCredentialPool) {
    const engineLeases = await Promise.all(
      engineCredentialFallbacks.map(([providerId, fallback]) =>
        externalCredentialPool.resolve(providerId, fallback),
      ),
    )
    engineLeases.forEach((lease, index) => {
      if (lease?.source === 'managed') managedEngineProviders.add(engineCredentialFallbacks[index][0])
    })
  }
  const hasGeminiCredential = Boolean(env.VERTEX_PROJECT_ID || bootGeminiCredential || env.GEMINI_API_KEY)
  const hasAnthropicCredential = Boolean(bootAnthropicCredential || env.ANTHROPIC_API_KEY)
  const hasDashscopeCredential = Boolean(bootDashscopeCredential || env.DASHSCOPE_API_KEY)
  const geminiTransport: GoogleTransport | undefined = vertexTx
    ?? (hasGeminiCredential
      ? externalCredentialPool
        ? credentialPoolAiStudioTransport(externalCredentialPool, env.GEMINI_API_KEY)
        : aiStudioTransport(env.GEMINI_API_KEY)
      : undefined)

  // One embedder for the whole process (was reconstructed at ten sites).
  // Embeddings default to Google (gemini-embedding-001, the registry's
  // embedding rows) via Vertex or AI Studio; a pure-Qwen deployment with no
  // Google credential falls back to DashScope text-embedding-v3. Vectors from
  // different vendors are NOT comparable — each embedder reports a distinct
  // model_id and switching requires a full re-embed.
  const embedderConfig: EmbedderAdapterConfig = vertexTx
    ? { adapter: 'vertex', transport: vertexTx }
    : geminiTransport
      ? { adapter: 'google-ai-studio', transport: geminiTransport }
      : {
          adapter: 'alicloud',
          apiKey: bootDashscopeCredential?.secret ?? env.DASHSCOPE_API_KEY ?? '',
          baseUrl: dashscopeBaseUrl,
          ...(externalCredentialPool
            ? {
                credentialPool: externalCredentialPool,
                systemFallback: env.DASHSCOPE_API_KEY,
              }
            : {}),
        }
  const sharedEmbedder = createEmbedderForAdapter(embedderConfig)

  // Media backend for file distillation + short-audio transcription. Google
  // (Gemini inlineData) via Vertex or AI Studio; a pure-Qwen deployment uses
  // DashScope (Qwen-VL for images and page-rendered PDFs, qwen-long
  // file-upload for office docs, Qwen-ASR for audio). See media/backend.ts.
  //
  // Application preference orders Google vs DashScope; auto keeps Google first.
  // The final rung is the chat provider itself. That last
  // rung is not cosmetic: this chain used to FALL THROUGH to a DashScope
  // backend with `apiKey: ''` whenever neither a Google credential nor a
  // DashScope key existed, so a Codex-only deployment (ChatGPT subscription
  // as the sole model credential) 401'd on every distill attempt and had no
  // working non-native document path at all. The provider-backed rung is
  // resolved after the provider stack is built (see `resolveMediaBackend`
  // below) because it needs the routing provider that does not exist yet.
  const googleMediaBackend: MediaBackend | undefined = vertexTx
    ? { kind: 'google', transport: vertexTx }
    : geminiTransport
      ? { kind: 'google', transport: geminiTransport }
      : undefined
  const dashscopeMediaKey = bootDashscopeCredential?.secret ?? env.DASHSCOPE_API_KEY
  const dashscopeMediaBackend: MediaBackend | undefined = dashscopeMediaKey
    ? {
        kind: 'dashscope',
        apiKey: dashscopeMediaKey,
        baseUrl: dashscopeBaseUrl,
        ...(externalCredentialPool
          ? {
              credentialPool: externalCredentialPool,
              systemFallback: env.DASHSCOPE_API_KEY,
            }
          : {}),
        ...(env.DASHSCOPE_VISION_MODEL ? { visionModel: env.DASHSCOPE_VISION_MODEL } : {}),
        ...(env.DASHSCOPE_ASR_MODEL ? { asrModel: env.DASHSCOPE_ASR_MODEL } : {}),
        ...(env.DASHSCOPE_LONG_MODEL ? { longModel: env.DASHSCOPE_LONG_MODEL } : {}),
      }
    : undefined
  const unavailableMediaBackend: MediaBackend = {
    kind: 'dashscope',
    apiKey: '',
    baseUrl: dashscopeBaseUrl,
  }
  // `providerMediaBackend` is late-bound: see BootLate (boot/late.ts).
  // Read MutableProviderAvailability on every operation so a hot preference
  // change reorders Codex/Google/DashScope without restarting the API.
  const selectKeyedMediaBackend = (): MediaBackend | undefined => {
    const preferred = late.configuredProviders.preferredProvider
    return preferred === 'dashscope-intl' || preferred === 'openai-compat:dashscope-intl'
      ? dashscopeMediaBackend ?? googleMediaBackend
      : googleMediaBackend ?? dashscopeMediaBackend
  }
  const selectMediaBackend = (mime: string): MediaBackend => {
    const preferred = late.configuredProviders.preferredProvider
    if (
      preferred === 'openai-codex' &&
      (mime === 'application/pdf' || mime.startsWith('image/'))
    ) {
      const model = providerVisionModelFor(late.configuredProviders, preferred)
      if (model) return { kind: 'provider', provider: late.provider, model }
    }
    return selectKeyedMediaBackend() ?? late.providerMediaBackend ?? unavailableMediaBackend
  }

  return {
    externalCredentialPool, managedEngineProviders, bootGeminiCredential, bootAnthropicCredential,
    bootDashscopeCredential, vertexTx, hasGeminiCredential, geminiTransport, dashscopeBaseUrl,
    dashscopeMediaKey, dashscopeMediaBackend, googleMediaBackend, selectKeyedMediaBackend,
    unavailableMediaBackend, sharedEmbedder, hasAnthropicCredential, hasDashscopeCredential,
    selectMediaBackend,
  } as const
}
