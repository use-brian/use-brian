/**
 * Raw fetch + regex HTML-to-text — last-resort fetch provider.
 *
 * Third (final) tier in the fetch stack. When Readability can't extract
 * and Jina is unavailable (sensitive URL, no network, etc.), this is the
 * fallback: plain `fetch()` with a browser User-Agent, strip script/style
 * tags, decode entities. Handles non-HTML text content too (plain text,
 * JSON) by passing the body through unchanged.
 *
 * This is the original behavior of `urlReaderTool` before the fetch stack
 * rebuild — extracted here so it can still run when the smarter providers
 * can't.
 */

import type { FetchProvider, FetchResult } from './fetch-stack.js'
import { isXHost } from './fetch-xai.js'

const USER_AGENT = 'Mozilla/5.0 (compatible; sidanclaw/1.0)'

export const rawFetchProvider: FetchProvider = {
  name: 'raw',

  canHandle: (url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false
    // x.com / twitter.com are handled exclusively by fetch-xai.ts — a raw
    // fetch here would return the login wall HTML as "successful" content.
    if (isXHost(url)) return false
    return true
  },

  async fetch(url, signal): Promise<FetchResult | null> {
    const res = await globalThis.fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.1',
      },
      redirect: 'follow',
      signal,
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const body = await res.text()

    let content: string
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      content = htmlToText(body)
    } else {
      // Pass through non-HTML text bodies unchanged (plain text, json, etc.)
      content = body
    }

    content = content.trim()
    if (!content) return null

    return {
      url,
      title: extractTitle(body),
      content,
      length: content.length,
      source: 'raw',
    }
  },
}

// ── HTML → text ───────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return undefined
  return match[1]
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim() || undefined
}
