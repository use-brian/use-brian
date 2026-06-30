/**
 * Outbound auth headers for custom MCP connectors.
 *
 * Maps a stored `ConnectorCredentials` blob to the HTTP headers attached to
 * every outbound request to the connector's MCP URL (discovery and tool
 * calls). `oauth` and `none` produce no headers — the OAuth client flow is a
 * separate surface, and legacy oauth-shaped blobs must keep today's
 * no-header behavior exactly.
 *
 * Never throws and never logs secret values: malformed input degrades to
 * `{}` with a name-only warning, so one bad credential cannot take down
 * tool injection for the whole turn. Validation here is defense-in-depth —
 * the route layer rejects invalid names/values at write time, but blobs can
 * also be written by system paths or predate the validation.
 *
 * See docs/architecture/integrations/mcp.md → "Custom connector auth".
 * Component tag: [COMP:api/mcp-auth-headers].
 */

import type { ConnectorCredentials, OAuthCredentials } from '../db/connector-store.js'

/** RFC 7230 token — the only characters legal in an HTTP header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_HEADER_NAME_LENGTH = 128
const MAX_HEADER_VALUE_LENGTH = 8192

/**
 * Reserved outbound-header namespace for sidanclaw-asserted values (the actor
 * identity headers below). User-controllable config — `preflightHeadersToRecord`
 * — drops any header in this namespace so a user can't forge an identity claim
 * that a connector trusts for auth. Lowercase; matched case-insensitively.
 */
export const RESERVED_HEADER_PREFIX = 'x-sidanclaw-'

export function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_HEADER_NAME_LENGTH && HEADER_NAME_RE.test(name)
}

/** No CR/LF (header injection) and a sane size cap. Empty is invalid. */
export function isValidHeaderValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_HEADER_VALUE_LENGTH && !/[\r\n]/.test(value)
}

/**
 * Build the auth headers for one connector's outbound requests.
 * Accepts the normalized union, a legacy `{ client_id, client_secret }`
 * blob (no `type` discriminator → no headers), or null/undefined.
 */
export function buildConnectorAuthHeaders(
  creds: ConnectorCredentials | OAuthCredentials | null | undefined,
): Record<string, string> {
  if (!creds || typeof creds !== 'object' || !('type' in creds)) return {}

  switch (creds.type) {
    case 'bearer':
      if (typeof creds.token !== 'string' || !isValidHeaderValue(creds.token)) {
        console.warn('[mcp-auth] rejected invalid bearer token (empty, oversized, or contains CR/LF)')
        return {}
      }
      return { Authorization: `Bearer ${creds.token}` }

    case 'custom_header': {
      if (typeof creds.header !== 'string' || !isValidHeaderName(creds.header)) {
        console.warn('[mcp-auth] rejected invalid auth header name')
        return {}
      }
      if (typeof creds.value !== 'string' || !isValidHeaderValue(creds.value)) {
        console.warn(`[mcp-auth] rejected invalid value for auth header "${creds.header}"`)
        return {}
      }
      return { [creds.header]: creds.value }
    }

    case 'oauth':
    case 'none':
    default:
      return {}
  }
}

/**
 * Merge hook-supplied preflight header overrides over a connector's stored-
 * credential headers, the override winning on a (case-insensitive) name
 * clash. Overrides are untrusted (code- or, later, config-driven), so each
 * name/value is re-validated with the same RFC 7230 / no-CRLF guards the
 * stored-credential path uses; invalid entries are dropped with a name-only
 * warning. Never throws, never logs values.
 *
 * Returns `undefined` when the merged set is empty so the transport layer
 * (`buildTransportOptions`) constructs exactly as before when there is
 * nothing to send. HTTP header names are case-insensitive, so an override
 * replaces a base entry regardless of case (e.g. `authorization` overwrites
 * a stored `Authorization`).
 *
 * Component tag: [COMP:api/mcp-header-merge].
 */
export function mergeValidatedHeaders(
  base: Record<string, string> | undefined,
  overrides: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...(base ?? {}) }

  if (overrides) {
    // Case-insensitive index of existing names so an override can replace a
    // base header that differs only in case.
    const lowerToActual = new Map<string, string>()
    for (const name of Object.keys(merged)) lowerToActual.set(name.toLowerCase(), name)

    for (const [name, value] of Object.entries(overrides)) {
      if (!isValidHeaderName(name)) {
        console.warn('[mcp-header-merge] dropped override with invalid header name')
        continue
      }
      if (typeof value !== 'string' || !isValidHeaderValue(value)) {
        console.warn(`[mcp-header-merge] dropped override "${name}" (empty, oversized, or contains CR/LF)`)
        continue
      }
      const existing = lowerToActual.get(name.toLowerCase())
      if (existing && existing !== name) delete merged[existing]
      merged[name] = value
      lowerToActual.set(name.toLowerCase(), name)
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Extract a connector's static **preflight headers** from its (non-secret,
 * client-writable) `config.preflightHeaders` into a name→value map. These are
 * operational headers (tenant, tracing, routing) a user configures per custom
 * MCP connector; `injectMcpTools` merges them over the connector's auth headers
 * (`mergeValidatedHeaders`, preflight wins) so they travel on discovery and
 * every tool call. See `docs/architecture/engine/tool-hooks.md`.
 *
 * Tolerant of malformed config — never throws. A non-array, or a row missing a
 * string `name`/`value`, is skipped; the header name/value charset is validated
 * later in `mergeValidatedHeaders`, so a bad entry is dropped there. Duplicate
 * names: last row wins.
 *
 * NOT for secrets — `config` is plaintext and surfaced in the connector read
 * APIs. A secret header belongs in the encrypted credential (the `bearer` /
 * `custom_header` auth type).
 *
 * Component tag: [COMP:api/connector-preflight-headers].
 */
export function preflightHeadersToRecord(
  config: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const raw = config?.preflightHeaders
  if (!Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const row of raw) {
    if (
      row && typeof row === 'object' &&
      typeof (row as { name?: unknown }).name === 'string' &&
      typeof (row as { value?: unknown }).value === 'string'
    ) {
      const { name, value } = row as { name: string; value: string }
      // Reserve the sidanclaw namespace: a user-config header may never set an
      // `X-Sidanclaw-*` value, or it could forge the actor identity a connector
      // trusts for auth. (Validation of the charset still happens at merge.)
      if (name.length > 0 && !name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX)) {
        out[name] = value
      }
    }
  }
  return out
}

/**
 * The acting user's identity for a turn, resolved server-side from the
 * authenticated session — never from model output. Injected (opt-in per
 * connector) as `X-Sidanclaw-Actor-*` headers so a custom MCP server can know
 * who the request acts on behalf of. See `docs/architecture/engine/tool-hooks.md`.
 */
export type ActorIdentity = {
  /** Channel the turn is on: `web` | `whatsapp` | `telegram` | `slack` | … */
  channel: string
  /** Channel-native id: email (web) / phone (whatsapp) / `@handle` (telegram) / Slack user id. Null when unknown. */
  id?: string | null
  /** The user's email, when known (also sent on channel turns). */
  email?: string | null
  /** Stable sidanclaw user UUID — the key that never changes across channels. */
  userId: string
}

/**
 * Build the reserved-namespace identity headers from a resolved `ActorIdentity`.
 * These merge at the HIGHEST precedence in `injectMcpTools` (over auth + static
 * preflight headers) and the user-config path can't set the namespace, so the
 * model and the user are both unable to influence them — the value is a
 * sidanclaw-backend assertion. Trustworthy when the connector authenticates the
 * connection (the connection auth proves it's sidanclaw; the header says which
 * user). Empty/missing fields are simply omitted.
 */
export function actorIdentityHeaders(actor: ActorIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Sidanclaw-Actor-Channel': actor.channel,
    'X-Sidanclaw-User-Id': actor.userId,
  }
  if (actor.id) headers['X-Sidanclaw-Actor-Id'] = actor.id
  if (actor.email) headers['X-Sidanclaw-Actor-Email'] = actor.email
  return headers
}
