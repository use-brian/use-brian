/**
 * Fetch / search provider failures with the HTTP status MEANING attached, and
 * the urlReader failure built from the whole attempt record.
 *
 * `urlReader` runs a stack of extractors (x-api → xai → readability → jina →
 * raw) and used to surface only the LAST one's bare `HTTP 403`. The model
 * then could not tell a login wall from a dead link from a rate limit, and
 * either retried the same URL or told the user the page "does not exist".
 * The search providers threw `Brave HTTP 429` / `Serper HTTP 403` the same
 * way, so the webSearch outage summary (which embeds those strings) said
 * nothing about quota vs bad key vs challenge page either.
 *
 * `FetchProviderError` / `SearchProviderError` carry the status and a
 * one-line meaning; `describeFetchFailure(url, attempts)` renders the whole
 * record — every extractor tried, what each hit, and ONE verdict derived from
 * the failure kinds ("use the webSearch snippet; do not retry this URL" for a
 * wall, "the URL is wrong or the page was removed" for a 404, "transient —
 * retry once" for 429 / 5xx / timeouts). Standard:
 * docs/architecture/engine/tool-executor.md → "Failure copy".
 *
 * Component tag: [COMP:tools/fetch-error].
 */

export type FetchFailureKind =
  | 'blocked'      // 401 / 403 / 451 / 999 — login wall, bot wall, geo / legal block
  | 'not_found'    // 404 / 410
  | 'rate_limit'   // 429
  | 'server'       // 5xx
  | 'timeout'      // aborted / timed out
  | 'network'      // DNS / connection failure
  | 'empty'        // 2xx but nothing readable
  | 'provider'     // the extractor service itself failed (Jina 4xx, X API misconfig)
  | 'other'

/** One line on what an HTTP status means for a page fetch. */
export function httpStatusMeaning(status: number): { kind: FetchFailureKind; meaning: string } {
  if (status === 401 || status === 403) return { kind: 'blocked', meaning: 'access denied — the page requires a login or blocks automated readers' }
  if (status === 999) return { kind: 'blocked', meaning: 'the site blocks automated readers (LinkedIn-style bot wall)' }
  if (status === 451) return { kind: 'blocked', meaning: 'unavailable for legal reasons in this region' }
  if (status === 404) return { kind: 'not_found', meaning: 'not found — the URL is wrong or the page was removed' }
  if (status === 410) return { kind: 'not_found', meaning: 'gone — the page was removed permanently' }
  if (status === 429) return { kind: 'rate_limit', meaning: 'rate limited — too many requests to this host right now' }
  if (status === 408 || status === 504) return { kind: 'timeout', meaning: 'the site timed out' }
  if (status >= 500) return { kind: 'server', meaning: "the site's server failed" }
  if (status === 402) return { kind: 'blocked', meaning: 'payment required — the page is paywalled' }
  if (status >= 400) return { kind: 'other', meaning: 'the site rejected the request' }
  return { kind: 'other', meaning: 'unexpected response' }
}

export class FetchProviderError extends Error {
  readonly provider: string
  readonly url: string
  readonly status?: number
  readonly kind: FetchFailureKind

  constructor(init: { provider: string; url: string; status?: number; kind?: FetchFailureKind; detail?: string; cause?: unknown }) {
    const meaning = init.status !== undefined ? httpStatusMeaning(init.status) : undefined
    const kind = init.kind ?? meaning?.kind ?? 'other'
    // `<provider>: HTTP <status> (<meaning>)` — the status stays first so
    // existing callers / tests that match `/HTTP 429/` keep working.
    const head = init.status !== undefined ? `HTTP ${init.status}` : init.detail ?? kind
    const tail = init.status !== undefined ? ` (${meaning!.meaning})` : ''
    const extra = init.status !== undefined && init.detail ? `: ${init.detail}` : ''
    super(`${init.provider}: ${head}${tail}${extra}`, init.cause !== undefined ? { cause: init.cause } : undefined)
    this.name = 'FetchProviderError'
    this.provider = init.provider
    this.url = init.url
    this.status = init.status
    this.kind = kind
  }
}

/** Classify any thrown extractor error (ours or a raw fetch failure). */
export function classifyFetchError(err: unknown): FetchFailureKind {
  if (err instanceof FetchProviderError) return err.kind
  const message = err instanceof Error ? err.message : String(err)
  const named = (err as { name?: unknown } | null)?.name
  if (named === 'AbortError' || named === 'TimeoutError' || /timed? ?out|aborted/i.test(message)) return 'timeout'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|fetch failed|socket hang up|UND_ERR/i.test(message)) return 'network'
  const m = /HTTP (\d{3})/.exec(message)
  if (m) return httpStatusMeaning(Number(m[1])).kind
  return 'other'
}

export type FetchAttempt = { provider: string; error: unknown }

/**
 * The urlReader failure: URL, every extractor tried with what it hit, and
 * one verdict. `attempts` is in stack order; providers that declined the URL
 * (`canHandle` false) or returned empty content are recorded by the stack
 * as `empty` so the model sees why the fallbacks did not help.
 */
export function describeFetchFailure(url: string, attempts: FetchAttempt[]): string {
  const lines = attempts.map((a) => {
    const message = a.error instanceof Error ? a.error.message : String(a.error)
    // FetchProviderError already leads with the provider name.
    return message.startsWith(`${a.provider}:`) ? message : `${a.provider}: ${message}`
  })
  const kinds = new Set(attempts.map((a) => classifyFetchError(a.error)))
  const only = (k: FetchFailureKind) => kinds.has(k) && [...kinds].every((x) => x === k || x === 'empty' || x === 'provider')

  let verdict: string
  if (attempts.length === 0) {
    verdict = 'No extractor accepted this URL (it is not an http(s) page this reader can fetch, or every extractor declined it). Do not retry with the same URL; use the webSearch snippet, or ask the user for a different link.'
  } else if (kinds.has('blocked') && !kinds.has('not_found') && !kinds.has('rate_limit') && !kinds.has('server') && !kinds.has('timeout') && !kinds.has('network')) {
    verdict = 'The page is behind a login / bot wall (or paywall) that an HTTP reader cannot pass. Do NOT retry this URL — no header or extractor will change the answer. Use the webSearch snippet and the URL itself in your reply, or ask the user to paste the content.'
  } else if (only('not_found')) {
    verdict = 'The URL is wrong or the page was removed. Do not retry it; find the current URL with webSearch (or ask the user), then read that.'
  } else if (only('empty')) {
    verdict = 'The page returned no readable text (rendered client-side, an image / binary, or an empty shell). Retrying will return the same nothing; use the webSearch snippet, or ask the user for a text version.'
  } else if (kinds.has('rate_limit') || kinds.has('server') || kinds.has('timeout') || kinds.has('network')) {
    verdict = 'This looks transient (rate limit / server error / timeout / network). Nothing about the URL is wrong: retry once after a short wait; if it fails again, use the webSearch snippet and tell the user the page could not be read right now.'
  } else {
    verdict = 'Retrying the same URL is unlikely to help; use the webSearch snippet, try a different URL for the same content, or ask the user.'
  }
  return `Could not read ${url}. Extractors tried: ${lines.join('; ')}. ${verdict}`
}

export class FetchStackExhaustedError extends Error {
  readonly url: string
  readonly attempts: FetchAttempt[]
  constructor(url: string, attempts: FetchAttempt[]) {
    super(describeFetchFailure(url, attempts))
    this.name = 'FetchStackExhaustedError'
    this.url = url
    this.attempts = attempts
  }
}

// ── Search providers ────────────────────────────────────────────────

export type SearchFailureKind = 'bad_key' | 'quota' | 'rate_limit' | 'challenge' | 'server' | 'other'

/**
 * Convert an HTTP Retry-After value (seconds or an HTTP date) to a bounded
 * delay. Providers are advisory here: callers still own their total-attempt
 * ceiling, and a surprising header can never stall a tool indefinitely.
 */
export function retryAfterMs(value: string | null | undefined, maxMs = 5_000): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), maxMs)
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return undefined
  return Math.min(Math.max(at - Date.now(), 0), maxMs)
}

/** What a non-2xx from a keyed search API means. */
export function searchStatusMeaning(provider: string, status: number): { kind: SearchFailureKind; meaning: string } {
  if (status === 401 || status === 403) return { kind: 'bad_key', meaning: `the ${provider} API key was rejected — invalid, revoked, or not enabled for this endpoint; a different query cannot fix it` }
  if (status === 402 || status === 429) return { kind: status === 402 ? 'quota' : 'rate_limit', meaning: status === 402 ? `the ${provider} plan quota is exhausted — no query will succeed until it resets or is topped up` : `${provider} rate limit hit — transient` }
  if (status >= 500) return { kind: 'server', meaning: `${provider} server error — transient` }
  return { kind: 'other', meaning: `${provider} rejected the request` }
}

const SEARCH_KIND_MEANING: Record<SearchFailureKind, (provider: string) => string> = {
  bad_key: (p) => `the ${p} API key was rejected — invalid, revoked, or not enabled for this endpoint; a different query cannot fix it`,
  quota: (p) => `the ${p} plan quota is exhausted — no query will succeed until it resets or is topped up`,
  rate_limit: (p) => `${p} rate limit hit — transient`,
  challenge: (p) => `${p} served a bot-detection challenge page instead of results — transient; another provider or a later retry works`,
  server: (p) => `${p} server error — transient`,
  other: (p) => `${p} rejected the request`,
}

export class SearchProviderError extends Error {
  readonly provider: string
  readonly status?: number
  readonly kind: SearchFailureKind
  readonly retryAfterMs?: number
  constructor(init: { provider: string; status?: number; kind?: SearchFailureKind; detail?: string; retryAfterMs?: number; cause?: unknown }) {
    const fromStatus = init.status !== undefined ? searchStatusMeaning(init.provider, init.status) : undefined
    const kind = init.kind ?? fromStatus?.kind ?? 'other'
    const meaning = init.kind ? SEARCH_KIND_MEANING[init.kind](init.provider) : fromStatus?.meaning
    // `<Provider> HTTP <status> (<meaning>)` — status first for existing
    // `/Brave HTTP 429/` matchers.
    const head = init.status !== undefined ? `${init.provider} HTTP ${init.status}` : `${init.provider}: ${init.detail ?? meaning ?? kind}`
    const tail = init.status !== undefined && meaning ? ` (${meaning})` : ''
    super(`${head}${tail}`, init.cause !== undefined ? { cause: init.cause } : undefined)
    this.name = 'SearchProviderError'
    this.provider = init.provider
    this.status = init.status
    this.kind = kind
    this.retryAfterMs = init.retryAfterMs
  }
}
