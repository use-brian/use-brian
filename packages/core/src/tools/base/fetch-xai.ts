/**
 * xAI fetch provider — transparent x.com redirect.
 *
 * First in the `urlReader` fetch stack. Intercepts x.com / twitter.com URLs
 * and routes them through xAI's `x_search` tool, returning the post text as
 * a normal `FetchResult`. The model sees `source: 'xai'` but otherwise
 * treats the result like any other fetch.
 *
 * When `XAI_API_KEY` is unset, `canHandle` returns false and the stack
 * falls through — but the other providers (readability/jina/raw) also
 * refuse x.com hosts, so callers get a clean "no provider could read this
 * URL" error rather than a useless login-wall extraction.
 *
 * See docs/architecture/integrations/xai.md.
 */

import type { FetchProvider, FetchResult } from './fetch-stack.js'
import {
  extractXaiResponseText,
  extractXaiUsage,
  postXaiResponses,
  XAI_X_URL_QUOTE_MODEL,
} from '../../providers/xai.js'

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
])

const REQUEST_TIMEOUT_MS = 30_000

/** Exported for use by other fetch providers that should skip x.com hosts. */
export function isXHost(url: string): boolean {
  try {
    return X_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

type ParsedStatus = { handle: string; postId: string }

function parseStatusUrl(url: string): ParsedStatus | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  // Handles `/{handle}/status/{id}` and `/{handle}/status/{id}/photo/1` etc.
  const parts = parsed.pathname.split('/').filter(Boolean)
  const statusIdx = parts.indexOf('status')
  if (statusIdx < 1) return undefined
  const handle = parts[statusIdx - 1]
  const postId = parts[statusIdx + 1]
  if (!handle || !postId || !/^\d+$/.test(postId)) return undefined
  return { handle, postId }
}

export const xaiFetchProvider: FetchProvider = {
  name: 'xai',

  canHandle: (url) => {
    if (!process.env.XAI_API_KEY) return false
    return isXHost(url)
  },

  async fetch(url, signal): Promise<FetchResult | null> {
    const apiKey = process.env.XAI_API_KEY
    if (!apiKey) return null

    const parsed = parseStatusUrl(url)
    const query = parsed
      ? `Quote verbatim the full text of the X post at https://x.com/${parsed.handle}/status/${parsed.postId}. Include any replies in the thread if they are part of the post. Do not summarize — give the raw post text.`
      : `Summarize the content at this X URL, quoting verbatim where possible: ${url}`

    const xSearchTool: Record<string, unknown> = {
      type: 'x_search',
      ...(parsed ? { allowed_x_handles: [parsed.handle] } : {}),
    }

    const model = XAI_X_URL_QUOTE_MODEL
    const data = await postXaiResponses({
      apiKey,
      model,
      inputText: query,
      tools: [xSearchTool],
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal,
    })

    const { content } = extractXaiResponseText(data)
    const text = content.trim()
    if (!text) return null

    const usage = extractXaiUsage(data)
    return {
      url,
      title: parsed ? `X post by @${parsed.handle}` : undefined,
      content: text,
      length: text.length,
      source: 'xai',
      externalCost: {
        kind: 'per-token',
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
      },
    }
  },
}
