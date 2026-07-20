/**
 * Connector health detection — the call-time write path for the liveness
 * signal persisted on `connector_instance` (migration 294).
 *
 * Built-in connector tools (github / notion / fathom) catch provider errors
 * internally and return `{ data: "<Provider> error: ...", isError: true }`
 * rather than throwing (see packages/core/src/tools/base/*.ts). So detection
 * inspects the returned `ToolResult` — a 401/403/invalid-credentials message
 * flips the backing instance to `auth_failed`; any other successful call resets
 * it to `ok`. Health is a pure side-effect: the tool result is returned
 * unchanged and a health-write failure never affects the call.
 *
 * The read path (skip + "reconnect" notice) lives in inject.ts; the reset path
 * (successful call or explicit reconnect) lives here + in the store.
 *
 * See docs/architecture/integrations/connector-health.md.
 * Component tag: [COMP:integrations/connector-health].
 */

import type { Tool } from '@use-brian/core'
import type { ConnectorInstanceStore, ConnectorHealthStatus } from '../db/connector-instance-store.js'

/**
 * Message fragments that mean the CREDENTIAL ITSELF is dead — reconnecting is
 * the only recovery. Provider-agnostic (github/notion/fathom/google).
 */
const CREDENTIAL_DEAD_SIGNALS = [
  'invalid_grant',
  'bad credentials',
  'invalid or revoked',
  'invalid or expired',
  'expired or revoked',
  'token expired',
  'token has been revoked',
  'unauthorized',
]

/**
 * 403s that STILL need a human to re-authorize the credential: the token is
 * structurally valid but was never authorized for this org, so reconnecting
 * (and completing SSO) is genuinely the fix. GitHub's SAML/SSO wording.
 */
const FORBIDDEN_REAUTH_SIGNALS = [
  'saml enforcement',
  'saml sso',
  'single sign-on',
  'must grant your personal access token',
]

/**
 * Refusals that must NEVER flip health even though the provider returns 403.
 * The credential is alive and works elsewhere — it simply may not touch THIS
 * resource, or it is being throttled. Reconnecting changes nothing, and marking
 * the connector dead disables it for every other repo/workflow in the
 * workspace. (Production incident 2026-07-20: a fine-grained GitHub PAT lacking
 * `Pull requests: Read` on one of two repos returned `403 Resource not
 * accessible by personal access token`; that flipped the whole connector to
 * `auth_failed`, so the next injection skipped the GitHub tools entirely and the
 * morning digest lost GitHub for every repo.)
 */
const NOT_CREDENTIAL_SIGNALS = [
  'resource not accessible',
  'rate limit',
  'abuse detection',
  'ip allow list',
  'ip address is not permitted',
]

/**
 * True when `code` appears as an HTTP status rather than as an incidental
 * number. A bare `\b403\b` also matches a PR number, an id, or a count — an
 * unrelated message mentioning "403" must not mark a live connector dead.
 */
function hasHttpStatus(msg: string, code: '401' | '403'): boolean {
  return new RegExp(
    `\\(${code}\\)` +                                  // "GitHub API error (403):"
      `|"?status"?\\s*[:=]\\s*"?${code}\\b` +          // `"status":"403"` / `status: 403`
      `|\\bhttp[^0-9]{0,3}${code}\\b` +                // "HTTP 403"
      `|\\b${code}\\s+(?:unauthorized|forbidden)\\b`,  // "401 Unauthorized"
  ).test(msg)
}

/**
 * True when an error/message means the connector's stored credential is dead
 * and needs reconnecting. Deliberately conservative — a transient blip, a 404,
 * a rate limit, or a per-resource permission gap must never mark a live
 * connector dead.
 *
 * 401 and 403 are NOT equivalent and must not be conflated:
 *   401 → "your credential is bad"            → auth_failed
 *   403 → "you may not touch THIS resource"   → healthy, unless the message
 *          says the token needs re-authorizing (SSO/SAML).
 */
export function classifyConnectorAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // Unambiguous credential death wins outright.
  if (CREDENTIAL_DEAD_SIGNALS.some((s) => msg.includes(s))) return true
  if (hasHttpStatus(msg, '401')) return true

  // Explicit per-resource / quota refusals are healthy, whatever status rides along.
  if (NOT_CREDENTIAL_SIGNALS.some((s) => msg.includes(s))) return false

  // A 403 only counts when it names a re-authorization requirement.
  if (hasHttpStatus(msg, '403')) return FORBIDDEN_REAUTH_SIGNALS.some((s) => msg.includes(s))

  return false
}

/** Fire-and-forget health writer — never blocks or fails the tool call. */
export type HealthReporter = (
  instanceId: string,
  status: ConnectorHealthStatus,
  error?: string | null,
) => void

/** Build a reporter over a connector-instance store (no-op when store/id absent). */
export function createHealthReporter(
  store: Pick<ConnectorInstanceStore, 'markHealth'> | undefined,
): HealthReporter {
  return (instanceId, status, error) => {
    if (!store || !instanceId) return
    void store
      .markHealth(instanceId, status, error ?? null)
      .catch((e) => console.error(`[connector-health] markHealth failed for ${instanceId}:`, e))
  }
}

function stringifyToolData(data: unknown): string {
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

/**
 * Wrap a connector's tools so each call records liveness on the backing
 * `connector_instance`: an auth-class `isError` result (or a thrown auth error)
 * flips it to `auth_failed`; any other completion resets it to `ok`. The result
 * (or thrown error) is passed through unchanged.
 */
export function wrapToolsWithHealthProbe(
  tools: Tool[],
  instanceId: string,
  report: HealthReporter,
): Tool[] {
  return tools.map((tool): Tool => ({
    ...tool,
    execute: async (input, context) => {
      try {
        const result = await tool.execute(input, context)
        if (result?.isError) {
          const text = stringifyToolData(result.data)
          if (classifyConnectorAuthError(text)) report(instanceId, 'auth_failed', text.slice(0, 500))
        } else {
          report(instanceId, 'ok')
        }
        return result
      } catch (err) {
        if (classifyConnectorAuthError(err)) {
          report(instanceId, 'auth_failed', err instanceof Error ? err.message : String(err))
        }
        throw err
      }
    },
  }))
}

/**
 * The dynamic "unavailable capability" line for a connector whose credentials
 * failed — injected into the system prompt (never Layer 1) so the model tells
 * the user to reconnect instead of burning its tool budget calling a dead
 * connector. Mirrors the revoked-Google lines already in inject.ts.
 */
export function connectorReconnectNotice(provider: string, label: string): string {
  const name = providerDisplayName(provider)
  const nick = label && label.toLowerCase() !== provider.toLowerCase() ? ` "${label}"` : ''
  return (
    `${name}${nick} (credentials failed - the connector needs reconnecting) - ` +
    `if the user asks for anything requiring ${name}, tell them: ` +
    `"The ${name} connector stopped working (its credentials expired or were revoked). ` +
    `Reconnect it in Studio then Connectors and try again."`
  )
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'notion':
      return 'Notion'
    case 'fathom':
      return 'Fathom'
    case 'gcal':
      return 'Google Calendar'
    case 'gmail':
      return 'Gmail'
    case 'gdrive':
      return 'Google Drive'
    default:
      return provider
  }
}
