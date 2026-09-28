/**
 * Canonical connector lifecycle shared by open and hosted route adapters.
 *
 * [COMP:connectors/lifecycle]
 */
import { classifyTool, defaultPolicy, type McpSettingsStore } from '@use-brian/core'
import {
  ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS,
  APP_LEVEL_ASSISTANT_ID,
  connectorSupportsMultipleInstances,
  MULTI_INSTANCE_CONNECTOR_IDS,
  OFFICIAL_CONNECTORS,
  OFFICIAL_CONNECTOR_TOOLS,
  type ConnectorEntry,
} from '@use-brian/shared'

import type { ConnectorCredentials, ConnectorStore, OAuthCredentials } from '../db/connector-store.js'
import type {
  ConnectorInstance,
  ConnectorInstanceStore,
  UpdateInstanceParams,
} from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { WorkspaceToolPolicyStore } from '../db/workspace-tool-policy-store.js'
import { listUsableWorkspaceConnectors, type UsableConnector } from './usable-connectors.js'
import type { ConnectorLifecycleDrivers } from './lifecycle-drivers.js'

export type ConnectorLifecycleTarget =
  | { kind: 'primary'; provider: string }
  | { kind: 'instance'; instanceId: string; provider?: string }

export type ConnectorLifecyclePolicy = {
  /** Directory installs are explicitly idempotent or multi-account. */
  directoryInstall: 'reuse_primary' | 'create_new'
  /** Registry rows hidden from the edition's browse directory. */
  directoryHiddenIds?: ReadonlySet<string>
}

export class ConnectorLifecycleError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'conflict' | 'unsupported' | 'settings_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ConnectorLifecycleError'
  }
}

export type ConnectorToolProjection = {
  name: string
  description: string
  classification: 'read' | 'write' | 'destructive' | 'unknown'
  policy: 'allow' | 'ask' | 'block'
}

export type ConnectorLifecycleServiceOptions = {
  instanceStore: ConnectorInstanceStore
  legacyStore: ConnectorStore
  grantStore?: ConnectorGrantStore
  settingsStore?: McpSettingsStore
  workspaceToolPolicyStore?: WorkspaceToolPolicyStore
  registry?: readonly ConnectorEntry[]
  policy: ConnectorLifecyclePolicy
  drivers?: ConnectorLifecycleDrivers
  canMutateWorkspaceInstance?: (userId: string, instance: ConnectorInstance) => Promise<boolean>
}

function oldestFirst(instances: ConnectorInstance[]): ConnectorInstance[] {
  return [...instances].sort((a, b) => (
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
  ))
}

export function createConnectorLifecycleService(options: ConnectorLifecycleServiceOptions) {
  const registry = options.registry ?? OFFICIAL_CONNECTORS
  const byId = new Map(registry.map((entry) => [entry.id, entry]))

  async function personal(userId: string): Promise<ConnectorInstance[]> {
    return oldestFirst(await options.instanceStore.listByUser(userId, userId))
  }

  async function resolveTarget(
    userId: string,
    target: ConnectorLifecycleTarget,
  ): Promise<ConnectorInstance> {
    const instance = target.kind === 'instance'
      ? await options.instanceStore.get(userId, target.instanceId)
      : (await personal(userId)).find((row) => row.provider === target.provider) ?? null
    if (!instance) throw new ConnectorLifecycleError('not_found', 'Connector instance not found')
    if (target.kind === 'instance' && target.provider && instance.provider !== target.provider) {
      throw new ConnectorLifecycleError('conflict', 'Connector instance does not match provider')
    }
    if (instance.scope === 'user' && instance.userId !== userId) {
      throw new ConnectorLifecycleError('forbidden', 'Only the connector owner can change this instance')
    }
    if (instance.scope === 'workspace') {
      const allowed = await options.canMutateWorkspaceInstance?.(userId, instance)
      if (!allowed) throw new ConnectorLifecycleError('not_found', 'Connector instance not found')
    }
    return instance
  }

  async function updateTarget(
    userId: string,
    target: ConnectorLifecycleTarget,
    updates: UpdateInstanceParams,
  ): Promise<ConnectorInstance> {
    const instance = await resolveTarget(userId, target)
    const updated = await options.instanceStore.update(userId, instance.id, updates)
    if (!updated) throw new ConnectorLifecycleError('not_found', 'Connector instance not found')
    return updated
  }

  async function effectiveTools(
    userId: string,
    serverName: string,
    tools: ReadonlyArray<{ name: string; description: string; classification?: ConnectorToolProjection['classification']; defaultPolicy?: ConnectorToolProjection['policy'] }>,
  ): Promise<ConnectorToolProjection[]> {
    return Promise.all(tools.map(async (tool) => {
      const classification = tool.classification ?? classifyTool(tool.name, tool.description)
      const fallback = tool.defaultPolicy ?? defaultPolicy(classification)
      const override = options.settingsStore
        ? await options.settingsStore.getPolicy({
            assistantId: APP_LEVEL_ASSISTANT_ID,
            userId,
            serverName,
            toolName: tool.name,
          })
        : null
      return {
        name: tool.name,
        description: tool.description,
        classification,
        policy: override?.policy ?? fallback,
      }
    }))
  }

  async function workspaceGovernanceId(
    userId: string,
    workspaceId: string,
    instance: ConnectorInstance,
  ): Promise<string> {
    if (ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(instance.provider)) {
      return `${instance.provider}:${instance.id}`
    }
    if (!MULTI_INSTANCE_CONNECTOR_IDS.has(instance.provider)) return instance.provider
    const primary = oldestFirst(
      (await options.instanceStore.listByWorkspace(userId, workspaceId))
        .filter((candidate) => candidate.provider === instance.provider),
    )[0]
    return primary?.id === instance.id ? instance.provider : `${instance.provider}:${instance.id}`
  }

  return {
    async list(userId: string, workspaceId?: string | null): Promise<{
      personal: ConnectorInstance[]
      workspace: UsableConnector[]
    }> {
      const [owned, workspace] = await Promise.all([
        personal(userId),
        workspaceId && options.grantStore
          ? listUsableWorkspaceConnectors({
              connectorInstanceStore: options.instanceStore,
              connectorGrantStore: options.grantStore,
              userId,
              workspaceId,
            })
          : Promise.resolve([]),
      ])
      return { personal: owned, workspace }
    },

    async directory(userId: string) {
      const instances = await personal(userId)
      return registry
        .filter((entry) => !options.policy.directoryHiddenIds?.has(entry.id))
        .map((entry) => {
          const matches = instances.filter((row) => row.provider === entry.id)
          return {
            ...entry,
            added: matches.length > 0,
            connected: matches.some((row) => row.connected),
            addable: connectorSupportsMultipleInstances(entry),
          }
        })
    },

    async install(userId: string, provider: string): Promise<ConnectorInstance> {
      const entry = byId.get(provider)
      if (!entry) throw new ConnectorLifecycleError('not_found', 'Connector not found in directory')
      if (options.policy.directoryInstall === 'reuse_primary') {
        const existing = (await personal(userId)).find((row) => row.provider === provider)
        if (existing) return existing
      }
      return options.instanceStore.createUserInstance({
        userId,
        provider,
        label: entry.name,
        url: entry.mcp_url ?? null,
        custom: false,
        connected: false,
      })
    },

    async attachCredentials(input: {
      userId: string
      provider: string
      credentials: ConnectorCredentials | OAuthCredentials
      fallbackLabel: string
      connectedEmail?: string | null
      label?: string
      configPatch?: Record<string, unknown> | null
      createNew?: boolean
      instanceId?: string
    }): Promise<ConnectorInstance> {
      if (!input.instanceId && !byId.has(input.provider)) {
        throw new ConnectorLifecycleError('unsupported', `Unsupported connector: ${input.provider}`)
      }
      if (input.createNew) {
        return options.instanceStore.createUserInstance({
          userId: input.userId,
          provider: input.provider,
          label: input.label ?? input.fallbackLabel,
          connectedEmail: input.connectedEmail ?? null,
          connected: true,
          credentials: input.credentials,
          ...(input.configPatch ? { config: input.configPatch } : {}),
        })
      }
      const target = input.instanceId
        ? { kind: 'instance' as const, instanceId: input.instanceId, provider: input.provider }
        : { kind: 'primary' as const, provider: input.provider }
      try {
        return await updateTarget(input.userId, target, {
          connected: true,
          connectedEmail: input.connectedEmail ?? null,
          credentials: input.credentials,
          ...(input.label ? { label: input.label } : {}),
          ...(input.configPatch ? { configPatch: input.configPatch } : {}),
        })
      } catch (error) {
        if (!(error instanceof ConnectorLifecycleError) || error.code !== 'not_found' || input.instanceId) throw error
        return options.instanceStore.createUserInstance({
          userId: input.userId,
          provider: input.provider,
          label: input.label ?? input.fallbackLabel,
          connectedEmail: input.connectedEmail ?? null,
          connected: true,
          credentials: input.credentials,
          ...(input.configPatch ? { config: input.configPatch } : {}),
        })
      }
    },

    connect(userId: string, target: ConnectorLifecycleTarget) {
      return updateTarget(userId, target, { connected: true })
    },

    update(userId: string, target: ConnectorLifecycleTarget, updates: UpdateInstanceParams) {
      return updateTarget(userId, target, updates)
    },

    async disconnect(userId: string, target: ConnectorLifecycleTarget) {
      const instance = await resolveTarget(userId, target)
      await options.drivers?.[instance.provider]?.prepareDisconnect?.({ userId, instance })
      return updateTarget(userId, { kind: 'instance', instanceId: instance.id, provider: instance.provider }, {
        connected: false,
        connectedEmail: null,
        configPatch: { connectedEmail: null },
      })
    },

    rename(userId: string, target: ConnectorLifecycleTarget, input: { label?: string; url?: string | null }) {
      return updateTarget(userId, target, input)
    },

    async remove(userId: string, target: ConnectorLifecycleTarget): Promise<void> {
      const instance = await resolveTarget(userId, target)
      const deleted = await options.instanceStore.delete(userId, instance.id)
      if (!deleted) throw new ConnectorLifecycleError('not_found', 'Connector instance not found')
    },

    async transferToWorkspace(input: {
      userId: string
      target: ConnectorLifecycleTarget
      workspaceId: string
      sensitivity?: ConnectorInstance['sensitivity']
    }): Promise<ConnectorInstance> {
      const instance = await resolveTarget(input.userId, input.target)
      if (instance.scope !== 'user' || instance.userId !== input.userId) {
        throw new ConnectorLifecycleError('forbidden', 'Only the connector owner can transfer this instance')
      }
      const transferred = await options.instanceStore.transferToWorkspace(
        input.userId,
        instance.id,
        input.workspaceId,
        input.sensitivity,
      )
      if (!transferred) {
        throw new ConnectorLifecycleError('forbidden', 'Connector transfer was not authorized')
      }
      return transferred
    },

    async getConfig(userId: string, target: ConnectorLifecycleTarget) {
      if (target.kind === 'primary') {
        return options.legacyStore.getConfig(userId, target.provider)
      }
      return (await resolveTarget(userId, target)).config ?? {}
    },

    async configure(userId: string, target: ConnectorLifecycleTarget, patch: Record<string, unknown>) {
      if (target.kind === 'primary') {
        await options.legacyStore.setConfig(userId, target.provider, patch)
        return options.legacyStore.getConfig(userId, target.provider)
      }
      return (await updateTarget(userId, target, { configPatch: patch })).config ?? {}
    },

    async tools(userId: string, target: ConnectorLifecycleTarget): Promise<{
      serverName: string
      tools: ConnectorToolProjection[]
    }> {
      const provider = target.kind === 'primary' ? target.provider : target.provider
      if (provider && OFFICIAL_CONNECTOR_TOOLS[provider]) {
        return {
          serverName: provider,
          tools: await effectiveTools(userId, provider, OFFICIAL_CONNECTOR_TOOLS[provider]),
        }
      }
      const instance = await resolveTarget(userId, target)
      const driver = options.drivers?.[instance.provider]
      if (!driver?.discoverTools) return { serverName: instance.label, tools: [] }
      const discovered = await driver.discoverTools({ userId, instance })
      return {
        serverName: discovered.serverName,
        tools: await effectiveTools(userId, discovered.serverName, discovered.tools),
      }
    },

    async projectToolInventory(input: {
      userId: string
      serverName: string
      tools: ReadonlyArray<{
        name: string
        description: string
        classification?: ConnectorToolProjection['classification']
        defaultPolicy?: ConnectorToolProjection['policy']
      }>
    }): Promise<ConnectorToolProjection[]> {
      return effectiveTools(input.userId, input.serverName, input.tools)
    },

    async setToolPolicy(input: {
      userId: string
      serverName: string
      toolName: string
      policy: 'allow' | 'ask' | 'block'
    }): Promise<void> {
      if (!options.settingsStore) {
        throw new ConnectorLifecycleError('settings_unavailable', 'MCP settings not configured')
      }
      await options.settingsStore.setPolicy({
        assistantId: APP_LEVEL_ASSISTANT_ID,
        userId: input.userId,
        serverName: input.serverName,
        toolName: input.toolName,
        policy: input.policy,
        classification: classifyTool(input.toolName),
      })
    },

    async listWorkspaceToolPolicies(input: {
      userId: string
      workspaceId: string
      target: ConnectorLifecycleTarget
    }) {
      if (!options.workspaceToolPolicyStore) {
        throw new ConnectorLifecycleError('settings_unavailable', 'Workspace tool policy store not configured')
      }
      const instance = await resolveTarget(input.userId, input.target)
      if (instance.scope !== 'workspace' || instance.workspaceId !== input.workspaceId) {
        throw new ConnectorLifecycleError('not_found', 'Connector instance not found')
      }
      const governanceId = await workspaceGovernanceId(input.userId, input.workspaceId, instance)
      const policies = await options.workspaceToolPolicyStore.listForWorkspace(input.workspaceId)
      const byTool = new Map<string, (typeof policies)[number]>()
      for (const policy of policies) {
        if (policy.serverName === instance.provider) byTool.set(policy.toolName, policy)
      }
      for (const policy of policies) {
        if (policy.serverName === governanceId) byTool.set(policy.toolName, policy)
      }
      return { instance, governanceId, policies: [...byTool.values()] }
    },

    async setWorkspaceToolPolicy(input: {
      userId: string
      workspaceId: string
      target: ConnectorLifecycleTarget
      toolName: string
      policy: 'allow' | 'ask' | 'block'
      classification?: ConnectorToolProjection['classification'] | null
    }) {
      if (!options.workspaceToolPolicyStore) {
        throw new ConnectorLifecycleError('settings_unavailable', 'Workspace tool policy store not configured')
      }
      const instance = await resolveTarget(input.userId, input.target)
      if (instance.scope !== 'workspace' || instance.workspaceId !== input.workspaceId) {
        throw new ConnectorLifecycleError('not_found', 'Connector instance not found')
      }
      const governanceId = await workspaceGovernanceId(input.userId, input.workspaceId, instance)
      const policy = await options.workspaceToolPolicyStore.setPolicy({
        workspaceId: input.workspaceId,
        serverName: governanceId,
        toolName: input.toolName,
        policy: input.policy,
        classification: input.classification ?? null,
        updatedBy: input.userId,
      })
      return { instance, governanceId, policy }
    },

    /** Legacy wire adapters may still need the compatibility projection. */
    legacyStore: options.legacyStore,
  }
}
