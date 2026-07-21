/**
 * Where a Google-family request goes, and how it authenticates.
 *
 * AI Studio and Vertex AI speak the **same** Gemini wire format — identical
 * `contents`, `tools`, `generationConfig`, and identical response parts down to
 * `thoughtSignature`. They differ in exactly two things: the URL they live at
 * and how they prove who you are. This module isolates that difference so
 * `gemini.ts` keeps one request builder, one SSE parser, and one stream
 * converter serving both.
 *
 * That symmetry is why Vertex is the cheap adapter and DashScope is not:
 * swapping to Vertex is a host + header change, whereas DashScope is a
 * different wire format entirely (see `dashscope.ts`).
 *
 * **Why this exists at all:** Google blocks its *developer* products
 * (AI Studio, `generativelanguage.googleapis.com`) in several regions
 * including Hong Kong, while Vertex AI is available there under enterprise
 * terms in `asia-east2`. A deployment serving those regions cannot reach the
 * default host at all, so the transport is not a preference — it is the
 * difference between the product working and not.
 *
 * See docs/architecture/engine/provider-abstraction.md → "Adapters".
 */

import type { TokenSource } from './google-auth.js'

export const AI_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * A resolved Google-family endpoint + auth pair.
 *
 * `headers()` is async because Vertex mints a short-lived OAuth token; the
 * AI Studio implementation resolves immediately with a static key.
 */
export type GoogleTransport = {
  /** Which adapter this is — surfaces in error messages and analytics. */
  readonly kind: 'ai-studio' | 'vertex'
  /**
   * Full URL for a model method.
   * @param modelId  Resolved wire model id (e.g. `gemini-3-flash-preview`).
   * @param method   REST verb suffix (`streamGenerateContent`, `generateContent`,
   *                 `batchEmbedContents`, `predict`).
   * @param query    Extra query params (e.g. `{ alt: 'sse' }`).
   */
  endpoint(modelId: string, method: string, query?: Record<string, string>): string
  /** Request headers including auth. Awaited per request; token sources cache. */
  headers(): Promise<Record<string, string>>
}

function withQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url
  return `${url}?${new URLSearchParams(query).toString()}`
}

/**
 * Google AI Studio (the Gemini Developer API) — static API key, global host.
 * This is the default adapter and the one every existing deployment uses.
 *
 * Deliberately total: an absent key does NOT throw here. Callers construct
 * providers eagerly — including test files that build one and then skip, and
 * boot paths that construct before deciding whether a feature is enabled — so
 * a constructor-time throw turns "this feature is off" into "the process
 * dies". Missing-credential validation belongs at the config boundary
 * (`getEnv()`'s per-adapter superRefine), which fails the whole deploy with a
 * precise message; an empty key reaching the wire simply 401s, as before.
 */
export function aiStudioTransport(
  apiKey: string | undefined,
  baseUrl: string = AI_STUDIO_BASE_URL,
): GoogleTransport {
  return {
    kind: 'ai-studio',
    endpoint(modelId, method, query) {
      return withQuery(`${baseUrl}/models/${modelId}:${method}`, query)
    },
    async headers() {
      return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey ?? '' }
    },
  }
}

export type VertexTransportOptions = {
  /** GCP project id owning the Vertex quota. */
  project: string
  /**
   * Vertex location, e.g. `asia-east2` (Hong Kong) or `global`. Note this
   * selects BOTH the hostname and the URL path segment — Vertex quota is
   * regional, so this is a capacity decision as much as a latency one.
   */
  location: string
  /** Mints OAuth2 bearer tokens; see `resolveVertexTokenSource`. */
  tokenSource: TokenSource
}

/**
 * Vertex AI — regional host, OAuth2 bearer, project-scoped model path.
 *
 * The `global` location is special-cased: it uses the unprefixed
 * `aiplatform.googleapis.com` host while still carrying `locations/global` in
 * the path. Getting this wrong yields a DNS failure rather than a clean API
 * error, which is a miserable thing to debug.
 */
export function vertexTransport(options: VertexTransportOptions): GoogleTransport {
  const { project, location, tokenSource } = options

  if (!project) throw new Error('vertexTransport requires a project (VERTEX_PROJECT_ID).')
  if (!location) throw new Error('vertexTransport requires a location (VERTEX_LOCATION).')

  const host =
    location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${location}-aiplatform.googleapis.com`
  const basePath = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models`

  return {
    kind: 'vertex',
    endpoint(modelId, method, query) {
      return withQuery(`${basePath}/${modelId}:${method}`, query)
    },
    async headers() {
      const token = await tokenSource()
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      }
    },
  }
}
