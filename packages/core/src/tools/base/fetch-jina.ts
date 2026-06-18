/**
 * Jina Reader API — JS-heavy-site escape hatch.
 *
 * Second tier in the fetch stack, after local Readability. When Readability
 * can't extract readable text (dynamic SPAs, JS-rendered content, sites
 * that block ordinary crawlers), Jina's `r.jina.ai` proxy renders the page
 * and returns clean markdown.
 *
 * Works without a token at lower rate limits. Set JINA_API_KEY for
 * production — raises the rate limit significantly. Token goes in the
 * Authorization header as `Bearer <token>`.
 *
 * Privacy note: Jina is a third party. URLs sent here are visible to them.
 * That's fine for public articles; NOT fine for URLs that encode state
 * (auth tokens, signed share links, internal documents). Sensitive URLs
 * are filtered out up-front via `canHandle` — they skip Jina entirely and
 * fall through to `fetch-raw.ts`.
 */

import type { FetchProvider, FetchResult } from './fetch-stack.js'

const JINA_ENDPOINT = 'https://r.jina.ai/'

/**
 * URL patterns that must bypass Jina for privacy reasons.
 *
 * Rules (any match → skip Jina):
 * - Auth/token query parameters (indicates signed/ephemeral links)
 * - Fragment-embedded tokens (OAuth implicit flows)
 * - Personal / internal / localhost domains
 *
 * This is a default constant, not a user setting — per-user allowlists
 * are deferred post-MVP. See docs/architecture/integrations/search-and-fetch.md.
 */
const SENSITIVE_QUERY_PARAMS = /[?&](token|access_token|auth|api_key|apikey|sig|signature)=/i
const SENSITIVE_FRAGMENTS = /#(access_token|id_token|token)=/i
const SENSITIVE_HOST_PATTERNS: RegExp[] = [
  /\.notion\.site$/i,
  /^(mail|drive|docs|calendar|meet)\.google\.com$/i,
  /\.sharepoint\.com$/i,
  /^(outlook|office)\.com$/i,
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /\.internal$/i,
  /\.local$/i,
  // X requires auth — Jina can't read the real content, and fetch-xai.ts
  // is the intended path. Listed here so we don't leak the URL to Jina.
  /^(www\.|mobile\.)?x\.com$/i,
  /^(www\.|mobile\.)?twitter\.com$/i,
]

export function isSensitiveUrl(rawUrl: string): boolean {
  if (SENSITIVE_QUERY_PARAMS.test(rawUrl)) return true
  if (SENSITIVE_FRAGMENTS.test(rawUrl)) return true
  try {
    const host = new URL(rawUrl).hostname
    return SENSITIVE_HOST_PATTERNS.some((p) => p.test(host))
  } catch {
    return false
  }
}

// ── Provider ──────────────────────────────────────────────────────

export const jinaProvider: FetchProvider = {
  name: 'jina',

  canHandle: (url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false
    return !isSensitiveUrl(url)
  },

  async fetch(url, signal): Promise<FetchResult | null> {
    const token = process.env.JINA_API_KEY
    const headers: Record<string, string> = {
      Accept: 'text/plain',
      // Ask Jina for structured markdown output.
      'X-Return-Format': 'markdown',
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const res = await globalThis.fetch(JINA_ENDPOINT + url, {
      method: 'GET',
      headers,
      signal,
    })

    if (!res.ok) {
      // Jina 5xx usually means "target site blocked us" — raw fetch will
      // fail the same way, but the caller may want a cleaner error. 4xx
      // means Jina itself is sick — surface and fall through.
      throw new Error(`Jina HTTP ${res.status}`)
    }

    const content = (await res.text()).trim()
    if (!content) return null

    // Jina markdown usually starts with `Title: ...\n\nURL Source: ...\n\n<body>`
    const title = extractTitle(content)

    return {
      url,
      title,
      content,
      length: content.length,
      source: 'jina',
    }
  },
}

// ── Jina markdown parsing ─────────────────────────────────────────

function extractTitle(markdown: string): string | undefined {
  const match = markdown.match(/^Title:\s*(.+)$/m)
  return match ? match[1].trim() : undefined
}
