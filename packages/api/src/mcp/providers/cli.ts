/**
 * CLI MCP provider (MCP over stdio, OSS edition) (M3 WP2).
 *
 * Local binaries that speak MCP over stdin/stdout. Discovered like remote
 * custom MCPs but dispatched via subprocess. Each connected CLI instance
 * becomes a `LocalSource` keyed by its label, with `wrapMcpTools` policy
 * enforcement under the instance's policy principal. Hosted builds have no
 * CLI connector rows, so this provider is inert there.
 *
 * Descriptors are dynamic (`describe()` returns none). Every discovery is
 * recorded in the descriptor lifecycle (`mcp/descriptors.ts`), which is also
 * the discovery cache: a `fresh` record is reused instead of spawning the
 * binary again. `activate()` returns `{ tools, records }` with direct adapters
 * (canonical and legacy `mcp_<label>_<tool>` names) over the discovered
 * sources, exactly as the folded index would dispatch them. See
 * docs/architecture/integrations/cli-connector.md and
 * docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { wrapMcpTools } from '@use-brian/core/mcp/connector.js'
import { buildToolIndex, createMcpSearchTools, type LocalSource } from '@use-brian/core/mcp/tool-search.js'
import type { McpServerConfig, McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import { discoverCliServer, callCliMcpTool, type CliServerParams } from '../cli-transport.js'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { connectorInstanceGovernanceId } from '../../db/connector-instance-store.js'
import {
  DISCOVERY_TIMEOUT_MS, cliDescriptorSourceKey, dynamicSourceBindingKey, dynamicToolDescriptors, getSharedDescriptorLifecycle,
  type DescriptorLifecycle, type DescriptorRecord, type DynamicSourceRef,
} from '../descriptors.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'

/** One admitted CLI instance with the policy principal that governs it. */
export type CliInstance = {
  id: string
  name: string
  updatedAt: Date | null
  config?: Record<string, unknown>
  policyStore: McpSettingsStore
  policyUserId: string
  policyServerName?: string
}

/**
 * Discover every admitted CLI instance in parallel (exact-instance
 * enablement first; a disabled or non-CLI credential yields nothing) and
 * return one local search source per instance, in instance order.
 */
export async function discoverCliSources(
  ctx: ProviderActivationContext,
  cliInstances: CliInstance[],
  options: {
    /** The catalog plan's lifecycle; the shared one otherwise. */
    descriptorLifecycle?: DescriptorLifecycle
    refreshDescriptors?: boolean
    /** Receives every record this call discovered or found unavailable. */
    records?: DescriptorRecord[]
  } = {},
): Promise<LocalSource[]> {
  const { assistantId } = ctx
  const { assistantConnectorStore, connectorInstanceStore } = ctx.stores
  const lifecycle = options.descriptorLifecycle ?? getSharedDescriptorLifecycle()
  const actorId = ctx.authority.runtimeActorId
  const cliLocalSources: LocalSource[] = []
  if (cliInstances.length > 0 && connectorInstanceStore) {
    const cliDiscoveries = await Promise.allSettled(
      cliInstances.map(async (inst) => {
        const governanceId = connectorInstanceGovernanceId('cli', inst.id)
        if (
          assistantConnectorStore
          && !(await assistantConnectorStore.isEnabled(assistantId, governanceId, 'cli'))
        ) {
          return null
        }
        const creds = await connectorInstanceStore.getAuthCredentialsSystem(inst.id)
        if (creds?.type !== 'cli') return null

        const serverParams: CliServerParams = {
          binaryPath: creds.binaryPath,
          args: creds.args,
          env: (inst.config?.env as Record<string, string>) ?? undefined,
          cwd: typeof inst.config?.cwd === 'string' ? inst.config.cwd : undefined,
          timeoutMs: typeof inst.config?.timeoutMs === 'number' ? inst.config.timeoutMs : undefined,
        }

        // The binding key carries `updatedAt`, so an edited binary/args/env
        // never reuses the previous tool list.
        const ref: DynamicSourceRef = { sourceKey: cliDescriptorSourceKey(inst.id), family: 'cli', connectorId: 'cli',
          bindingKey: dynamicSourceBindingKey({ url: null, updatedAt: inst.updatedAt, config: inst.config }, actorId) }
        const cached = lifecycle.read(ref)
        let server: McpServerConfig
        if (cached.availability === 'fresh' && !options.refreshDescriptors) {
          server = { name: inst.name, url: '', tools: cached.tools.map((tool) => ({ name: tool.name, description: tool.description,
            inputSchema: tool.inputSchema.kind === 'json-schema' ? tool.inputSchema.schema : { type: 'object' } })) }
        } else {
          try {
            server = await Promise.race([
              discoverCliServer(serverParams, inst.name),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`CLI discovery timeout for ${inst.name}`)), DISCOVERY_TIMEOUT_MS),
              ),
            ])
          } catch (error) {
            lifecycle.markUnavailable(ref, 'the last discovery failed')
            options.records?.push(lifecycle.read(ref))
            throw error
          }
          options.records?.push(lifecycle.record(ref, dynamicToolDescriptors({ family: 'cli', connectorId: 'cli', tools: server.tools })).record)
        }

        const wrappedTools = wrapMcpTools({
          server,
          settingsStore: inst.policyStore,
          assistantId,
          userId: inst.policyUserId,
          appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
          policyServerName: inst.policyServerName,
          callMcpTool: (_serverName, toolName, input) =>
            callCliMcpTool(serverParams, toolName, input),
        })

        // The search gateway already scopes tools by server, so expose the
        // MCP server's canonical names. `wrapMcpTools` prefixes names for
        // legacy direct injection, which does not match workflow catalog ids.
        const searchableTools = wrappedTools.map((tool, index) => ({
          ...tool,
          name: server.tools[index]?.name ?? tool.name,
        }))

        return { id: inst.id, label: inst.name, tools: searchableTools }
      }),
    )

    for (const result of cliDiscoveries) {
      if (result.status === 'fulfilled' && result.value) {
        cliLocalSources.push({
          kind: 'local',
          serverName: `connector:${result.value.id}`,
          label: result.value.label,
          tools: result.value.tools,
        })
        console.debug(`[mcp-inject] CLI ${result.value.label}: ${result.value.tools.length} tools`)
      } else if (result.status === 'rejected') {
        console.error('[mcp-inject] CLI connector discovery failed:', result.reason)
      }
    }
  }

  return cliLocalSources
}

/** CLI family input: admitted instances plus the lifecycle to record into. */
export type CliInstances = CliInstance[] | { instances: CliInstance[]; descriptorLifecycle?: DescriptorLifecycle; refreshDescriptors?: boolean }

export const cliProvider: ProviderModule<CliInstances> = {
  family: 'cli',
  describe: () => [],
  async activate(ctx, input) {
    const { instances, descriptorLifecycle, refreshDescriptors } = Array.isArray(input) ? { instances: input } : input
    const records: DescriptorRecord[] = []
    const sources = await discoverCliSources(ctx, instances, { descriptorLifecycle, refreshDescriptors, records })
    if (sources.length === 0) return { tools: [], records }
    // Direct adapters under canonical and legacy names, dispatched through the
    // wrapped local tool (policy under the instance's principal stays intact).
    const adapters = (selected: typeof sources) => createMcpSearchTools({
      index: buildToolIndex(selected),
      settingsStore: ctx.stores.settingsStore,
      assistantId: ctx.assistantId,
      appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
      userId: ctx.userId,
      hooks: ctx.hosted.engineHooks,
      keepDynamicToolsDirect: true,
    }).filter((tool) => tool.name !== 'mcp_search' && tool.name !== 'mcp_call')
    return { tools: adapters(sources), records,
      sourceTools: Object.fromEntries(sources.map(source => [source.serverName, adapters([source])])) }
  },
}
