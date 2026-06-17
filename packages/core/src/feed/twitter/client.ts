/**
 * X (Twitter) API v2 client — thin fetch wrappers.
 *
 * OAuth 2.0 PKCE flow:
 *   authorize → code → POST /2/oauth2/token (w/ code_verifier) → (access, refresh, 2h)
 *   refresh  → POST /2/oauth2/token (w/ grant_type=refresh_token) → (new pair, old refresh invalidated)
 *
 * Phase 1 surface: token exchange + refresh, profile, tweet create/delete/read,
 * insights, reply/mention listing via conversation_id search + /mentions.
 * Phase 2 adds reply and hide-reply write endpoints.
 *
 * See docs/architecture/feed/twitter.md.
 */

import {
  TwitterCreateTweetResponse,
  TwitterDeleteResponse,
  TwitterHideResponse,
  TwitterListResponse,
  TwitterProfile,
  TwitterProfileResponse,
  TwitterSingleTweetResponse,
  TwitterTokenResponse,
  TwitterTweet,
  TwitterTweetListResponse,
  TwitterTweetWithIncludesResponse,
} from './types.js'

const API_BASE = 'https://api.x.com'

export class TwitterApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message)
    this.name = 'TwitterApiError'
  }
  /** 401 → token expired / revoked; 403 → scope insufficient. Both require re-auth. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }
}

async function twitterFetch(
  path: string,
  init: RequestInit & { token?: string; basicAuth?: { id: string; secret: string } } = {},
): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.basicAuth) {
    const enc = Buffer.from(`${init.basicAuth.id}:${init.basicAuth.secret}`).toString('base64')
    headers.Authorization = `Basic ${enc}`
  }

  const res = await fetch(url, { ...init, headers })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const errMsg = extractErrorMessage(body) ?? text
    throw new TwitterApiError(res.status, `Twitter API ${res.status}: ${errMsg}`, body)
  }
  return body
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { title?: string; detail?: string; error?: unknown; error_description?: string }
  if (b.error_description) return b.error_description
  if (typeof b.error === 'string') return b.error
  if (b.detail) return b.detail
  if (b.title) return b.title
  return null
}

// ── OAuth token exchange ─────────────────────────────────────────

/**
 * Exchange an authorization code for an access+refresh token pair.
 * Uses confidential-client auth (Basic header) plus PKCE code_verifier.
 */
export async function exchangeCodeForToken(params: {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  codeVerifier: string
}): Promise<TwitterTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
  })
  const body = await twitterFetch('/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    basicAuth: { id: params.clientId, secret: params.clientSecret },
  })
  return TwitterTokenResponse.parse(body)
}

/**
 * Refresh an access token using a refresh_token. Old refresh token is
 * invalidated on success — callers MUST persist the returned refresh_token
 * atomically before their next call.
 */
export async function refreshAccessToken(params: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): Promise<TwitterTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  })
  const body = await twitterFetch('/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    basicAuth: { id: params.clientId, secret: params.clientSecret },
  })
  return TwitterTokenResponse.parse(body)
}

// ── Profile ─────────────────────────────────────────────────────

export async function getAuthenticatedProfile(accessToken: string): Promise<TwitterProfile> {
  const body = await twitterFetch(
    '/2/users/me?user.fields=profile_image_url',
    { token: accessToken },
  )
  return TwitterProfileResponse.parse(body).data
}

// ── Tweets ──────────────────────────────────────────────────────

export type CreateTweetParams = {
  text: string
  replyToTweetId?: string
  /** Up to 4 media ids returned from the media-upload endpoint. Phase 1 usually empty. */
  mediaIds?: string[]
}

export async function createTweet(params: {
  accessToken: string
  tweet: CreateTweetParams
}): Promise<string> {
  const { accessToken, tweet } = params

  if (!tweet.text || tweet.text.length === 0) {
    throw new TwitterApiError(400, 'Twitter API 400: text is required', null)
  }
  if (tweet.text.length > 280) {
    throw new TwitterApiError(400, `Twitter API 400: text exceeds 280 chars (${tweet.text.length})`, null)
  }

  const payload: Record<string, unknown> = { text: tweet.text }
  if (tweet.replyToTweetId) {
    payload.reply = { in_reply_to_tweet_id: tweet.replyToTweetId }
  }
  if (tweet.mediaIds && tweet.mediaIds.length > 0) {
    if (tweet.mediaIds.length > 4) {
      throw new TwitterApiError(400, 'Twitter API 400: at most 4 media attachments per tweet', null)
    }
    payload.media = { media_ids: tweet.mediaIds }
  }

  const body = await twitterFetch('/2/tweets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    token: accessToken,
  })
  return TwitterCreateTweetResponse.parse(body).data.id
}

export async function deleteTweet(params: {
  accessToken: string
  tweetId: string
}): Promise<void> {
  const body = await twitterFetch(`/2/tweets/${encodeURIComponent(params.tweetId)}`, {
    method: 'DELETE',
    token: params.accessToken,
  })
  const parsed = TwitterDeleteResponse.parse(body)
  if (!parsed.data.deleted) {
    throw new TwitterApiError(500, 'Twitter delete returned deleted=false', body)
  }
}

export async function getTweet(params: {
  accessToken: string
  tweetId: string
}): Promise<TwitterSingleTweetResponse['data']> {
  const fields = 'public_metrics,created_at,author_id,conversation_id,in_reply_to_user_id'
  const body = await twitterFetch(
    `/2/tweets/${encodeURIComponent(params.tweetId)}?tweet.fields=${fields}`,
    { token: params.accessToken },
  )
  return TwitterSingleTweetResponse.parse(body).data
}

/**
 * Fetch a single tweet **with its author** expanded. Unlike `getTweet`,
 * this requests `expansions=author_id` + `user.fields` so callers can
 * render an author byline (handle, display name, avatar). Used by the
 * external-post preview card for X reply targets — works for any public
 * tweet regardless of who authored it.
 */
export async function getTweetWithAuthor(params: {
  accessToken: string
  tweetId: string
}): Promise<{ tweet: TwitterTweet; author: TwitterProfile | null }> {
  const fields = 'public_metrics,created_at,author_id,conversation_id,in_reply_to_user_id'
  const userFields = 'name,username,profile_image_url'
  const body = await twitterFetch(
    `/2/tweets/${encodeURIComponent(params.tweetId)}?tweet.fields=${fields}&expansions=author_id&user.fields=${userFields}`,
    { token: params.accessToken },
  )
  const parsed = TwitterTweetWithIncludesResponse.parse(body)
  return { tweet: parsed.data, author: parsed.includes?.users?.[0] ?? null }
}

/** Profile-level timeline — used to aggregate metrics when no mediaId given. */
export async function getUserTimeline(params: {
  accessToken: string
  userId: string
  max?: number
  sinceId?: string
}): Promise<TwitterTweetListResponse> {
  const fields = 'public_metrics,created_at,conversation_id'
  const qs = new URLSearchParams({
    'tweet.fields': fields,
    max_results: String(Math.min(Math.max(params.max ?? 20, 5), 100)),
  })
  if (params.sinceId) qs.set('since_id', params.sinceId)
  const body = await twitterFetch(
    `/2/users/${encodeURIComponent(params.userId)}/tweets?${qs.toString()}`,
    { token: params.accessToken },
  )
  return TwitterTweetListResponse.parse(body)
}

// ── Voice-import + inspiration reads ────────────────────────────

/**
 * List the connected user's recent originals — the source for voice import.
 * Uses `GET /2/users/:id/tweets`, paginated up to `limit` (capped at 200; X
 * page size = 100, so up to 2 paginated calls).
 *
 * Includes `referenced_tweets` so the tool layer can drop retweets and
 * quote-only posts. `in_reply_to_user_id` lets the tool drop replies. The
 * returned `text` is what voice analysis consumes.
 */
export async function listOwnTweets(params: {
  accessToken: string
  userId: string
  /** Total cap. Defaults to 200, hard-clamped to [10, 200]. */
  limit?: number
}): Promise<TwitterTweetListResponse> {
  const target = Math.min(Math.max(params.limit ?? 200, 10), 200)
  const expansions = 'referenced_tweets.id,attachments.media_keys'
  const fields = 'public_metrics,created_at,conversation_id,in_reply_to_user_id,referenced_tweets,attachments'

  const accumulated: TwitterTweetListResponse = { data: [], meta: undefined }
  let nextToken: string | undefined
  while ((accumulated.data?.length ?? 0) < target) {
    const remaining = target - (accumulated.data?.length ?? 0)
    const qs = new URLSearchParams({
      'tweet.fields': fields,
      expansions,
      max_results: String(Math.min(Math.max(remaining, 5), 100)),
    })
    if (nextToken) qs.set('pagination_token', nextToken)
    const body = await twitterFetch(
      `/2/users/${encodeURIComponent(params.userId)}/tweets?${qs.toString()}`,
      { token: params.accessToken },
    )
    const page = TwitterTweetListResponse.parse(body)
    if (page.data && page.data.length > 0) {
      accumulated.data = [...(accumulated.data ?? []), ...page.data]
    }
    accumulated.meta = page.meta
    nextToken = page.meta?.next_token
    if (!nextToken) break
  }
  // Trim to target — last page may have over-fetched.
  if (accumulated.data && accumulated.data.length > target) {
    accumulated.data = accumulated.data.slice(0, target)
  }
  return accumulated
}

/**
 * Read the connected user's home timeline (reverse chronological).
 * `GET /2/users/:id/timelines/reverse_chronological` — used by the
 * inspiration-feed scan to discover replyable opportunities in the
 * follower graph.
 *
 * Per-user limit: 180/15min — well above expected operator cadence.
 */
export async function listHomeTimeline(params: {
  accessToken: string
  userId: string
  max?: number
}): Promise<TwitterTweetListResponse> {
  const fields = 'public_metrics,created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets'
  const qs = new URLSearchParams({
    'tweet.fields': fields,
    expansions: 'author_id',
    'user.fields': 'username,name,verified',
    max_results: String(Math.min(Math.max(params.max ?? 50, 10), 100)),
  })
  const body = await twitterFetch(
    `/2/users/${encodeURIComponent(params.userId)}/timelines/reverse_chronological?${qs.toString()}`,
    { token: params.accessToken },
  )
  return TwitterTweetListResponse.parse(body)
}

/**
 * Read recent tweets in an X List the connected user owns or follows.
 * `GET /2/lists/:id/tweets`. Lists are operator-curated, so this is the
 * highest-signal inspiration source.
 */
export async function listFromList(params: {
  accessToken: string
  listId: string
  max?: number
}): Promise<TwitterTweetListResponse> {
  const fields = 'public_metrics,created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets'
  const qs = new URLSearchParams({
    'tweet.fields': fields,
    expansions: 'author_id',
    'user.fields': 'username,name,verified',
    max_results: String(Math.min(Math.max(params.max ?? 50, 10), 100)),
  })
  const body = await twitterFetch(
    `/2/lists/${encodeURIComponent(params.listId)}/tweets?${qs.toString()}`,
    { token: params.accessToken },
  )
  return TwitterTweetListResponse.parse(body)
}

/**
 * Recent-search by query string. `GET /2/tweets/search/recent`.
 * Used by inspiration-feed for topic-driven discovery.
 *
 * The `query` follows X's search syntax — operators can use `lang:`,
 * `-is:retweet`, `has:links`, etc. We don't sanitize; the operator owns
 * the query, and the connected token can only see what it could see in
 * X's UI.
 */
export async function searchRecent(params: {
  accessToken: string
  query: string
  max?: number
}): Promise<TwitterTweetListResponse> {
  const fields = 'public_metrics,created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets'
  const qs = new URLSearchParams({
    query: params.query,
    'tweet.fields': fields,
    expansions: 'author_id',
    'user.fields': 'username,name,verified',
    max_results: String(Math.min(Math.max(params.max ?? 50, 10), 100)),
  })
  const body = await twitterFetch(
    `/2/tweets/search/recent?${qs.toString()}`,
    { token: params.accessToken },
  )
  return TwitterTweetListResponse.parse(body)
}

// ── Quote tweets ────────────────────────────────────────────────

/**
 * Tweets that quote a given tweet. `GET /2/tweets/:id/quote_tweets`.
 *
 * Quote tweets do NOT share the quoted tweet's `conversation_id` and don't
 * @-mention the author, so they're invisible to both the mentions timeline
 * and the `conversation_id:` reply search — this is the only endpoint that
 * surfaces them. No `since_id` support (pagination is `pagination_token`
 * based); the poller uses `public_metrics.quote_count` growth to decide when
 * to call, and `hasRecentInboundSystem` for per-id dedup.
 */
export async function listQuotes(params: {
  accessToken: string
  tweetId: string
  max?: number
}): Promise<TwitterTweetListResponse> {
  const fields = 'author_id,created_at,conversation_id,public_metrics'
  const qs = new URLSearchParams({
    'tweet.fields': fields,
    expansions: 'author_id',
    'user.fields': 'username,name',
    max_results: String(Math.min(Math.max(params.max ?? 25, 10), 100)),
  })
  const body = await twitterFetch(
    `/2/tweets/${encodeURIComponent(params.tweetId)}/quote_tweets?${qs.toString()}`,
    { token: params.accessToken },
  )
  return TwitterTweetListResponse.parse(body)
}

// ── Lists discovery (operator picker) ───────────────────────────

const LIST_FIELDS = 'list.fields=member_count,follower_count,private,description,owner_id'

/**
 * Lists owned by the authenticated user. `GET /2/users/:id/owned_lists`.
 * Used by the inspiration config UI to populate the "pick a List" dropdown
 * without forcing operators to paste numeric IDs from the X URL bar.
 *
 * Requires `list.read` scope; raises 403 for tokens issued before the
 * scope was added (the workspace surfaces a reconnect banner on that path).
 */
export async function listOwnedLists(params: {
  accessToken: string
  userId: string
  max?: number
}): Promise<TwitterListResponse> {
  const qs = new URLSearchParams({
    max_results: String(Math.min(Math.max(params.max ?? 100, 1), 100)),
  })
  const body = await twitterFetch(
    `/2/users/${encodeURIComponent(params.userId)}/owned_lists?${qs.toString()}&${LIST_FIELDS}`,
    { token: params.accessToken },
  )
  return TwitterListResponse.parse(body)
}

/**
 * Lists the authenticated user is a member of. `GET /2/users/:id/list_memberships`.
 * Includes both Lists owned by the user and Lists they were added to —
 * the operator picker can show owned + member separately for clarity.
 */
export async function listMembershipsForUser(params: {
  accessToken: string
  userId: string
  max?: number
}): Promise<TwitterListResponse> {
  const qs = new URLSearchParams({
    max_results: String(Math.min(Math.max(params.max ?? 100, 1), 100)),
  })
  const body = await twitterFetch(
    `/2/users/${encodeURIComponent(params.userId)}/list_memberships?${qs.toString()}&${LIST_FIELDS}`,
    { token: params.accessToken },
  )
  return TwitterListResponse.parse(body)
}

// ── Replies (by conversation_id search) ─────────────────────────

/**
 * X doesn't have a direct "list replies to tweet X" endpoint. Replies share
 * `conversation_id` with the parent, so we query recent search with
 * `conversation_id:<id>` and filter out the parent on the client.
 */
export async function listReplies(params: {
  accessToken: string
  tweetId: string
  sinceId?: string
  max?: number
}): Promise<TwitterTweetListResponse> {
  const fields = 'author_id,created_at,conversation_id,in_reply_to_user_id'
  const qs = new URLSearchParams({
    query: `conversation_id:${params.tweetId}`,
    'tweet.fields': fields,
    expansions: 'author_id',
    'user.fields': 'username,name',
    max_results: String(Math.min(Math.max(params.max ?? 25, 10), 100)),
  })
  if (params.sinceId) qs.set('since_id', params.sinceId)
  const body = await twitterFetch(
    `/2/tweets/search/recent?${qs.toString()}`,
    { token: params.accessToken },
  )
  const parsed = TwitterTweetListResponse.parse(body)
  // Strip the parent (it satisfies conversation_id:<id> too).
  if (parsed.data) {
    parsed.data = parsed.data.filter((t) => t.id !== params.tweetId)
  }
  return parsed
}

export async function listMentions(params: {
  accessToken: string
  userId: string
  sinceId?: string
  max?: number
}): Promise<TwitterTweetListResponse> {
  const fields = 'author_id,created_at,conversation_id,in_reply_to_user_id'
  const qs = new URLSearchParams({
    'tweet.fields': fields,
    expansions: 'author_id',
    'user.fields': 'username,name',
    max_results: String(Math.min(Math.max(params.max ?? 25, 5), 100)),
  })
  if (params.sinceId) qs.set('since_id', params.sinceId)
  const body = await twitterFetch(
    `/2/users/${encodeURIComponent(params.userId)}/mentions?${qs.toString()}`,
    { token: params.accessToken },
  )
  return TwitterTweetListResponse.parse(body)
}

// ── Reply posting + hiding (Phase 2 — kept here for completeness) ──

export async function replyToTweet(params: {
  accessToken: string
  text: string
  replyToTweetId: string
}): Promise<string> {
  return createTweet({
    accessToken: params.accessToken,
    tweet: { text: params.text, replyToTweetId: params.replyToTweetId },
  })
}

export async function hideReply(params: {
  accessToken: string
  tweetId: string
  hide: boolean
}): Promise<void> {
  const body = await twitterFetch(
    `/2/tweets/${encodeURIComponent(params.tweetId)}/hidden`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: params.hide }),
      token: params.accessToken,
    },
  )
  TwitterHideResponse.parse(body)
}
