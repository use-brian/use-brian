/**
 * Connector resolver — the Stage-5 replacement for `getConnectorUserId`.
 *
 * Returns the full set of connector_instance rows that an assistant's
 * turn has access to:
 *
 *   Personal assistant → the owner's user-scoped instances.
 *   Team assistant    → the team's team-scoped instances + every instance
 *                       granted to the team via `connector_grant`.
 *
 * Replaces the legacy `getConnectorUserId(userId, workspaceId)` path which
 * resolved to a single userId (team owner) whose personal connectors
 * were then used. The new resolver returns instances directly, with
 * scope, provider, sensitivity, and credentials all addressable.
 *
 * See docs/architecture/integrations/mcp.md.
 * Component tag: [COMP:mcp/connector-resolver].
 */

import type { ConnectorInstanceStore, ConnectorInstance } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'

export type ResolvedAssistant = {
  id: string
  ownerUserId: string | null
  workspaceId: string | null
}

export type ResolveConnectorInstancesParams = {
  assistant: ResolvedAssistant
  connectorInstanceStore: ConnectorInstanceStore
  connectorGrantStore: ConnectorGrantStore
}

export async function resolveConnectorInstances(
  params: ResolveConnectorInstancesParams,
): Promise<ConnectorInstance[]> {
  const { assistant, connectorInstanceStore, connectorGrantStore } = params

  if (assistant.workspaceId) {
    const [teamOwned, granted] = await Promise.all([
      // System-level reads — injection runs per-turn, potentially in
      // cron / webhook contexts where there's no acting user yet.
      connectorInstanceStore.listByWorkspaceSystem(assistant.workspaceId),
      connectorGrantStore.listForTargetSystem('workspace', assistant.workspaceId),
    ])

    const grantedInstances = granted.map(g => g.instance)
    return [...teamOwned, ...grantedInstances]
  }

  if (assistant.ownerUserId) {
    return connectorInstanceStore.listByUserSystem(assistant.ownerUserId)
  }

  // Assistant with neither team nor owner — invariant violation post-XOR.
  return []
}
