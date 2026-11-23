/**
 * Microsoft Graph (Teams) provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyToolPolicies`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createMsGraphTools } from '@use-brian/core/tools/base/msgraph.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { wrapToolsWithHealthProbe, type HealthReporter } from '../connector-health.js'
import { createMsGraphClient } from '../../msgraph/client.js'
import { createMsGraphTokenManager, packMsGraphTokens, unpackMsGraphTokens, unpackMsGraphAppCredentials, type MsGraphTokens } from '../../msgraph/token.js'
import { getConnectorConfig } from '../../connector-config.js'
import { applyToolPolicies } from '../activation.js'
import { notConnectedNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in Microsoft Graph (Teams) connector ─────────────
//
// READ-ONLY Teams access (docs/architecture/integrations/msgraph.md). Two
// things differ from the injectors above:
//
//   - Like Fathom, the credential is an OAuth tuple whose refresh token
//     ROTATES on every use, so the token manager persists the new tuple back
//     into the credentials envelope before returning. See msgraph/token.ts.
//   - Unlike GitHub/Notion/Fathom/Shopify there is no extras path: `msgraph`
//     is `single_instance` in OFFICIAL_CONNECTORS (one Microsoft identity per
//     user), which keeps it out of MULTI_INSTANCE_CONNECTOR_IDS entirely.
//     Dropping that flag means wiring `extrasByProvider.get('msgraph')`
//     through here in the same change, or a second account is silently dead.
//
// Called from THREE places, and all three must stay wired: the base built-in
// pass (personal, workspace-less assistants), the member-exposure grant
// overlay, and the team-native overlay. A workspace assistant NEVER reaches
// the base pass — the connector-scoping gate suppresses it — so an injector
// that only the base pass calls is dead for every assistant a user actually
// chats with, while Studio still lists its tools as connected and governable.

async function collectMsGraphTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** Call-time liveness probe (migration 294). See `collectGitHubTools`. */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /**
   * Workspace-overlay credential binding. Reads the packed tuple off the EXACT
   * exposed / team-owned `connector_instance` row instead of the provider-wide
   * `getCredentials(userId, 'msgraph')` lookup (which is
   * `ORDER BY created_at ASC LIMIT 1` — the grantor's oldest account, possibly
   * one that was never exposed to this workspace; incident 2026-07-08).
   */
  credsOverride?: () => Promise<string | null>,
  /**
   * Where the ROTATED tuple lands. Graph invalidates the refresh token on every
   * use, so an overlay that reads from the instance row but writes back to the
   * user-scoped envelope bricks the connector on the second call — the hazard
   * that deferred team-native Fathom. Always pass this alongside
   * `credsOverride`.
   */
  persistOverride?: (encoded: string) => Promise<void>,
): Promise<void> {
  const msgraphCfg = getConnectorConfig('msgraph')
  const msgraph = connectors.find((c) => c.connectorId === 'msgraph' && c.connected)
  const msgraphEnabled = msgraph && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'msgraph'))

  if (!msgraph || !msgraphEnabled) {
    // Connector-less boot (the open single-player default): no deployment app
    // and nothing connected. Stay silent rather than spending context telling
    // the model about a connector nobody on this install could have connected.
    // A workspace-owned app is invisible from here — this path has no
    // workspace id — but it is only reachable through a connected instance
    // anyway, which is the branch below.
    if (!msgraphCfg) return
    unavailable?.push(notConnectedNotice('Microsoft Teams', 'reading and searching Teams channels, chats, and members'))
    return
  }

  async function readCredentialBlob(): Promise<string | null> {
    return credsOverride
      ? await credsOverride()
      : (await connectorStore.getCredentials(userId, 'msgraph'))?.client_secret ?? null
  }

  // Which Entra app rotates this grant. Deployment config is the FALLBACK
  // here, not the gate: a workspace that registered its own app
  // (connector_app_credentials, migration 394) is connected through an app
  // this process has no env var for, and gating on `getConnectorConfig` would
  // make every such connection inject zero tools while Studio kept showing it
  // connected. The pair rides in the grant envelope precisely so this path can
  // find it without a workspace id, which it does not have.
  const envelopeApp = unpackMsGraphAppCredentials((await readCredentialBlob()) ?? '')
  const app = envelopeApp ?? msgraphCfg
  if (!app) {
    // Connected, but no app can rotate the token — a self-host that removed
    // its env config after users connected. Say so rather than injecting tools
    // that would all fail at the first refresh.
    unavailable?.push(notConnectedNotice('Microsoft Teams', 'reading and searching Teams channels, chats, and members'))
    return
  }
  // Captured as primitives so the nested closures keep the narrowing (TS
  // widens the captured object back to possibly-undefined) — same reason as
  // the Fathom injector above.
  const clientId = app.clientId
  const clientSecret = app.clientSecret

  const tokenManager = createMsGraphTokenManager({
    clientId,
    clientSecret,
    store: {
      async getTokens(): Promise<MsGraphTokens | null> {
        const blob = await readCredentialBlob()
        return blob ? unpackMsGraphTokens(blob) : null
      },
      async persistTokens(next) {
        const encoded = packMsGraphTokens(next)
        if (persistOverride) {
          await persistOverride(encoded)
          return
        }
        await connectorStore.upsert(userId, {
          connectorId: 'msgraph',
          name: 'Microsoft Teams',
          connected: true,
          credentials: { client_id: 'msgraph_oauth', client_secret: encoded },
        })
      },
    },
  })

  const primaryInstanceId = healthProbe?.instanceId ?? (msgraph as { id?: string }).id ?? null
  try {
    // `retry` is left at its default so the client uses the real
    // `fetchWithRetry` — Graph enforces ~1 rps per channel and this is the
    // only connector in the repo that honours `Retry-After`.
    const built = createMsGraphTools(
      createMsGraphClient({ getAccessToken: () => tokenManager.getAccessToken() }),
    )
    // A dead refresh token surfaces as a thrown MsGraphTokenError whose
    // message carries `invalid_grant`, which `classifyConnectorAuthError`
    // reads — so the probe flips this instance to `auth_failed` on first use,
    // the same signal the Google extras path relies on.
    const msgraphTools = healthProbe && primaryInstanceId
      ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
      : built

    for (const tool of await applyToolPolicies(msgraphTools, 'msgraph', settingsStore, assistantId, userId, unavailable)) {
      tools.set(tool.name, tool)
    }

    console.debug('[mcp-inject] Microsoft Teams: injected tools')
  } catch (err) {
    console.error('[mcp-inject] Microsoft Teams injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One Microsoft Graph lane. Overlay lanes always pair `credsOverride` with `persistOverride`. */
export type MsGraphLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  healthProbe?: { report: HealthReporter; instanceId?: string | null }
  credsOverride?: () => Promise<string | null>
  persistOverride?: (encoded: string) => Promise<void>
}

export async function activateMsGraphLane(ctx: ProviderActivationContext, lane: MsGraphLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectMsGraphTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.healthProbe,
    lane.credsOverride, lane.persistOverride,
  )
  return [...tools.values()]
}

export const msgraphProvider: ProviderModule<readonly MsGraphLane[]> = {
  family: 'msgraph',
  describe: memoDescribe(() => describeFactoryTools('msgraph', { msgraph: () => createMsGraphTools(inertPort('msgraph')) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateMsGraphLane(ctx, lane)),
}
