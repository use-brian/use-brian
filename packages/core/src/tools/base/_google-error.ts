/**
 * Google API failures as STRUCTURED errors + the model-facing translation.
 *
 * Every Google product client in `packages/api/src/google/client.ts`
 * (Calendar, Gmail, Tasks, Drive, Docs, Sheets, Slides, plus the OAuth
 * token endpoint) used to throw `new Error(\`<Api> API error (<status>):
 * <raw body>\`)` — the whole JSON envelope, untranslated — and every tool
 * wrapped it as `<Product> error: <that>`. The model then read
 * `Calendar error: Calendar API error (404): {"error":{"code":404,"message":
 * "Not Found","errors":[{"domain":"global","reason":"notFound"}]}}` and had
 * to guess whether the id was stale, the account was wrong, or the token was
 * dead — usually retrying the same id.
 *
 * `GoogleApiError` keeps what Google actually said (`error.message`,
 * `error.errors[0].reason`, `error.status`), capped so a stray HTML error page
 * cannot flood the context, and `describeGoogleError` renders it by status as
 * the three-part failure copy every tool result owes the model (see
 * docs/architecture/engine/tool-executor.md → "Failure copy"): WHAT failed
 * (product + operation + target), WHY (a diagnosis, with the code kept in
 * parentheses for grep and for the connector-health classifier), the NEXT
 * STEP (which id / field to fix, which sibling tool discovers a valid id, or
 * "reconnect"), and a RETRY VERDICT.
 *
 * The parenthesized status and the dead-credential phrasing on 401 /
 * `invalid_grant` are load-bearing: `packages/api/src/mcp/connector-health.ts`
 * (`classifyConnectorAuthError`) string-matches `(401)` and `invalid or
 * expired` / `invalid_grant` / `expired or revoked` on the flattened tool
 * result to flip a connector to `auth_failed`, and 403 / 429 copy must keep a
 * "not accessible" / "rate limit" phrase so a per-item refusal never marks a
 * live connector dead. See the D2 tests in `__tests__/google-error.test.ts`.
 *
 * Lives in core (not `packages/api`) because the tools that catch it are in
 * core and core cannot import api; the api client constructs it via
 * `googleApiError(res, api, operation)` in `google/client.ts`.
 *
 * Component tag: [COMP:tools/google-error].
 */

/** Which Google API answered — the `<Api> API error (<status>)` prefix. */
export type GoogleApiProduct =
  | 'Calendar'
  | 'Gmail'
  | 'Tasks'
  | 'Drive'
  | 'Docs'
  | 'Sheets'
  | 'Slides'
  | 'Google'

/** Longest slice of Google's own wording that reaches the model. */
export const GOOGLE_ERROR_MESSAGE_CAP = 200

export type GoogleApiErrorInit = {
  api: GoogleApiProduct
  status: number
  /** Google's `error.message` (or the raw body when it was not JSON). Capped. */
  message: string
  /**
   * `error.errors[0].reason` / `error.details[].reason` / OAuth `error` —
   * `notFound`, `insufficientPermissions`, `rateLimitExceeded`,
   * `invalid_grant`, ….
   */
  reason?: string
  /** `error.status` — the gRPC-style code (`NOT_FOUND`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`). */
  googleStatus?: string
  /** What the client was doing (`export`, `download`, `batchUpdate`) — part of the prefix. */
  operation?: string
}

export class GoogleApiError extends Error {
  readonly api: GoogleApiProduct
  readonly status: number
  readonly reason?: string
  readonly googleStatus?: string
  readonly operation?: string
  /** Google's own words, capped — the `message` minus our prefix. */
  readonly detail: string

  constructor(init: GoogleApiErrorInit) {
    const detail = capMessage(init.message)
    // The `<Api> API [op] error (<status>): <detail>` prefix is load-bearing:
    // callers and tests match on it (`Calendar API error (400)`) and the
    // health classifier reads the parenthesized status. The reason rides at
    // the end when Google's message does not already carry it — callers
    // that branch on a reason by substring (the calendar poller's
    // `updatedMinTooLongAgo` sync-token recovery) keep working.
    const reasonTail = init.reason && !detail.includes(init.reason) ? ` [${init.reason}]` : ''
    super(`${init.api} API${init.operation ? ` ${init.operation}` : ''} error (${init.status}): ${detail}${reasonTail}`)
    this.name = 'GoogleApiError'
    this.api = init.api
    this.status = init.status
    this.reason = init.reason
    this.googleStatus = init.googleStatus
    this.operation = init.operation
    this.detail = detail
  }
}

export function isGoogleApiError(err: unknown): err is GoogleApiError {
  return err instanceof GoogleApiError
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'GoogleApiError'
      && typeof (err as { status?: unknown }).status === 'number')
}

function capMessage(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat.length <= GOOGLE_ERROR_MESSAGE_CAP) return flat
  return `${flat.slice(0, GOOGLE_ERROR_MESSAGE_CAP - 1)}…`
}

/**
 * Parse a Google error body. Handles the REST envelope
 * (`{ error: { code, message, status, errors:[{reason}], details:[{reason}] } }`),
 * the OAuth token endpoint shape (`{ error: 'invalid_grant', error_description }`),
 * and a non-JSON body (HTML error page, plain text) — the raw text is capped.
 * Pure so the api client and tests can share it.
 */
export function parseGoogleErrorBody(raw: string): { message: string; reason?: string; googleStatus?: string } {
  const text = raw ?? ''
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed as {
        error?: unknown
        error_description?: unknown
      }
      const error = envelope.error
      if (typeof error === 'string') {
        // OAuth token endpoint: { error: 'invalid_grant', error_description: '…' }
        const description = typeof envelope.error_description === 'string' ? envelope.error_description : ''
        return { message: description ? `${error}: ${description}` : error, reason: error }
      }
      if (error && typeof error === 'object') {
        const e = error as {
          message?: unknown
          status?: unknown
          errors?: unknown
          details?: unknown
        }
        const first = Array.isArray(e.errors) ? (e.errors[0] as { reason?: unknown } | undefined) : undefined
        let reason = typeof first?.reason === 'string' ? first.reason : undefined
        if (!reason && Array.isArray(e.details)) {
          const detailed = (e.details as Array<{ reason?: unknown }>).find((d) => typeof d?.reason === 'string')
          reason = detailed?.reason as string | undefined
        }
        return {
          message: typeof e.message === 'string' && e.message ? e.message : text,
          reason,
          googleStatus: typeof e.status === 'string' ? e.status : undefined,
        }
      }
    }
  } catch {
    // not JSON — fall through
  }
  return { message: text || '(empty response body)' }
}

// ── Rendering ─────────────────────────────────────────────────

const PRODUCT_DISPLAY: Record<GoogleApiProduct, string> = {
  Calendar: 'Google Calendar',
  Gmail: 'Gmail',
  Tasks: 'Google Tasks',
  Drive: 'Google Drive',
  Docs: 'Google Docs',
  Sheets: 'Google Sheets',
  Slides: 'Google Slides',
  Google: 'Google',
}

export type GoogleFailureContext = {
  /** The tool that was running — the "what". */
  tool: string
  /** Which product the tool speaks to; defaults to the error's own `api`. */
  product?: GoogleApiProduct
  /** The id / range / field the call was about, e.g. `event abc123`, `spreadsheet 1x…!Sheet1!A1:B2`. */
  target?: string
  /** The sibling tool that discovers a valid id for `target` (rendered on 404 / conflict). */
  discoveryTool?: string
}

const RECONNECT = 'Studio → Connectors'

const SCOPE_REASONS = new Set([
  'insufficientPermissions',
  'insufficientScopes',
  'accessNotConfigured',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'SERVICE_DISABLED',
])
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
])

function looksLikeScopeLoss(err: GoogleApiError): boolean {
  if (err.reason && SCOPE_REASONS.has(err.reason)) return true
  return /insufficient (authentication )?scopes?|insufficient permission|access not configured|has not been used in project|is disabled|enable it by visiting/i.test(err.detail)
}

function looksLikeRateLimit(err: GoogleApiError): boolean {
  if (err.status === 429) return true
  if (err.reason && RATE_REASONS.has(err.reason)) return true
  return /rate limit|quota exceeded|too many requests/i.test(err.detail)
}

/** Transient transport failures a plain `fetch` throws — no HTTP status at all. */
function looksLikeNetworkBlip(message: string): boolean {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|aborted|The operation was aborted|UND_ERR/i.test(message)
}

/**
 * Render any error a Google tool caught as model-actionable text.
 * `GoogleApiError` is rendered by status; a plain error (client-side
 * validation, "not connected", a network blip) is framed with the tool and
 * a verdict but its message is passed through — those strings are already
 * sentences the client composed for the model.
 */
/**
 * A plain `Error` whose message already carries the client's legacy prefix
 * (`Tasks API error (401): Unauthorized`) — thrown by older callers, test
 * doubles, or a sibling package that pre-dates `GoogleApiError` — is
 * upgraded to the structured shape so it still gets the per-status rendering
 * instead of the plain-error frame.
 */
const LEGACY_PREFIX = /^(Calendar|Gmail|Tasks|Drive|Docs|Sheets|Slides|Google)(?: API)?(?: ([a-z][\w ]*?))? error \((\d{3})\):\s*([\s\S]*)$/
function coerceGoogleApiError(err: unknown): GoogleApiError | undefined {
  if (isGoogleApiError(err)) return err
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined
  if (!message) return undefined
  const m = LEGACY_PREFIX.exec(message)
  if (!m) return undefined
  const parsed = parseGoogleErrorBody(m[4])
  return new GoogleApiError({
    api: m[1] as GoogleApiProduct,
    operation: m[2]?.trim() || undefined,
    status: Number(m[3]),
    message: parsed.message,
    reason: parsed.reason,
    googleStatus: parsed.googleStatus,
  })
}

export function describeGoogleError(rawErr: unknown, ctx: GoogleFailureContext): string {
  const err = coerceGoogleApiError(rawErr) ?? rawErr
  const product = PRODUCT_DISPLAY[ctx.product ?? (isGoogleApiError(err) ? err.api : 'Google')]
  const doing = ctx.target ? `\`${ctx.tool}\` on ${ctx.target}` : `\`${ctx.tool}\``
  const discover = ctx.discoveryTool
    ? `Call \`${ctx.discoveryTool}\` to get a current id.`
    : 'Ask the user to confirm the id.'

  if (!isGoogleApiError(err)) {
    const message = err instanceof Error ? err.message : String(err)
    if (looksLikeNetworkBlip(message)) {
      return `${product} could not be reached for ${doing} (${message}). Nothing about the input is wrong — this is a network blip. Retry once after a short wait; if it persists, tell the user.`
    }
    return `${product} ${doing} failed: ${message} This was refused before or after the Google call rather than by Google itself, so retrying the same arguments will not help — fix what the message names, or ask the user.`
  }

  const code = `${err.api} API${err.operation ? ` ${err.operation}` : ''} error (${err.status})${err.reason ? `, ${err.reason}` : ''}`
  const said = err.detail ? ` Google said: "${err.detail}".` : ''

  // invalid_grant — the OAuth token endpoint refused the refresh token. The
  // whole grant is dead; no product call can succeed until reconnected.
  if (err.reason === 'invalid_grant' || /invalid_grant/.test(err.detail)) {
    return `The Google grant behind ${product} has expired or been revoked (invalid_grant), so ${doing} — and every other ${product} call — will fail until the user reconnects it (${RECONNECT}). Do not retry; tell the user to reconnect.`
  }

  switch (true) {
    case err.status === 401 || err.googleStatus === 'UNAUTHENTICATED' || err.reason === 'authError':
      return `${product} rejected this connector's credential while running ${doing} (${code}): the Google grant is invalid or expired.${said} Reconnect ${product} (${RECONNECT}) — retrying will not help until it is reconnected.`

    case err.status === 404 || err.googleStatus === 'NOT_FOUND' || err.reason === 'notFound':
      return `${product} could not find ${ctx.target ?? 'the requested item'} for ${doing} (${code}).${said} Either the id is wrong, the item was deleted, or it belongs to an account this connector cannot see. ${discover} Retrying this exact id will keep failing.`

    case looksLikeRateLimit(err):
      return `${product} rate limit hit while running ${doing} (${code}).${said} Nothing about the input is wrong — this is a rate limit / quota throttle. Wait a few seconds and retry the same call once; do not loop.`

    case err.status === 403 && looksLikeScopeLoss(err):
      return `${product} refused ${doing} (${code}): the connector's Google grant lacks the permission scope this call needs, or the API is not enabled for it.${said} Reconnect ${product} (${RECONNECT}) to re-grant access — the same call will keep failing until then, so do not retry now; tell the user.`

    case err.status === 403:
      return `${product} refused ${doing} (${code}): the resource is not accessible to this connector's Google account.${said} This is a permission on ${ctx.target ?? 'that specific item'}, not a problem with the connector as a whole — ask the user to share it with the connected account or pick another item. Retrying unchanged will fail the same way.`

    case err.status === 409 || err.status === 412 || err.googleStatus === 'ABORTED' || err.googleStatus === 'FAILED_PRECONDITION':
      return `${product} rejected ${doing} because of a conflict (${code}): the item changed since it was read, or a precondition no longer holds.${said} Re-read it${ctx.discoveryTool ? ` (\`${ctx.discoveryTool}\`)` : ''} and retry once with current data; do not resend the same request blind.`

    case err.status === 413:
      return `${product} rejected ${doing} because the payload is too large (${code}).${said} Reduce the size (fewer rows, smaller attachment, shorter body) and retry; the same payload will fail the same way.`

    case err.status === 408 || err.status >= 500:
      return `${product} failed ${doing} with a server-side error (${code}).${said} Nothing about the input is wrong — this is transient. Retry once after a short wait; if it persists, tell the user Google is having trouble.`

    case err.status === 400 || err.status === 422 || err.googleStatus === 'INVALID_ARGUMENT':
      return `${product} rejected the request for ${doing} (${code}).${said} Fix the field that message names before retrying — the same input will fail the same way.`

    default:
      return `${product} failed ${doing} (${code}).${said} Check the arguments against that message before retrying; the same input will fail the same way.`
  }
}

/** `{ data, isError: true }` frame around `describeGoogleError` — what every Google tool's `catch` returns. */
export function googleFailure(err: unknown, ctx: GoogleFailureContext): { data: string; isError: true } {
  return { data: describeGoogleError(err, ctx), isError: true }
}
