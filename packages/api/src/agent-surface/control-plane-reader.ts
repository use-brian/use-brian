/**
 * Control-plane reader — DB adapter for the Tier-1 agent read tools
 * (`createControlPlaneTools` in @use-brian/core). One reader instance is
 * built at boot in `apps/api/src/index.ts` and shared by every agent
 * surface (brain MCP / assistant MCP / public-api chat).
 *
 * Access posture: every method scopes to the acting `(userId, workspaceId)`
 * principal — the same rows that principal could see in Studio. Membership
 * gates ride the underlying store calls (`listAccessibleAssistants` joins
 * membership; `listByWorkspace` is RLS-gated; `listChannelsForWorkspace` is
 * RLS-gated). Connector facts derive from `OFFICIAL_CONNECTORS`, never a
 * hardcoded id set (registry-drift rule in CLAUDE.md).
 *
 * Spec: docs/architecture/integrations/agent-capability-surface.md §4 (Tier 1).
 * Component tag: [COMP:control-plane/read-tools] (adapter half).
 */

import type {
  CapabilityStore,
  ControlPlaneAssistant,
  ControlPlaneChannel,
  ControlPlaneConnector,
  ControlPlaneMode,
  ControlPlaneReader,
  ControlPlaneSkill,
} from '@use-brian/core'
import { OFFICIAL_CONNECTORS } from '@use-brian/shared'
import { listAccessibleAssistants, getUserAssistant, getWorkspacePrimaryAssistant } from '../db/users.js'
import { listChannelsForWorkspace } from '../db/channels-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore, ConnectorInstance } from '../db/connector-instance-store.js'
import type { AssistantModesStore } from '../db/assistant-modes-store.js'
import type { WorkspaceSkillStore } from '../db/skill-store.js'

export type ControlPlaneReaderDeps = {
  capabilityStore: CapabilityStore
  connectorInstanceStore: ConnectorInstanceStore
  connectorGrantStore: ConnectorGrantStore
  workspaceSkillStore: WorkspaceSkillStore
  modesStore: AssistantModesStore
}

/** Project one connector_instance row into the agent-facing shape. */
function projectInstance(
  instance: ConnectorInstance,
  scope: 'team-native' | 'team-grant',
): ControlPlaneConnector {
  const registryEntry = OFFICIAL_CONNECTORS.find((c) => c.id === instance.provider)
  // Custom MCP connectors carry their own credentialsType; built-ins derive
  // the auth posture from the registry (the single source of truth).
  const oauthRequired = registryEntry
    ? registryEntry.oauth_required || registryEntry.auth_type === 'oauth'
    : instance.credentialsType === 'oauth'
  const authType = registryEntry ? registryEntry.auth_type : instance.credentialsType
  return {
    provider: instance.provider,
    instanceId: instance.id,
    label: instance.label,
    connected: instance.connected,
    oauthRequired,
    authType,
    scope,
    sensitivity: instance.sensitivity,
  }
}

export function createControlPlaneReader(deps: ControlPlaneReaderDeps): ControlPlaneReader {
  return {
    async listAssistants(userId, workspaceId): Promise<ControlPlaneAssistant[]> {
      const rows = await listAccessibleAssistants(userId, workspaceId)
      return Promise.all(
        rows.map(async (a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind === 'primary' || a.kind === 'app' ? a.kind : 'standard',
          clearance: a.clearance,
          appType: a.appType ?? null,
          capabilities: await deps.capabilityStore.listActive(a.id),
        })),
      )
    },

    async getAssistant(userId, workspaceId, assistantId): Promise<ControlPlaneAssistant | null> {
      const a = await getUserAssistant(userId, assistantId)
      // Workspace binding check — an id from another workspace is invisible
      // here even when the user happens to be a member of both.
      if (!a || a.workspaceId !== workspaceId) return null
      return {
        id: a.id,
        name: a.name,
        kind: a.kind === 'primary' || a.kind === 'app' ? a.kind : 'standard',
        clearance: a.clearance,
        appType: a.appType ?? null,
        capabilities: await deps.capabilityStore.listActive(a.id),
      }
    },

    async listConnectors(userId, workspaceId): Promise<ControlPlaneConnector[]> {
      // Membership probe first: `listForTargetSystem` is system-level (no
      // RLS), so without this gate a non-member principal — the shadow
      // visitor on the public-api chat channel — could enumerate grant-
      // exposed connector labels. `getWorkspacePrimaryAssistant` is
      // membership-gated and returns null for non-members.
      const memberProbe = await getWorkspacePrimaryAssistant(userId, workspaceId)
      if (!memberProbe) return []
      const teamNative = await deps.connectorInstanceStore.listByWorkspace(userId, workspaceId)
      const grants = await deps.connectorGrantStore.listForTargetSystem('workspace', workspaceId)
      return [
        ...teamNative.map((i) => projectInstance(i, 'team-native')),
        ...grants.map((g) => projectInstance(g.instance, 'team-grant')),
      ]
    },

    async listSkills(userId, workspaceId): Promise<ControlPlaneSkill[]> {
      // RLS-gated via the acting principal — on the public-api chat channel
      // the principal is the SHADOW visitor (not a workspace member), so the
      // read scopes to empty there instead of leaking skill names through the
      // store's system-level path.
      const rows = await deps.workspaceSkillStore.listForWorkspace(workspaceId, {
        actingUserId: userId,
      })
      return rows.map((s) => ({
        id: s.rowId,
        slug: s.slug,
        name: s.name,
        description: s.description,
        state: s.state,
        activatedAt: s.activatedAt ?? null,
        inductionSource: s.inductionSource,
        sensitivity: s.sensitivity,
      }))
    },

    async listChannels(userId, workspaceId): Promise<ControlPlaneChannel[]> {
      const rows = await listChannelsForWorkspace(userId, workspaceId)
      return rows.map((c) => ({
        id: c.id,
        channelType: c.channelType,
        displayName: c.displayName ?? null,
        clearance: c.clearance,
        enabledCapabilities: c.enabledCapabilities,
        status: c.status,
      }))
    },

    async listModes(userId, workspaceId, assistantId): Promise<ControlPlaneMode[]> {
      // Scope gate: the target assistant must belong to this workspace and be
      // visible to the acting principal (the modes store itself is system-level).
      const a = await getUserAssistant(userId, assistantId)
      if (!a || a.workspaceId !== workspaceId) return []
      const rows = await deps.modesStore.list(assistantId)
      return rows.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        freshness: m.freshness,
        requireApproval: m.requireApproval,
      }))
    },
  }
}
