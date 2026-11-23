/**
 * Fathom provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyToolPolicies`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createFathomTools } from '@use-brian/core/tools/base/fathom.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { createFathomTokenManager, listFathomMeetings, getFathomMeeting, getFathomTranscript, getFathomSummary, unpackFathomTokens, packFathomTokens, type FathomTokens } from '../../fathom/client.js'
import { getConnectorConfig } from '../../connector-config.js'
import { applyToolPolicies, injectInstanceVariants } from '../activation.js'
import type { ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in Fathom connector ──────────────────────────────
// Read-only meeting note ingestion. The token manager rotates the refresh
// token on every refresh and persists the new tuple back into the
// connector_instance.credentials envelope. See
// docs/architecture/integrations/fathom.md.

async function collectFathomTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** See `collectGitHubTools` — same role. Returns the encoded FathomTokens JSON blob. */
  credsOverride?: () => Promise<string | null>,
  /** Persistence override for team-native rows; defaults to the user-scoped connectorStore. */
  persistOverride?: (encoded: string) => Promise<void>,
  /** Additional connected Fathom instances (multi-account). See `collectGitHubTools`. */
  extraInstances?: ConnectorInstanceRef[],
  /** Load an extra instance's encoded token tuple. */
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /** Persist a rotated token tuple back to an extra instance (one-time-use refresh tokens). */
  persistInstanceCreds?: (instanceId: string, clientId: string, secret: string) => Promise<void>,
): Promise<void> {
  const fathomCfg = getConnectorConfig('fathom')
  if (!fathomCfg) return
  // Capture as primitives so the nested makeTokenManager closure keeps the
  // narrowing (TS widens the captured object back to possibly-undefined).
  const fathomClientId = fathomCfg.clientId
  const fathomClientSecret = fathomCfg.clientSecret

  const fathom = connectors.find((c) => c.connectorId === 'fathom' && c.connected)
  const fathomEnabled = fathom && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'fathom'))

  if (!fathom) {
    unavailable?.push(notConnectedNotice('Fathom', 'meeting transcripts, summaries, and action items'))
    return
  }

  async function loadEncodedTokens(): Promise<string | null> {
    if (credsOverride) return credsOverride()
    const creds = await connectorStore.getCredentials(userId, 'fathom')
    return creds?.client_secret ?? null
  }

  async function persistEncoded(encoded: string): Promise<void> {
    if (persistOverride) {
      await persistOverride(encoded)
      return
    }
    await connectorStore.upsert(userId, {
      connectorId: 'fathom',
      name: 'Fathom',
      connected: true,
      credentials: { client_id: 'fathom_oauth', client_secret: encoded },
    })
  }

  // Fathom rotates the refresh token on every refresh, so each account needs
  // its own token manager (load + persist bound to that instance's row).
  function makeTokenManager(
    load: () => Promise<string | null>,
    persist: (encoded: string) => Promise<void>,
  ) {
    return createFathomTokenManager({
      clientId: fathomClientId,
      clientSecret: fathomClientSecret,
      store: {
        async getTokens(): Promise<FathomTokens | null> {
          const encoded = await load()
          return encoded ? unpackFathomTokens(encoded) : null
        },
        async persistTokens(tokens) {
          await persist(packFathomTokens(tokens))
        },
      },
    })
  }

  function buildTools(tm: ReturnType<typeof makeTokenManager>): Tool[] {
    return createFathomTools({
      listMeetings: async (params) => listFathomMeetings(await tm.getAccessToken(), params),
      getMeeting: async (meetingId) => getFathomMeeting(await tm.getAccessToken(), meetingId),
      getTranscript: async (meetingId) => getFathomTranscript(await tm.getAccessToken(), meetingId),
      getSummary: async (meetingId) => getFathomSummary(await tm.getAccessToken(), meetingId),
    })
  }

  try {
    if (fathomEnabled) {
      const fathomTools = buildTools(makeTokenManager(loadEncodedTokens, persistEncoded))

      for (const tool of await applyToolPolicies(fathomTools, 'fathom', settingsStore, assistantId, userId, unavailable)) {
        tools.set(tool.name, tool)
      }
    }

    if (extraInstances?.length && resolveInstanceCreds && persistInstanceCreds) {
      await injectInstanceVariants({
        provider: 'fathom',
        extras: extraInstances,
        settingsStore, assistantId, userId, assistantConnectorStore, tools,
        buildToolsForInstance: (inst) =>
          buildTools(makeTokenManager(
            () => resolveInstanceCreds(inst.id),
            (encoded) => persistInstanceCreds(inst.id, 'fathom_oauth', encoded),
          )),
      })
    }

    console.debug(`[mcp-inject] Fathom: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra account(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] Fathom injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One Fathom lane. Rotated token tuples persist through the lane's writers. */
export type FathomLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  credsOverride?: () => Promise<string | null>
  persistOverride?: (encoded: string) => Promise<void>
  extraInstances?: ConnectorInstanceRef[]
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  persistInstanceCreds?: (instanceId: string, clientId: string, secret: string) => Promise<void>
}

export async function activateFathomLane(ctx: ProviderActivationContext, lane: FathomLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectFathomTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.credsOverride,
    lane.persistOverride, lane.extraInstances, lane.resolveInstanceCreds, lane.persistInstanceCreds,
  )
  return [...tools.values()]
}

export const fathomProvider: ProviderModule<readonly FathomLane[]> = {
  family: 'fathom',
  describe: memoDescribe(() => describeFactoryTools('fathom', { fathom: () => createFathomTools(inertPort('fathom')) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateFathomLane(ctx, lane)),
}
