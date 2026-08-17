/**
 * [COMP:tools/fetch-error] — fetch / search provider failure copy: status
 * meanings, the whole-attempt-record urlReader failure, and the search
 * provider errors the webSearch outage summary embeds.
 */

import { describe, it, expect } from 'vitest'
import {
  FetchProviderError,
  FetchStackExhaustedError,
  SearchProviderError,
  classifyFetchError,
  describeFetchFailure,
  httpStatusMeaning,
  searchStatusMeaning,
} from '../_fetch-error.js'
import { createFetchStack, type FetchProvider } from '../fetch-stack.js'

const URL_ = 'https://example.com/article'

describe('[COMP:tools/fetch-error] FetchProviderError + status meanings', () => {
  it('keeps `HTTP <status>` first (existing matchers) and appends the meaning', () => {
    const err = new FetchProviderError({ provider: 'raw', url: URL_, status: 403 })
    expect(err.message).toBe('raw: HTTP 403 (access denied — the page requires a login or blocks automated readers)')
    expect(err.kind).toBe('blocked')
    expect(err.message).toMatch(/HTTP 403/)
    expect(httpStatusMeaning(404).kind).toBe('not_found')
    expect(httpStatusMeaning(429).kind).toBe('rate_limit')
    expect(httpStatusMeaning(503).kind).toBe('server')
    expect(httpStatusMeaning(999).kind).toBe('blocked')
  })

  it('classifies raw fetch failures too (timeouts, DNS, legacy HTTP messages)', () => {
    expect(classifyFetchError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe('timeout')
    expect(classifyFetchError(new TypeError('fetch failed'))).toBe('network')
    expect(classifyFetchError(new Error('Jina HTTP 502'))).toBe('server')
    expect(classifyFetchError(new Error('weird'))).toBe('other')
  })
})

describe('[COMP:tools/fetch-error] describeFetchFailure', () => {
  it('a login / bot wall → names every extractor + status, says do NOT retry, use the webSearch snippet', () => {
    const text = describeFetchFailure(URL_, [
      { provider: 'readability', error: new FetchProviderError({ provider: 'readability', url: URL_, status: 403 }) },
      { provider: 'jina', error: new FetchProviderError({ provider: 'jina', url: URL_, status: 451, detail: 'the target site refused Jina' }) },
      { provider: 'raw', error: new FetchProviderError({ provider: 'raw', url: URL_, status: 403 }) },
    ])
    expect(text).toContain(`Could not read ${URL_}. Extractors tried: readability: HTTP 403 (access denied`)
    expect(text).toContain('jina: HTTP 451')
    expect(text).toContain('raw: HTTP 403')
    expect(text).toContain('Do NOT retry this URL')
    expect(text).toContain('Use the webSearch snippet')
  })

  it('404 everywhere → the URL is wrong or removed; find the current one via webSearch', () => {
    const text = describeFetchFailure(URL_, [
      { provider: 'readability', error: new FetchProviderError({ provider: 'readability', url: URL_, status: 404 }) },
      { provider: 'raw', error: new FetchProviderError({ provider: 'raw', url: URL_, status: 404 }) },
    ])
    expect(text).toContain('The URL is wrong or the page was removed')
    expect(text).toContain('find the current URL with webSearch')
  })

  it('transient (429 / 5xx / timeout / network) → retry once', () => {
    const text = describeFetchFailure(URL_, [
      { provider: 'readability', error: new FetchProviderError({ provider: 'readability', url: URL_, status: 503 }) },
      { provider: 'raw', error: new TypeError('fetch failed') },
    ])
    expect(text).toContain('raw: fetch failed')
    expect(text).toContain('This looks transient')
    expect(text).toContain('retry once after a short wait')
  })

  it('every extractor returned nothing → empty page, retrying returns the same nothing', () => {
    const text = describeFetchFailure(URL_, [
      { provider: 'readability', error: new FetchProviderError({ provider: 'readability', url: URL_, kind: 'empty', detail: 'no readable content' }) },
      { provider: 'raw', error: new FetchProviderError({ provider: 'raw', url: URL_, kind: 'empty', detail: 'no readable content' }) },
    ])
    expect(text).toContain('readability: no readable content')
    expect(text).toContain('no readable text')
    expect(text).toContain('Retrying will return the same nothing')
  })

  it('no extractor accepted the URL → say so; a provider-side failure (Jina 4xx) is not a fact about the page', () => {
    expect(describeFetchFailure('ftp://x', [])).toContain('No extractor accepted this URL')
    const jina = new FetchProviderError({ provider: 'jina', url: URL_, status: 402, kind: 'provider', detail: 'the Jina reader service refused the request (key / quota), not the target site' })
    expect(jina.kind).toBe('provider')
    expect(jina.message).toContain('not the target site')
  })
})

describe('[COMP:tools/fetch-error] fetch stack records every attempt', () => {
  const provider = (name: string, impl: () => Promise<{ url: string; content: string; length: number; source: never } | null>): FetchProvider =>
    ({ name: name as never, canHandle: () => true, fetch: impl })

  it('throws FetchStackExhaustedError naming each extractor (errors AND empties) with one verdict', async () => {
    const stack = createFetchStack({
      providers: [
        provider('readability', async () => { throw new FetchProviderError({ provider: 'readability', url: URL_, status: 403 }) }),
        provider('jina', async () => null),
        provider('raw', async () => { throw new FetchProviderError({ provider: 'raw', url: URL_, status: 403 }) }),
      ],
      maxChars: 5000,
    })
    const err = await stack(URL_).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FetchStackExhaustedError)
    const message = (err as Error).message
    expect(message).toContain('readability: HTTP 403')
    expect(message).toContain('jina: no readable content')
    expect(message).toContain('raw: HTTP 403')
    expect(message).toContain('Do NOT retry this URL')
    expect((err as FetchStackExhaustedError).attempts).toHaveLength(3)
  })
})

describe('[COMP:tools/fetch-error] SearchProviderError', () => {
  it('translates bad key vs quota vs rate limit vs server; keeps `<Provider> HTTP <status>` first', () => {
    expect(new SearchProviderError({ provider: 'Brave', status: 401 }).message).toMatch(/^Brave HTTP 401 \(the Brave API key was rejected/)
    expect(new SearchProviderError({ provider: 'Serper', status: 402 }).message).toContain('quota is exhausted')
    expect(new SearchProviderError({ provider: 'Tavily', status: 429 }).message).toMatch(/^Tavily HTTP 429 \(Tavily rate limit hit — transient\)/)
    expect(new SearchProviderError({ provider: 'Brave', status: 503 }).kind).toBe('server')
    expect(searchStatusMeaning('Brave', 403).kind).toBe('bad_key')
  })

  it('a DuckDuckGo challenge page is a challenge, not a bad key (DDG has none)', () => {
    const ddg = new SearchProviderError({ provider: 'DuckDuckGo', status: 202, kind: 'challenge' })
    expect(ddg.kind).toBe('challenge')
    expect(ddg.message).toContain('bot-detection challenge page')
    expect(ddg.message).not.toContain('API key')
    const html = new SearchProviderError({ provider: 'DuckDuckGo', kind: 'challenge', detail: 'HTTP 200 challenge page (bot detection) instead of results — transient' })
    expect(html.message).toBe('DuckDuckGo: HTTP 200 challenge page (bot detection) instead of results — transient')
  })
})
