/**
 * Lightweight Slack Web API client using fetch.
 *
 * Every non-`ok` response is thrown as a `SlackApiError` (see ./errors.ts)
 * that keeps Slack's error code, its `response_metadata.messages` validator
 * detail, the `missing_scope` needed/provided pair, and the rate-limit
 * `Retry-After` — so a tool catching it can render a diagnosis instead of the
 * bare code.
 */

import { SlackApiError, type SlackErrorTarget } from './errors.js'

type SlackFailureBody = {
  ok: boolean
  error?: string
  needed?: string
  provided?: string
  response_metadata?: { messages?: unknown }
}

/** Pick the call arguments worth echoing back in a failure message. */
function targetOf(params?: Record<string, unknown>): SlackErrorTarget {
  const target: SlackErrorTarget = {}
  const channel = params?.channel ?? params?.channel_id
  if (typeof channel === 'string') target.channel = channel
  if (typeof params?.user === 'string') target.user = params.user
  const ts = params?.ts ?? params?.thread_ts ?? params?.timestamp
  if (typeof ts === 'string') target.ts = ts
  return target
}

/**
 * Parse a Slack Web API response and throw a structured `SlackApiError` on
 * failure. Slack signals failure with `{ ok: false, error }` at HTTP 200; a
 * non-2xx status (429 rate limit, 5xx) may carry the same JSON body or none.
 */
async function readSlackResponse<T>(
  method: string,
  res: Response,
  params?: Record<string, unknown>,
): Promise<T> {
  let data: (SlackFailureBody & T) | undefined
  try {
    data = await res.json() as SlackFailureBody & T
  } catch {
    data = undefined
  }
  if (data?.ok) return data
  // Defensive reads: test doubles (and some fetch polyfills) hand back a
  // partial Response without `headers` / `ok` / `status`.
  const httpFailed = typeof res.status === 'number' && (res.status < 200 || res.status >= 300)
  const retryAfterHeader = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null
  const retryAfterSec = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
    ? Number(retryAfterHeader)
    : undefined
  const messages = data?.response_metadata?.messages
  throw new SlackApiError({
    method,
    code: data?.error ?? (httpFailed ? `http_${res.status}` : 'unknown_error'),
    detail: Array.isArray(messages) ? messages.filter((m): m is string => typeof m === 'string') : undefined,
    needed: typeof data?.needed === 'string' ? data.needed : undefined,
    provided: typeof data?.provided === 'string' ? data.provided : undefined,
    retryAfterSec,
    httpStatus: httpFailed ? res.status : undefined,
    target: targetOf(params),
  })
}

export type SlackOutboundAudit = {
  kind: 'post_message' | 'update_message'
  /** Slack channel id ('C…' public, 'G…' private, 'D…' DM, 'I…' IM). */
  channel: string
  /** Outbound message text (chunked at the caller). */
  text: string
  /** thread_ts for chat.postMessage; the prior message ts for chat.update. */
  ts?: string
  /** Result from Slack — the new message ts when applicable. */
  externalTs?: string | null
  status: 'executed' | 'failed'
  error?: string
}

export type SlackApiOptions = {
  botToken: string
  /**
   * Optional async hook invoked after every outbound Slack write
   * (`chat.postMessage`, `chat.update`). When set, the Slack route
   * uses it to emit a `connector_action` Episode + audit row per
   * `docs/architecture/integrations/connector-actions.md`. Errors
   * thrown by the hook are caught + logged — audit failures must not
   * crash the user-facing send. Skipped for status/typing/reaction
   * calls (they aren't user-visible writes).
   *
   * TODO: migrate Slack to the unified `connector_instance` substrate
   * (`docs/plans/company-brain/connector-actions.md` → "Slack write
   * actions"). Until then this hook is the temp path — audit emission
   * happens at the bot-socket boundary rather than the tool boundary.
   */
  onOutboundAudit?: (event: SlackOutboundAudit) => Promise<void>
}

/** Provider fields needed to project a Slack thread into model-visible text. */
export type SlackConversationMessage = {
  type: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  subtype?: string
}

export type SlackThreadMessages = {
  /** Root first, followed by replies in chronological order. */
  messages: SlackConversationMessage[]
  /** True when the bounded reader omitted provider messages. */
  truncated: boolean
}

export function createSlackApi(options: SlackApiOptions) {
  const base = 'https://slack.com/api'
  const onOutboundAudit = options.onOutboundAudit

  async function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.botToken}`,
      },
      body: params ? JSON.stringify(params) : undefined,
    })
    return readSlackResponse<T>(method, res, params)
  }

  /**
   * Form-encoded variant. Only SOME Slack Web API methods accept a JSON
   * body (the docs mark them "Accepts: application/json" — mostly the
   * chat.* write family); every method accepts
   * `application/x-www-form-urlencoded`. A JSON body sent to a form-only
   * method is silently IGNORED, which fails in two shapes:
   *
   *  - a required argument goes missing → `invalid_arguments` on every
   *    call, no matter how correct the value was (prod 2026-08-17:
   *    `conversations.info` with a valid `C…` id failed 100% of the time,
   *    blinding the workflow delivery-target verifier for days), and
   *  - an optional argument silently reverts to its default → the call
   *    "succeeds" wrong (`conversations.list` dropped
   *    `types=public_channel,private_channel`, so private channels never
   *    appeared and the bot was asked for invites to channels it was
   *    already a member of).
   *
   * Rule: GET-family read methods (`conversations.info` / `.list` /
   * `.history` / `.replies`, `users.list`) and `files.getUploadURLExternal` go through
   * here; JSON `call` is only for methods proven to accept it.
   * `undefined`/`null` params are dropped; the rest are stringified.
   */
  async function callForm<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      form.set(key, String(value))
    }
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${options.botToken}`,
      },
      body: form.toString(),
    })
    return readSlackResponse<T>(method, res, params)
  }

  async function safeAudit(event: SlackOutboundAudit): Promise<void> {
    if (!onOutboundAudit) return
    try {
      await onOutboundAudit(event)
    } catch (err) {
      // Audit failure NEVER affects the send — the slack message has
      // already been delivered (or the failure has already propagated).
      console.warn(
        '[slack/api] outbound audit hook failed (suppressed):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return {
    postMessage: async (channel: string, text: string, opts?: { threadTs?: string; mrkdwn?: boolean }) => {
      try {
        const result = await call<{ ts: string; channel: string }>('chat.postMessage', {
          channel,
          text,
          mrkdwn: opts?.mrkdwn ?? true,
          thread_ts: opts?.threadTs,
          // Suppress link previews on bot outbound. Every link the assistant
          // posts is either an auth-gated app.usebrian.ai page — which all unfurl
          // to the SAME generic marketing card ("The shared brain for your
          // small team"), since the crawler can't see past the login — or an
          // occasional external link where a preview in a notification is
          // noise. A digest is a LIST of task links, so default unfurling
          // buried the actual content under a stack of identical cards.
          unfurl_links: false,
          unfurl_media: false,
        })
        await safeAudit({
          kind: 'post_message',
          channel,
          text,
          ts: opts?.threadTs,
          externalTs: result.ts,
          status: 'executed',
        })
        return result
      } catch (err) {
        await safeAudit({
          kind: 'post_message',
          channel,
          text,
          ts: opts?.threadTs,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    updateMessage: async (channel: string, ts: string, text: string, opts?: { mrkdwn?: boolean }) => {
      try {
        const result = await call<{ ts: string }>('chat.update', {
          channel,
          ts,
          text,
          mrkdwn: opts?.mrkdwn ?? true,
        })
        await safeAudit({
          kind: 'update_message',
          channel,
          text,
          ts,
          externalTs: result.ts,
          status: 'executed',
        })
        return result
      } catch (err) {
        await safeAudit({
          kind: 'update_message',
          channel,
          text,
          ts,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    authTest: () => call<{ user_id: string; bot_id: string; team: string }>('auth.test'),

    addReaction: (channel: string, timestamp: string, name: string) =>
      call<{}>('reactions.add', { channel, timestamp, name }),

    removeReaction: (channel: string, timestamp: string, name: string) =>
      call<{}>('reactions.remove', { channel, timestamp, name }),

    /** Set the native "thinking" status in a Slack Assistants thread. */
    setAssistantStatus: (channelId: string, threadTs: string, status: string) =>
      call<{}>('assistant.threads.setStatus', { channel_id: channelId, thread_ts: threadTs, status }),

    /** Clear the native thinking status (set empty string). */
    clearAssistantStatus: (channelId: string, threadTs: string) =>
      call<{}>('assistant.threads.setStatus', { channel_id: channelId, thread_ts: threadTs, status: '' }),

    /**
     * Look up a channel by id — confirms the BYO bot can actually see and
     * (for a member channel) post to it. Throws `channel_not_found` when the
     * id is wrong, from another workspace, or a non-Slack id mistakenly stamped
     * as a Slack channel (the workflow `channel_not_found` delivery incident).
     * Used by the authoring-time delivery-target validator. Requires no extra
     * scope beyond what a posting bot already holds.
     */
    conversationsInfo: (channel: string) =>
      // Form-encoded: `conversations.info` ignores a JSON body, which loses
      // the required `channel` arg → unconditional `invalid_arguments`.
      callForm<{ channel: { id: string; name?: string; is_archived?: boolean; is_member?: boolean } }>(
        'conversations.info',
        { channel },
      ),

    /**
     * List the (non-archived) public + private conversations the BYO bot can
     * see, paginating through `conversations.list`. Backs the workflow
     * authoring `listSlackChannels` tool so the model can target a real
     * channel id (`C…` public, `G…` private) instead of guessing — the fix for
     * the `channel_not_found` cross-wiring incident. Requires `channels:read` +
     * `groups:read` (both already in the BYO app manifest). `isMember` marks
     * the channels the bot can actually post to without a join. Paging is
     * bounded (10 pages) so a huge workspace can't spin the authoring turn.
     */
    conversationsList: async (
      opts?: { limit?: number },
    ): Promise<{
      channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean; isArchived: boolean }>
    }> => {
      const pageLimit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000)
      const channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean; isArchived: boolean }> = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        // Form-encoded: with a JSON body Slack silently dropped every one of
        // these args — `types` fell back to public_channel only (private
        // channels invisible), and `cursor` was ignored.
        const res = await callForm<{
          channels?: Array<{ id: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }>
          response_metadata?: { next_cursor?: string }
        }>('conversations.list', {
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: pageLimit,
          cursor,
        })
        for (const c of res.channels ?? []) {
          channels.push({
            id: c.id,
            name: c.name ?? c.id,
            isPrivate: c.is_private ?? false,
            isMember: c.is_member ?? false,
            isArchived: c.is_archived ?? false,
          })
        }
        cursor = res.response_metadata?.next_cursor || undefined
        if (!cursor) break
      }
      return { channels }
    },

    /**
     * List the workspace's human members (id + handle + display/real name),
     * paginating through `users.list`. Deleted users, bots, and Slackbot are
     * excluded. Backs outbound mention resolution (`mentions.ts`) and the
     * workflow-authoring `listSlackMembers` tool — Slack only notifies via
     * `<@MEMBER_ID>` syntax, so the model needs real ids, not guesses.
     * Requires `users:read` (already in the BYO app manifest — the identity
     * path calls `users.info` with the same scope). Paging is bounded
     * (10 pages) so a huge workspace can't spin the caller.
     */
    usersList: async (
      opts?: { limit?: number },
    ): Promise<{
      members: Array<{ id: string; handle: string; displayName: string; realName: string }>
    }> => {
      const pageLimit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000)
      const members: Array<{ id: string; handle: string; displayName: string; realName: string }> = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        // Form-encoded: `users.list` is GET-family — a JSON body loses
        // `limit`/`cursor` (pagination silently pinned to the first page).
        const res = await callForm<{
          members?: Array<{
            id: string
            name?: string
            deleted?: boolean
            is_bot?: boolean
            profile?: { display_name?: string; real_name?: string }
          }>
          response_metadata?: { next_cursor?: string }
        }>('users.list', { limit: pageLimit, cursor })
        for (const m of res.members ?? []) {
          if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue
          members.push({
            id: m.id,
            handle: m.name ?? '',
            displayName: m.profile?.display_name ?? '',
            realName: m.profile?.real_name ?? '',
          })
        }
        cursor = res.response_metadata?.next_cursor || undefined
        if (!cursor) break
      }
      return { members }
    },

    /** Fetch recent messages from a channel. Requires the matching history scope.
     *  Form-encoded: GET-family — a JSON body loses the required `channel`. */
    conversationsHistory: (
      channel: string,
      opts?: { limit?: number; latest?: string; oldest?: string; inclusive?: boolean },
    ) =>
      callForm<{ messages: SlackConversationMessage[] }>(
        'conversations.history',
        {
          channel,
          limit: opts?.limit ?? 20,
          latest: opts?.latest,
          oldest: opts?.oldest,
          inclusive: opts?.inclusive,
        },
      ),

    /**
     * Read one Slack thread with bounded cursor pagination. Slack returns the
     * root first; when the requested output window is smaller than the thread,
     * retain that root plus the newest replies so both the referent and current
     * discussion survive. The page ceiling prevents an unexpectedly huge
     * thread from spinning a channel turn indefinitely.
     *
     * Slack may reject bot tokens for public/private channel threads even when
     * the corresponding `*:history` scope is present. The channel route owns
     * that provider-specific root-only fallback because it can also consult
     * the locally stored provider-message id; this client reports the rejection
     * honestly as `SlackApiError`.
     */
    conversationsReplies: async (
      channel: string,
      threadTs: string,
      opts?: { limit?: number },
    ): Promise<SlackThreadMessages> => {
      const outputLimit = Math.min(Math.max(opts?.limit ?? 50, 1), 100)
      const pageLimit = Math.max(outputLimit, 100)
      const collected: SlackConversationMessage[] = []
      let cursor: string | undefined
      let providerHasMore = false

      for (let page = 0; page < 10; page++) {
        const res = await callForm<{
          messages?: SlackConversationMessage[]
          has_more?: boolean
          response_metadata?: { next_cursor?: string }
        }>('conversations.replies', {
          channel,
          ts: threadTs,
          limit: pageLimit,
          cursor,
        })
        collected.push(...(res.messages ?? []))
        providerHasMore = res.has_more === true
        cursor = res.response_metadata?.next_cursor || undefined
        if (!cursor) break
      }

      const byTs = new Map<string, SlackConversationMessage>()
      for (const message of collected) byTs.set(message.ts, message)
      const chronological = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts))
      const root = chronological.find((message) => message.ts === threadTs)
      let messages = chronological
      if (chronological.length > outputLimit) {
        if (outputLimit === 1) {
          messages = root ? [root] : chronological.slice(-1)
        } else {
          const newest = chronological
            .filter((message) => message.ts !== root?.ts)
            .slice(-(outputLimit - 1))
          messages = root ? [root, ...newest] : chronological.slice(-outputLimit)
        }
      }

      return {
        messages,
        truncated: Boolean(cursor) || providerHasMore || chronological.length > messages.length,
      }
    },

    // ── File upload (external upload flow) ─────────────────────────
    // The three-step replacement for the deprecated `files.upload`:
    // getUploadURLExternal → POST bytes to the returned URL →
    // completeUploadExternal. Requires the `files:write` scope on the
    // BYO app. See adapter-pattern.md → "Outbound documents".

    /** Step 1: mint a one-time upload URL for a file of `length` bytes. */
    getUploadURLExternal: (filename: string, length: number) =>
      callForm<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', {
        filename,
        length: String(length),
      }),

    /** Step 2: POST the raw bytes to the minted URL (not a Web API method — no envelope). */
    uploadToExternalURL: async (uploadUrl: string, data: Uint8Array): Promise<void> => {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
      })
      if (!res.ok) {
        // Structured like every other Slack failure so describeSlackError's
        // `http_*` branch renders it (transient upload-host error, retry once).
        throw new SlackApiError({
          method: 'files.uploadToExternalURL',
          code: `http_${res.status}`,
          httpStatus: res.status,
        })
      }
    },

    /** Step 3: finalize and share the upload into a channel/thread. */
    completeUploadExternal: (
      files: Array<{ id: string; title?: string }>,
      opts?: { channelId?: string; threadTs?: string },
    ) =>
      call<{ files: Array<{ id: string }> }>('files.completeUploadExternal', {
        files,
        channel_id: opts?.channelId,
        thread_ts: opts?.threadTs,
      }),
  }
}

export type SlackApi = ReturnType<typeof createSlackApi>
