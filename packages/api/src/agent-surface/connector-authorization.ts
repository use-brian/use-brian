/**
 * Pure connector-authorization action contract shared by chat persistence and
 * the resume route. The supported provider set is registry-derived.
 *
 * [COMP:agent-surface/connector-authorization]
 */
import type { ControlPlaneConnector } from '@use-brian/core'
import { OFFICIAL_CONNECTORS, type ConnectorEntry } from '@use-brian/shared'

export const CONNECTOR_AUTHORIZATION_ACTION_PREFIX = 'connector_authorization:'

export function connectorAuthorizationEntry(actionId: unknown): ConnectorEntry | null {
  if (typeof actionId !== 'string' || !actionId.startsWith(CONNECTOR_AUTHORIZATION_ACTION_PREFIX)) {
    return null
  }
  const provider = actionId.slice(CONNECTOR_AUTHORIZATION_ACTION_PREFIX.length)
  return OFFICIAL_CONNECTORS.find(
    (entry) =>
      entry.id === provider &&
      entry.enabled &&
      entry.agent_authorization_handoff === true,
  ) ?? null
}

export function connectorAuthorizationActionId(provider: string): string {
  return `${CONNECTOR_AUTHORIZATION_ACTION_PREFIX}${provider}`
}

export function connectorAuthorizationPath(input: {
  workspaceId: string
  provider: string
  sessionId?: string
  approvalId?: string
}): string {
  const query = new URLSearchParams({ connect: input.provider })
  if (input.sessionId && input.approvalId) {
    query.set('setupSession', input.sessionId)
    query.set('setupApproval', input.approvalId)
  }
  return `/w/${encodeURIComponent(input.workspaceId)}/studio/connectors?${query}`
}

/** Project registry-backed catalog rows that have no configured instance yet. */
export function availableOfficialConnectorRows(
  configuredProviders: ReadonlySet<string>,
  workspaceId: string,
): ControlPlaneConnector[] {
  return OFFICIAL_CONNECTORS
    .filter(
      (entry) =>
        entry.enabled &&
        entry.auth_type !== 'none' &&
        !configuredProviders.has(entry.id),
    )
    .map((entry) => ({
      provider: entry.id,
      name: entry.name,
      description: entry.description,
      instanceId: null,
      label: entry.name,
      connected: false,
      availability: 'available' as const,
      oauthRequired: entry.oauth_required || entry.auth_type === 'oauth',
      authorizationHandoff: entry.agent_authorization_handoff === true,
      connectPath: connectorAuthorizationPath({ workspaceId, provider: entry.id }),
      authType: entry.auth_type,
      scope: 'available' as const,
      sensitivity: 'internal' as const,
    }))
}
