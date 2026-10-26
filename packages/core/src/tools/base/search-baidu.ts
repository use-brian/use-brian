/**
 * Baidu Qianfan Search API provider.
 *
 * Uses Baidu's standard `baidu_search_v2` web index. The endpoint returns a
 * `references` array whose web entries map directly to the shared search
 * result shape.
 *
 * Docs: https://cloud.baidu.com/doc/qianfan/s/2mh4su4uy
 * Endpoint: POST https://qianfan.baidubce.com/v2/ai_search/web_search
 * Auth:     Authorization: Bearer <API Key>
 */

import type { SearchProvider, SearchResult } from './search-stack.js'
import { compileSearchFilters } from './search-filters.js'
import { retryAfterMs, SearchProviderError } from './_fetch-error.js'
import { clampResultCount, stripHtmlTags } from './search-stack.js'
import type { ExternalCredentialPool } from '../../providers/credential-pool.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'
import { recordToolSpend, resolveToolCredential } from './provider-credential.js'

const BAIDU_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search'

type BaiduReference = {
  type?: string
  title?: string
  web_anchor?: string
  website?: string
  url?: string
  snippet?: string
  content?: string
}

type BaiduResponse = {
  references?: BaiduReference[]
  code?: string | number
  message?: string
}

export function createBaiduProvider(pool?: ExternalCredentialPool): SearchProvider {
  return {
  name: 'baidu',

  available: () => Boolean(pool || process.env.BAIDU_SEARCH_API_KEY),

  // Baidu documents a low default QPS. Keep exact-provider panels serial so
  // one panel does not create its own avoidable burst; 429s still use the
  // shared bounded retry path.
  panelConcurrency: 1,

  async search(query, maxResults, signal, filters): Promise<SearchResult[]> {
    const filterParams = compileSearchFilters('baidu', filters)
    const lease = await resolveToolCredential(pool, 'baidu', process.env.BAIDU_SEARCH_API_KEY)
    if (!lease) throw new SearchProviderError({ provider: 'baidu', kind: 'bad_key', detail: 'No eligible search credential is configured.' })

    const res = await fetch(BAIDU_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${lease.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        edition: 'standard',
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: clampResultCount(maxResults) }],
        ...filterParams,
      }),
      signal,
    })

    if (!res.ok) {
      throw new SearchProviderError({
        provider: 'Baidu',
        status: res.status,
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      })
    }
    await recordToolSpend(lease, flatSearchCostUsd('baidu'))

    const data = (await res.json()) as BaiduResponse
    const errorCode = data.code === undefined ? '' : String(data.code).trim()
    if (errorCode && errorCode !== '0') {
      const detail = [errorCode, data.message?.trim()].filter(Boolean).join(': ')
      throw new SearchProviderError({
        provider: 'Baidu',
        kind: 'other',
        detail: detail.slice(0, 300),
      })
    }

    return (data.references ?? [])
      .filter((reference) => !reference.type || reference.type === 'web')
      .map((reference) => ({
        title: stripHtmlTags(reference.title ?? reference.web_anchor ?? reference.website ?? '').trim(),
        url: reference.url ?? '',
        snippet: stripHtmlTags(reference.snippet ?? reference.content ?? '').trim(),
      }))
      .filter((result) => result.url.startsWith('http'))
      .slice(0, maxResults)
  },
  }
}

export const baiduProvider: SearchProvider = createBaiduProvider()
