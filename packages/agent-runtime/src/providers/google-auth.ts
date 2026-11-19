/**
 * Google Cloud OAuth2 access tokens for the Vertex adapter — zero dependency.
 *
 * Vertex AI authenticates with a short-lived OAuth2 bearer token, not the
 * static `x-goog-api-key` the AI Studio adapter uses. We mint that token here
 * rather than pulling `google-auth-library`, for the same reason `gemini.ts`
 * hits the REST API rather than `@google/generative-ai`: the dependency buys
 * us little and costs control. Two sources, matching the two places this runs:
 *
 * - **Metadata server** (`metadataTokenSource`) — Cloud Run / GCE. The
 *   instance's attached service account is exchanged by the platform; no
 *   secret material ever touches the container. This is the production path
 *   and the default when `VERTEX_SERVICE_ACCOUNT_JSON` is unset.
 * - **Service-account JSON** (`serviceAccountTokenSource`) — local dev, CI, or
 *   any non-GCP host. Signs an RS256 JWT with `node:crypto` and exchanges it
 *   at Google's token endpoint per the standard JWT-bearer flow.
 *
 * Both are wrapped in `cachedTokenSource`, which is the load-bearing piece:
 * an uncached source would mint a token per LLM call, adding a full round trip
 * to every turn's latency and hammering the token endpoint's quota.
 *
 * See docs/architecture/engine/provider-abstraction.md → "Vertex adapter".
 */

import { createSign } from 'node:crypto'

/** Resolves to a bearer token valid for at least a few more seconds. */
export type TokenSource = () => Promise<string>

type TokenResponse = { access_token?: string; expires_in?: number }

/**
 * Refresh this many milliseconds BEFORE the stated expiry. A token that
 * expires mid-flight produces a 401 on a request we already committed to, so
 * we always trade a little freshness for never handing out a token that dies
 * in transit.
 */
const EXPIRY_SKEW_MS = 60_000

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-account/token'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const PRE_DISPATCH_RETRY_DELAYS_MS = [250, 1_000] as const
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])
const DEFINITELY_UNDISPATCHED_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

export class GoogleRequestNotDispatchedError extends Error {
  readonly causeCodes: string[]
  constructor(cause: unknown) {
    super('google_request_not_dispatched', { cause })
    this.name = 'GoogleRequestNotDispatchedError'
    this.causeCodes = googleNetworkErrorCodes(cause)
  }
}

function googleNetworkErrorCodes(error: unknown): string[] {
  const pending: unknown[] = [error]; const seen = new Set<object>(); const codes: string[] = []
  for (let inspected = 0; pending.length && inspected < 8; inspected++) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const detail = current as { code?: unknown; cause?: unknown; errors?: unknown }
    if (typeof detail.code === 'string' && !codes.includes(detail.code)) codes.push(detail.code)
    if (detail.cause) pending.push(detail.cause)
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 4))
  }
  return codes
}

const isTransientNetworkFailure = (error: unknown) => {
  const codes = googleNetworkErrorCodes(error)
  return codes.length > 0 && codes.every(code => TRANSIENT_NETWORK_CODES.has(code))
}

export function isDefinitelyUndispatchedGoogleRequest(error: unknown): boolean {
  const codes = googleNetworkErrorCodes(error)
  return codes.length > 0
    && codes.every(code => code === 'ETIMEDOUT' || DEFINITELY_UNDISPATCHED_CODES.has(code))
    && codes.some(code => DEFINITELY_UNDISPATCHED_CODES.has(code))
}

async function waitForPreDispatchRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, delayMs)
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function retryGooglePreDispatch<T>(
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (details: { attempt: number; maxAttempts: number; delayMs: number; causeCodes: string[] }) => void;
  } = {},
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isTransientNetworkFailure
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      if (!shouldRetry(error)) throw error
      const delayMs = PRE_DISPATCH_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined) throw new GoogleRequestNotDispatchedError(error)
      options.onRetry?.({ attempt: attempt + 1, maxAttempts: PRE_DISPATCH_RETRY_DELAYS_MS.length + 1, delayMs, causeCodes: googleNetworkErrorCodes(error) })
      await waitForPreDispatchRetry(delayMs, options.signal)
    }
  }
}

/**
 * Wrap a token source with expiry-aware caching, collapsing concurrent
 * refreshes into one in-flight request.
 *
 * The `inflight` promise matters under load: without it, N concurrent turns
 * arriving on a cold cache each fire their own token request, and all but one
 * are wasted. With it, they all await the same mint.
 */
export function cachedTokenSource(
  inner: () => Promise<{ token: string; expiresInMs: number }>,
): TokenSource {
  let token: string | undefined
  let expiresAt = 0
  let inflight: Promise<string> | undefined

  return async () => {
    if (token && Date.now() < expiresAt) return token
    if (inflight) return inflight

    inflight = (async () => {
      try {
        const result = await retryGooglePreDispatch(inner, {
          onRetry: details => console.warn('[google-auth] transient token mint failure; retrying before provider dispatch', details),
        })
        token = result.token
        expiresAt = Date.now() + Math.max(0, result.expiresInMs - EXPIRY_SKEW_MS)
        return result.token
      } finally {
        inflight = undefined
      }
    })()

    return inflight
  }
}

/**
 * Token from the GCE/Cloud Run metadata server (Application Default
 * Credentials). Requires no secret in the environment — the platform vouches
 * for the instance's attached service account.
 */
export function metadataTokenSource(fetchFn: typeof fetch = fetch): TokenSource {
  return cachedTokenSource(async () => {
    const response = await fetchFn(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Vertex ADC: metadata server returned ${response.status}. ` +
        `This host has no attached service account — set VERTEX_SERVICE_ACCOUNT_JSON ` +
        `when running outside GCP. Detail: ${body.slice(0, 300)}`,
      )
    }

    const data = (await response.json()) as TokenResponse
    if (!data.access_token) {
      throw new Error('Vertex ADC: metadata server returned no access_token')
    }

    return { token: data.access_token, expiresInMs: (data.expires_in ?? 3600) * 1000 }
  })
}

/** The fields we need out of a GCP service-account key file. */
type ServiceAccountKey = {
  client_email?: string
  private_key?: string
  token_uri?: string
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Token minted from an explicit service-account JSON key via the RS256
 * JWT-bearer grant. `rawJson` is the full key file contents.
 *
 * Parsing happens once, eagerly, so a malformed key fails at boot with a clear
 * message rather than on the first user turn.
 */
export function serviceAccountTokenSource(
  rawJson: string,
  fetchFn: typeof fetch = fetch,
): TokenSource {
  let key: ServiceAccountKey
  try {
    key = JSON.parse(rawJson) as ServiceAccountKey
  } catch {
    throw new Error(
      'VERTEX_SERVICE_ACCOUNT_JSON is not valid JSON. Expected the full ' +
      'service-account key file contents.',
    )
  }

  const clientEmail = key.client_email
  const privateKey = key.private_key
  if (!clientEmail || !privateKey) {
    throw new Error(
      'VERTEX_SERVICE_ACCOUNT_JSON is missing `client_email` or `private_key`. ' +
      'Expected the full service-account key file contents.',
    )
  }
  const tokenUri = key.token_uri || OAUTH_TOKEN_URL

  return cachedTokenSource(async () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const expiresAt = issuedAt + 3600

    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64Url(
      JSON.stringify({
        iss: clientEmail,
        scope: CLOUD_PLATFORM_SCOPE,
        aud: tokenUri,
        exp: expiresAt,
        iat: issuedAt,
      }),
    )

    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    const signature = base64Url(signer.sign(privateKey))
    const assertion = `${header}.${claims}.${signature}`

    const response = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Vertex service-account token exchange failed (${response.status}): ${body.slice(0, 300)}`,
      )
    }

    const data = (await response.json()) as TokenResponse
    if (!data.access_token) {
      throw new Error('Vertex service-account token exchange returned no access_token')
    }

    return { token: data.access_token, expiresInMs: (data.expires_in ?? 3600) * 1000 }
  })
}

/**
 * Pick the right source for the environment: explicit key when supplied,
 * otherwise the metadata server.
 */
export function resolveVertexTokenSource(
  serviceAccountJson?: string,
  fetchFn: typeof fetch = fetch,
): TokenSource {
  return serviceAccountJson
    ? serviceAccountTokenSource(serviceAccountJson, fetchFn)
    : metadataTokenSource(fetchFn)
}
