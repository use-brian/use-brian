/**
 * Resolve the commerce-store tools a granted custom Home app may reach.
 *
 * Binds to the **workspace owner + primary assistant** — the same principal
 * every other workspace-scoped credential on the brain MCP acts as
 * (`resolveWriteTarget`). That binding is what makes the authorization
 * compose instead of fork: `injectMcpTools` already applies the primary
 * assistant's per-connector action grants through `gateToolsOnActionGrants`,
 * so a store tool the owner never granted that assistant is absent here too.
 * The app's `storeScope` then narrows further, and destructive tools are
 * dropped outright.
 *
 * Four filters, all of which must pass:
 *   workspace exposure  ∩  connector grants  ∩  scopes.store tier  ∩  not destructive
 *
 * The first is the security boundary and the easiest to lose: it exists only
 * because `assistantTeamId` is passed below. See the comment on that field.
 *
 * Reusing `injectMcpTools` rather than reaching for `injectShopifyTools`
 * directly is deliberate: that path owns token load/persist/rotation, the
 * call-time health probe, and multi-store instances. A second Shopify wiring
 * beside it is the drift this codebase has been bitten by before.
 *
 * [COMP:api/home-app-store-tools]
 */

import type { Tool } from '@use-brian/core'
import type { AppStoreScope } from '@use-brian/brian-app'
import { injectMcpTools } from '../mcp/inject.js'
import { filterStoreTools } from '../brain-mcp/store-tools.js'
import { resolveWriteTarget } from '../brain-mcp/tools.js'

/** Connectors whose tools a Home app may reach under `scopes.store`. */
const STORE_CONNECTORS = ['shopify'] as const

export type StoreToolResolverDeps = Pick<
  Parameters<typeof injectMcpTools>[0],
  | 'connectorStore'
  | 'settingsStore'
  | 'assistantConnectorStore'
  | 'assistantConnectorGrantsStore'
  | 'connectorGrantStore'
  | 'connectorInstanceStore'
  | 'workspaceToolPolicyStore'
>

export function createStoreToolResolver(deps: StoreToolResolverDeps) {
  return async function resolveStoreTools(params: {
    workspaceId: string
    storeScope: AppStoreScope
    /**
     * Extra tools admitted by NAME, past the tier. Reserved for first-party
     * native app surfaces; the sandboxed bundle bridge never passes it, and
     * the `undefined` default is what keeps that true by omission rather than
     * by every caller remembering to say no.
     */
    alsoAllow?: readonly string[]
  }): Promise<Tool[]> {
    if (params.storeScope === 'none') return []

    const target = await resolveWriteTarget(params.workspaceId)
    if (!target) return []

    const tools = new Map<string, Tool>()
    await injectMcpTools({
      ...deps,
      userId: target.ownerUserId,
      assistantId: target.assistantId,
      tools,
      // THE workspace connector boundary, and the reason this is not optional.
      //
      // `injectMcpTools` reads `loadOwnerPersonalConnectors = !assistantTeamId`
      // (`mcp/inject.ts`). Omitting this field does not merely skip an overlay
      // — it flips the base load ON and hands the app the workspace OWNER'S
      // PERSONAL connectors, which is incident 2026-06-01 (a workspace admin
      // read the owner's personal Notion) re-created behind a sandboxed
      // third-party bundle. Setting it restricts the surface to exactly what
      // the callee path sees: `scope='workspace'` instances plus connectors a
      // member explicitly exposed via `connector_grant`.
      //
      // Consequence worth stating, because it reads as a regression and is
      // not one: a store connected at `scope='user'` yields ZERO tools here
      // until it is exposed to the workspace. Exposure is the grant; there is
      // no code path that should shortcut it.
      //
      // See docs/architecture/integrations/mcp.md → "Workspace connector
      // scoping". `connectorInstanceStore` + `connectorGrantStore` are the
      // overlays that repopulate the surface once exposure exists — without
      // them this returns nothing for every workspace, which fails closed but
      // makes the feature inert.
      assistantTeamId: params.workspaceId,
      // Built-ins must land in the map as THEMSELVES. The default path folds
      // every connector tool behind the `mcp_search` / `mcp_call` pair, and
      // this gate resolves a tool's classification from its NAME — behind
      // `mcp_call` there are no names to classify, so the filter would drop
      // everything and a granted app would silently see no store at all.
      //
      // The workflow executor sets this flag for the same shape of reason
      // (it inspects `requiresConfirmation`, which `mcp_call` also hides).
      //
      // Note the pair itself never reaches the app: `mcp_search` / `mcp_call`
      // are absent from `OFFICIAL_CONNECTOR_TOOLS.shopify`, so the registry
      // filter drops them. That is load-bearing — a reachable `mcp_call`
      // would be a name-addressed bypass around every rule in this file,
      // destructive tools included.
      keepBuiltinsDirect: true,
    })

    const collected: Tool[] = []
    for (const connectorId of STORE_CONNECTORS) {
      collected.push(
        ...filterStoreTools([...tools.values()], {
          connectorId,
          storeScope: params.storeScope,
          alsoAllow: params.alsoAllow,
        }),
      )
    }
    return collected
  }
}
