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
