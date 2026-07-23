/**
 * Microsoft Graph retry + backoff.
 *
 * See docs/architecture/integrations/msgraph.md.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 60_000

/**
 * Jitter spread around the exponential term: +/-25%. Centred rather than
 * "full jitter" (`random() * exp`) so a retry never collapses to ~0ms and
 * re-hits Graph's 1-req/sec channel budget immediately.
 */
const JITTER_SPREAD = 0.5

/**
 * 429 (throttled) and 5xx (transient server/gateway) are worth another
 * attempt. Every other 4xx is a decision the server already made — retrying a
 * 401 spends the whole backoff budget on a credential that will not heal.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function exponentialDelay(attempt: number, baseDelayMs: number, random: () => number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1)
  return exp * (1 - JITTER_SPREAD / 2 + JITTER_SPREAD * random())
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parses `Retry-After` (RFC 9110 §10.2.3): either delta-seconds or an
 * HTTP-date. Returns a delay in ms, or null when absent/unparseable.
 */
function parseRetryAfter(res: Response, now: () => number): number | null {
  const raw = res.headers.get('Retry-After')
  if (!raw) return null

  const trimmed = raw.trim()
  const seconds = Number(trimmed)
  if (trimmed !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const at = Date.parse(trimmed)
  if (Number.isFinite(at)) return Math.max(0, at - now())

  return null
}

export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  let lastRes: Response | null = null
  // Boxed so a thrown `undefined` is still distinguishable from "no throw".
  let lastError: { error: unknown } | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastError = null
    try {
      lastRes = await doFetch()
      if (!isRetryableStatus(lastRes.status)) return lastRes
    } catch (error) {
      // A transport-level failure (DNS, socket, TLS) is as transient as a 5xx.
      lastRes = null
      lastError = { error }
    }

    if (attempt >= maxAttempts) break

    const retryAfter = lastRes ? parseRetryAfter(lastRes, now) : null
    const delay = retryAfter ?? exponentialDelay(attempt, baseDelayMs, random)
    await sleep(Math.min(delay, maxDelayMs))
  }

  // Exhausted: hand the caller the real response so it can classify (401 →
  // auth failure, 429 → still throttled). Only a transport failure throws.
  if (lastRes) return lastRes
  if (lastError) throw lastError.error
  throw new Error('fetchWithRetry: maxAttempts must be at least 1')
}
