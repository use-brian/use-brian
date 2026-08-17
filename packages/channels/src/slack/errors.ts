/**
 * Slack Web API failures as STRUCTURED errors + a model-facing translation.
 *
 * Slack answers every failure with `{ ok: false, error: '<code>' }` — a bare
 * snake_case code (`invalid_arguments`, `channel_not_found`, `missing_scope`)
 * that names neither what was wrong nor what to do about it. When that code
 * reaches the model verbatim (`Slack: invalid_arguments`, prod 2026-08-17 on
 * `listSlackChannels`) the model has to guess: was the token bad? the id?
 * the request shape? It retries blind, and a retry that happens to omit the
 * offending argument "works", teaching nothing.
 *
 * Slack does ship the detail — just not in `error`:
 *   - `response_metadata.messages` carries the validator's line for
 *     `invalid_arguments` (e.g. `[ERROR] invalid `channel` value`), and
 *   - `needed` / `provided` carry the scope gap for `missing_scope`,
 *   - the `Retry-After` header carries the wait for `ratelimited`.
 *
 * `SlackApiError` keeps all of that; `describeSlackError` renders it as the
 * three-part failure copy every tool result owes the model (see
 * docs/architecture/engine/tool-executor.md → "Failure copy"): WHAT failed
 * (method + target), WHY (plain-language diagnosis of the code), and the
 * NEXT STEP (which field to fix / which tool discovers a valid id / whether a
 * retry can ever succeed).
 *
 * Component tag: [COMP:channels/slack-errors].
 */

/** The subset of call arguments worth echoing back in a failure message. */
export type SlackErrorTarget = {
  channel?: string
  user?: string
  ts?: string
}

export type SlackApiErrorInit = {
  method: string
  code: string
  /** `response_metadata.messages` — Slack's own validator lines. */
  detail?: string[]
  /** `missing_scope` → the scope Slack wanted. */
  needed?: string
  /** `missing_scope` → the scopes the token actually has. */
  provided?: string
  /** `ratelimited` → seconds from the `Retry-After` header. */
  retryAfterSec?: number
  /** HTTP status when the failure was transport-level (non-2xx, non-JSON). */
  httpStatus?: number
  target?: SlackErrorTarget
}

export class SlackApiError extends Error {
  readonly method: string
  readonly code: string
  readonly detail: string[]
  readonly needed?: string
  readonly provided?: string
  readonly retryAfterSec?: number
  readonly httpStatus?: number
  readonly target: SlackErrorTarget

  constructor(init: SlackApiErrorInit) {
    // The `Slack API <method>: <code>` prefix is load-bearing: callers and
    // tests match on it (`/channel_not_found/`), and the audit trail stores
    // it. The validator detail rides after it so a raw log line is already
    // more useful than the bare code.
    const detail = (init.detail ?? []).map((m) => m.trim()).filter(Boolean)
    super(
      `Slack API ${init.method}: ${init.code}${detail.length ? ` (${detail.join('; ')})` : ''}`,
    )
    this.name = 'SlackApiError'
    this.method = init.method
    this.code = init.code
    this.detail = detail
    this.needed = init.needed
    this.provided = init.provided
    this.retryAfterSec = init.retryAfterSec
    this.httpStatus = init.httpStatus
    this.target = init.target ?? {}
  }
}

export function isSlackApiError(err: unknown): err is SlackApiError {
  return err instanceof SlackApiError
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'SlackApiError'
      && typeof (err as { code?: unknown }).code === 'string')
}

/**
 * Slack conversation ids are `C…` (public), `G…` (private / legacy mpim),
 * `D…` (DM). Anything else — `#general`, `general`, an internal UUID — is
 * not something `conversations.info` / `chat.postMessage` will accept.
 */
export function looksLikeSlackConversationId(value: string): boolean {
  return /^[CGD][A-Z0-9]{6,}$/.test(value.trim())
}

/** Slack member ids are `U…` (users) or `W…` (Enterprise Grid). */
export function looksLikeSlackMemberId(value: string): boolean {
  return /^[UW][A-Z0-9]{6,}$/.test(value.trim())
}

/**
 * Codes that mean "the bot's credential is unusable" — retrying the same call
 * cannot help; the workspace has to reconnect Slack.
 */
export const SLACK_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'org_login_required',
])

/** Codes that are transient — a later retry can succeed. */
export const SLACK_TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ratelimited',
  'internal_error',
  'service_unavailable',
  'fatal_error',
  'request_timeout',
])

const RECONNECT_HINT =
  'Reconnect Slack for this workspace (Studio → Channels → Slack) — retrying the same call will not help until the token is replaced.'
const BROWSE_HINT =
  'Call `listSlackChannels` with NO `channelId` to browse the channels this bot can see and pick a real id (a Slack `C…`/`G…` id, never a `#name` or an internal channel UUID).'
const MEMBERS_HINT =
  'Call `listSlackMembers` and use the exact `U…` id from that list.'

/**
 * Render a Slack failure as model-actionable text. `fallback` (any non-Slack
 * error) is passed through as its message so callers can funnel every catch
 * through here.
 */
export function describeSlackError(err: unknown): string {
  if (!isSlackApiError(err)) {
    return err instanceof Error ? err.message : String(err)
  }
  const { method, code, detail, target } = err
  const channel = target.channel ? `\`${target.channel}\`` : 'the requested channel'
  const detailText = detail.length ? ` Slack's detail: ${detail.join('; ')}.` : ''

  switch (code) {
    case 'invalid_arguments': {
      // The one code that most needs the validator line — Slack rejected the
      // request SHAPE, not the auth. On the conversation methods the usual
      // cause is a non-id `channel` value.
      const idHint = target.channel && !looksLikeSlackConversationId(target.channel)
        ? ` \`${target.channel}\` is not a Slack conversation id (those look like \`C0123ABCD\` / \`G…\` / \`D…\`). ${BROWSE_HINT}`
        : target.user && !looksLikeSlackMemberId(target.user)
          ? ` \`${target.user}\` is not a Slack member id (those look like \`U0123ABCD\`). ${MEMBERS_HINT}`
          : ' Fix the offending argument before retrying — the same input will fail the same way.'
      return `Slack rejected the arguments of \`${method}\` (invalid_arguments).${detailText}${idHint}`
    }
    case 'channel_not_found':
      return `Slack has no conversation ${channel} that this bot can see (channel_not_found on \`${method}\`). Either the value is not a Slack channel id, the channel was deleted, or the bot's Slack workspace is a different one. ${BROWSE_HINT} If the channel is private, the bot must be invited (\`/invite @<bot>\`) before it can appear or be posted to.`
    case 'not_in_channel':
      return `The bot is not a member of ${channel} (not_in_channel on \`${method}\`), so it cannot post or read there. Ask a member to run \`/invite @<bot>\` in that channel, then retry with the same id.`
    case 'is_archived':
      return `Slack channel ${channel} is archived (is_archived on \`${method}\`); nothing can be posted there until someone unarchives it. Pick a different channel — ${BROWSE_HINT}`
    case 'missing_scope': {
      const scope = err.needed ? `\`${err.needed}\`` : 'a required OAuth scope'
      const has = err.provided ? ` (token has: ${err.provided})` : ''
      return `The Slack app's token lacks the ${scope} scope needed for \`${method}\` (missing_scope)${has}. Add the scope to the Slack app and reinstall / re-authorize it — retrying will not help until the token carries that scope. Tell the user which scope is missing.`
    }
    case 'ratelimited': {
      const wait = err.retryAfterSec ? `${err.retryAfterSec}s` : 'a few seconds'
      return `Slack rate-limited \`${method}\` (ratelimited). This is transient: wait ${wait}, then retry the same call once. Do not loop.`
    }
    case 'msg_too_long':
      return `Slack rejected the message for \`${method}\` because it exceeds Slack's per-message length limit (msg_too_long). Split the text into shorter messages and resend.`
    case 'user_not_found':
      return `Slack has no member ${target.user ? `\`${target.user}\`` : 'with that id'} (user_not_found on \`${method}\`). ${MEMBERS_HINT}`
    case 'restricted_action':
    case 'restricted_action_read_only_channel':
    case 'restricted_action_thread_only_channel':
    case 'restricted_action_non_threadable_channel':
      return `Slack workspace policy blocks the bot from this action in ${channel} (${code} on \`${method}\`). A Slack admin must change the channel posting permissions; retrying will not help. Tell the user.`
    case 'channel_is_archived':
      return `Slack channel ${channel} is archived (${code} on \`${method}\`); pick a different channel — ${BROWSE_HINT}`
    default:
      break
  }

  if (SLACK_AUTH_ERROR_CODES.has(code)) {
    return `Slack rejected the bot token used for \`${method}\` (${code}) — the Slack connection is invalid, revoked, or the workspace/app was removed. ${RECONNECT_HINT}`
  }
  if (SLACK_TRANSIENT_ERROR_CODES.has(code)) {
    return `Slack failed \`${method}\` with a transient error (${code}). Retry once after a short wait; if it persists, tell the user Slack is having trouble.`
  }
  if (code.startsWith('http_')) {
    return `Slack's API returned HTTP ${err.httpStatus ?? code.slice(5)} for \`${method}\` instead of a normal response. This is usually a transient Slack-side problem: retry once; if it persists, tell the user.`
  }
  return `Slack failed \`${method}\` with error code \`${code}\`.${detailText} Slack's own error catalogue is at https://docs.slack.dev/reference/methods/${method} — check the arguments named there before retrying; the same input will fail the same way.`
}
