/**
 * Custom remote MCP provider (M3 WP2).
 *
 * Discovers custom HTTP MCP servers (personal, workspace-owned and granted
 * instances) and produces `RemoteSource`s for the unified `mcp_search` index.
 * Each source keeps its own transport: per-instance auth headers, static
 * preflight headers, opt-in actor identity and media-token headers, the
 * protected source runtime when the host supplies one, and a dispatcher that
 * re-checks the runtime authority and every binding pin before the call.
 *
 * Descriptors are dynamic, so `describe()` returns none. Every discovery is
 * recorded in the descriptor lifecycle (`mcp/descriptors.ts`; the shared one
 * unless the caller passes the catalog plan's), which is also the discovery
 * cache: a `fresh` record (same binding key, within the TTL) is reused instead
 * of a network discovery. A protected source is never read from or stored in
 * the lifecycle; its record is returned with the tools instead. `activate()`
 * returns `{ tools, records }`: direct adapters (canonical and legacy
 * `mcp_<server>_<tool>` names) from `createMcpSearchTools`, which keep
 * classifier policy and engine hooks.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation" and
 * "Custom connector auth".
 */
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { buildToolIndex, createMcpSearchTools, type RemoteSource } from '@use-brian/core/mcp/tool-search.js'
import type { McpSettingsStore, McpServerConfig } from '@use-brian/agent-runtime/mcp/types.js'
import { discoverMcpServer, callRemoteMcpTool } from '../client.js'
import { buildConnectorAuthHeaders, mergeValidatedHeaders, mergeHostConnectorIdentityHeaders, preflightHeadersToRecord, actorIdentityHeaders, type ActorIdentity } from '../auth-headers.js'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import type { TurnAuthority } from '../activation.js'
import {
  DISCOVERY_TIMEOUT_MS, dynamicSourceBindingKey, dynamicToolDescriptors, getSharedDescriptorLifecycle, remoteDescriptorSourceKey,
  type DescriptorLifecycle, type DescriptorRecord, type DynamicSourceRef,
} from '../descriptors.js'
import type { ProviderModule } from './types.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'

/** One admitted custom MCP instance, after exposure and assistant enablement. */
export type RemoteMcpInstance = {
  connectorId: string
  name: string
  url: string
  instanceId: string | null
  updatedAt: Date | null
  /** Static operational headers from `config.preflightHeaders` (validated at merge). */
  preflightHeaders: Record<string, string>
  /** Opt-in: send the acting user's `X-UseBrian-Actor-*` identity to this connector. */
  sendActorIdentity: boolean
  /** Opt-in: send the acting user's `X-UseBrian-Media-Token` capability to this connector. */
  sendMediaToken: boolean
  policyStore: McpSettingsStore
  policyUserId: string
  policyServerName?: string
  governanceId: string
}

/** A custom MCP exposed through a member-exposure grant (discovered under the grantor's policy principal). */
export type GrantedRemoteMcp = {
  url: string
  name: string
  cacheUserId: string
  instanceId?: string | null
  updatedAt?: Date | null
  policyServerName?: string
  config?: Record<string, unknown>
  /** Governance connector id (the granted instance's provider UUID). */
  connectorId?: string
}

export type RemoteMcpAuthority = Pick<TurnAuthority,
  'runtimeAuthority' | 'assertBindingsCurrent' | 'sourceRuntime' | 'pinAuth' | 'bindingCacheKey' | 'noteProtectedUnavailable'>
  & Partial<Pick<TurnAuthority, 'runtimeActorId'>>

export type RemoteMcpSessionPorts = {
  userId: string
  assistantId: string
  /** Policy store for granted sources (the acting user's L1/L2 store). */
  settingsStore: McpSettingsStore
  connectorInstanceStore?: ConnectorInstanceStore
  actorIdentity?: ActorIdentity
  authority: RemoteMcpAuthority
  /** Descriptor lifecycle the session records into and reads `fresh` records from. Defaults to the shared one. */
  descriptorLifecycle?: DescriptorLifecycle
  refreshDescriptors?: boolean
}

export type RemoteMcpSession = {
  /** Discover the admitted instances in parallel; failures are logged and skipped. */
  discover(active: RemoteMcpInstance[]): Promise<void>
  /** Discover one granted custom MCP; an instance already indexed is skipped. */
  addGrantedCustomMcp(url: string, name: string, cacheUserId: string, instanceId?: string | null, updatedAt?: Date | null, policyServerName?: string, config?: Record<string, unknown>, grantConnectorId?: string): Promise<void>
  /** Sources discovered so far, in discovery order. */
  readonly sources: RemoteSource[]
  /** Descriptor records produced by this session's discoveries (protected sources included). */
  readonly records: DescriptorRecord[]
}

/** One discovery session per turn: auth pins, header merge and the discovery cache are shared across its calls. */
export function createRemoteMcpSession(ports: RemoteMcpSessionPorts): RemoteMcpSession {
  const { userId, assistantId, settingsStore, connectorInstanceStore, actorIdentity, authority } = ports
  const { runtimeAuthority, assertBindingsCurrent, sourceRuntime, noteProtectedUnavailable } = authority
  const lifecycle = ports.descriptorLifecycle ?? getSharedDescriptorLifecycle()
  const actorId = authority.runtimeActorId ?? actorIdentity?.userId
  const remoteSources: RemoteSource[] = []
  const remoteInstanceIds = new Set<string>()
  const records: DescriptorRecord[] = []

  /** Lifecycle identity of one source; null without an instance id (nothing to key it by). */
  function sourceRef(source: { connectorId: string; instanceId: string | null | undefined; url: string; updatedAt: Date | null | undefined
    sendActorIdentity: boolean; sendMediaToken: boolean }, isProtected: boolean): DynamicSourceRef | null {
    if (!source.instanceId) return null
    return {
      sourceKey: remoteDescriptorSourceKey(source.instanceId),
      family: 'remote-mcp',
      connectorId: source.connectorId,
      bindingKey: dynamicSourceBindingKey({ url: source.url, updatedAt: source.updatedAt ?? null,
        config: { sendActorIdentity: source.sendActorIdentity, sendMediaToken: source.sendMediaToken } }, actorId),
      protected: isProtected,
    }
  }
  /** A `fresh` lifecycle record as the server config the index needs (never for a protected source). */
  function freshServer(ref: DynamicSourceRef | null, name: string, url: string): McpServerConfig | null {
    if (!ref || ref.protected || ports.refreshDescriptors) return null
    const record = lifecycle.read(ref)
    if (record.availability !== 'fresh') return null
    // The catalog may treat this source as protected (and so never read the
    // shared lifecycle for it); the record travels with the activation either way.
    records.push(record)
    return { name, url, tools: record.tools.map((tool) => ({ name: tool.name, description: tool.description,
      inputSchema: tool.inputSchema.kind === 'json-schema' ? tool.inputSchema.schema : { type: 'object' } })) }
  }
  function recordDiscovery(ref: DynamicSourceRef | null, server: McpServerConfig): void {
    if (!ref) return
    records.push(lifecycle.record(ref, dynamicToolDescriptors({ family: 'remote-mcp', connectorId: ref.connectorId, tools: server.tools })).record)
  }
  function recordFailure(ref: DynamicSourceRef | null): void {
    if (!ref) return
    lifecycle.markUnavailable(ref, 'the last discovery failed')
    if (!ref.protected) records.push(lifecycle.read(ref))
  }

  async function loadAuthHeaders(instanceId: string | null | undefined): Promise<Record<string, string>> {
    if (!instanceId || !connectorInstanceStore) return {}
    try {
      const creds = await connectorInstanceStore.getAuthCredentialsSystem(instanceId)
      const headers = buildConnectorAuthHeaders(creds)
      authority.pinAuth(instanceId, headers)
      return headers
    } catch (err) {
      console.error('[mcp-inject] auth-header resolution failed:', err)
      return {}
    }
  }

  async function invokeRemoteMcp(url: string, tool: string, input: Record<string, unknown>, headers?: Record<string, string>, instanceId?: string | null) {
    await runtimeAuthority?.assertCurrent()
    await assertBindingsCurrent()
    const source = await sourceRuntime(instanceId, headers ?? {})
    return source ? source.call(tool, input, headers) : callRemoteMcpTool(url, tool, input, headers)
  }

  // Reserved-namespace identity headers, built once per turn (the actor is
  // constant for the turn). Only attached to connectors that opted in, and
  // merged LAST so neither user config nor auth can shadow the assertion.
  const actorHeaders = actorIdentity ? actorIdentityHeaders({ ...actorIdentity, assistantId }) : null
  // Media capability token — a separate reserved header gated on its OWN opt-in
  // (`sendMediaToken`), independent of `sendActorIdentity`. It is a bearer
  // capability (possession fetches the user's latest recording), so it only
  // attaches to connectors the user explicitly granted media access.
  const mediaTokenHeader =
    actorIdentity?.mediaToken
      ? {
          // Dual-emit during the rebrand transition (canonical + legacy).
          'X-UseBrian-Media-Token': actorIdentity.mediaToken,
          'X-Sidanclaw-Media-Token': actorIdentity.mediaToken,
        }
      : null
  async function discover(active: RemoteMcpInstance[]): Promise<void> {
    // Each discovered source owns its transport. Equal URLs do not share credentials.
    const headersByConnector = new Map<RemoteMcpInstance, Record<string, string>>()

    const discoveredServers: Array<{
      server: McpServerConfig
      connectorUrl: string
      instanceId: string | null
      headers: Record<string, string>
      policy: NonNullable<RemoteSource['policy']>
    }> = []

    // Resolve per-instance headers once, keeping the same selected identity on
    // discovery and invocation even when different instances share an endpoint.
    const resolvedHeaders = await Promise.all(active.map((c) => loadAuthHeaders(c.instanceId)))
    active.forEach((c, i) => {
      // Layer the connector's static preflight headers (config) over its auth
      // headers (credentials) — preflight wins on a name clash, both validated
      // and deduped in mergeValidatedHeaders. The merged set travels on
      // discovery + every mcp_call; a runtime preToolUse hook can still override
      // it per call. See docs/architecture/engine/tool-hooks.md.
      let merged = mergeValidatedHeaders(resolvedHeaders[i], c.preflightHeaders)
      if (actorHeaders && c.sendActorIdentity) {
        merged = mergeHostConnectorIdentityHeaders(merged, actorHeaders)
      }
      if (mediaTokenHeader && c.sendMediaToken) {
        merged = mergeHostConnectorIdentityHeaders(merged, mediaTokenHeader)
      }
      headersByConnector.set(c, { ...merged })
    })

    const discoveries = await Promise.allSettled(
      active.map(async (connector) => {
        const authHeaders = headersByConnector.get(connector) ?? {}

        await runtimeAuthority?.assertCurrent()
        await assertBindingsCurrent()
        const protectedSource = await sourceRuntime(connector.instanceId, authHeaders)
        // The binding key carries `updatedAt`: credential/URL edits bump the
        // row's updated_at, so a stale-auth discovery never outlives an edit.
        const ref = sourceRef(connector, !!protectedSource)

        // A fresh descriptor record replaces the network discovery.
        const cached = freshServer(ref, connector.name, connector.url)
        if (cached) {
          console.debug(`[mcp-inject] ${connector.name}: cache hit (${cached.tools.length} tools)`)
          return {
            server: cached,
            connectorUrl: connector.url,
            instanceId: connector.instanceId,
            headers: authHeaders,
            policy: {
              settingsStore: connector.policyStore,
              userId: connector.policyUserId,
              serverName: connector.policyServerName,
              appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
            },
          }
        }

        // Discover with timeout
        let server: McpServerConfig
        try {
          server = await Promise.race([
            protectedSource ? protectedSource.discover(connector.name) : discoverMcpServer(connector.url, connector.name, authHeaders),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Discovery timeout for ${connector.name}`)), DISCOVERY_TIMEOUT_MS),
            ),
          ])
        } catch (error) {
          recordFailure(ref)
          throw error
        }
        await runtimeAuthority?.assertCurrent()
        await assertBindingsCurrent()

        recordDiscovery(ref, server)
        console.debug(
          `[mcp-inject] ${connector.name}: discovered ${server.tools.length} tools`,
        )
        return {
          server,
          connectorUrl: connector.url,
          instanceId: connector.instanceId,
          headers: authHeaders,
          policy: {
            settingsStore: connector.policyStore,
            userId: connector.policyUserId,
            serverName: connector.policyServerName,
            appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
          },
        }
      }),
    )

    for (const result of discoveries) {
      if (result.status === 'fulfilled') {
        discoveredServers.push(result.value)
      } else {
        if (result.reason instanceof SourceProtocolError) noteProtectedUnavailable()
        console.error('[mcp-inject] server discovery failed:', result.reason)
      }
    }

    // ── Collect remote sources for the unified tool-search index ──
    //
    // We defer the actual `buildToolIndex` + `createMcpSearchTools` step to
    // the bottom of this function so the built-in injectors below can also
    // feed into the index as **local sources** when `keepBuiltinsDirect`
    // is false (the chat path's token-saving default). The workflow path
    // (`keepBuiltinsDirect: true`) still gets `mcp_search` / `mcp_call`
    // here for custom MCP only — built-ins stay direct so the workflow
    // executor's per-tool `requiresConfirmation` inspection still works.
    for (const id of discoveredServers.flatMap(source => source.instanceId ? [source.instanceId] : [])) remoteInstanceIds.add(id)
    remoteSources.push(...discoveredServers.map(({ server, connectorUrl, instanceId, headers, policy }) => ({
      kind: 'remote' as const,
      server,
      serverUrl: connectorUrl,
      ...(instanceId ? { sourceId: `connector:${instanceId}` } : {}),
      callMcpTool: (_url: string, toolName: string, input: Record<string, unknown>, overrides?: Record<string, string>) =>
        invokeRemoteMcp(connectorUrl, toolName, input, mergeValidatedHeaders(headers, overrides), instanceId),
      policy,
    })))
  }

  // Discover a custom remote MCP shared to this workspace via a grant and add
  // it to the search index. Per-instance auth credentials (bearer / custom
  // header) stay bound to the exact instance like the personal/team-native paths.
  // Duplicate exposure of one instance is indexed once; equal URLs stay distinct. See
  // docs/architecture/integrations/mcp.md → "Workspace connector scoping".
  async function addGrantedCustomMcp(
    url: string,
    name: string,
    cacheUserId: string,
    instanceId?: string | null,
    updatedAt?: Date | null,
    policyServerName?: string,
    config?: Record<string, unknown>,
    /** Governance connector id of the granted instance (its provider UUID); the label otherwise. */
    grantConnectorId?: string,
  ): Promise<void> {
    if (instanceId ? remoteInstanceIds.has(instanceId) : remoteSources.some(source => source.serverUrl === url)) return
    try {
      let authHeaders = mergeValidatedHeaders(await loadAuthHeaders(instanceId), preflightHeadersToRecord(config)) ?? {}
      if (actorHeaders && config?.sendActorIdentity === true) authHeaders = mergeHostConnectorIdentityHeaders(authHeaders, actorHeaders)
      if (mediaTokenHeader && config?.sendMediaToken === true) authHeaders = mergeHostConnectorIdentityHeaders(authHeaders, mediaTokenHeader)
      await runtimeAuthority?.assertCurrent()
      await assertBindingsCurrent()
      const protectedSource = await sourceRuntime(instanceId, authHeaders)
      const ref = sourceRef({ connectorId: grantConnectorId ?? name, instanceId, url, updatedAt,
        sendActorIdentity: config?.sendActorIdentity === true, sendMediaToken: config?.sendMediaToken === true }, !!protectedSource)
      let server = freshServer(ref, name, url)
      if (!server) {
        try {
          server = await Promise.race([
            protectedSource ? protectedSource.discover(name) : discoverMcpServer(url, name, authHeaders),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Discovery timeout for ${name}`)), DISCOVERY_TIMEOUT_MS),
            ),
          ])
        } catch (error) {
          recordFailure(ref)
          throw error
        }
        await runtimeAuthority?.assertCurrent()
        await assertBindingsCurrent()
        recordDiscovery(ref, server)
      }
      remoteSources.push({
        kind: 'remote',
        server,
        serverUrl: url,
        ...(instanceId ? { sourceId: `connector:${instanceId}` } : {}),
        callMcpTool: (_url: string, toolName: string, input: Record<string, unknown>, overrides?: Record<string, string>) =>
          invokeRemoteMcp(url, toolName, input, mergeValidatedHeaders(authHeaders, overrides), instanceId),
        policy: {
          settingsStore,
          userId: cacheUserId,
          serverName: policyServerName,
          appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
        },
      })
      if (instanceId) remoteInstanceIds.add(instanceId)
      console.debug(`[mcp-inject] granted custom MCP ${name}: discovered ${server.tools.length} tools`)
    } catch (err) {
      if (err instanceof SourceProtocolError) noteProtectedUnavailable()
      console.error(`[mcp-inject] granted custom MCP discovery failed (${name}):`, err)
    }
  }
  return { discover, addGrantedCustomMcp, sources: remoteSources, records }
}

// ── Provider module ───────────────────────────────────────────

export type RemoteMcpInstances = {
  instances: RemoteMcpInstance[]
  granted?: GrantedRemoteMcp[]
  authority: RemoteMcpAuthority
  /** The catalog plan's lifecycle; the shared one otherwise. */
  descriptorLifecycle?: DescriptorLifecycle
  refreshDescriptors?: boolean
}

export const remoteMcpProvider: ProviderModule<RemoteMcpInstances> = {
  family: 'remote-mcp',
  describe: () => [],
  async activate(ctx, { instances, granted = [], authority, descriptorLifecycle, refreshDescriptors }) {
    const session = createRemoteMcpSession({
      userId: ctx.userId,
      assistantId: ctx.assistantId,
      settingsStore: ctx.stores.settingsStore,
      connectorInstanceStore: ctx.stores.connectorInstanceStore,
      actorIdentity: ctx.hosted.actorIdentity,
      authority,
      descriptorLifecycle,
      refreshDescriptors,
    })
    await session.discover(instances)
    for (const grant of granted) {
      await session.addGrantedCustomMcp(grant.url, grant.name, grant.cacheUserId, grant.instanceId, grant.updatedAt, grant.policyServerName, grant.config, grant.connectorId)
    }
    if (session.sources.length === 0) return { tools: [], records: session.records }
    const adapters = (sources: RemoteSource[]) => createMcpSearchTools({
      index: buildToolIndex(sources),
      settingsStore: ctx.stores.settingsStore,
      assistantId: ctx.assistantId,
      appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
      userId: ctx.userId,
      hooks: ctx.hosted.engineHooks,
      keepDynamicToolsDirect: true,
    }).filter((tool) => tool.name !== 'mcp_search' && tool.name !== 'mcp_call')
    // Each source's own adapters, unambiguous even when labels and tool names collide.
    const sourceTools = Object.fromEntries(session.sources.flatMap((source) => source.sourceId ? [[source.sourceId, adapters([source])]] : []))
    return { tools: adapters(session.sources), records: session.records, sourceTools }
  },
}
