/**
 * Shopify branded-domain resolution.
 *
 * The OAuth authorize URL is per-shop and keyed on the canonical
 * `{handle}.myshopify.com` host — which merchants rarely know, because after
 * they point a branded domain (`shop.theirbrand.com`) at the store, that
 * permanent myshopify host is the one thing they never see. Asking them to
 * dig it out of Shopify admin → Settings → Domains is the friction this
 * removes.
 *
 * A Shopify storefront's `/admin` path 301-redirects to the store's admin on
 * the canonical host (`https://{handle}.myshopify.com/admin`, or the newer
 * `https://admin.shopify.com/store/{handle}`). Reading that redirect's
 * `Location` yields the handle without touching the storefront HTML (which
 * modern/Plus/Hydrogen themes no longer inline the domain into). Non-Shopify
 * hosts just 404, so a clean "not a store" fallback drops out for free.
 *
 * SSRF: the probe fetches a user-supplied host server-side, so every hop is
 * validated with the same private-range/DNS guard the doc OG-preview endpoint
 * uses (`validateUrlAsync` from `../routes/doc-og`), redirects are followed
 * manually (never `redirect: 'follow'`), the request is time-boxed, and a
 * result is only surfaced when the `Location` matches the myshopify allowlist.
 *
 * Component tag: [COMP:api/shopify-domain-resolve].
 * Spec: docs/architecture/integrations/shopify.md → "Branded-domain resolution".
 */

import { normalizeShopDomain } from './client.js'
import { validateUrlAsync, type FetchFn } from '../routes/doc-og.js'

const MYSHOPIFY_HOST_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const PROBE_TIMEOUT_MS = 5_000
const MAX_HOPS = 4

export type ShopifyDomainResolution =
  | { ok: true; shopDomain: string; source: 'direct' | 'redirect' }
  | { ok: false; reason: 'invalid_input' | 'blocked' | 'not_shopify' | 'fetch_failed' }

/**
 * Pull a canonical `{handle}.myshopify.com` out of a redirect `Location`, or
 * null when it isn't a shop admin redirect. Handles both admin URL shapes:
 * the legacy `{handle}.myshopify.com/admin` and the newer
 * `admin.shopify.com/store/{handle}`.
 */
export function parseMyshopifyFromLocation(location: string, base: URL): string | null {
  let u: URL
  try {
    u = new URL(location, base)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (MYSHOPIFY_HOST_RE.test(host)) return host
  if (host === 'admin.shopify.com') {
    const m = u.pathname.match(/^\/store\/([a-z0-9][a-z0-9-]*)/i)
    if (m) return `${m[1].toLowerCase()}.myshopify.com`
  }
  return null
}

/** Parse arbitrary input into a URL (defaulting to https://), or null. */
function toUrlOrNull(input: string): URL | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
}

/** Build the `https://<host>/admin` probe URL from arbitrary user input, or null. */
function toProbeUrl(input: string): URL | null {
  const u = toUrlOrNull(input)
  if (!u) return null
  // Force scheme + path; drop any user-supplied path/query/fragment.
  u.protocol = 'https:'
  u.pathname = '/admin'
  u.search = ''
  u.hash = ''
  return u
}

/**
 * Resolve arbitrary store-domain input to a canonical `{handle}.myshopify.com`.
 *
 * `source: 'direct'` when the input already normalizes (a myshopify domain, a
 * bare handle, or a pasted admin URL — no network). `source: 'redirect'` when
 * a branded domain was resolved via the `/admin` probe.
 *
 * `fetchFn`/`validate` are injectable test seams; they default to the global
 * fetch and the doc-og SSRF validator.
 */
export async function resolveShopifyDomain(
  input: string,
  opts: { fetchFn?: FetchFn; validate?: (raw: string) => Promise<URL | null> } = {},
): Promise<ShopifyDomainResolution> {
  // 1. Direct — already a myshopify domain / bare handle.
  const direct = normalizeShopDomain(input)
  if (direct) return { ok: true, shopDomain: direct, source: 'direct' }

  // 1b. A pasted admin URL (`admin.shopify.com/store/<handle>`) that
  // normalizeShopDomain declines — the handle is right there, no probe needed.
  const asUrl = toUrlOrNull(input)
  if (asUrl) {
    const fromUrl = parseMyshopifyFromLocation(asUrl.toString(), asUrl)
    if (fromUrl) return { ok: true, shopDomain: fromUrl, source: 'direct' }
  }

  // 2. Branded domain — probe /admin and read the redirect to the shop host.
  const probe = toProbeUrl(input)
  if (!probe) return { ok: false, reason: 'invalid_input' }

  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn)
  const validate = opts.validate ?? validateUrlAsync

  // SSRF: DNS-resolved private-range block before the first fetch.
  let current = await validate(probe.toString())
  if (!current) return { ok: false, reason: 'blocked' }

  let signal: AbortSignal
  try {
    signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  } catch {
    const c = new AbortController()
    setTimeout(() => c.abort(), PROBE_TIMEOUT_MS).unref?.()
    signal = c.signal
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let resp: Awaited<ReturnType<FetchFn>>
    try {
      resp = await fetchFn(current.toString(), {
        signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'usebrian-shopify-resolve/1.0',
          Accept: 'text/html,*/*;q=0.5',
        },
      })
    } catch {
      return { ok: false, reason: 'fetch_failed' }
    }

    // Only the redirect carries the shop identity we want.
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) return { ok: false, reason: 'not_shopify' }
      const handle = parseMyshopifyFromLocation(location, current)
      if (handle) return { ok: true, shopDomain: handle, source: 'redirect' }
      // Intermediate hop to another non-shopify host — re-validate (SSRF) and follow.
      let nextRaw: string
      try {
        nextRaw = new URL(location, current).toString()
      } catch {
        return { ok: false, reason: 'not_shopify' }
      }
      const next = await validate(nextRaw)
      if (!next) return { ok: false, reason: 'not_shopify' }
      current = next
      continue
    }

    // 2xx / 4xx / 5xx with no shop redirect → not a resolvable Shopify storefront.
    return { ok: false, reason: 'not_shopify' }
  }
  return { ok: false, reason: 'not_shopify' }
}
