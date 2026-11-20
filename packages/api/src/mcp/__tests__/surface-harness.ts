/**
 * Test harness for suites written against the retired injector's parameter
 * shape (M3 WP5). `composeForTest(params)` prepares the same parameters
 * through the production entrypoint surface (`composeSurfaceCapabilities`):
 * the `workflow` surface for workflow-authorized knowledge writes, otherwise
 * the `web` surface narrowed by the parameters exactly as an entrypoint's
 * options narrow its profile.
 *
 * Unit suites have no database, so the catalog's two bulk reads are served
 * from the suite's own mocked stores: the policy read probes the mocked
 * per-user and workspace policy stores for every registry tool, and the
 * action-grant read lists the mocked grants store. Production uses one SQL
 * statement each (`mcp/catalog.ts`).
 */
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { CatalogActionGrantReader, CatalogPolicyReader, CatalogPolicyRow } from '../catalog.js'
import { composeSurfaceCapabilities, type SurfaceCapabilities, type SurfaceCapabilityOptions } from '../surface.js'

type Policy = 'allow' | 'ask' | 'block'

function probingPolicyReader(params: SurfaceCapabilityOptions): CatalogPolicyReader {
  return async ({ assistantIds, userIds, workspaceId }) => {
    const rows: CatalogPolicyRow[] = []
    // Provider servers plus every listed instance's exact governance id.
    const servers: Array<[string, readonly { name: string }[]]> = Object.entries(OFFICIAL_CONNECTOR_TOOLS)
    const instances = workspaceId
      ? (await params.connectorInstanceStore?.listByWorkspaceSystem?.(workspaceId).catch(() => []) ?? []).map((row) => ({ provider: row.provider, id: row.id }))
      : []
    for (const { provider, id } of instances) servers.push([`${provider}:${id}`, OFFICIAL_CONNECTOR_TOOLS[provider] ?? []])
    for (const [serverName, tools] of servers) {
      for (const { name: toolName } of tools) {
        for (const assistantId of assistantIds) {
          for (const userId of userIds) {
            const row = await params.settingsStore.getPolicy({ assistantId, userId, serverName, toolName })
            if (row?.policy) rows.push({ scope: 'user', assistantId, userId, serverName, toolName, policy: row.policy as Policy })
          }
        }
        if (workspaceId && params.workspaceToolPolicyStore) {
          const row = await params.workspaceToolPolicyStore.getPolicy(workspaceId, serverName, toolName)
          if (row?.policy) rows.push({ scope: 'workspace', workspaceId, serverName, toolName, policy: row.policy as Policy })
        }
      }
    }
    return rows
  }
}

function listingGrantReader(params: SurfaceCapabilityOptions): CatalogActionGrantReader | null {
  const store = params.assistantConnectorGrantsStore
  if (!store) return null
  // Mirror the execute-time gate over the suite's mocked per-connector read:
  // a missing grant row grants nothing.
  return async (assistantId) => {
    const rows: Array<{ connectorId: string; allowedActions: readonly string[] }> = []
    for (const connectorId of Object.keys(OFFICIAL_CONNECTOR_TOOLS)) {
      const grant = await store.getForAssistantSystem(assistantId, connectorId)
      rows.push({ connectorId, allowedActions: grant?.allowedActions ?? [] })
    }
    return rows
  }
}

/**
 * Suites that mock only the per-connector `isEnabled` read get a bulk
 * `listForAssistant` built from it over the rows the fixture lists (the
 * catalog reads enablement once per turn).
 */
function withBulkEnablement(params: SurfaceCapabilityOptions): SurfaceCapabilityOptions['assistantConnectorStore'] {
  const store = params.assistantConnectorStore as (SurfaceCapabilityOptions['assistantConnectorStore'] & Record<string, unknown>) | undefined
  if (!store || typeof store.listForAssistant === 'function' || typeof store.isEnabled !== 'function') return store
  const listForAssistant = async (assistantId: string) => {
    const teamId = params.assistantTeamId
    const rows: Array<{ provider: string; id: string }> = []
    if (!teamId) for (const row of await params.connectorStore.list(params.userId).catch(() => [])) rows.push({ provider: row.connectorId, id: row.id })
    if (teamId && params.connectorInstanceStore) {
      for (const row of await params.connectorInstanceStore.listByWorkspaceSystem(teamId).catch(() => [])) rows.push({ provider: row.provider, id: row.id })
    }
    if (teamId && params.connectorGrantStore) {
      for (const grant of await params.connectorGrantStore.listForTargetSystem('workspace', teamId).catch(() => [])) rows.push({ provider: grant.instance.provider, id: grant.instance.id })
    }
    const out: Array<{ connectorId: string; enabled: boolean }> = []
    for (const { provider, id } of rows) {
      for (const governanceId of [provider, `${provider}:${id}`]) {
        if (out.some((row) => row.connectorId === governanceId)) continue
        out.push({ connectorId: governanceId, enabled: await store.isEnabled(assistantId, governanceId, provider) })
      }
    }
    return out
  }
  return Object.assign(Object.create(store), { listForAssistant }) as never
}

export function composeForTest(params: SurfaceCapabilityOptions): Promise<SurfaceCapabilities> {
  const surface = params.knowledgeWriteAuthorization === 'workflow' ? 'workflow' : 'web'
  return composeSurfaceCapabilities(surface, {
    ...params,
    assistantConnectorStore: withBulkEnablement(params),
    policyReader: params.policyReader ?? probingPolicyReader(params),
    actionGrantReader: params.actionGrantReader !== undefined ? params.actionGrantReader : listingGrantReader(params),
    routineCalendarRead: params.routineCalendarRead ?? params.exposeLocalReadTools,
  })
}

/**
 * Dynamic sources are discovered lazily, when a search names them (the
 * injector discovered every source while composing). Suites that assert on
 * discovery search for the source first, as the model does.
 */
export async function discoverSources(tools: ReadonlyMap<string, import('@use-brian/agent-runtime/tools/types.js').Tool>, labels: string | readonly string[],
  context: import('@use-brian/agent-runtime/tools/types.js').ToolContext = {} as never): Promise<void> {
  const search = tools.get('mcp_search')
  for (const label of typeof labels === 'string' ? [labels] : labels) await search?.execute({ query: label }, context)
}
