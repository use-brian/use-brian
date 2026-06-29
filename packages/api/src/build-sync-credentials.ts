/**
 * OPEN sync-credential resolver — the open default for `ports.buildSyncCredentials`.
 *
 * The knowledge sync worker (and the KB edit-proposal routes) need the GitHub
 * PAT a synced source operates through, resolved by `(workspaceId,
 * connectorInstanceId)`. The hosted tier kept this resolver closed
 * (`@sidanclaw/api-platform`), so the open standalone build historically fell
 * back to a stub that always threw `GitHub knowledge sync is not configured in
 * this build` — the worker ticked but every GitHub source failed.
 *
 * Since migration `280_oss_connectors` the `connector_instance` /
 * `connector_grant` tables (and their stores) exist in OSS too, so the
 * resolution the closed provider performs is now expressible entirely over open
 * stores. This module is that open implementation:
 *
 *   1. A source created through the picker carries its bound `connectorInstanceId`
 *      — read that instance's credentials directly (the source always syncs
 *      through the connector it was created with).
 *   2. A legacy source (no bound instance) resolves by workspace: the team-native
 *      GitHub instance first, then a personal instance granted to the workspace.
 *
 * Mirrors `build-episode-ingestors.ts`: boot prefers `ports.buildSyncCredentials`
 * (the platform's closed factory) and falls back to this open one. Both run over
 * the SAME connector stores, so boot is unchanged.
 *
 * See docs/architecture/features/knowledge-base.md → "Team credential scoping".
 */

import type { SyncCredentials } from '@sidanclaw/core'
import type { createConnectorInstanceStore } from './db/connector-instance-store.js'
import type { createConnectorGrantStore } from './db/connector-grant-store.js'

export function buildOpenSyncCredentials(deps: {
  connectorInstanceStore: ReturnType<typeof createConnectorInstanceStore>
  connectorGrantStore: Awaited<ReturnType<typeof createConnectorGrantStore>>
}): SyncCredentials {
  const { connectorInstanceStore, connectorGrantStore } = deps

  return {
    async getPat(workspaceId, connectorInstanceId) {
      // 1. Resolve the instance the source syncs through.
      let instanceId = connectorInstanceId
      if (!instanceId) {
        // Legacy source (no bound instance): team-native GitHub instance first,
        // then a personal instance granted to the workspace.
        const inst =
          (await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'github')) ??
          (await connectorGrantStore.findGrantedInstanceByProviderSystem('workspace', workspaceId, 'github'))
        if (!inst) {
          throw new Error(
            `No GitHub connector for workspace ${workspaceId}. Connect GitHub (/connect github) and bind it to the knowledge source.`,
          )
        }
        instanceId = inst.id
      }

      // 2. Read the PAT — stored as the `client_secret` of the credentials blob.
      const creds = await connectorInstanceStore.getCredentialsSystem(instanceId)
      const pat = creds?.client_secret
      if (!pat) {
        throw new Error(`GitHub connector ${instanceId} has no stored credentials (reconnect it).`)
      }
      return pat
    },
  }
}
