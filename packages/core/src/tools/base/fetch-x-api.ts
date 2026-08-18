/**
 * X (Twitter) API fetch provider — official tweet lookup.
 *
 * First in the `urlReader` fetch stack, ahead of the xAI / Grok redirect.
 * Intercepts x.com / twitter.com *status permalinks* (`/{handle}/status/{id}`)
 * and reads them through the official X API v2 tweet-lookup endpoint
 * (`GET /2/tweets/{id}`), returning the exact post text, author, metrics,
 * and any quoted / replied-to post as a normal `FetchResult` with
 * `source: 'x-api'`.
 *
 * Why ahead of xAI: the API returns the *verbatim* post (including the full
 * `note_tweet` text for long-form posts) deterministically, with no LLM in
 * the loop and no per-token cost — strictly better than Grok's paraphrase for
 * a known permalink. xAI stays in the stack as the fallback for:
 *   - non-permalink X URLs (profiles, search, lists) — `canHandle` declines
 *     them so the stack falls through to xAI,
 *   - read failures (rate limit / monthly cap / 4xx / deleted post) — the
 *     provider throws and the stack continues to xAI.
 *
 * Requires `TWITTER_BEARER_TOKEN` (app-only Bearer from an X developer app on
 * the Basic tier or higher — the Free tier cannot read tweets). When unset,
 * `canHandle` returns false and the stack behaves exactly as before (xAI, or
 * a clean "unreadable" error when xAI is also unconfigured).
 *
 * See docs/architecture/integrations/search-and-fetch.md and xai.md.
 */

import type { FetchProvider, FetchResult } from './fetch-stack.js'
import { FetchProviderError } from './_fetch-error.js'
import { isXHost, parseStatusUrl } from './fetch-xai.js'

const API_BASE = 'https://api.x.com/2/tweets'
const REQUEST_TIMEOUT_MS = 12_000

const TWEET_FIELDS = 'created_at,public_metrics,note_tweet,lang'
const EXPANSIONS = 'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys'
const USER_FIELDS = 'username,name,verified'
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text'

// ── X API v2 response shapes (only the fields we read) ──────────────

type XUser = { id: string; username: string; name?: string; verified?: boolean }

type XMedia = {
  media_key: string
  type: string
  url?: string
  preview_image_url?: string
  alt_text?: string
}

type XTweet = {
  id: string
  text: string
  author_id?: string
  created_at?: string
  /** Full text for long-form (>280 char) posts; `text` is truncated for these. */
  note_tweet?: { text?: string }
  public_metrics?: {
    like_count?: number
    retweet_count?: number
    reply_count?: number
    quote_count?: number
    impression_count?: number
  }
  referenced_tweets?: Array<{ type: 'replied_to' | 'quoted' | 'retweeted'; id: string }>
  attachments?: { media_keys?: string[] }
}

type XIncludes = { users?: XUser[]; tweets?: XTweet[]; media?: XMedia[] }

type XResponse = {
  data?: XTweet
  includes?: XIncludes
  errors?: Array<{ title?: string; detail?: string }>
}

export const xApiFetchProvider: FetchProvider = {
  name: 'x-api',

  canHandle: (url) => {
    if (!process.env.TWITTER_BEARER_TOKEN) return false
    if (!isXHost(url)) return false
    // Only single-post permalinks can be read via tweet lookup. Profiles,
    // search, and list URLs fall through to the xAI provider.
    return parseStatusUrl(url) !== undefined
  },

  async fetch(url, signal): Promise<FetchResult | null> {
    const token = process.env.TWITTER_BEARER_TOKEN
    const parsed = parseStatusUrl(url)
    if (!token || !parsed) return null

    const query = new URLSearchParams({
      'tweet.fields': TWEET_FIELDS,
      expansions: EXPANSIONS,
      'user.fields': USER_FIELDS,
      'media.fields': MEDIA_FIELDS,
    })

    const res = await globalThis.fetch(`${API_BASE}/${parsed.postId}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      // Throw so the stack falls through to the xAI provider (rate limit,
      // monthly cap exhaustion, revoked token, or a tier without read access).
      throw new FetchProviderError({
        provider: 'x-api',
        url,
        status: res.status,
        kind: 'provider',
        detail: res.status === 429 ? 'X API rate limit / monthly cap' : res.status === 401 || res.status === 403 ? 'the X API token is rejected or the tier has no read access' : undefined,
      })
    }

    const body = (await res.json()) as XResponse
    const tweet = body.data
    if (!tweet) {
      // Deleted / protected / not-found — let the xAI fallback try.
      const detail = body.errors?.[0]?.detail ?? body.errors?.[0]?.title
      throw new FetchProviderError({ provider: 'x-api', url, kind: 'not_found', detail: `X API returned no post${detail ? ` (${detail})` : ''} — deleted, protected, or not found` })
    }

    const content = renderTweet(tweet, body.includes, parsed.handle)
    if (!content.trim()) return null

    const author = resolveAuthor(tweet, body.includes) ?? parsed.handle
    return {
      url,
      title: `X post by @${author}`,
      content,
      length: content.length,
      source: 'x-api',
      // X API reads are covered by the flat-rate developer subscription, not
      // billed per call, so there is no per-request externalCost to attach
      // (unlike the xAI fallback, which pays Grok tokens).
    }
  },
}

// ── Rendering ───────────────────────────────────────────────────────

function resolveAuthor(tweet: XTweet, includes?: XIncludes): string | undefined {
  return includes?.users?.find((u) => u.id === tweet.author_id)?.username
}

function tweetText(tweet: XTweet): string {
  // note_tweet carries the full text for long-form posts; the top-level
  // `text` is truncated for those, so prefer note_tweet when present.
  return (tweet.note_tweet?.text ?? tweet.text ?? '').trim()
}

function renderTweet(tweet: XTweet, includes: XIncludes | undefined, fallbackHandle: string): string {
  const author = resolveAuthor(tweet, includes) ?? fallbackHandle
  const lines: string[] = [`@${author}:`, tweetText(tweet)]

  // Quoted / replied-to post, resolved from includes.tweets.
  for (const ref of tweet.referenced_tweets ?? []) {
    if (ref.type === 'retweeted') continue
    const refTweet = includes?.tweets?.find((t) => t.id === ref.id)
    if (!refTweet) continue
    const refAuthor = resolveAuthor(refTweet, includes) ?? 'unknown'
    const label = ref.type === 'quoted' ? 'Quoting' : 'In reply to'
    lines.push('', `${label} @${refAuthor}: ${tweetText(refTweet)}`)
  }

  // Media alt-text / links — the model can't see images, so surface the
  // author-supplied alt-text (when present) and the media URL.
  const media = (tweet.attachments?.media_keys ?? [])
    .map((k) => includes?.media?.find((m) => m.media_key === k))
    .filter((m): m is XMedia => Boolean(m))
  for (const m of media) {
    const link = m.url ?? m.preview_image_url
    const alt = m.alt_text ? `: ${m.alt_text}` : ''
    lines.push('', `[${m.type}${link ? ` ${link}` : ''}]${alt}`)
  }

  const pm = tweet.public_metrics
  if (pm) {
    const stats = [
      pm.like_count != null ? `${pm.like_count} likes` : null,
      pm.retweet_count != null ? `${pm.retweet_count} reposts` : null,
      pm.reply_count != null ? `${pm.reply_count} replies` : null,
      pm.quote_count != null ? `${pm.quote_count} quotes` : null,
      pm.impression_count != null ? `${pm.impression_count} views` : null,
    ].filter(Boolean)
    if (stats.length) lines.push('', stats.join(' · '))
  }

  if (tweet.created_at) lines.push(`Posted ${tweet.created_at}`)

  return lines.join('\n')
}
