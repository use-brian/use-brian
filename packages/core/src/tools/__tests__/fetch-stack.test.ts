import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFetchStack, type FetchProvider, type FetchResult } from '../base/fetch-stack.js'
import { isSensitiveUrl, jinaProvider } from '../base/fetch-jina.js'
import { __resetFetchCache } from '../base/fetch-cache.js'

// ── Helpers ─────────────────────────────────────────────────────

function mockProvider(
  name: FetchResult['source'],
  opts: { canHandle?: boolean; result?: FetchResult | null; throws?: Error } = {},
): FetchProvider {
  return {
    name,
    canHandle: () => opts.canHandle ?? true,
    fetch: async (url) => {
      if (opts.throws) throw opts.throws
      if (opts.result === null) return null
      return opts.result ?? { url, content: `content-${name}`, length: 9, source: name }
    },
  }
}

// ── Stack composer tests ────────────────────────────────────────

describe('[COMP:tools/fetch] Fetch stack composer', () => {
  beforeEach(() => __resetFetchCache())

  it('returns the first provider that produces non-empty content', async () => {
    const stack = createFetchStack({
      providers: [
        mockProvider('readability', { result: null }),
        mockProvider('jina', { result: { url: 'u', content: 'hello', length: 5, source: 'jina' } }),
        mockProvider('raw', { result: { url: 'u', content: 'never', length: 5, source: 'raw' } }),
      ],
      maxChars: 1000,
    })
    const out = await stack('https://example.com')
    expect(out.source).toBe('jina')
    expect(out.content).toBe('hello')
  })

  it('skips providers whose canHandle returns false', async () => {
    const stack = createFetchStack({
      providers: [
        mockProvider('readability', { canHandle: false, result: { url: 'u', content: 'skip', length: 4, source: 'readability' } }),
        mockProvider('raw', { result: { url: 'u', content: 'hit', length: 3, source: 'raw' } }),
      ],
      maxChars: 1000,
    })
    const out = await stack('https://example.com')
    expect(out.source).toBe('raw')
  })

  it('falls through on provider error', async () => {
    const stack = createFetchStack({
      providers: [
        mockProvider('readability', { throws: new Error('parse failed') }),
        mockProvider('jina', { result: { url: 'u', content: 'rescue', length: 6, source: 'jina' } }),
      ],
      maxChars: 1000,
    })
    const out = await stack('https://example.com')
    expect(out.source).toBe('jina')
  })

  it('throws when every provider fails', async () => {
    const stack = createFetchStack({
      providers: [
        mockProvider('readability', { throws: new Error('x') }),
        mockProvider('jina', { throws: new Error('y') }),
      ],
      maxChars: 1000,
    })
    await expect(stack('https://example.com')).rejects.toThrow(/y/)
  })

  it('truncates content to maxChars and adds a marker', async () => {
    const stack = createFetchStack({
      providers: [mockProvider('raw', { result: { url: 'u', content: 'a'.repeat(100), length: 100, source: 'raw' } })],
      maxChars: 20,
    })
    const out = await stack('https://example.com')
    expect(out.content).toContain('[Content truncated]')
    expect(out.length).toBe(20)
  })

  it('applies sanitizeDeep to content (strips invisible unicode)', async () => {
    const dirty = 'Fli\u200Bght details'
    const stack = createFetchStack({
      providers: [mockProvider('raw', { result: { url: 'u', content: dirty, length: dirty.length, source: 'raw' } })],
      maxChars: 1000,
    })
    const out = await stack('https://example.com')
    expect(out.content).toBe('Flight details')
  })

  it('cache hit short-circuits the provider stack on second call', async () => {
    let calls = 0
    const stack = createFetchStack({
      providers: [
        {
          name: 'raw',
          canHandle: () => true,
          fetch: async (url) => {
            calls++
            return { url, content: 'cached body', length: 11, source: 'raw' }
          },
        },
      ],
      maxChars: 1000,
    })
    await stack('https://example.com/article')
    const second = await stack('https://example.com/article')
    expect(calls).toBe(1)
    expect(second.source).toBe('cache')
    expect(second.content).toBe('cached body')
  })

  it('cache normalizes URLs (strips tracking params)', async () => {
    let calls = 0
    const stack = createFetchStack({
      providers: [
        {
          name: 'raw',
          canHandle: () => true,
          fetch: async (url) => {
            calls++
            return { url, content: 'body', length: 4, source: 'raw' }
          },
        },
      ],
      maxChars: 1000,
    })
    await stack('https://example.com/article?utm_source=twitter&utm_campaign=launch')
    const second = await stack('https://example.com/article')
    expect(calls).toBe(1)
    expect(second.source).toBe('cache')
  })
})

// ── Sensitive-URL bypass for Jina ───────────────────────────────

describe('[COMP:tools/fetch] Sensitive URL bypass (jina)', () => {
  it('skips URLs with token query parameters', () => {
    expect(isSensitiveUrl('https://example.com/share?token=abc123')).toBe(true)
    expect(isSensitiveUrl('https://example.com/share?access_token=xyz')).toBe(true)
    expect(isSensitiveUrl('https://example.com/page?auth=secret')).toBe(true)
    expect(isSensitiveUrl('https://example.com/api?api_key=hidden')).toBe(true)
  })

  it('skips URLs with fragment-embedded tokens (OAuth implicit)', () => {
    expect(isSensitiveUrl('https://example.com/callback#access_token=abc')).toBe(true)
    expect(isSensitiveUrl('https://example.com/cb#id_token=xyz')).toBe(true)
  })

  it('skips sensitive hostnames', () => {
    expect(isSensitiveUrl('https://user-workspace.notion.site/doc')).toBe(true)
    expect(isSensitiveUrl('https://mail.google.com/mail/u/0/#inbox')).toBe(true)
    expect(isSensitiveUrl('https://drive.google.com/file/d/abc')).toBe(true)
    expect(isSensitiveUrl('https://docs.google.com/document/d/xyz')).toBe(true)
  })

  it('skips private network / loopback hosts', () => {
    expect(isSensitiveUrl('http://localhost:8080/admin')).toBe(true)
    expect(isSensitiveUrl('http://127.0.0.1/api')).toBe(true)
    expect(isSensitiveUrl('http://10.0.0.5/internal')).toBe(true)
    expect(isSensitiveUrl('http://192.168.1.1/router')).toBe(true)
    expect(isSensitiveUrl('http://172.16.0.1/')).toBe(true)
    expect(isSensitiveUrl('https://wiki.internal/page')).toBe(true)
    expect(isSensitiveUrl('https://service.local/x')).toBe(true)
  })

  it('allows public commercial URLs', () => {
    expect(isSensitiveUrl('https://www.cathaypacific.com/cx/en_HK/book')).toBe(false)
    expect(isSensitiveUrl('https://www.kayak.com/flights/HKG-TPE')).toBe(false)
    expect(isSensitiveUrl('https://en.wikipedia.org/wiki/Taipei')).toBe(false)
  })

  it('jinaProvider.canHandle rejects sensitive URLs', () => {
    expect(jinaProvider.canHandle('https://www.cathaypacific.com')).toBe(true)
    expect(jinaProvider.canHandle('https://mail.google.com')).toBe(false)
    expect(jinaProvider.canHandle('https://example.com?token=abc')).toBe(false)
  })
})
