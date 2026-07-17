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
 * True when an error/message looks like a credential or authorization failure
 * (the connector needs reconnecting), as opposed to a transient network blip,
 * rate limit, or a not-found. Deliberately conservative: only a clear auth
 * signal flips health, so a flaky network never marks a live connector dead.
 * Matches the messages the provider clients emit (github/notion/fathom/google).
 */
export function classifyConnectorAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    /\b(401|403)\b/.test(msg) ||
    msg.includes('invalid_grant') ||
    msg.includes('bad credentials') ||
    msg.includes('invalid or revoked') ||
    msg.includes('invalid or expired') ||
    msg.includes('expired or revoked') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  )
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
