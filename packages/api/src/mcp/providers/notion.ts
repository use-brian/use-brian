/**
 * Notion provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyToolPolicies`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createNotionTools } from '@use-brian/core/tools/base/notion.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { gateToolsOnActionGrants } from '../../safety/assert-action-allowed.js'
import { wrapToolsWithHealthProbe, type HealthReporter } from '../connector-health.js'
import { searchNotion, getNotionPage, getNotionDatabase, queryNotionDatabase, createNotionPage, updateNotionPage, appendNotionBlocks } from '../../notion/client.js'
import { getConnectorConfig } from '../../connector-config.js'
import { applyToolPolicies, injectInstanceVariants } from '../activation.js'
import type { ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in Notion connector ──────────────────────────────

async function collectNotionTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** See `collectGitHubTools` — same role. */
  credsOverride?: () => Promise<string | null>,
  /** Additional connected Notion instances (multi-workspace). See `collectGitHubTools`. */
  extraInstances?: ConnectorInstanceRef[],
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /** Call-time liveness probe (migration 294). See `collectGitHubTools`. */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
): Promise<void> {
  if (!getConnectorConfig('notion')) return

  const notion = connectors.find((c) => c.connectorId === 'notion' && c.connected)
  const notionEnabled = notion && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'notion'))

  if (!notion) {
    unavailable?.push(notConnectedNotice('Notion', 'searching and updating Notion pages and databases'))
    return
  }

  // Notion uses a long-lived access token stored in client_secret. Build the
  // tool set bound to a given token source — reused per account.
  function buildTools(getAccessToken: () => Promise<string>, governanceId: string = 'notion'): Tool[] {
    return gateToolsOnActionGrants(createNotionTools({
      search: async (params) => searchNotion(await getAccessToken(), params),
      getPage: async (pageId) => getNotionPage(await getAccessToken(), pageId),
      getDatabase: async (databaseId) => getNotionDatabase(await getAccessToken(), databaseId),
      queryDatabase: async (databaseId, params) => queryNotionDatabase(await getAccessToken(), databaseId, params),
      createPage: async (params) => createNotionPage(await getAccessToken(), params),
      updatePage: async (pageId, params) => updateNotionPage(await getAccessToken(), pageId, params),
      appendBlocks: async (pageId, content) => appendNotionBlocks(await getAccessToken(), pageId, content),
    }), 'notion', assistantConnectorGrantsStore, assistantId, governanceId)
  }

  async function getAccessToken(): Promise<string> {
    if (credsOverride) {
      const token = await credsOverride()
      if (!token) throw new Error('Notion not connected (team-native override returned no creds)')
      return token
    }
    const creds = await connectorStore.getCredentials(userId, 'notion')
    if (!creds) throw new Error('Notion not connected')
    return creds.client_secret
  }

  const primaryInstanceId = healthProbe?.instanceId ?? (notion as { id?: string }).id ?? null
  try {
    if (notionEnabled) {
      const builtNotion = buildTools(getAccessToken)
      const notionTools = healthProbe && primaryInstanceId
        ? wrapToolsWithHealthProbe(builtNotion, primaryInstanceId, healthProbe.report)
        : builtNotion

      for (const tool of await applyToolPolicies(notionTools, 'notion', settingsStore, assistantId, userId, unavailable)) {
        tools.set(tool.name, tool)
      }
    }

    if (extraInstances?.length && resolveInstanceCreds) {
      await injectInstanceVariants({
        provider: 'notion',
        extras: extraInstances,
        settingsStore, assistantId, userId, assistantConnectorStore, tools,
        buildToolsForInstance: (inst, governanceId) => {
          const variant = buildTools(async () => {
            const token = await resolveInstanceCreds(inst.id)
            if (!token) throw new Error(`Notion instance ${inst.id} has no credentials`)
            return token
          }, governanceId)
          return healthProbe ? wrapToolsWithHealthProbe(variant, inst.id, healthProbe.report) : variant
        },
      })
    }

    console.debug(`[mcp-inject] Notion: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra workspace(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] Notion injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One Notion lane. Same shape as the GitHub lane. */
export type NotionLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  credsOverride?: () => Promise<string | null>
  extraInstances?: ConnectorInstanceRef[]
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  healthProbe?: { report: HealthReporter; instanceId?: string | null }
}

export async function activateNotionLane(ctx: ProviderActivationContext, lane: NotionLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectNotionTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.credsOverride,
    lane.extraInstances, lane.resolveInstanceCreds, lane.healthProbe, ctx.stores.assistantConnectorGrantsStore,
  )
  return [...tools.values()]
}

export const notionProvider: ProviderModule<readonly NotionLane[]> = {
  family: 'notion',
  describe: memoDescribe(() => describeFactoryTools('notion', { notion: () => createNotionTools(inertPort('notion')) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateNotionLane(ctx, lane)),
}
