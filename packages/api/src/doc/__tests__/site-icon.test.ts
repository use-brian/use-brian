/**
 * [COMP:api/site-icon-fetch] Site-icon fetcher — resolution order + guards.
 *
 * Drives `fetchSiteIconImage` against a fake fetch. Pins:
 *   - domain normalization (bare `example.com` → https)
 *   - candidate preference: apple-touch-icon > rel icon > og:image > /favicon.ico
 *   - the direct-image-URL input case
 *   - SSRF rejects (literal private IPs; a redirect hop into one)
 *   - content-type allowlist (html/svg icon candidates skipped) + size cap
 */

import { describe, expect, it } from 'vitest'
import {
  extractIconCandidates,
  fetchSiteIconImage as fetchSiteIconImageReal,
  normalizeSiteInput,
  MAX_ICON_BYTES,
  type BytesFetchFn,
} from '../site-icon.js'
import { validateUrl } from '../../routes/doc-og.js'

// The DNS-aware default validator would hit real DNS from tests; the sync
// half (`validateUrl`) covers everything these tests exercise — scheme,
// hostname blocklist, literal private IPs.
const fetchSiteIconImage = (input: string, fetchFn: BytesFetchFn) =>
  fetchSiteIconImageReal(input, fetchFn, validateUrl)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

type FakeResponse = {
  status?: number
  contentType?: string
  body?: Buffer | string
  location?: string
  contentLength?: string
}

/** Build a BytesFetchFn from a url → response table. Unknown URL → 404. */
function fakeFetch(table: Record<string, FakeResponse>): BytesFetchFn {
  return async (input) => {
    const spec = table[input]
    if (!spec) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }
    const status = spec.status ?? 200
    const body =
      typeof spec.body === 'string' ? Buffer.from(spec.body) : (spec.body ?? Buffer.alloc(0))
    const headers: Record<string, string> = {}
    if (spec.contentType) headers['content-type'] = spec.contentType
    if (spec.location) headers['location'] = spec.location
    if (spec.contentLength) headers['content-length'] = spec.contentLength
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string): string | null => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    }
  }
}

describe('[COMP:api/site-icon-fetch] site icon fetcher', () => {
  it('normalizes bare domains to https', () => {
    expect(normalizeSiteInput('theground.io')).toBe('https://theground.io')
    expect(normalizeSiteInput('  http://a.com ')).toBe('http://a.com')
  })

  it('orders candidates apple-touch-icon > icon > og:image > /favicon.ico', () => {
    const html = `
      <head>
        <link rel="icon" href="/fav32.ico">
        <meta property="og:image" content="https://cdn.example.com/banner.png">
        <link rel="apple-touch-icon" href="/touch.png">
      </head>`
    expect(extractIconCandidates(html, new URL('https://example.com/'))).toEqual([
      'https://example.com/touch.png',
      'https://example.com/fav32.ico',
      'https://cdn.example.com/banner.png',
      'https://example.com/favicon.ico',
    ])
  })

  it('fetches the apple-touch-icon from an HTML page', async () => {
    const fetchFn = fakeFetch({
      'https://example.com/': {
        contentType: 'text/html; charset=utf-8',
        body: '<link rel="apple-touch-icon" href="/touch.png">',
      },
      'https://example.com/touch.png': { contentType: 'image/png', body: PNG },
    })
    const result = await fetchSiteIconImage('example.com', fetchFn)
    expect(result).toMatchObject({
      ok: true,
      mime: 'image/png',
      ext: 'png',
      sourceUrl: 'https://example.com/touch.png',
    })
  })

  it('falls through a dead candidate to /favicon.ico', async () => {
    const fetchFn = fakeFetch({
      'https://example.com/': {
        contentType: 'text/html',
        body: '<link rel="apple-touch-icon" href="/gone.png">',
      },
      'https://example.com/favicon.ico': {
        contentType: 'image/x-icon',
        body: PNG,
      },
    })
    const result = await fetchSiteIconImage('example.com', fetchFn)
    expect(result).toMatchObject({ ok: true, ext: 'ico', mime: 'image/x-icon' })
  })

  it('uses a direct image URL as-is', async () => {
    const fetchFn = fakeFetch({
      'https://cdn.example.com/logo.webp': { contentType: 'image/webp', body: PNG },
    })
    const result = await fetchSiteIconImage('https://cdn.example.com/logo.webp', fetchFn)
    expect(result).toMatchObject({ ok: true, mime: 'image/webp', ext: 'webp' })
  })

  it('rejects private-IP and non-http inputs without fetching', async () => {
    let called = 0
    const fetchFn: BytesFetchFn = async () => {
      called++
      throw new Error('must not fetch')
    }
    for (const bad of ['127.0.0.1', 'http://169.254.169.254/meta', 'localhost']) {
      const result = await fetchSiteIconImage(bad, fetchFn)
      expect(result).toEqual({ ok: false, error: 'invalid_url' })
    }
    expect(called).toBe(0)
  })

  it('drops a redirect hop that lands on a private IP', async () => {
    const fetchFn = fakeFetch({
      'https://example.com/': {
        status: 302,
        location: 'http://169.254.169.254/latest/meta-data',
      },
    })
    const result = await fetchSiteIconImage('example.com', fetchFn)
    expect(result).toEqual({ ok: false, error: 'fetch_failed' })
  })

  it('skips svg and oversized candidates', async () => {
    const fetchFn = fakeFetch({
      'https://example.com/': {
        contentType: 'text/html',
        body: '<link rel="apple-touch-icon" href="/logo.svg"><link rel="icon" href="/big.png">',
      },
      'https://example.com/logo.svg': {
        contentType: 'image/svg+xml',
        body: '<svg/>',
      },
      'https://example.com/big.png': {
        contentType: 'image/png',
        body: PNG,
        contentLength: String(MAX_ICON_BYTES + 1),
      },
      'https://example.com/favicon.ico': {
        contentType: 'image/vnd.microsoft.icon',
        body: PNG,
      },
    })
    const result = await fetchSiteIconImage('example.com', fetchFn)
    expect(result).toMatchObject({
      ok: true,
      ext: 'ico',
      sourceUrl: 'https://example.com/favicon.ico',
    })
  })

  it('reports no_icon_found when nothing image-shaped exists', async () => {
    const fetchFn = fakeFetch({
      'https://example.com/': { contentType: 'text/html', body: '<p>hi</p>' },
    })
    const result = await fetchSiteIconImage('example.com', fetchFn)
    expect(result).toEqual({ ok: false, error: 'no_icon_found' })
  })
})
