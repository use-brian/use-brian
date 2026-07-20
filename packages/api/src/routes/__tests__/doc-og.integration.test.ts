import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import {
  docOgRoutes,
  OgPreviewCache,
  parseOgTags,
  type FetchFn,
} from '../doc-og.js'
import { createRateLimiter } from '@use-brian/core'

/** Build a stub fetch that returns a fixed HTML body + status. */
function htmlFetch(html: string, status = 200): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  })) as unknown as FetchFn
}

function timeoutFetch(): FetchFn {
  return vi.fn(async () => {
    const err = new Error('aborted') as Error & { name: string }
    err.name = 'TimeoutError'
    throw err
  }) as unknown as FetchFn
}

function networkErrorFetch(): FetchFn {
  return vi.fn(async () => {
    throw new Error('ENOTFOUND')
  }) as unknown as FetchFn
}

describe('[COMP:api/doc-og-fetch] Doc OG preview route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // ── Happy path ───────────────────────────────────────────────

  it('fetches and parses a URL with rich OG tags', async () => {
    const html = `<!doctype html><html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Real OG title" />
      <meta property="og:description" content="Real OG description" />
      <meta property="og:image" content="https://example.com/img.png" />
      <meta property="og:site_name" content="Example" />
      <link rel="icon" href="/static/favicon.svg" />
    </head><body></body></html>`

    const fetchFn = htmlFetch(html)
    const cache = new OgPreviewCache()
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn, cache }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/page' })

    expect(res.status).toBe(200)
    expect(res.body.url).toBe('https://example.com/page')
    expect(res.body.title).toBe('Real OG title')
    expect(res.body.description).toBe('Real OG description')
    expect(res.body.image).toBe('https://example.com/img.png')
    expect(res.body.siteName).toBe('Example')
    expect(res.body.favicon).toBe('https://example.com/static/favicon.svg')
    expect(typeof res.body.fetchedAt).toBe('string')
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('falls back to <title> + name="description" + /favicon.ico when OG tags absent', async () => {
    const html = `<html><head>
      <title>Plain Title</title>
      <meta name="description" content="Plain description" />
    </head></html>`

    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn: htmlFetch(html), cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/' })

    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Plain Title')
    expect(res.body.description).toBe('Plain description')
    expect(res.body.image).toBeUndefined()
    expect(res.body.siteName).toBeUndefined()
    expect(res.body.favicon).toBe('https://example.com/favicon.ico')
  })

  it('resolves relative og:image and favicon URLs to absolute', async () => {
    const html = `<html><head>
      <meta property="og:image" content="/images/hero.jpg" />
      <link rel="shortcut icon" href="favicon.png" />
    </head></html>`

    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn: htmlFetch(html), cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/path/to/page' })

    expect(res.status).toBe(200)
    expect(res.body.image).toBe('https://example.com/images/hero.jpg')
    expect(res.body.favicon).toBe('https://example.com/path/to/favicon.png')
  })

  // ── Cache ────────────────────────────────────────────────────

  it('returns cached response on second call within TTL (no second fetch)', async () => {
    const html = `<html><head><meta property="og:title" content="Cached" /></head></html>`
    const fetchFn = htmlFetch(html)
    const cache = new OgPreviewCache()
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn, cache }),
      { userId: 'u_1' },
    )

    const first = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/cached' })
    expect(first.status).toBe(200)
    expect(first.body.title).toBe('Cached')

    const second = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/cached' })
    expect(second.status).toBe(200)
    expect(second.body.title).toBe('Cached')

    expect(
      (fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(1)
    expect(cache.size()).toBe(1)
  })

  // ── Validation ───────────────────────────────────────────────

  it('returns 400 invalid_url for a malformed URL', async () => {
    const fetchFn = htmlFetch('<html></html>')
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn, cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'not-a-real-url' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_url')
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('returns 400 invalid_url for a non-http(s) scheme', async () => {
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn: htmlFetch(''), cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'javascript:alert(1)' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_url')
  })

  it('returns 400 invalid_url for missing body field', async () => {
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn: htmlFetch(''), cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app).post('/api/doc/og-preview').send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_url')
  })

  // ── Network failures ─────────────────────────────────────────

  it('returns 504 timeout when fetch aborts on the configured deadline', async () => {
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn: timeoutFetch(), cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/slow' })

    expect(res.status).toBe(504)
    expect(res.body.error).toBe('timeout')
  })

  it('returns 502 fetch_failed on generic network errors', async () => {
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({
        fetchFn: networkErrorFetch(),
        cache: new OgPreviewCache(),
      }),
      { userId: 'u_1' },
    )

    // SSRF hardening rejects unresolvable hostnames (.invalid TLD never resolves)
    // at the validation layer. Use a public TEST-NET-3 IP literal instead so the
    // request reaches the mocked fetch and surfaces the network error path.
    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'http://203.0.113.1/' })

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('fetch_failed')
  })

  it('rejects unresolvable hostnames as invalid_url (SSRF hardening)', async () => {
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({
        fetchFn: networkErrorFetch(), // would 502 if it got that far
        cache: new OgPreviewCache(),
      }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://nope.example.invalid/' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_url')
  })

  it('rejects private IP literals (loopback, RFC1918, link-local) as invalid_url', async () => {
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({
        fetchFn: networkErrorFetch(),
        cache: new OgPreviewCache(),
      }),
      { userId: 'u_1' },
    )

    const blocked = [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/computeMetadata/v1/', // GCP metadata
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://localhost/',
      'http://metadata.google.internal/',
    ]
    for (const url of blocked) {
      const res = await request(app)
        .post('/api/doc/og-preview')
        .send({ url })
      expect(res.status, `expected 400 for ${url}`).toBe(400)
      expect(res.body.error).toBe('invalid_url')
    }
  })

  it('returns 200 with empty meta on upstream 404 (bookmark still renders)', async () => {
    const fetchFn: FetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    })) as unknown as FetchFn

    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn, cache: new OgPreviewCache() }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/missing' })

    expect(res.status).toBe(200)
    expect(res.body.url).toBe('https://example.com/missing')
    expect(res.body.title).toBeUndefined()
    expect(res.body.description).toBeUndefined()
    expect(res.body.image).toBeUndefined()
    expect(typeof res.body.fetchedAt).toBe('string')
  })

  // ── Auth + rate limit ────────────────────────────────────────

  it('returns 401 when the request is unauthenticated', async () => {
    const fetchFn = htmlFetch('<html></html>')
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn, cache: new OgPreviewCache() }),
      // no userId
    )

    const res = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/' })

    expect(res.status).toBe(401)
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('rate-limits at 30 calls / 60s per user', async () => {
    const fetchFn = htmlFetch('<html><head><title>x</title></head></html>')
    const rateLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 })
    const app = createTestApp(
      '/api/doc',
      docOgRoutes({ fetchFn, cache: new OgPreviewCache(), rateLimiter }),
      { userId: 'u_burst' },
    )

    let lastStatus = 0
    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .post('/api/doc/og-preview')
        .send({ url: `https://example.com/p${i}` })
      lastStatus = r.status
    }
    expect(lastStatus).toBe(200)

    const blocked = await request(app)
      .post('/api/doc/og-preview')
      .send({ url: 'https://example.com/p-blocked' })
    expect(blocked.status).toBe(429)
  })

  // ── Parser unit tests ────────────────────────────────────────

  it('parseOgTags tolerates attribute order and extra whitespace', () => {
    const html = `<meta content="Reversed Title"  property="og:title" >
      <meta data-x="1" property="og:description"  content="Reversed Desc">`
    const out = parseOgTags(html, new URL('https://example.com/'))
    expect(out.title).toBe('Reversed Title')
    expect(out.description).toBe('Reversed Desc')
  })

  it('parseOgTags decodes common HTML entities in extracted values', () => {
    const html = `<meta property="og:title" content="Foo &amp; Bar &#8211; Baz" />`
    const out = parseOgTags(html, new URL('https://example.com/'))
    expect(out.title).toBe('Foo & Bar – Baz')
  })
})
