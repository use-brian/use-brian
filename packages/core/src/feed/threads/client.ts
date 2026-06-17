/**
 * Meta Threads Graph API client.
 *
 * Thin fetch-based wrappers. Each call takes an access token and makes a
 * single HTTP request. Long-lived tokens last 60 days and are refreshed
 * opportunistically by a daily job (see packages/api/src/routes/threads-oauth.ts).
 *
 * Phase 1 surface: profile, post create/delete/insights, long-lived token
 * exchange + refresh. Phase 2 adds reply management, mentions, webhooks.
 *
 * See docs/architecture/feed/threads.md.
 */

import {
  LongLivedTokenResponse,
  ShortLivedTokenResponse,
  ThreadsContainerStatusResponse,
  ThreadsInsightsResponse,
  ThreadsMediaContainer,
  ThreadsMediaDetails,
  ThreadsProfile,
  ThreadsProfilePostsResponse,
  ThreadsPublishedMedia,
  ThreadsRepliesResponse,
  type ThreadsContainerStatusValue,
  type ThreadsTextSpoiler,
} from './types.js'

const GRAPH_HOST = 'https://graph.threads.net'

export class ThreadsApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message)
    this.name = 'ThreadsApiError'
  }
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }
  /**
   * 5xx responses are the ones where Meta has been observed to ack
   * publish on their side but still error on the response leg — the
   * exact case the verify-after-publish path was added for. 4xx are
   * deterministic refusals (auth, validation, permission) and should
   * not trigger verify.
   */
  get isTransient(): boolean {
    return this.status >= 500 && this.status < 600
  }
}

/**
 * Thrown by `replyToPost` / `createPost` when the create-container step
 * succeeded but the publish step failed. Carries the `containerId` so
 * the caller can verify via `getContainerStatus` whether Meta actually
 * published despite returning an error response. See
 * `docs/architecture/feed/threads.md` → "Verify-after-publish".
 */
export class ThreadsPublishStepError extends ThreadsApiError {
  constructor(
    public containerId: string,
    cause: ThreadsApiError,
  ) {
    super(cause.status, cause.message, cause.body)
    this.name = 'ThreadsPublishStepError'
  }
}

async function threadsFetch(
  path: string,
  init: RequestInit & { token?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${GRAPH_HOST}${path}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`

  const res = await fetch(url, { ...init, headers })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const errMsg =
      body && typeof body === 'object' && body !== null && 'error' in body
        ? ((body as { error: { message?: string } }).error?.message ?? text)
        : text
    throw new ThreadsApiError(res.status, `Threads API ${res.status}: ${errMsg}`, body)
  }
  return body
}

// ── OAuth token exchange ─────────────────────────────────────────

/**
 * Exchange an authorization code for a short-lived token.
 * Body is form-encoded; endpoint lives on graph.threads.net (not
 * api.instagram.com where the authorize endpoint is).
 */
export async function exchangeCodeForShortLivedToken(params: {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
}): Promise<ShortLivedTokenResponse> {
  const form = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
    code: params.code,
  })
  const body = await threadsFetch('/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  return ShortLivedTokenResponse.parse(body)
}

/** Exchange a short-lived token for a long-lived (60-day) token. */
export async function exchangeShortLivedForLongLived(params: {
  clientSecret: string
  shortLivedToken: string
}): Promise<LongLivedTokenResponse> {
  const url = `${GRAPH_HOST}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(params.clientSecret)}&access_token=${encodeURIComponent(params.shortLivedToken)}`
  const body = await threadsFetch(url, { method: 'GET' })
  return LongLivedTokenResponse.parse(body)
}

/** Refresh a still-valid long-lived token (must be called before expiry). */
export async function refreshLongLivedToken(longLivedToken: string): Promise<LongLivedTokenResponse> {
  const url = `${GRAPH_HOST}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(longLivedToken)}`
  const body = await threadsFetch(url, { method: 'GET' })
  return LongLivedTokenResponse.parse(body)
}

// ── Profile ─────────────────────────────────────────────────────

export async function getProfile(accessToken: string): Promise<ThreadsProfile> {
  const body = await threadsFetch(
    '/v1.0/me?fields=id,username,threads_profile_picture_url,threads_biography',
    { token: accessToken },
  )
  return ThreadsProfile.parse(body)
}

// ── Posts ───────────────────────────────────────────────────────

export type CreatePostParams =
  | {
      mediaType: 'TEXT'
      text: string
      replyToId?: string
      textSpoilers?: ThreadsTextSpoiler[]
      /**
       * Single topic tag to attach to the post. Threads' platform-level
       * limit is one tag per post (see Meta's "Tag a topic" docs); the
       * Graph API accepts a single string and rejects `.` / `&`. The
       * draft-app surfaces a `Add topic` chip on the post-intent hero
       * for Threads sessions only — X has no equivalent first-class
       * concept.
       *
       * https://developers.facebook.com/docs/threads/reference/publishing/
       */
      topicTag?: string
    }
  | {
      mediaType: 'IMAGE'
      text?: string
      imageUrl: string
      replyToId?: string
      isSpoilerMedia?: boolean
      textSpoilers?: ThreadsTextSpoiler[]
      topicTag?: string
    }
  | {
      mediaType: 'CAROUSEL'
      text?: string
      children: Array<{ mediaType: 'IMAGE'; imageUrl: string }>
      replyToId?: string
      isSpoilerMedia?: boolean
      textSpoilers?: ThreadsTextSpoiler[]
      topicTag?: string
    }

/**
 * Two-step publish: create media container(s), then publish.
 * Returns the published post id.
 *
 * If the publish step throws a `ThreadsApiError`, this rewraps it as
 * `ThreadsPublishStepError` so the caller can recover by querying the
 * container status (see verify-after-publish in
 * `packages/api/src/feed/threads-api.ts`). Container-creation errors
 * pass through unchanged — there is no container yet to verify.
 */
export async function createPost(params: {
  userId: string
  accessToken: string
  post: CreatePostParams
}): Promise<string> {
  const { userId, accessToken, post } = params
  const containerId = await createContainer({ userId, accessToken, post })
  // Meta recommends a short delay between container creation and publish to
  // give their side time to process media. For text posts this is optional,
  // but a small sleep avoids intermittent 'media not ready' errors.
  if (post.mediaType !== 'TEXT') {
    await sleep(2_000)
  }
  try {
    const published = await publishContainer({ userId, accessToken, containerId })
    return published.id
  } catch (err) {
    if (err instanceof ThreadsApiError) {
      throw new ThreadsPublishStepError(containerId, err)
    }
    throw err
  }
}

async function createContainer(params: {
  userId: string
  accessToken: string
  post: CreatePostParams
}): Promise<string> {
  const { userId, accessToken, post } = params
  const form = new URLSearchParams()
  form.set('media_type', post.mediaType)
  if ('text' in post && post.text !== undefined) form.set('text', post.text)
  if (post.mediaType === 'IMAGE') form.set('image_url', post.imageUrl)
  if ('replyToId' in post && post.replyToId) form.set('reply_to_id', post.replyToId)

  // Topic tag — Threads accepts one per post; reject the two characters
  // Meta's docs explicitly disallow before the API does, so the operator
  // sees a precise error from us rather than an opaque Graph API rejection.
  if ('topicTag' in post && post.topicTag) {
    const tag = post.topicTag.trim()
    if (tag.length === 0) {
      // Treat empty/whitespace as "no tag" — same as omitting the field.
    } else if (tag.length > 50) {
      throw new Error(
        `Threads topic tag must be 50 characters or less (got ${tag.length}).`,
      )
    } else if (/[.&]/.test(tag)) {
      throw new Error(
        'Threads topic tags cannot contain `.` or `&` characters.',
      )
    } else {
      form.set('topic_tag', tag)
    }
  }

  // Spoilers — applied at parent-container creation only. For CAROUSEL,
  // setting `is_spoiler_media` on the parent marks every attached child
  // as a spoiler (per Meta docs); children do not opt in individually.
  if ('isSpoilerMedia' in post && post.isSpoilerMedia) {
    form.set('is_spoiler_media', 'true')
  }
  if ('textSpoilers' in post && post.textSpoilers && post.textSpoilers.length > 0) {
    const entities = post.textSpoilers.map(({ offset, length }) => ({
      entity_type: 'SPOILER' as const,
      offset,
      length,
    }))
    form.set('text_entities', JSON.stringify(entities))
  }

  if (post.mediaType === 'CAROUSEL') {
    // Each carousel child is its own container; pass their IDs comma-sep.
    const childIds = await Promise.all(
      post.children.map(async (child) => {
        const childForm = new URLSearchParams()
        childForm.set('media_type', 'IMAGE')
        childForm.set('image_url', child.imageUrl)
        childForm.set('is_carousel_item', 'true')
        const childBody = await threadsFetch(`/v1.0/${encodeURIComponent(userId)}/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: childForm.toString(),
          token: accessToken,
        })
        return ThreadsMediaContainer.parse(childBody).id
      }),
    )
    form.set('children', childIds.join(','))
  }

  const body = await threadsFetch(`/v1.0/${encodeURIComponent(userId)}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    token: accessToken,
  })
  return ThreadsMediaContainer.parse(body).id
}

/**
 * Publish a previously-created media container. Exported so the api
 * adapter can drive create + publish as separate steps and hold onto
 * the containerId across a publish-step failure for the verify path.
 */
export async function publishContainer(params: {
  userId: string
  accessToken: string
  containerId: string
}): Promise<ThreadsPublishedMedia> {
  const form = new URLSearchParams({ creation_id: params.containerId })
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.userId)}/threads_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      token: params.accessToken,
    },
  )
  return ThreadsPublishedMedia.parse(body)
}

/**
 * Read the publish status of a media container we previously created.
 * Used by the verify-after-publish recovery path: when `/threads_publish`
 * returns 5xx, callers poll this to determine whether Meta actually
 * published the container or not, instead of blind-retrying (which
 * duplicates the post on Threads).
 *
 * Per Meta's troubleshooting docs, the documented field is `status`
 * (not `status_code` as on Instagram Graph). Statuses:
 *   IN_PROGRESS — keep polling
 *   FINISHED    — ready to publish; publish call may need to be retried
 *   PUBLISHED   — terminal-success
 *   ERROR       — terminal-failure; `error_message` populated
 *   EXPIRED     — terminal-failure (>24h, never published)
 *
 * https://developers.facebook.com/docs/threads/troubleshooting/
 */
export async function getContainerStatus(params: {
  accessToken: string
  containerId: string
}): Promise<ThreadsContainerStatusResponse> {
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.containerId)}?fields=id,status,error_message`,
    { token: params.accessToken },
  )
  return ThreadsContainerStatusResponse.parse(body)
}

export type ThreadsTerminalStatus = Extract<
  ThreadsContainerStatusValue,
  'PUBLISHED' | 'ERROR' | 'EXPIRED'
>

export async function deletePost(params: {
  accessToken: string
  mediaId: string
}): Promise<void> {
  await threadsFetch(`/v1.0/${encodeURIComponent(params.mediaId)}`, {
    method: 'DELETE',
    token: params.accessToken,
  })
}

export async function getMediaDetails(params: {
  accessToken: string
  mediaId: string
}): Promise<ThreadsMediaDetails> {
  const fields = 'id,media_type,media_url,permalink,text,timestamp,username'
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.mediaId)}?fields=${fields}`,
    { token: params.accessToken },
  )
  return ThreadsMediaDetails.parse(body)
}

// ── Insights ────────────────────────────────────────────────────

export async function getMediaInsights(params: {
  accessToken: string
  mediaId: string
}): Promise<ThreadsInsightsResponse> {
  const metrics = ['views', 'likes', 'replies', 'reposts', 'quotes'].join(',')
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.mediaId)}/insights?metric=${metrics}`,
    { token: params.accessToken },
  )
  return ThreadsInsightsResponse.parse(body)
}

export async function getProfileInsights(params: {
  accessToken: string
  userId: string
  /** ISO date, defaults to 7 days ago. */
  since?: string
  /** ISO date, defaults to now. */
  until?: string
}): Promise<ThreadsInsightsResponse> {
  const metrics = ['views', 'likes', 'replies', 'reposts', 'quotes', 'followers_count'].join(',')
  const qs = new URLSearchParams({ metric: metrics })
  if (params.since) qs.set('since', String(Math.floor(new Date(params.since).getTime() / 1000)))
  if (params.until) qs.set('until', String(Math.floor(new Date(params.until).getTime() / 1000)))
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.userId)}/threads_insights?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsInsightsResponse.parse(body)
}

// ── Replies (Phase 2 — kept here so the client surface is complete) ──

export async function listReplies(params: {
  accessToken: string
  mediaId: string
  limit?: number
}): Promise<ThreadsRepliesResponse> {
  const fields = 'id,text,username,timestamp,root_post,replied_to,hide_status,has_replies'
  const qs = new URLSearchParams({ fields })
  if (params.limit) qs.set('limit', String(params.limit))
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.mediaId)}/replies?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsRepliesResponse.parse(body)
}

/**
 * Create a reply media container. Exported so callers that need the
 * verify-after-publish recovery path (the api adapter) can drive
 * create + publish as separate steps and keep the containerId after
 * a publish-step failure.
 */
export async function createReplyContainer(params: {
  userId: string
  accessToken: string
  text: string
  replyToId: string
}): Promise<string> {
  const form = new URLSearchParams({
    media_type: 'TEXT',
    text: params.text,
    reply_to_id: params.replyToId,
  })
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.userId)}/threads`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      token: params.accessToken,
    },
  )
  return ThreadsMediaContainer.parse(body).id
}

/**
 * Post a reply to an existing post. `replyToId` can be the root post id or
 * any reply id within the thread. Returns the newly-published reply id.
 *
 * On publish-step failure, throws `ThreadsPublishStepError` carrying the
 * `containerId` so callers can verify via `getContainerStatus`.
 * Container-creation errors pass through unchanged.
 */
export async function replyToPost(params: {
  userId: string
  accessToken: string
  text: string
  replyToId: string
}): Promise<string> {
  const containerId = await createReplyContainer(params)
  try {
    const published = await publishContainer({
      userId: params.userId,
      accessToken: params.accessToken,
      containerId,
    })
    return published.id
  } catch (err) {
    if (err instanceof ThreadsApiError) {
      throw new ThreadsPublishStepError(containerId, err)
    }
    throw err
  }
}

export async function hideReply(params: {
  accessToken: string
  replyId: string
  hide: boolean
}): Promise<void> {
  const form = new URLSearchParams({ hide: String(params.hide) })
  await threadsFetch(`/v1.0/${encodeURIComponent(params.replyId)}/manage_reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    token: params.accessToken,
  })
}

// ── Mentions ────────────────────────────────────────────────────

/**
 * List posts that @-mention the authenticated user. Requires the
 * `threads_manage_mentions` scope. Meta returns the same shape as
 * `/replies` — we reuse `ThreadsRepliesResponse` to avoid a duplicate
 * schema that would drift over time.
 */
export async function listMentions(params: {
  accessToken: string
  userId: string
  limit?: number
}): Promise<ThreadsRepliesResponse> {
  const fields = 'id,text,username,timestamp,root_post,replied_to'
  const qs = new URLSearchParams({ fields })
  if (params.limit) qs.set('limit', String(params.limit))
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.userId)}/mentions?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsRepliesResponse.parse(body)
}

// ── Keyword search ────────────────────────────────────────────────

/**
 * Search public Threads posts by keyword. Hits Meta's `/v1.0/keyword_search`
 * endpoint. Returns posts matching `query` in the same `data: ThreadsReply[]`
 * envelope so callers can reuse the existing conversion helpers.
 *
 * Requires the `threads_keyword_search` scope on the token. Tokens issued
 * before the scope was added to `SCOPES` (`packages/api/src/routes/threads-oauth.ts`)
 * will fail with HTTP 500 "Application does not have permission for this
 * action" — those users must reconnect Threads to obtain a new token. See
 * `docs/architecture/feed/threads.md` for the re-consent note.
 */
export async function searchThreads(params: {
  accessToken: string
  query: string
  limit?: number
  /** TOP (default) ranks by relevance; RECENT orders chronologically. */
  searchType?: 'TOP' | 'RECENT'
}): Promise<ThreadsRepliesResponse> {
  const fields = 'id,text,username,timestamp'
  const qs = new URLSearchParams({ q: params.query, fields })
  if (params.searchType) qs.set('search_type', params.searchType)
  if (params.limit) qs.set('limit', String(params.limit))
  const body = await threadsFetch(
    `/v1.0/keyword_search?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsRepliesResponse.parse(body)
}

// ── Profile post listings (URL-paste reply resolver) ────────────
//
// The Threads Graph API has no public URL- or shortcode-lookup endpoint.
// The only documented way to turn a Threads URL into the `reply_to_id`
// the API accepts is to list the author's posts (filtered by the
// shortcode-decoded creation timestamp via `since`/`until`) and match the
// `shortcode` field client-side. See the URL-paste resolver in
// `packages/api/src/feed/threads-post-resolver.ts`.
//
// `since` / `until` are unix-seconds; passing them is what makes this
// affordable — without them the caller would have to paginate the
// author's full history.

/**
 * List the connected account's own top-level posts. Requires `threads_basic`
 * only, so this is the cheap path for "reply to your own URL-pasted post".
 * The `userId` is the connected account's Graph user id (from `getProfile`).
 *
 * **Does NOT return replies.** Meta's `/{user-id}/threads` is documented as
 * top-level posts only ("To retrieve posts that are replies, refer to
 * Retrieve User Replies"). Use `listOwnReplies` for outbound replies.
 */
export async function listOwnPosts(params: {
  accessToken: string
  userId: string
  /** Unix seconds. */
  since?: number
  /** Unix seconds. */
  until?: number
  /** Default 25, max 100. */
  limit?: number
}): Promise<ThreadsProfilePostsResponse> {
  const fields =
    'id,shortcode,permalink,text,timestamp,username,is_reply,is_quote_post,replied_to,root_post,media_type'
  const qs = new URLSearchParams({ fields })
  if (params.since !== undefined) qs.set('since', String(params.since))
  if (params.until !== undefined) qs.set('until', String(params.until))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.userId)}/threads?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsProfilePostsResponse.parse(body)
}

/**
 * List the connected account's outbound replies (threads they posted as a
 * reply to someone else's thread). Companion to `listOwnPosts` — Meta splits
 * top-level posts and replies across two endpoints.
 *
 * Requires `threads_read_replies` scope. Same response envelope as
 * `listOwnPosts`; `is_reply` is true for every row, and `replied_to.id`
 * carries the parent thread's media id when available.
 */
export async function listOwnReplies(params: {
  accessToken: string
  userId: string
  /** Unix seconds. */
  since?: number
  /** Unix seconds. */
  until?: number
  /** Default 25, max 100. */
  limit?: number
}): Promise<ThreadsProfilePostsResponse> {
  const fields =
    'id,shortcode,permalink,text,timestamp,username,is_reply,is_quote_post,replied_to,root_post,media_type'
  const qs = new URLSearchParams({ fields })
  if (params.since !== undefined) qs.set('since', String(params.since))
  if (params.until !== undefined) qs.set('until', String(params.until))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const body = await threadsFetch(
    `/v1.0/${encodeURIComponent(params.userId)}/replies?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsProfilePostsResponse.parse(body)
}

/**
 * List a public profile's posts. Same response shape as `listOwnPosts`
 * but hits `/v1.0/profile_posts?username=…` and requires the
 * `threads_profile_discovery` advanced-access scope (Meta-approved).
 * Used when the URL-pasted post is not on the connected account.
 */
export async function listProfilePosts(params: {
  accessToken: string
  username: string
  /** Unix seconds. */
  since?: number
  /** Unix seconds. */
  until?: number
  /** Default 25, max 100. */
  limit?: number
}): Promise<ThreadsProfilePostsResponse> {
  const fields = 'id,shortcode,permalink,text,timestamp,username'
  const qs = new URLSearchParams({ username: params.username, fields })
  if (params.since !== undefined) qs.set('since', String(params.since))
  if (params.until !== undefined) qs.set('until', String(params.until))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const body = await threadsFetch(
    `/v1.0/profile_posts?${qs.toString()}`,
    { token: params.accessToken },
  )
  return ThreadsProfilePostsResponse.parse(body)
}

// ── Helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
