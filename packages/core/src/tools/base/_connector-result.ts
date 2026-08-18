/**
 * Shared helpers for projecting raw connector API responses down to the
 * concise, model-relevant shape each tool's description already promises.
 *
 * Connector list/search endpoints (GitHub repo search, Gmail message lists,
 * Drive file lists, Notion query results, …) return large raw provider JSON:
 * arrays of full objects, each carrying dozens of URL / metadata / nested
 * sub-objects the model never needs. Feeding that verbatim into the agent
 * loop bloats context and re-reads it on every subsequent internal turn,
 * which is what drove the cache-read cost blow-up in the 2026-06-10
 * "AI Prof Service" incident. We do **not** blunt-truncate the payload; we
 * select the fields that matter, per tool, so the model gets *precise*
 * information instead of a 60 KB blob.
 *
 * See docs/architecture/integrations/mcp.md → "Connector result projection".
 */

/** Strict-safe view of an unknown JSON object. */
export type Json = Record<string, unknown>

/** Coerce an unknown value to an array of JSON objects (empty if not array). */
export function asRows(v: unknown): Json[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'object' && x !== null) as Json[]) : []
}

/** Read a string field, or undefined if absent / wrong type. */
export function str(o: Json | undefined, key: string): string | undefined {
  const v = o?.[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * Read an id field that may arrive as a string OR a number, coerced to a
 * string. Several providers return numeric ids (e.g. Fathom `recording_id`
 * is an integer); `str()` would silently drop those, leaving the model with
 * no id to make per-resource follow-up calls. Use this for id-shaped fields.
 */
export function idStr(o: Json | undefined, key: string): string | undefined {
  const v = o?.[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

/** Read a numeric field, or undefined if absent / wrong type. */
export function num(o: Json | undefined, key: string): number | undefined {
  const v = o?.[key]
  return typeof v === 'number' ? v : undefined
}

/** Read a boolean field, or undefined if absent / wrong type. */
export function bool(o: Json | undefined, key: string): boolean | undefined {
  const v = o?.[key]
  return typeof v === 'boolean' ? v : undefined
}

/** Read a nested object field as a Json view (undefined if absent). */
export function obj(o: Json | undefined, key: string): Json | undefined {
  const v = o?.[key]
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined
}

/**
 * Project a list of raw rows to a concise shape and cap it, reporting how
 * many matched so the model knows whether to paginate rather than assuming it
 * saw everything. `total` overrides the matched count when the provider
 * reports a separate total (e.g. GitHub search's `total_count`, which exceeds
 * the returned page). `truncated` is true when rows were dropped.
 */
export function projectList<U>(
  rows: Json[],
  limit: number,
  map: (row: Json) => U,
  total?: number,
): { matched: number; returned: number; truncated: boolean; items: U[] } {
  const capped = rows.slice(0, Math.max(0, limit))
  const matched = total ?? rows.length
  return {
    matched,
    returned: capped.length,
    truncated: matched > capped.length,
    items: capped.map(map),
  }
}

/** Map each entry in a nested array field to a primitive (e.g. labels → names). */
export function mapField<U>(o: Json | undefined, key: string, map: (row: Json) => U): U[] {
  return asRows(o?.[key]).map(map)
}

// ── Failure copy: `ConnectorApiError` + `connectorError()` ─────────────────
//
// The other half of the projection story above: what the model reads when a
// connector call FAILS. Every built-in connector tool used to return
// `${Provider} error: ${err.message}` — exactly as good as the client's
// message and no better, and the clients threw the raw provider body
// (`GitHub API error (422): {"message":"Validation Failed","errors":[…]}`).
// The model then had to guess between a bad argument, a dead credential and a
// missing capability, and usually retried blind.
//
// The contract (docs/architecture/engine/tool-executor.md → "Failure copy"):
// the API client that knows the provider's vocabulary throws a structured
// `ConnectorApiError` (status, code, field, capped message, retry-after — or
// a `kind` when the client can classify better than the status can), and
// every tool's `catch` returns `connectorError({ provider, tool, target,
// discoveryTool, err })`, which renders WHAT failed, WHY, the NEXT STEP and a
// RETRY VERDICT. Provider-specific vocabulary (GitHub's SAML wording, Notion's
// `object_not_found`, Shopify's `userErrors`) is handled by the client — the
// tool passes at most a `translate` hook for copy that needs the tool's own
// context.
//
// Markers the health classifier keys on (`packages/api/src/mcp/connector-health.ts`)
// are preserved by construction: every auth rendering carries `(401)` (or the
// provider's own status) plus a dead-credential phrase; per-resource 403 copy
// carries `not accessible`; rate-limit copy carries `rate limit`. See the
// per-provider D2 tests.
//
// Component tag: [COMP:tools/connector-error].

/** How a connector failure should be read, when the client can say better than the HTTP status. */
export type ConnectorFailureKind =
  | 'not_connected'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'transient'
  | 'validation'
  | 'conflict'
  | 'too_large'
  | 'permanent'
  | 'unknown'

/** Longest slice of a provider's own wording that reaches the model. */
export const CONNECTOR_ERROR_MESSAGE_CAP = 300

export type ConnectorApiErrorInit = {
  /** Display name: `GitHub`, `Notion`, `Microsoft Teams`, `Shopify`, `Fathom`, `AgentMail`. */
  provider: string
  /** HTTP status when the failure was an HTTP rejection. */
  status?: number
  /** Provider code: `object_not_found`, `validation_failed`, `THROTTLED`, `invalid_grant`, … */
  code?: string
  /** The provider's own message (capped). */
  message: string
  /** Field / path the provider named, when it did. */
  field?: string
  /** `Retry-After` seconds on a throttle. */
  retryAfterSec?: number
  /** Explicit classification when the client knows better than the status. */
  kind?: ConnectorFailureKind
}

export class ConnectorApiError extends Error {
  readonly provider: string
  readonly status?: number
  readonly code?: string
  readonly field?: string
  readonly retryAfterSec?: number
  readonly kind?: ConnectorFailureKind
  /** The provider's own words, capped — the `message` minus our prefix. */
  readonly detail: string

  constructor(init: ConnectorApiErrorInit) {
    const detail = capConnectorMessage(init.message)
    // `<Provider> API error (<status>): <detail>` — the legacy prefix callers
    // and tests match on, and where the health classifier reads the status.
    super(`${init.provider} API error${init.status ? ` (${init.status})` : ''}: ${detail}`)
    this.name = 'ConnectorApiError'
    this.provider = init.provider
    this.status = init.status
    this.code = init.code
    this.field = init.field
    this.retryAfterSec = init.retryAfterSec
    this.kind = init.kind
    this.detail = detail
  }
}

export function isConnectorApiError(err: unknown): err is ConnectorApiError {
  return err instanceof ConnectorApiError
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ConnectorApiError'
      && typeof (err as { provider?: unknown }).provider === 'string')
}

export function capConnectorMessage(message: string, cap = CONNECTOR_ERROR_MESSAGE_CAP): string {
  const flat = (message ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= cap) return flat
  return `${flat.slice(0, cap - 1)}…`
}

export type ConnectorErrorContext = {
  /** Display name of the provider the tool speaks to. */
  provider: string
  /** The tool that was running — the "what". */
  tool: string
  /** The id / path / field the call was about, e.g. `repo \`o/r\` issue #12`, `page \`abc\``. */
  target?: string
  /** The sibling tool that discovers a valid id for `target` (rendered on not-found / conflict). */
  discoveryTool?: string
  /**
   * The tool writes: the verdict says outright that nothing was changed /
   * sent, so the model never reports a write that did not happen.
   */
  mutating?: boolean
  /**
   * Provider- or tool-specific copy for a code the generic rendering cannot
   * phrase well. Return a full sentence to replace the rendering, or
   * `undefined` to fall through.
   */
  translate?: (err: ConnectorApiError) => string | undefined
}

const RECONNECT_AT = 'Studio → Connectors'
const LEGACY_CONNECTOR_PREFIX = /^([A-Z][\w .]*?)(?: API)?(?: (?:auth|upload|token endpoint))? (?:error|failed)(?: \((\d{3})\))?: ?([\s\S]*)$/

/** Transient transport failures a plain `fetch` throws — no HTTP status at all. */
function isNetworkBlip(message: string): boolean {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|The operation was aborted|UND_ERR/i.test(message)
}

/**
 * Bring any thrown value into the structured shape: a `ConnectorApiError` as
 * is; a provider error class that carries a numeric `status` (`MsGraphError`,
 * `AgentmailApiError`) by its status + message; a plain `Error` whose message
 * carries the legacy `<Provider> API error (<status>): …` prefix by parsing
 * it. Returns `undefined` for anything else (a client-side validation
 * sentence, "not connected", a network blip).
 */
export function coerceConnectorError(err: unknown, provider: string): ConnectorApiError | undefined {
  if (isConnectorApiError(err)) return err
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined
  if (message === undefined) return undefined
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number') {
    const stripped = message.replace(LEGACY_CONNECTOR_PREFIX, (_m, _p, _s, rest: string) => rest)
    return new ConnectorApiError({ provider, status, message: stripped || message })
  }
  const m = LEGACY_CONNECTOR_PREFIX.exec(message)
  if (m && m[2]) return new ConnectorApiError({ provider, status: Number(m[2]), message: m[3] || message })
  // `GitHub PAT is invalid or revoked (401): Bad credentials` — a provider
  // sentence that still carries the status in parentheses.
  const paren = /\((\d{3})\)/.exec(message)
  if (paren && message.toLowerCase().startsWith(provider.toLowerCase().split(' ')[0])) {
    return new ConnectorApiError({ provider, status: Number(paren[1]), message })
  }
  return undefined
}

function kindOf(err: ConnectorApiError): ConnectorFailureKind {
  if (err.kind) return err.kind
  const s = err.status
  if (s === 401) return 'auth'
  if (s === 403) return /rate limit|too many requests|throttl/i.test(err.detail) ? 'rate_limit' : 'forbidden'
  if (s === 404 || s === 410) return 'not_found'
  if (s === 429) return 'rate_limit'
  if (s === 409 || s === 412) return 'conflict'
  if (s === 413) return 'too_large'
  if (s === 400 || s === 422) return 'validation'
  if (s === 408 || (s !== undefined && s >= 500)) return 'transient'
  if (/rate limit|throttl|too many requests/i.test(err.detail)) return 'rate_limit'
  if (/not connected/i.test(err.detail)) return 'not_connected'
  return 'unknown'
}

/**
 * Render any error a connector tool caught as model-actionable text — the
 * three parts and the verdict, by failure kind. `translate` runs first for a
 * structured error so a provider can phrase its own codes.
 */
export function describeConnectorError(rawErr: unknown, ctx: ConnectorErrorContext): string {
  const { provider } = ctx
  const doing = ctx.target ? `\`${ctx.tool}\` on ${ctx.target}` : `\`${ctx.tool}\``
  const discover = ctx.discoveryTool
    ? `Call \`${ctx.discoveryTool}\` to get a current id.`
    : 'Ask the user to confirm the id.'
  const unchanged = ctx.mutating ? ' Nothing was changed on the provider side.' : ''

  const err = coerceConnectorError(rawErr, provider)
  if (!err) {
    const message = rawErr instanceof Error ? rawErr.message : String(rawErr)
    // A token-refresh failure (`invalid_grant`) is a whole-connector
    // condition thrown outside the HTTP client — keep the literal code so the
    // health classifier flips the instance, and say reconnect / never retry.
    if (/invalid_grant/.test(message)) {
      return `The ${provider} grant behind this connector has expired or been revoked (invalid_grant), so ${doing} — and every other ${provider} call — will fail until the user reconnects it (${RECONNECT_AT}). ${message} Do not retry; tell the user to reconnect.`
    }
    if (/not connected/i.test(message)) {
      return `${provider} is not connected for this assistant, so ${doing} could not run. Nothing about the arguments is wrong and retrying will not help — ask the user to connect ${provider} (${RECONNECT_AT}) and try again once they confirm.`
    }
    if (isNetworkBlip(message)) {
      return `${provider} could not be reached for ${doing} (${message}). Nothing about the input is wrong — this is a network blip.${unchanged ? ' The request may or may not have reached the provider — check before repeating a write.' : ''} Retry once after a short wait; if it persists, tell the user.`
    }
    return `${provider} ${doing} failed: ${message}${/[.!?]$/.test(message) ? '' : '.'}${unchanged} Retrying the same arguments will not help — fix what the message names, or ask the user.`
  }

  const translated = ctx.translate?.(err)
  if (translated) return translated

  const code = `${provider} API error${err.status ? ` (${err.status})` : ''}${err.code ? `, ${err.code}` : ''}`
  const said = err.detail ? ` ${provider} said: "${err.detail}".` : ''
  const field = err.field ? ` The field ${provider} named is \`${err.field}\`.` : ''

  switch (kindOf(err)) {
    case 'not_connected':
      return `${provider} is not connected for this assistant, so ${doing} could not run. Nothing about the arguments is wrong and retrying will not help — ask the user to connect ${provider} (${RECONNECT_AT}) and try again once they confirm.`
    case 'auth':
      return `${provider} rejected this connector's credential while running ${doing} (${code}): the token is invalid or expired.${said} Reconnect ${provider} (${RECONNECT_AT}) — retrying will not help until it is reconnected.`
    case 'forbidden':
      return `${provider} refused ${doing} (${code}): the credential is alive but the resource is not accessible to it.${said} This is a permission on ${ctx.target ?? 'that specific resource'}, not a problem with the connector as a whole — ask the user to grant the connected account access (or pick another target). Retrying unchanged will fail the same way.`
    case 'not_found':
      return `${provider} has no ${ctx.target ?? 'such item'} that this connector can see (${code}).${said} Either the id is wrong, the item was deleted, or the connected account lacks access to it. ${discover} Retrying this exact id will keep failing.`
    case 'rate_limit': {
      const wait = err.retryAfterSec ? `${err.retryAfterSec}s` : 'a few seconds'
      return `${provider} rate limit hit while running ${doing} (${code}).${said} Nothing about the input is wrong — this is a rate limit / quota throttle. Wait ${wait}, then retry the same call once; do not loop.`
    }
    case 'transient':
      return `${provider} failed ${doing} with a server-side error (${code}).${said} Nothing about the input is wrong — this is transient.${ctx.mutating ? ' The write may or may not have been applied — read it back before repeating it.' : ''} Retry once after a short wait; if it persists, tell the user ${provider} is having trouble.`
    case 'validation':
      return `${provider} rejected the request for ${doing} (${code}).${said}${field}${unchanged} Fix the field that message names before retrying — the same input will fail the same way.`
    case 'conflict':
      return `${provider} rejected ${doing} because of a conflict (${code}): the item changed since it was read, or a precondition no longer holds.${said}${unchanged} Re-read it${ctx.discoveryTool ? ` (\`${ctx.discoveryTool}\`)` : ''} and retry once with current data; do not resend the same request blind.`
    case 'too_large':
      return `${provider} rejected ${doing} because the payload is too large (${code}).${said}${unchanged} Reduce the size and retry; the same payload will fail the same way.`
    case 'permanent':
      return `${provider} cannot do ${doing} (${code}).${said}${unchanged} This is a permanent limitation of the connected account or store, not a transient failure or a bad argument — do not retry; tell the user.`
    default:
      return `${provider} failed ${doing} (${code}).${said}${unchanged} Check the arguments against that message before retrying; the same input will fail the same way.`
  }
}

/** `{ data, isError: true }` frame around `describeConnectorError` — what every connector tool's `catch` returns. */
export function connectorError(ctx: ConnectorErrorContext & { err: unknown }): { data: string; isError: true } {
  const { err, ...rest } = ctx
  return { data: describeConnectorError(err, rest), isError: true }
}
