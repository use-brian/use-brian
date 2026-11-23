/**
 * Google Search Console provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyToolPolicies`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createSearchConsoleTools } from '@use-brian/core/tools/base/gsc.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { gateToolsOnActionGrants } from '../../safety/assert-action-allowed.js'
import { wrapToolsWithHealthProbe, type HealthReporter } from '../connector-health.js'
import { createSearchConsoleApi, unpackSearchConsoleCredentials, type SearchConsoleCredentials } from '../../gsc/client.js'
import { applyToolPolicies, injectInstanceVariants } from '../activation.js'
import type { ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice, expiredCredentialsNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in Google Search Console connector ────────────────
// Four read-only tools over a BYO service-account key. Cloned from the
// WordPress injector minus the files plumbing (nothing here reads or writes
// workspace files). The default property rides in the credential envelope,
// so `defaultSite()` never touches instance config. One instance per
// service account (multi-instance via `extraInstances`).
// See docs/architecture/integrations/search-console.md.

async function collectSearchConsoleTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** Exact-instance credential override for a grant/team-native overlay. */
  credsOverride?: () => Promise<string | null>,
  /** Additional connected service accounts for the personal base load. */
  extraInstances?: ConnectorInstanceRef[],
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
): Promise<void> {
  const gsc = connectors.find((c) => c.connectorId === 'gsc' && c.connected)
  const gscEnabled = gsc && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gsc'))

  if (!gsc) {
    unavailable?.push(notConnectedNotice('Google Search Console', 'search performance, URL index status, sitemaps'))
    return
  }

  const primaryCredentials = async (): Promise<string | null> => {
    if (credsOverride) return credsOverride()
    return (await connectorStore.getCredentials(userId, 'gsc'))?.client_secret ?? null
  }

  const resolveEnvelope = async (load: () => Promise<string | null>): Promise<SearchConsoleCredentials> => {
    const encoded = await load()
    const envelope = encoded ? unpackSearchConsoleCredentials(encoded) : null
    if (!envelope) throw new Error('Google Search Console connector credentials are missing or invalid')
    return envelope
  }

  function buildTools(
    load: () => Promise<string | null>,
    governanceId: string = 'gsc',
  ): Tool[] {
    // One api (and so one token cache) per tool set: the envelope is
    // resolved lazily on first call and the client reused after that.
    let apiPromise: Promise<{ api: ReturnType<typeof createSearchConsoleApi>; defaultSite: string | null }> | null = null
    const bound = () => {
      if (!apiPromise) {
        apiPromise = resolveEnvelope(load).then((envelope) => ({
          api: createSearchConsoleApi(envelope),
          defaultSite: envelope.defaultSite,
        })).catch((err: unknown) => {
          apiPromise = null
          throw err
        })
      }
      return apiPromise
    }
    return gateToolsOnActionGrants(createSearchConsoleTools({
      listSites: async () => (await bound()).api.listSites(),
      query: async (siteUrl, body) => (await bound()).api.querySearchAnalytics(siteUrl, body),
      inspectUrl: async (siteUrl, url, languageCode) => (await bound()).api.inspectUrl(siteUrl, url, languageCode),
      listSitemaps: async (siteUrl) => (await bound()).api.listSitemaps(siteUrl),
      defaultSite: async () => (await bound()).defaultSite,
    }), 'gsc', assistantConnectorGrantsStore, assistantId, governanceId)
  }

  const primaryInstanceId = healthProbe?.instanceId ?? (gsc as { id?: string }).id ?? null
  try {
    if (gscEnabled) {
      const encoded = await primaryCredentials()
      if (!encoded || !unpackSearchConsoleCredentials(encoded)) {
        unavailable?.push(expiredCredentialsNotice('Google Search Console'))
      } else {
        const built = buildTools(primaryCredentials)
        const gscTools = healthProbe && primaryInstanceId
          ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
          : built
        for (const tool of await applyToolPolicies(gscTools, 'gsc', settingsStore, assistantId, userId, unavailable)) {
          tools.set(tool.name, tool)
        }
      }
    }

    if (extraInstances?.length && resolveInstanceCreds) {
      await injectInstanceVariants({
        provider: 'gsc',
        extras: extraInstances,
        settingsStore, assistantId, userId, assistantConnectorStore, tools,
        buildToolsForInstance: (instance, governanceId) => {
          const variant = buildTools(() => resolveInstanceCreds(instance.id), governanceId)
          return healthProbe ? wrapToolsWithHealthProbe(variant, instance.id, healthProbe.report) : variant
        },
      })
    }

    console.debug(`[mcp-inject] Google Search Console: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra account(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] Google Search Console injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One Search Console lane. Same shape as the GitHub lane. */
export type SearchConsoleLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  credsOverride?: () => Promise<string | null>
  extraInstances?: ConnectorInstanceRef[]
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  healthProbe?: { report: HealthReporter; instanceId?: string | null }
}

export async function activateSearchConsoleLane(ctx: ProviderActivationContext, lane: SearchConsoleLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectSearchConsoleTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.credsOverride,
    lane.extraInstances, lane.resolveInstanceCreds, lane.healthProbe, ctx.stores.assistantConnectorGrantsStore,
  )
  return [...tools.values()]
}

export const gscProvider: ProviderModule<readonly SearchConsoleLane[]> = {
  family: 'gsc',
  describe: memoDescribe(() => describeFactoryTools('gsc', { gsc: () => createSearchConsoleTools(inertPort('gsc')) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateSearchConsoleLane(ctx, lane)),
}
