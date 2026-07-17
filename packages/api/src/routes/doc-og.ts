/**
 * Doc OG-tag fetch endpoint — backs the bookmark block's rich card.
 *
 *   POST /api/doc/og-preview     body: { url }
 *     → { url, title?, description?, image?, siteName?, favicon?, fetchedAt }
 *     → { error: 'invalid_url' | 'fetch_failed' | 'timeout' } on failure
 *
 * Mounted behind `requireAuth` in `apps/api/src/index.ts`. Authenticated
 * because each call performs an outbound HTTP fetch; gating on JWT
 * userId gives us a per-user rate-limit key.
 *
 * Cache: a process-local TTL `Map` keyed by `sha256(url)`. 24h TTL.
 * Production-wise this is correct for a single-instance Cloud Run
 * deployment (the same one the SWR insights cache already runs in —
 * see `packages/api/src/feed/insights-cache.ts`). When the platform
 * scales horizontally this needs a Redis adapter; the cache interface
 * (`get(key)` / `set(key, value)`) is small enough that the swap-in
 * is straightforward. See TODO inline.
 *
 * Parser: pure regex over the raw HTML. OG tags are well-structured;
 * pulling in `cheerio`/`linkedom` for a v1 endpoint that extracts six
 * fields is overkill and adds an extra dependency to `packages/api`.
 *
 * Rate limit: 30 calls / 60s per user via `createRateLimiter` from
 * `@sidanclaw/core`. Keyed by `req.userId` (set by `requireAuth`).
 *
 * Component tag: [COMP:api/doc-og-fetch].
 * Spec: docs/plans/doc-v1-execution.md → Phase 2 Bookmark block.
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { isIP, isIPv4, isIPv6 } from 'node:net'
import { promisify } from 'node:util'
import { createRateLimiter } from '@sidanclaw/core'

const dnsLookupAsync = promisify(dnsLookup)

// ── Types ──────────────────────────────────────────────────────

export type OgPreviewResponse = {
  url: string
  title?: string
  description?: string
  image?: string
  siteName?: string
  favicon?: string
  fetchedAt: string
}

export type OgFetchResult =
  | { ok: true; value: OgPreviewResponse }
  | { ok: false; error: 'invalid_url' | 'fetch_failed' | 'timeout' }

// ── Cache (in-memory; TODO: swap to Redis for multi-instance) ──

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const CACHE_MAX_ENTRIES = 5_000

type CacheEntry = { value: OgPreviewResponse; storedAt: number }

/**
 * Process-local TTL cache for OG previews.
 *
 * TODO(redis): replace this with a `RedisCache` adapter when sidanclaw-api
 * scales beyond a single Cloud Run instance. The same in-memory shape
 * is used by `feed/insights-cache.ts`; a future shared cache abstraction
 * should cover both.
 */
class OgPreviewCache {
  private map = new Map<string, CacheEntry>()
  private now: () => number
  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now
  }
  get(key: string): OgPreviewResponse | null {
    const entry = this.map.get(key)
    if (!entry) return null
    if (this.now() - entry.storedAt > CACHE_TTL_MS) {
      this.map.delete(key)
      return null
    }
    return entry.value
  }
  set(key: string, value: OgPreviewResponse): void {
    if (this.map.size >= CACHE_MAX_ENTRIES && !this.map.has(key)) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.delete(key)
    this.map.set(key, { value, storedAt: this.now() })
  }
  clear(): void {
    this.map.clear()
  }
  size(): number {
    return this.map.size
  }
}

const cacheKey = (url: string) =>
  'doc:og:' + createHash('sha256').update(url).digest('hex')

// ── URL validation ─────────────────────────────────────────────

const RequestBody = z
  .object({
    url: z.string().min(1).max(2048),
  })
  .strict()

// ── SSRF defenses ──────────────────────────────────────────────
//
// User-supplied URLs are fetched server-side, so we must reject:
//   - loopback (127/8, ::1)
//   - link-local (169.254/16, fe80::/10)  ← includes 169.254.169.254 cloud metadata
//   - RFC1918 private (10/8, 172.16-31/12, 192.168/16)
//   - unique-local IPv6 (fc00::/7)
//   - unspecified (0.0.0.0, ::)
//   - broadcast/multicast (224.0.0.0/4, 240/4, ff00::/8)
//   - well-known internal hostnames (localhost, metadata.*)
//
// Validation runs *after* DNS resolution because public hostnames can be
// pointed at private IPs. We resolve via dns.lookup({ all: true }) and
// reject if ANY resolved address falls in a blocked range.
//
// Known v2 follow-up: DNS rebinding. The window between our resolve-and-validate
// step and the actual fetch lets an attacker re-point the hostname to an
// internal IP. The proper defense is an undici Agent with a custom
// `connect.lookup` that returns the IP we already validated. Adds undici
// Agent setup complexity; documented here, deferred to Phase 2 v2 polish.
//
// Redirects are followed manually with re-validation at each hop, capped at
// 3 hops (see followRedirects in fetchAndParse). Native fetch's
// `redirect: 'follow'` bypasses our validation — never use it here.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.internal',
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata.azure.internal',
])

function isPrivateIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const parts = ip.split('.').map(Number)
  const [a, b] = parts
  if (a === 0) return true                       // 0.0.0.0/8 unspecified
  if (a === 10) return true                      // 10/8 RFC1918
  if (a === 127) return true                     // 127/8 loopback
  if (a === 169 && b === 254) return true        // 169.254/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16-31/12 RFC1918
  if (a === 192 && b === 0) return true          // 192.0.0/24 IETF
  if (a === 192 && b === 168) return true        // 192.168/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 benchmarking
  if (a >= 224 && a <= 239) return true          // 224-239 multicast
  if (a >= 240) return true                      // 240+ reserved (incl. 255.255.255.255 broadcast)
  return false
}

function isPrivateIPv6(ip: string): boolean {
  if (!isIPv6(ip)) return false
  const lower = ip.toLowerCase()
  if (lower === '::1') return true                // loopback
  if (lower === '::') return true                 // unspecified
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true  // fc00::/7 unique-local
  if (/^ff[0-9a-f]{2}:/i.test(lower)) return true     // ff00::/8 multicast
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — check the embedded v4
  const v4Mapped = lower.match(/^::ffff:([0-9.]+)$/)
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1])
  // IPv4-in-IPv6 with hex form
  const v4Hex = lower.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/i)
  if (v4Hex) {
    const high = parseInt(v4Hex[1], 16)
    const low = parseInt(v4Hex[2], 16)
    const a = (high >> 8) & 0xff
    const b = high & 0xff
    const c = (low >> 8) & 0xff
    const d = low & 0xff
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`)
  }
  return false
}

function isPrivateIP(ip: string): boolean {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip)
}

/**
 * Sync URL shape validation (protocol + hostname presence + literal-IP block).
 * Used as a cheap pre-check. DNS-aware validation happens in validateUrlAsync.
 */
export function validateUrl(raw: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(hostname)) return null
  // Literal IP — validate immediately (no DNS needed)
  if (isIP(hostname) !== 0) {
    if (isPrivateIP(hostname)) return null
  }
  return parsed
}

/**
 * Full validation: sync checks + DNS resolution + per-address private-range check.
 * Returns null if the URL is malformed, the hostname is blocked, or ANY resolved
 * IP falls in a private/loopback/link-local/multicast/reserved range.
 *
 * DNS rebinding caveat: between this resolve and the subsequent fetch, an
 * attacker controlling the hostname's authoritative DNS can swap the IP for
 * an internal one. Phase 2 v2 will pin the validated IP via an undici Agent
 * custom `connect.lookup`. See SSRF defenses header comment.
 */
export async function validateUrlAsync(raw: string): Promise<URL | null> {
  const parsed = validateUrl(raw)
  if (!parsed) return null

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // Literal IPs already validated by validateUrl; no DNS needed.
  if (isIP(hostname) !== 0) return parsed

  try {
    const addrs = await dnsLookupAsync(hostname, { all: true })
    if (addrs.length === 0) return null
    for (const { address } of addrs) {
      if (isPrivateIP(address)) return null
    }
  } catch {
    return null
  }
  return parsed
}

// ── HTML parsing (regex-only — see header comment) ─────────────

/**
 * Extract the first match group from a list of regex patterns.
 * Stops at the first hit, so caller patterns should be ordered by
 * specificity / preference.
 */
export function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(html)
    if (m && m[1]) {
      return decodeEntities(m[1].trim()) || undefined
    }
  }
  return undefined
}

// Minimal HTML entity decode for the handful that appear in og:* values.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

/**
 * Tag-name-then-attribute and attribute-then-tag-name orderings both
 * appear in real OG markup; the patterns below cover both shapes.
 * `[^>]*?` between attributes tolerates other attributes interleaved
 * (e.g. `<meta property="og:title" content="…" data-foo="bar">`).
 */
export function metaPatterns(propName: string, attr: 'property' | 'name'): RegExp[] {
  const p = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    new RegExp(
      `<meta[^>]+${attr}=["']${p}["'][^>]*?content=["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*?${attr}=["']${p}["']`,
      'i',
    ),
  ]
}

export function linkRelPatterns(rels: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const rel of rels) {
    const r = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out.push(
      new RegExp(`<link[^>]+rel=["']${r}["'][^>]*?href=["']([^"']*)["']`, 'i'),
      new RegExp(`<link[^>]+href=["']([^"']*)["'][^>]*?rel=["']${r}["']`, 'i'),
    )
  }
  return out
}

const TITLE_PATTERN = /<title[^>]*>([^<]*)<\/title>/i

/** Resolve a possibly-relative URL against the page's base URL. */
export function resolveUrl(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, base).toString()
  } catch {
    return undefined
  }
}

export function parseOgTags(html: string, pageUrl: URL): Omit<OgPreviewResponse, 'fetchedAt'> {
  const title =
    firstMatch(html, metaPatterns('og:title', 'property')) ??
    firstMatch(html, [TITLE_PATTERN]) ??
    undefined

  const description =
    firstMatch(html, metaPatterns('og:description', 'property')) ??
    firstMatch(html, metaPatterns('description', 'name')) ??
    undefined

  const siteName = firstMatch(html, metaPatterns('og:site_name', 'property'))

  const rawImage = firstMatch(html, metaPatterns('og:image', 'property'))
  const image = resolveUrl(rawImage, pageUrl)

  const rawFavicon = firstMatch(
    html,
    linkRelPatterns(['icon', 'shortcut icon', 'apple-touch-icon']),
  )
  const favicon =
    resolveUrl(rawFavicon, pageUrl) ??
    new URL('/favicon.ico', pageUrl).toString()

  const out: Omit<OgPreviewResponse, 'fetchedAt'> = { url: pageUrl.toString() }
  if (title !== undefined) out.title = title
  if (description !== undefined) out.description = description
  if (image !== undefined) out.image = image
  if (siteName !== undefined) out.siteName = siteName
  if (favicon !== undefined) out.favicon = favicon
  return out
}

// ── Fetcher ────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5_000
const MAX_HTML_BYTES = 512 * 1024 // 512 KB — enough for <head>

export type FetchHeaders = { get: (k: string) => string | null }

export type FetchFn = (
  input: string,
  init?: {
    signal?: AbortSignal
    headers?: Record<string, string>
    /** SSRF defense: callers MUST pass 'manual' so we control redirects + re-validate each hop. */
    redirect?: 'follow' | 'manual' | 'error'
  },
) => Promise<{
  ok: boolean
  status: number
  headers: FetchHeaders | Headers
  text: () => Promise<string>
}>

const MAX_REDIRECT_HOPS = 3

async function fetchOneHop(
  url: URL,
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<FetchFn>> | { __error: 'timeout' | 'fetch_failed' }> {
  try {
    return await fetchFn(url.toString(), {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'sidanclaw-doc-og/1.0',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    })
  } catch (err: unknown) {
    const name = (err as { name?: string } | null)?.name
    if (name === 'AbortError' || name === 'TimeoutError') return { __error: 'timeout' }
    return { __error: 'fetch_failed' }
  }
}

async function fetchAndParse(
  parsed: URL,
  fetchFn: FetchFn,
): Promise<OgFetchResult> {
  let signal: AbortSignal
  try {
    signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  } catch {
    // Older Node (<17.3) — fall back to a manual AbortController.
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS).unref?.()
    signal = ctrl.signal
  }

  // SSRF: follow redirects manually so we can re-validate each hop.
  // Native `redirect: 'follow'` would bypass our private-IP/hostname blocklist.
  let currentUrl = parsed
  let response: Awaited<ReturnType<FetchFn>> | undefined
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const r = await fetchOneHop(currentUrl, fetchFn, signal)
    if ('__error' in r) return { ok: false, error: r.__error }

    // 3xx — read Location, re-validate, recurse.
    if (r.status >= 300 && r.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) return { ok: false, error: 'fetch_failed' }
      const location = r.headers.get('location')
      if (!location) return { ok: false, error: 'fetch_failed' }
      let next: URL
      try {
        next = new URL(location, currentUrl)
      } catch {
        return { ok: false, error: 'fetch_failed' }
      }
      const reValidated = await validateUrlAsync(next.toString())
      if (!reValidated) return { ok: false, error: 'fetch_failed' }
      currentUrl = reValidated
      continue
    }

    response = r
    break
  }
  if (!response) return { ok: false, error: 'fetch_failed' }

  if (!response.ok) {
    // 4xx / 5xx — return an empty-meta success response so the
    // bookmark still renders with just the URL.
    return {
      ok: true,
      value: { url: currentUrl.toString(), fetchedAt: new Date().toISOString() },
    }
  }

  let html: string
  try {
    html = await response.text()
  } catch {
    return { ok: false, error: 'fetch_failed' }
  }
  if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)

  const parsedOg = parseOgTags(html, currentUrl)
  return {
    ok: true,
    value: { ...parsedOg, fetchedAt: new Date().toISOString() },
  }
}

// ── Route factory ──────────────────────────────────────────────

export type DocOgRoutesOptions = {
  /** Override for tests — defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn
  /** Override for tests — defaults to a per-process `OgPreviewCache`. */
  cache?: OgPreviewCache
  /** Override for tests — defaults to `createRateLimiter({ maxRequests: 30 })`. */
  rateLimiter?: ReturnType<typeof createRateLimiter>
}

/** Exposed for tests. */
export { OgPreviewCache }

export function docOgRoutes(opts: DocOgRoutesOptions = {}): Router {
  const router = Router()
  const cache = opts.cache ?? new OgPreviewCache()
  const fetchFn = opts.fetchFn ?? ((globalThis.fetch as unknown) as FetchFn)
  const rateLimiter =
    opts.rateLimiter ?? createRateLimiter({ maxRequests: 30, windowMs: 60_000 })

  router.post('/og-preview', async (req: Request, res: Response) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    if (!rateLimiter.check(`u:${userId}`)) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }

    const parsedBody = RequestBody.safeParse(req.body)
    if (!parsedBody.success) {
      res.status(400).json({ error: 'invalid_url' })
      return
    }
    const parsedUrl = await validateUrlAsync(parsedBody.data.url)
    if (!parsedUrl) {
      res.status(400).json({ error: 'invalid_url' })
      return
    }

    const key = cacheKey(parsedUrl.toString())
    const cached = cache.get(key)
    if (cached) {
      res.json(cached)
      return
    }

    let result: OgFetchResult
    try {
      result = await fetchAndParse(parsedUrl, fetchFn)
    } catch (err) {
      console.error('[doc-og] unexpected error:', err)
      res.status(502).json({ error: 'fetch_failed' })
      return
    }

    if (!result.ok) {
      const status = result.error === 'timeout' ? 504 : 502
      res.status(status).json({ error: result.error })
      return
    }

    cache.set(key, result.value)
    res.json(result.value)
  })

  return router
}
