import { describe, it, expect, vi } from 'vitest'
import {
  resolveShopifyDomain,
  parseMyshopifyFromLocation,
  type ShopifyDomainResolution,
} from '../resolve-domain.js'
import type { FetchFn } from '../../routes/doc-og.js'

// A fetch stub that returns a canned response per URL prefix. Headers are a
// plain Map wrapped in the { get } shape the resolver reads.
function stubFetch(
  routes: Record<string, { status: number; location?: string }>,
): { fn: FetchFn; calls: string[] } {
  const calls: string[] = []
  const fn: FetchFn = async (input) => {
    calls.push(input)
    const match = Object.keys(routes).find((k) => input.startsWith(k))
    const r = match ? routes[match] : { status: 404 }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => (k.toLowerCase() === 'location' ? r.location ?? null : null) },
      text: async () => '',
    }
  }
  return { fn, calls }
}

// Bypass DNS/SSRF in unit tests: accept every public-looking host, reject the
// couple we explicitly want blocked so the guard path stays covered.
const BLOCKED = new Set(['169.254.169.254', 'localhost', '10.0.0.5'])
const validate = async (raw: string): Promise<URL | null> => {
  try {
    const u = new URL(raw)
    return BLOCKED.has(u.hostname) ? null : u
  } catch {
    return null
  }
}

describe('[COMP:api/shopify-domain-resolve] Shopify branded-domain resolution', () => {
  describe('parseMyshopifyFromLocation', () => {
    const base = new URL('https://x.example/admin')

    it('reads the legacy {handle}.myshopify.com/admin redirect', () => {
      expect(parseMyshopifyFromLocation('https://gymsharkusa.myshopify.com/admin', base)).toBe(
        'gymsharkusa.myshopify.com',
      )
    })

    it('reads the newer admin.shopify.com/store/{handle} redirect', () => {
      expect(parseMyshopifyFromLocation('https://admin.shopify.com/store/coolstore', base)).toBe(
        'coolstore.myshopify.com',
      )
    })

    it('returns null for a non-shop redirect', () => {
      expect(parseMyshopifyFromLocation('https://www.example.com/login', base)).toBeNull()
      expect(parseMyshopifyFromLocation('not a url', base)).toBeNull()
    })
  })

  describe('resolveShopifyDomain — direct (no network)', () => {
    it('passes a full myshopify domain straight through', async () => {
      const { fn, calls } = stubFetch({})
      const r = await resolveShopifyDomain('mystore.myshopify.com', { fetchFn: fn, validate })
      expect(r).toEqual<ShopifyDomainResolution>({
        ok: true,
        shopDomain: 'mystore.myshopify.com',
        source: 'direct',
      })
      expect(calls).toHaveLength(0)
    })

    it('expands a bare handle to {handle}.myshopify.com', async () => {
      const { fn, calls } = stubFetch({})
      const r = await resolveShopifyDomain('gymshark', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: true, shopDomain: 'gymshark.myshopify.com', source: 'direct' })
      expect(calls).toHaveLength(0)
    })

    it('parses a pasted admin.shopify.com/store URL without probing', async () => {
      const { fn, calls } = stubFetch({})
      const r = await resolveShopifyDomain('https://admin.shopify.com/store/coolstore/products', {
        fetchFn: fn,
        validate,
      })
      expect(r).toEqual({ ok: true, shopDomain: 'coolstore.myshopify.com', source: 'direct' })
      expect(calls).toHaveLength(0)
    })
  })

  describe('resolveShopifyDomain — branded domain probe', () => {
    it('resolves a branded domain via the /admin 301 (handle != brand)', async () => {
      const { fn, calls } = stubFetch({
        'https://gymshark.com/admin': { status: 301, location: 'https://gymsharkusa.myshopify.com/admin' },
      })
      const r = await resolveShopifyDomain('gymshark.com', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: true, shopDomain: 'gymsharkusa.myshopify.com', source: 'redirect' })
      expect(calls).toEqual(['https://gymshark.com/admin'])
    })

    it('strips a pasted storefront path/scheme before probing', async () => {
      const { fn, calls } = stubFetch({
        'https://shop.brand.com/admin': { status: 302, location: 'https://brandhq.myshopify.com/admin' },
      })
      const r = await resolveShopifyDomain('https://shop.brand.com/collections/all', {
        fetchFn: fn,
        validate,
      })
      expect(r).toEqual({ ok: true, shopDomain: 'brandhq.myshopify.com', source: 'redirect' })
      expect(calls).toEqual(['https://shop.brand.com/admin'])
    })

    it('follows an intermediate non-shop redirect hop', async () => {
      const { fn, calls } = stubFetch({
        'https://brand.com/admin': { status: 301, location: 'https://www.brand.com/admin' },
        'https://www.brand.com/admin': { status: 301, location: 'https://thebrand.myshopify.com/admin' },
      })
      const r = await resolveShopifyDomain('brand.com', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: true, shopDomain: 'thebrand.myshopify.com', source: 'redirect' })
      expect(calls).toEqual(['https://brand.com/admin', 'https://www.brand.com/admin'])
    })

    it('resolves the newer admin.shopify.com/store redirect shape', async () => {
      const { fn } = stubFetch({
        'https://brand.com/admin': { status: 301, location: 'https://admin.shopify.com/store/thebrand' },
      })
      const r = await resolveShopifyDomain('brand.com', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: true, shopDomain: 'thebrand.myshopify.com', source: 'redirect' })
    })
  })

  describe('resolveShopifyDomain — non-resolvable / guarded', () => {
    it('returns not_shopify when /admin does not redirect to a shop (404)', async () => {
      const { fn } = stubFetch({ 'https://google.com/admin': { status: 404 } })
      const r = await resolveShopifyDomain('google.com', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: false, reason: 'not_shopify' })
    })

    it('returns not_shopify when a redirect points nowhere useful', async () => {
      const { fn } = stubFetch({
        'https://brand.com/admin': { status: 301, location: 'https://brand.com/password' },
      })
      const r = await resolveShopifyDomain('brand.com', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: false, reason: 'not_shopify' })
    })

    it('blocks a host the SSRF guard rejects (private IP / metadata)', async () => {
      const { fn, calls } = stubFetch({})
      const r = await resolveShopifyDomain('169.254.169.254', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: false, reason: 'blocked' })
      expect(calls).toHaveLength(0)
    })

    it('returns invalid_input for junk that is neither a handle nor a URL host', async () => {
      const { fn } = stubFetch({})
      const r = await resolveShopifyDomain('   ', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: false, reason: 'invalid_input' })
    })

    it('returns fetch_failed when the probe throws', async () => {
      const fn: FetchFn = vi.fn(async () => {
        throw Object.assign(new Error('boom'), { name: 'TypeError' })
      })
      const r = await resolveShopifyDomain('brand.com', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: false, reason: 'fetch_failed' })
    })

    it('stops after MAX_HOPS of chained non-shop redirects', async () => {
      // Every hop redirects to the next numbered host, never reaching a shop.
      const fn: FetchFn = async (input) => {
        const n = Number(new URL(input).hostname.match(/^h(\d+)\./)?.[1] ?? '0')
        return {
          ok: false,
          status: 301,
          headers: { get: (k: string) => (k.toLowerCase() === 'location' ? `https://h${n + 1}.example/admin` : null) },
          text: async () => '',
        }
      }
      const r = await resolveShopifyDomain('h0.example', { fetchFn: fn, validate })
      expect(r).toEqual({ ok: false, reason: 'not_shopify' })
    })
  })
})
