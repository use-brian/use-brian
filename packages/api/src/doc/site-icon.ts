/**
 * Site-icon fetcher — resolve a website's real icon/logo and hand back its
 * bytes, for the `fetchSiteIcon` doc tool (`./site-icon-tool.ts`) to store
 * as an image page icon (`img:<workspaceId>/<fileId>`, see
 * `@use-brian/shared` `page-icon.ts`).
 *
 * Input is a user/model-supplied string: a bare domain (`theground.io`),
 * a site URL, or a direct image URL (e.g. found via web search). The
 * resolution is DETERMINISTIC — no search provider involved:
 *
 *   1. Normalize (bare domain → `https://…`) and SSRF-validate.
 *   2. Fetch the target. If it answers with an image content-type, that IS
 *      the icon (the direct-image case).
 *   3. If it answers with HTML, extract icon candidates in preference
 *      order — `apple-touch-icon` (usually a ≥180px PNG) over `rel="icon"` /
 *      `shortcut icon` (often a 32px ICO) over `og:image` (usually a wide
 *      social banner — last resort) — plus the conventional `/favicon.ico`
 *      as the final fallback. Fetch each candidate until one yields a real
 *      image.
 *
 * Reuses the SSRF defenses from `../routes/doc-og.ts` (private-IP DNS
 * validation, manual redirect hops with per-hop re-validation) and its
 * link/meta extraction regexes. Every candidate fetch re-runs the full
 * validation — a page can point its `<link rel=icon>` anywhere.
 *
 * Caps: 5s per fetch, 3 redirect hops, 512KB of HTML, 3MB of image bytes.
 * Allowed image types: png / jpeg / webp / gif / ico. SVG is deliberately
 * excluded (scriptable format; not worth the audit surface for a v1 whose
 * only renderer is an `<img>` tag).
 *
 * Spec: docs/architecture/features/doc.md → "Image icons".
 *
 * [COMP:api/site-icon-fetch]
 */

import {
  firstMatch,
  linkRelPatterns,
  metaPatterns,
  resolveUrl,
  validateUrlAsync,
} from '../routes/doc-og.js'

const FETCH_TIMEOUT_MS = 5_000
const MAX_REDIRECT_HOPS = 3
const MAX_HTML_BYTES = 512 * 1024
export const MAX_ICON_BYTES = 3 * 1024 * 1024

/** Image content-types we accept as a page icon (no SVG — see header). */
const ALLOWED_IMAGE_TYPES = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
  ['image/ico', 'ico'],
])

export type SiteIconResult =
  | {
      ok: true
      bytes: Buffer
      mime: string
      /** Canonical extension for the stored file name. */
      ext: string
      /** The URL the bytes actually came from (post-redirect). */
      sourceUrl: string
    }
  | { ok: false; error: 'invalid_url' | 'no_icon_found' | 'fetch_failed' }

/**
 * Minimal fetch surface — native `fetch` compatible. Tests inject a fake.
 * Callers of the real fetch MUST keep `redirect: 'manual'` (SSRF: we follow
 * and re-validate each hop ourselves).
 */
export type BytesFetchFn = (
  input: string,
  init?: {
    signal?: AbortSignal
    headers?: Record<string, string>
    redirect?: 'follow' | 'manual' | 'error'
  },
) => Promise<{
  ok: boolean
  status: number
  headers: { get: (k: string) => string | null }
  arrayBuffer: () => Promise<ArrayBuffer>
}>

/** Bare domain / schemeless input → an https URL string. */
export function normalizeSiteInput(raw: string): string {
  const trimmed = raw.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * Extract icon-candidate URLs from a page's HTML, best-first. Relative
 * hrefs resolve against the (post-redirect) page URL; `/favicon.ico` rides
 * last as the conventional fallback every browser probes.
 */
export function extractIconCandidates(html: string, pageUrl: URL): string[] {
  const raw = [
    firstMatch(html, linkRelPatterns(['apple-touch-icon', 'apple-touch-icon-precomposed'])),
    firstMatch(html, linkRelPatterns(['icon', 'shortcut icon'])),
    firstMatch(html, metaPatterns('og:image', 'property')),
  ]
  const out: string[] = []
  for (const href of raw) {
    const abs = resolveUrl(href, pageUrl)
    if (abs && !out.includes(abs)) out.push(abs)
  }
  const favicon = new URL('/favicon.ico', pageUrl).toString()
  if (!out.includes(favicon)) out.push(favicon)
  return out
}

function timeoutSignal(): AbortSignal {
  try {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS)
  } catch {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS).unref?.()
    return ctrl.signal
  }
}

/**
 * Fetch one URL with manual, re-validated redirects. Returns the terminal
 * response + the URL it came from, or null on any failure (bad status,
 * timeout, SSRF-rejected hop). Shared by the HTML fetch and every image
 * candidate fetch.
 */
async function fetchGuarded(
  start: URL,
  fetchFn: BytesFetchFn,
  accept: string,
  validate: (raw: string) => Promise<URL | null> | URL | null,
): Promise<{ res: Awaited<ReturnType<BytesFetchFn>>; url: URL } | null> {
  const signal = timeoutSignal()
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res: Awaited<ReturnType<BytesFetchFn>>
    try {
      res = await fetchFn(current.toString(), {
        signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'sidanclaw-site-icon/1.0', Accept: accept },
      })
    } catch {
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) return null
      const location = res.headers.get('location')
      if (!location) return null
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return null
      }
      const revalidated = await validate(next.toString())
      if (!revalidated) return null
      current = revalidated
      continue
    }
    if (!res.ok) return null
    return { res, url: current }
  }
  return null
}

/** Content-type header → allowlisted mime + extension, or null. */
function allowedImageType(
  contentType: string | null,
): { mime: string; ext: string } | null {
  if (!contentType) return null
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const ext = ALLOWED_IMAGE_TYPES.get(mime)
  return ext ? { mime, ext } : null
}

async function readImage(
  hit: { res: Awaited<ReturnType<BytesFetchFn>>; url: URL },
): Promise<SiteIconResult | null> {
  const type = allowedImageType(hit.res.headers.get('content-type'))
  if (!type) return null
  const declared = Number(hit.res.headers.get('content-length') ?? '0')
  if (declared > MAX_ICON_BYTES) return null
  let buf: Buffer
  try {
    buf = Buffer.from(await hit.res.arrayBuffer())
  } catch {
    return null
  }
  if (buf.byteLength === 0 || buf.byteLength > MAX_ICON_BYTES) return null
  return {
    ok: true,
    bytes: buf,
    mime: type.mime,
    ext: type.ext,
    sourceUrl: hit.url.toString(),
  }
}

/**
 * Resolve + download a site's icon. See module header for the strategy.
 * `fetchFn` defaults to global fetch; tests inject a fake. `validate`
 * defaults to the DNS-aware SSRF validator; tests inject the sync-only
 * `validateUrl` so no test ever touches real DNS.
 */
export async function fetchSiteIconImage(
  input: string,
  fetchFn: BytesFetchFn = fetch as unknown as BytesFetchFn,
  validate: (raw: string) => Promise<URL | null> | URL | null = validateUrlAsync,
): Promise<SiteIconResult> {
  const normalized = normalizeSiteInput(input)
  const validated = await validate(normalized)
  if (!validated) return { ok: false, error: 'invalid_url' }

  const first = await fetchGuarded(
    validated,
    fetchFn,
    'text/html,image/*;q=0.9,*/*;q=0.8',
    validate,
  )
  if (!first) return { ok: false, error: 'fetch_failed' }

  // Direct image URL — the input itself is the icon.
  const direct = await readImage(first)
  if (direct) return direct

  // HTML page — walk the candidates best-first.
  const contentType = first.res.headers.get('content-type') ?? ''
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    return { ok: false, error: 'no_icon_found' }
  }
  let html: string
  try {
    html = Buffer.from(await first.res.arrayBuffer())
      .subarray(0, MAX_HTML_BYTES)
      .toString('utf8')
  } catch {
    return { ok: false, error: 'fetch_failed' }
  }

  for (const candidate of extractIconCandidates(html, first.url)) {
    const candidateUrl = await validate(candidate)
    if (!candidateUrl) continue
    const hit = await fetchGuarded(candidateUrl, fetchFn, 'image/*,*/*;q=0.8', validate)
    if (!hit) continue
    const image = await readImage(hit)
    if (image) return image
  }
  return { ok: false, error: 'no_icon_found' }
}
