/**
 * Resolve the commerce-store tools a granted custom Home app may reach.
 *
 * Credential storage belongs to the workspace owner; read authority belongs
 * to the authenticated viewer plus primary assistant. Their canonical turn
 * scope gates connector discovery on every request.
 *
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
import { findAssistantById } from '../db/users.js'
import { resolveTurnScopeSystem } from '../context-scope/resolve-turn-scope.js'
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
  async function loadStoreTools(params: {
    workspaceId: string
    actingUserId?: string
    storeScope: AppStoreScope
    /**
     * Extra tools admitted by NAME, past the tier. Reserved for first-party
     * native app surfaces; the sandboxed bundle bridge never passes it, and
     * the `undefined` default is what keeps that true by omission rather than
     * by every caller remembering to say no.
     */
    alsoAllow?: readonly string[]
  }): Promise<Tool[]> {
    if (params.storeScope === 'none' || !params.actingUserId) return []

    const target = await resolveWriteTarget(params.workspaceId)
    if (!target) return []

    const assistant = await findAssistantById(target.assistantId)
    if (!assistant) return []
    const contextScope = await resolveTurnScopeSystem({
      userId: params.actingUserId, assistant, workspaceId: params.workspaceId,
    })
    const tools = new Map<string, Tool>()
    await injectMcpTools({
      ...deps,
      contextScope,
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

  return async function resolveStoreTools(params: Parameters<typeof loadStoreTools>[0]): Promise<Tool[]> {
    const tools = await loadStoreTools(params)
    return tools.map((tool) => ({
      ...tool,
      async execute(input, ctx) {
        let current: Tool | undefined
        try {
          // Discovery is not a durable grant. Reload current authority and
          // exact instance before invoking any provider-backed closure.
          current = (await loadStoreTools(params)).find((candidate) => candidate.name === tool.name)
        } catch {
          return { isError: true, data: 'Store access could not be verified. Refresh and try again.' }
        }
        if (!current) return { isError: true, data: 'This store tool is no longer available. Refresh to see your current access.' }
        return current.execute(current.inputSchema.parse(input), ctx)
      },
    }))
  }
}
