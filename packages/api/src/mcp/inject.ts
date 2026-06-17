/**
 * MCP tool injection — discovers tools from the user's connected MCP
 * servers and injects them into the query loop's tool map.
 *
 * Uses the **tool search pattern** (Pattern E): 2 tools (mcp_search +
 * mcp_call) replace N per-connector gateways. The model searches for
 * relevant tools by keyword, gets back schemas, then calls them.
 *
 * Discovery results are cached in-memory with a 5-minute TTL to avoid
 * re-discovering on every chat turn within the same session.
 *
 * ⚠️ Drift hazard: every tool wired in a `createXxxTools({...})` block below
 * must also appear in `OFFICIAL_CONNECTOR_TOOLS` in
 * `packages/shared/src/builtin-connectors.ts`, or the web UI (Settings ▸
 * Connectors, Assistant ▸ Tools) will not show or govern it. See
 * docs/architecture/integrations/mcp.md → "Adding a new built-in connector tool".
 *
 * See docs/architecture/integrations/mcp.md → "Runtime".
 */

import { buildToolIndex, createMcpSearchTools, createGoogleCalendarTools, createGmailTools, createGoogleTasksTools, createGoogleDriveTools, createGoogleDocsTools, createGoogleSheetsTools, createGoogleSlidesTools, createGDriveFilesTools, createGitHubTools, createNotionTools, createFathomTools, createKnowledgeTools } from '@sidanclaw/core'
import type { Tool, McpSettingsStore, McpServerConfig, KnowledgeStoreInterface, AuthorizedFile, GDriveFilesStore, GDriveFileKind, LocalSource, RemoteSource } from '@sidanclaw/core'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../connector-action-port.js'
import { isSoloWorkspaceSystem } from '../db/workspace-store.js'
import { discoverMcpServer, callRemoteMcpTool } from './client.js'
import { buildConnectorAuthHeaders } from './auth-headers.js'
import {
  refreshGoogleAccessToken,
  listCalendarEvents, getCalendarEvent, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  listGmailMessages, getGmailMessage, sendGmailMessage,
  listTaskLists, listGoogleTasks, getGoogleTask, createGoogleTask, updateGoogleTask, deleteGoogleTask,
  listDriveFiles, getDriveFile, getDriveFileContent, createDriveFile, updateDriveFileContent,
  getDocContent, appendToDoc, replaceInDoc, createDocument,
  getSpreadsheetInfo, readSheetRange, writeSheetRange, appendSheetRows, createSpreadsheet, formatSpreadsheet, batchUpdateSpreadsheet,
  getPresentationInfo, getSlideContent, getSlideThumbnail,
  createSlide as slidesCreateSlide,
  updateSlideContent as slidesUpdateSlideContent,
  insertImage as slidesInsertImage,
  deleteSlide as slidesDeleteSlide,
  reorderSlides as slidesReorderSlides,
  duplicateSlide as slidesDuplicateSlide,
  batchUpdateSlides,
  createPresentation,
} from '../google/client.js'
import {
  searchRepositories, getRepository, listIssues, getIssue,
  listPullRequests, getPullRequest, createIssue, createIssueComment,
  getFileContents, createOrUpdateFile,
} from '../github/client.js'
import {
  searchNotion, getNotionPage, getNotionDatabase, queryNotionDatabase,
  createNotionPage, updateNotionPage, appendNotionBlocks,
} from '../notion/client.js'
import {
  createFathomTokenManager,
  listFathomMeetings, getFathomMeeting, getFathomTranscript, getFathomSummary,
  unpackFathomTokens, packFathomTokens,
  type FathomTokens,
} from '../fathom/client.js'
import { APP_LEVEL_ASSISTANT_ID } from '@sidanclaw/shared'
// Built-in connector OAuth app creds come through getConnectorConfig (OPEN, file
// or env), NOT getEnv (closed env schema) — so this open injector imports no
// closed code. See connector-config.ts + oss-local-brain-wedge.md §12.2.
import { getConnectorConfig } from '../connector-config.js'

// ── Discovery cache (in-memory, per-process) ──────────────────

type CachedDiscovery = {
  server: McpServerConfig
  cachedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CACHE_MAX_ENTRIES = 1000
const discoveryCache = new Map<string, CachedDiscovery>()

function getCachedDiscovery(cacheKey: string): McpServerConfig | null {
  const cached = discoveryCache.get(cacheKey)
  if (!cached) return null
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    discoveryCache.delete(cacheKey)
    return null
  }
  return cached.server
}

function setCachedDiscovery(cacheKey: string, server: McpServerConfig): void {
  // The cache key includes the row's updated_at, so a credential/URL edit
  // (or a connected-flip from the probe) mints a fresh key and orphans the
  // old one — delete-on-read can never reclaim it. Bound growth: when over
  // the cap, sweep TTL-expired entries first, then evict oldest-inserted
  // (Map preserves insertion order) until back under.
  if (discoveryCache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now()
    for (const [k, v] of discoveryCache) {
      if (now - v.cachedAt > CACHE_TTL_MS) discoveryCache.delete(k)
    }
    while (discoveryCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = discoveryCache.keys().next().value
      if (oldest === undefined) break
      discoveryCache.delete(oldest)
    }
  }
  discoveryCache.set(cacheKey, { server, cachedAt: Date.now() })
}

export function _getMcpDiscoveryCacheSize(): number {
  return discoveryCache.size
}

// ── Built-in tool surface (drift-sweep source of truth) ───────

/**
 * Tools that `injectMcpTools()` injects per connector when the connector
 * is connected + enabled (regardless of L1/L2 policy resolution). Static
 * source of truth for the drift-sweep admin surface
 * (`packages/api/src/mcp/drift.ts`).
 *
 * If you add a `createXxxTools()` call inside an injector below, add the
 * tool names here in the same edit. The corresponding governance row is
 * `OFFICIAL_CONNECTOR_TOOLS` in `packages/shared/src/builtin-connectors.ts`
 * — any mismatch between this constant and that one is surfaced as drift
 * on the Drift Sweep admin page.
 *
 * NOT included: workspace `files` tools (boot-wired in
 * `apps/api/src/index.ts`; see `BOOT_INJECTED_BUILTIN_TOOLS` in
 * `packages/shared/src/builtin-connectors.ts`).
 */
export const INJECTED_BUILTIN_TOOLS_BY_CONNECTOR: Record<string, readonly string[]> = {
  gcal: [
    'googleCalendarListEvents',
    'googleCalendarGetEvent',
    'googleCalendarCreateEvent',
    'googleCalendarUpdateEvent',
    'googleCalendarDeleteEvent',
    'googleTasksListTaskLists',
    'googleTasksListTasks',
    'googleTasksGetTask',
    'googleTasksCreateTask',
    'googleTasksUpdateTask',
    'googleTasksDeleteTask',
  ],
  gmail: [
    'gmailListMessages',
    'gmailGetMessage',
    'gmailSendMessage',
  ],
  gdrive: [
    'googleDriveListFiles',
    'googleDriveGetFile',
    'googleDriveGetFileContent',
    'googleDriveCreateFile',
    'googleDriveUpdateFile',
    'googleDocsGetContent',
    'googleDocsAppendText',
    'googleDocsReplaceText',
    'googleDocsCreate',
    'googleSheetsGetInfo',
    'googleSheetsReadRange',
    'googleSheetsWriteRange',
    'googleSheetsAppendRows',
    'googleSheetsCreate',
    'googleSheetsFormat',
    'googleSheetsBatchUpdate',
    'googleSlidesGetPresentation',
    'googleSlidesGetSlideContent',
    'googleSlidesGetThumbnail',
    'googleSlidesCreateSlide',
    'googleSlidesUpdateSlideContent',
    'googleSlidesInsertImage',
    'googleSlidesDeleteSlide',
    'googleSlidesReorderSlides',
    'googleSlidesDuplicateSlide',
    'googleSlidesBatchUpdate',
    'googleSlidesCreatePresentation',
    'findGDriveFiles',
  ],
  github: [
    'githubSearchRepositories',
    'githubGetRepository',
    'githubListIssues',
    'githubGetIssue',
    'githubListPullRequests',
    'githubGetPullRequest',
    'githubCreateIssue',
    'githubCreateIssueComment',
    'githubGetFileContents',
    'githubWriteFile',
  ],
  notion: [
    'notionSearch',
    'notionGetPage',
    'notionGetDatabase',
    'notionQueryDatabase',
    'notionCreatePage',
    'notionUpdatePage',
    'notionAppendBlocks',
  ],
  fathom: [
    'fathomListMeetings',
    'fathomGetMeeting',
    'fathomGetTranscript',
    'fathomGetSummary',
  ],
}

// ── Main injection ────────────────────────────────────────────

/**
 * Discover tools from the user's connected MCP servers and inject
 * mcp_search + mcp_call tools into the tools map.
 */
/** Enriches confirmation input by fetching real data (e.g. actual event title from Google Calendar). */
export type ConfirmationEnricher = (toolName: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>

export type McpInjectionResult = {
  enrichConfirmation: ConfirmationEnricher
  /** Capabilities that are unavailable (not connected, disabled, or blocked). Injected into the system prompt so the model doesn't waste turns searching for them. */
  unavailable: string[]
}

export async function injectMcpTools(params: {
  userId: string
  assistantId: string
  tools: Map<string, Tool>
  connectorStore: ConnectorStore
  settingsStore: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  userTimezone?: string
  knowledgeStore?: KnowledgeStoreInterface
  gdriveFilesStore?: GDriveFilesStore
  /**
   * Stage 4/5 of the team-connector promotion: when the turn is on a
   * team-owned assistant, these stores enable member-exposure grant and
   * team-native instance consumption. Personal assistants and back-compat
   * paths can omit them.
   */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  assistantTeamId?: string | null
  /**
   * Connector-action audit deps. When provided, the Gmail
   * `sendMessage` callback wraps its execute with a `connector_action`
   * Episode + audit row emit (per `connector-actions.md`). Absent →
   * Gmail still works; only the audit trail is skipped.
   */
  connectorActionAudit?: ConnectorActionAudit
  /**
   * Per-assistant capability grants store (#4 in `connector-actions.md`).
   * Forwarded to `injectGoogleTools` so Gmail/GCal write callbacks
   * gate on `assertActionAllowed` before executing.
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /**
   * Authoritative primary email domain for the acting assistant's
   * workspace — drives `audience_clearance` derivation in the GCal
   * audit hook. Absent / null → every attendee treated as external.
   */
  workspaceDomain?: string | null
  /**
   * Tool-search routing for built-in connectors (PR #4 of token-cost
   * reduction).
   *
   * **Default (false):** built-ins (Google / GitHub / Notion / Fathom / KB)
   * are gathered into local sources for `buildToolIndex` and exposed to the
   * model behind `mcp_search` + `mcp_call`. Saves ~5k input tokens/turn for
   * a fully-connected user; the model discovers via search and the
   * dispatcher fires each tool's `requiresConfirmation` /
   * `describeConfirmation` / unified-approvals flow with the canonical
   * underlying name.
   *
   * **`true`:** legacy direct injection — each built-in lands in `tools`
   * map under its canonical name. Required for the workflow path
   * (`packages/api/src/workflow/mcp-bridge.ts`) because the workflow
   * executor inspects each tool's `requiresConfirmation` to decide
   * Phase-A fail-fast vs Phase-C pause; routing through `mcp_call`
   * hides those flags from the executor.
   *
   * See `docs/architecture/integrations/mcp.md` → "Tool search pattern".
   */
  keepBuiltinsDirect?: boolean
}): Promise<McpInjectionResult> {
  const {
    userId, assistantId, tools, connectorStore, settingsStore, assistantConnectorStore,
    userTimezone, knowledgeStore, gdriveFilesStore,
    connectorGrantStore, connectorInstanceStore, assistantTeamId,
    connectorActionAudit, assistantConnectorGrantsStore, workspaceDomain,
    keepBuiltinsDirect = false,
  } = params

  const unavailable: string[] = []

  // ── Workspace connector-scoping gate (SECURITY — incident 2026-06-01,
  //    re-opened 2026-06-02) ──
  //
  // The base load below pulls `userId`'s personal (scope='user') connectors.
  // For a workspace assistant, `userId` was resolved to the workspace OWNER
  // via `getConnectorUserId` in the route. That is safe ONLY while the owner
  // is the workspace's SOLE member — then their personal connectors ARE the
  // workspace's connectors.
  //
  // The gate is `isSoloWorkspaceSystem` (live member count <= 1), keyed purely
  // on member count and NEVER on `is_personal`: per workspaces.md, `is_personal`
  // is only a label marking the auto-created *default* workspace, and teammates
  // are invited into that same workspace with no "promote to team" migration —
  // so it routinely has multiple members. Keying on the flag re-exposed the
  // owner's private Gmail/Notion to every member (a 3-member is_personal
  // workspace was injecting the owner's connectors for everyone). Every
  // workspace is treated identically: solo (any kind) loads the owner-personal
  // base, multi-member (any kind) suppresses it. Once a second member joins,
  // the workspace's tool access must come SOLELY from team-native
  // (scope='workspace') instances + member-exposure grants (`connector_grant`)
  // — both applied as overlays further down — so we suppress the owner-personal
  // base load.
  //
  // See docs/architecture/integrations/mcp.md → "Workspace connector scoping"
  // and `resolveConnectorInstances` (the Stage-5 intent this enforces).
  let loadOwnerPersonalConnectors = true
  if (assistantTeamId) {
    loadOwnerPersonalConnectors = await isSoloWorkspaceSystem(assistantTeamId)
  }

  let connectors
  try {
    connectors = loadOwnerPersonalConnectors ? await connectorStore.list(userId) : []
  } catch (err) {
    console.error('[mcp-inject] failed to list connectors:', err)
    return { enrichConfirmation: async (_t, input) => input, unavailable }
  }

  // Layer 1: connected connectors with a remote URL (custom + directory).
  // Built-in connectors (gcal, gmail) are handled separately below. We
  // normalize personal and team-native custom MCPs into the same slim
  // shape so the discovery loop is shared.
  // `instanceId` is the connector_instance UUID (the shim's McpConnector.id
  // IS that UUID) — used to resolve per-instance auth credentials.
  // `updatedAt` feeds the discovery cache key so credential/URL edits
  // self-invalidate the 5-minute cache.
  const connectedCustom: Array<{
    connectorId: string
    name: string
    url: string
    instanceId: string | null
    updatedAt: Date | null
  }> = connectors
    .filter((c) => c.connected && c.url)
    .map((c) => ({ connectorId: c.connectorId, name: c.name, url: c.url!, instanceId: c.id, updatedAt: c.updatedAt }))

  // Team-native custom MCP instances live as separate `connector_instance`
  // rows scoped to the team. The `provider` column is a UUID for custom
  // team MCPs (set in connector-instances.ts), so it never collides with
  // personal connectorIds, and the L2 toggle key matches what
  // /api/assistants/:id/connectors writes.
  if (assistantTeamId && connectorInstanceStore) {
    try {
      const teamInstances = await connectorInstanceStore.listByWorkspaceSystem(assistantTeamId)
      for (const inst of teamInstances) {
        if (!inst.custom || !inst.connected || !inst.url) continue
        connectedCustom.push({
          connectorId: inst.provider,
          name: inst.label,
          url: inst.url,
          instanceId: inst.id,
          updatedAt: inst.updatedAt,
        })
      }
    } catch (err) {
      console.error('[mcp-inject] team-native custom MCP listing failed:', err)
    }
  }

  // Filter by assistant-level enablement (Layer 2). No row = default enabled.
  let active = connectedCustom
  if (assistantConnectorStore) {
    const checks = await Promise.all(
      connectedCustom.map(async (c) => ({
        connector: c,
        enabled: await assistantConnectorStore.isEnabled(assistantId, c.connectorId),
      })),
    )
    active = checks.filter((c) => c.enabled).map((c) => c.connector)
  }

  // ── Discover tools (with cache) ──────────────────────────────

  const DISCOVERY_TIMEOUT = 8_000

  // Per-URL auth headers for outbound custom-MCP requests. Execution
  // dispatches by serverUrl alone (tool-search's mcp_call carries no
  // per-entry credentials — see the top-level callMcpTool below), so the
  // join key is the URL. First instance to register a URL wins, matching
  // the by-URL discovery dedupe in addGrantedCustomMcp.
  const headersByUrl = new Map<string, Record<string, string>>()

  async function loadAuthHeaders(instanceId: string | null | undefined): Promise<Record<string, string>> {
    if (!instanceId || !connectorInstanceStore) return {}
    try {
      const creds = await connectorInstanceStore.getAuthCredentialsSystem(instanceId)
      return buildConnectorAuthHeaders(creds)
    } catch (err) {
      console.error('[mcp-inject] auth-header resolution failed:', err)
      return {}
    }
  }

  function registerAuthHeaders(url: string, headers: Record<string, string>): void {
    if (Object.keys(headers).length > 0 && !headersByUrl.has(url)) {
      headersByUrl.set(url, headers)
    }
  }

  const discoveredServers: Array<{
    server: McpServerConfig
    connectorUrl: string
  }> = []

  // Resolve per-connector auth headers up front and register them in the
  // deterministic `active` array order (stable: custom ASC, label ASC, then
  // team-native). When two instances share a serverUrl, the winner is the
  // first in that order, not whichever DB read resolved first — discovery
  // and the mcp_call dispatcher then agree on one header set per URL.
  const resolvedHeaders = await Promise.all(active.map((c) => loadAuthHeaders(c.instanceId)))
  active.forEach((c, i) => registerAuthHeaders(c.url, resolvedHeaders[i]))

  const discoveries = await Promise.allSettled(
    active.map(async (connector) => {
      const authHeaders = headersByUrl.get(connector.url) ?? {}

      // `updatedAt` in the key: credential/URL edits bump the row's
      // updated_at, so a stale-auth discovery never outlives an edit.
      const cacheKey = `${userId}:${connector.connectorId}:${connector.url}:${connector.updatedAt?.getTime() ?? 0}`

      // Check cache first
      const cached = getCachedDiscovery(cacheKey)
      if (cached) {
        console.debug(`[mcp-inject] ${connector.name}: cache hit (${cached.tools.length} tools)`)
        discoveredServers.push({ server: cached, connectorUrl: connector.url })
        return
      }

      // Discover with timeout
      const server = await Promise.race([
        discoverMcpServer(connector.url, connector.name, authHeaders),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Discovery timeout for ${connector.name}`)), DISCOVERY_TIMEOUT),
        ),
      ])

      setCachedDiscovery(cacheKey, server)
      discoveredServers.push({ server, connectorUrl: connector.url })

      console.debug(
        `[mcp-inject] ${connector.name}: discovered ${server.tools.length} tools`,
      )
    }),
  )

  for (const result of discoveries) {
    if (result.status === 'rejected') {
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
  const remoteSources: RemoteSource[] = discoveredServers.map(({ server, connectorUrl }) => ({
    kind: 'remote' as const,
    server,
    serverUrl: connectorUrl,
    callMcpTool: (url: string, toolName: string, input: Record<string, unknown>) =>
      callRemoteMcpTool(url, toolName, input, headersByUrl.get(url)),
  }))

  // Discover a custom remote MCP shared to this workspace via a grant and add
  // it to the search index. Per-instance auth credentials (bearer / custom
  // header) are resolved off the granted instance row and joined by URL —
  // same as the personal / team-native custom paths above. Deduped by URL so
  // a server reachable through more than one path is indexed once. See
  // docs/architecture/integrations/mcp.md → "Workspace connector scoping".
  async function addGrantedCustomMcp(
    url: string,
    name: string,
    cacheUserId: string,
    instanceId?: string | null,
    updatedAt?: Date | null,
  ): Promise<void> {
    if (remoteSources.some((s) => s.serverUrl === url)) return
    try {
      const authHeaders = await loadAuthHeaders(instanceId)
      registerAuthHeaders(url, authHeaders)
      const cacheKey = `${cacheUserId}:${url}:${updatedAt?.getTime() ?? 0}`
      let server = getCachedDiscovery(cacheKey)
      if (!server) {
        server = await Promise.race([
          discoverMcpServer(url, name, authHeaders),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Discovery timeout for ${name}`)), DISCOVERY_TIMEOUT),
          ),
        ])
        setCachedDiscovery(cacheKey, server)
      }
      remoteSources.push({
        kind: 'remote',
        server,
        serverUrl: url,
        callMcpTool: (u: string, toolName: string, input: Record<string, unknown>) =>
          callRemoteMcpTool(u, toolName, input, headersByUrl.get(u)),
      })
      console.debug(`[mcp-inject] granted custom MCP ${name}: discovered ${server.tools.length} tools`)
    } catch (err) {
      console.error(`[mcp-inject] granted custom MCP discovery failed (${name}):`, err)
    }
  }

  // ── Multi-account extras (personal base load) ────────────────
  // For single-secret built-ins a user can connect more than one account.
  // The OLDEST connected instance per provider keeps the canonical tools (so
  // single-account users are unchanged); each additional instance is exposed
  // as a label-qualified variant set bound to its own credentials. Requires
  // the instance store for per-instance credential reads/writes.
  const MULTI_INSTANCE_RUNTIME_PROVIDERS = ['github', 'notion', 'fathom'] as const // drift-sweep: intentionally-narrow: single-secret providers with instance-aware runtime credential resolution (deliberately excludes Google)
  const extrasByProvider = new Map<string, ConnectorInstanceRef[]>()
  if (connectorInstanceStore) {
    for (const provider of MULTI_INSTANCE_RUNTIME_PROVIDERS) {
      const insts = connectors
        .filter((c) => c.connectorId === provider && c.connected)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      if (insts.length > 1) {
        extrasByProvider.set(provider, insts.slice(1).map((c) => ({ id: c.id, label: c.name })))
      }
    }
  }
  const resolveInstanceCreds = connectorInstanceStore
    ? async (id: string) => (await connectorInstanceStore.getCredentialsSystem(id))?.client_secret ?? null
    : undefined
  const persistInstanceCreds = connectorInstanceStore
    ? async (id: string, clientId: string, secret: string) =>
        connectorInstanceStore.updateCredentialsSystem(id, { client_id: clientId, client_secret: secret })
    : undefined

  // ── Built-in connectors ─────────────────────────────────────
  await injectGitHubTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, extrasByProvider.get('github'), resolveInstanceCreds)
  await injectNotionTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, extrasByProvider.get('notion'), resolveInstanceCreds)
  await injectFathomTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, undefined, extrasByProvider.get('fathom'), resolveInstanceCreds, persistInstanceCreds)
  const enricher = await injectGoogleTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, userTimezone, unavailable, gdriveFilesStore, undefined, connectorActionAudit, assistantConnectorGrantsStore, workspaceDomain)

  // ── Team overlays (Stage 4/5 of the team-connector promotion) ──
  //
  // For a *personal* workspace the block above injected the owner's personal
  // connectors (owner == sole member). For a *shared* workspace that base
  // load was suppressed (see the connector-scoping gate above), so for shared
  // workspaces these overlays are the ONLY source of connector tools. Here we
  // overlay two sources, in precedence order:
  //
  //   Team-native instances (scope='team')  — HIGHEST precedence. The
  //     team admin configured a team-owned credential for this provider
  //     (e.g. a team GitHub service account). Credentials live only in
  //     `connector_instance.credentials`, so we drive the per-provider
  //     injectors via a `credsOverride` that reads from there directly.
  //
  //   Member-exposure grants  — LOWEST precedence of the overlays.
  //     Each grant routes the relevant injector through the grantor's
  //     `userId`, reusing the existing `mcp_connectors` path because
  //     grantor instances are dual-written into that table.
  //
  // Last writer wins on the tool map: team-native overrides grants
  // override the team-owner's personal connectors. This matches the V1
  // "most specific source wins" semantic from
  // docs/architecture/integrations/mcp.md.
  //
  // Both overlays are gated on their respective stores being passed in so
  // legacy call sites (pre-promotion, tests) stay unchanged.
  if (assistantTeamId && connectorGrantStore) {
    try {
      const grants = await connectorGrantStore.listForTargetSystem('workspace', assistantTeamId)
      const overlaidByGrant = new Set<string>()
      for (const g of grants) {
        if (!g.instance.connected) continue
        const p = g.instance.provider
        if (overlaidByGrant.has(p)) continue    // first grant per provider wins
        overlaidByGrant.add(p)
        const grantorConnectors = await connectorStore.list(g.grantedByUserId).catch(() => [])
        if (p === 'github') {
          await injectGitHubTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined)
        } else if (p === 'notion') {
          await injectNotionTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined)
        } else if (p === 'fathom') {
          await injectFathomTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined)
        } else if (p === 'gcal' || p === 'gmail' || p === 'gdrive') {
          await injectGoogleTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, userTimezone, undefined, gdriveFilesStore, undefined, connectorActionAudit, assistantConnectorGrantsStore, workspaceDomain)
        } else if (g.instance.custom && g.instance.url) {
          // Custom remote MCP shared via a grant. Respect Layer-2 enablement
          // (keyed on the provider UUID, like the team-native custom path),
          // then discover it and add it to the search index. Without this the
          // grant is a no-op for workspace assistants — the tools never appear.
          const enabled = !assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, p)
          if (enabled) {
            await addGrantedCustomMcp(g.instance.url, g.instance.label ?? p, g.grantedByUserId, g.instance.id, g.instance.updatedAt)
          }
        }
        // Any other unknown provider — skipped.
      }
      if (overlaidByGrant.size > 0) {
        console.debug(`[mcp-inject] team-grant overlay: re-injected ${overlaidByGrant.size} provider(s) from exposed instances`)
      }
    } catch (err) {
      console.error('[mcp-inject] team-grant overlay failed:', err)
    }
  }

  if (assistantTeamId && connectorInstanceStore) {
    try {
      const teamNative = await connectorInstanceStore.listByWorkspaceSystem(assistantTeamId)
      const overlaidByTeam = new Set<string>()
      const googleOverrides: Partial<Record<string, () => Promise<string | null>>> = {}

      // Synthesize a "connectors" array that looks like the legacy per-user
      // one, so the per-provider injectors' enable checks and discovery
      // logic don't need to change. `credsOverride` / `credsOverridePerConnector`
      // reroute the actual credential reads.
      const syntheticConnectors: Array<{ connectorId: string; connected: boolean; url?: string | null }> = []

      for (const inst of teamNative) {
        if (!inst.connected) continue
        const p = inst.provider
        if (overlaidByTeam.has(p)) continue    // first team-native per provider wins
        overlaidByTeam.add(p)
        syntheticConnectors.push({ connectorId: p, connected: true, url: inst.url ?? null })

        if (p === 'github') {
          await injectGitHubTools(
            syntheticConnectors,
            connectorStore,
            settingsStore,
            userId,              // policy lookup still uses the acting user
            assistantId,
            assistantConnectorStore,
            tools,
            undefined,
            async () => {
              const creds = await connectorInstanceStore.getCredentialsSystem(inst.id)
              return creds?.client_secret ?? null
            },
          )
        } else if (p === 'notion') {
          await injectNotionTools(
            syntheticConnectors,
            connectorStore,
            settingsStore,
            userId,
            assistantId,
            assistantConnectorStore,
            tools,
            undefined,
            async () => {
              const creds = await connectorInstanceStore.getCredentialsSystem(inst.id)
              return creds?.client_secret ?? null
            },
          )
        } else if (p === 'fathom') {
          // Fathom team-native is intentionally deferred: refresh tokens are
          // one-time-use, so this path needs a system-level writer on
          // connectorInstanceStore to persist rotated tokens back into the
          // team-scoped row. Without it, the first refresh would land in
          // the user-scoped store and brick the next call. Skip until that
          // writer lands. User-scoped Fathom continues to work via the main
          // built-in path above.
          continue
        } else if (p === 'gcal' || p === 'gmail' || p === 'gdrive') {
          googleOverrides[p] = async () => {
            const creds = await connectorInstanceStore.getCredentialsSystem(inst.id)
            return creds?.client_secret ?? null
          }
        }
        // Custom remote MCP team-native instances are handled in the
        // unified MCP discovery loop near the top of this function — they
        // surface to the model through `mcp_search` / `mcp_call` like
        // personal custom MCPs.
      }

      if (Object.keys(googleOverrides).length > 0) {
        // Run the Google injector once with all team-native Google services
        // overridden together (gcal + gmail + gdrive share the same enricher
        // + policy pipeline, so batching keeps the token-cache shared).
        await injectGoogleTools(
          syntheticConnectors,
          connectorStore,
          settingsStore,
          userId,
          assistantId,
          assistantConnectorStore,
          tools,
          userTimezone,
          undefined,
          gdriveFilesStore,
          googleOverrides,
          connectorActionAudit,
          assistantConnectorGrantsStore,
          workspaceDomain,
        )
      }

      if (overlaidByTeam.size > 0) {
        console.debug(`[mcp-inject] team-native overlay: re-injected ${overlaidByTeam.size} provider(s) from team-scoped connector_instance rows`)
      }
    } catch (err) {
      console.error('[mcp-inject] team-native overlay failed:', err)
    }
  }

  // ── Knowledge base ─────────────────────────────────────────
  // Names of KB tools the injector emitted this turn — used below to
  // pluck them into the local-source bundle when `keepBuiltinsDirect`
  // is false. Empty when the assistant has no KB entries / sources.
  const kbToolNames: string[] = []
  if (knowledgeStore) {
    try {
      const hasEntries = await knowledgeStore.hasEntriesForAssistant(assistantId)
      const sources = await knowledgeStore.listSourcesForAssistant(assistantId)
      if (hasEntries || sources.length > 0) {
        const kbTools = createKnowledgeTools(knowledgeStore, {
          repoConnected: sources.length > 0,
        })
        for (const tool of kbTools) {
          tools.set(tool.name, tool)
          kbToolNames.push(tool.name)
        }
        console.debug(`[mcp-inject] Knowledge: injected ${kbTools.length} tools (repo connected: ${sources.length > 0})`)
      }
    } catch (err) {
      console.error('[mcp-inject] Knowledge injection failed:', err)
    }
  }

  // ── Unified tool-search index ──────────────────────────────
  // Build the `mcp_search` + `mcp_call` pair once, fed by:
  //   - Remote sources: custom MCP connectors discovered above.
  //   - Local sources: first-party built-ins (Google / GitHub / Notion /
  //     Fathom) + KB tools — gathered out of the `tools` map by name,
  //     using the existing drift-sweep source of truth.
  //
  // The pluck pattern preserves the team-overlay precedence: the master
  // `tools` map already saw each injector run in the right order
  // (personal → grant → team-native), so the last-writer-wins instance
  // for each canonical name is what lands in the local source.
  //
  // `keepBuiltinsDirect=true` (workflow path) skips the pluck — built-ins
  // stay direct so the workflow executor still sees per-tool
  // `requiresConfirmation` flags and can apply `kind='workflow_step'`
  // approvals + per-step permission grants correctly.
  const localSources: LocalSource[] = []
  if (!keepBuiltinsDirect) {
    for (const [connectorId, toolNames] of Object.entries(INJECTED_BUILTIN_TOOLS_BY_CONNECTOR)) {
      const canonical = new Set(toolNames)
      const localTools: Tool[] = []
      // Match canonical names AND their multi-instance suffixed variants
      // (`<canonical>__<acct>`), so every account's tools land in this
      // provider's search source. Collect first, then delete (avoids mutating
      // the map mid-iteration).
      const matched: string[] = []
      for (const name of tools.keys()) {
        if (canonical.has(baseToolName(name))) matched.push(name)
      }
      for (const name of matched) {
        const tool = tools.get(name)
        if (tool) {
          localTools.push(tool)
          tools.delete(name)
        }
      }
      if (localTools.length > 0) {
        localSources.push({ kind: 'local', serverName: connectorId, tools: localTools })
      }
    }

    // KB tools — separate bucket; the assistant-scoped enablement check
    // above already gated whether they were emitted this turn.
    if (kbToolNames.length > 0) {
      const kbLocalTools: Tool[] = []
      for (const name of kbToolNames) {
        const tool = tools.get(name)
        if (tool) {
          kbLocalTools.push(tool)
          tools.delete(name)
        }
      }
      if (kbLocalTools.length > 0) {
        localSources.push({ kind: 'local', serverName: 'knowledge', tools: kbLocalTools })
      }
    }
  }

  // Build + inject the search pair whenever **any** source is present.
  // Direct-injection-only paths (workflow, smoke tests with no custom MCP)
  // still skip when both lists are empty.
  if (remoteSources.length > 0 || localSources.length > 0) {
    const index = buildToolIndex([...remoteSources, ...localSources])
    const searchTools = createMcpSearchTools({
      index,
      settingsStore,
      assistantId,
      appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
      userId,
      // The execution dispatcher — every remote mcp_call lands here with
      // only the serverUrl, so per-connector auth joins via headersByUrl.
      callMcpTool: (serverUrl, toolName, input) =>
        callRemoteMcpTool(serverUrl, toolName, input, headersByUrl.get(serverUrl)),
    })
    for (const tool of searchTools) {
      tools.set(tool.name, tool)
    }

    const remoteCount = remoteSources.reduce((sum, s) => sum + s.server.tools.length, 0)
    const localCount = localSources.reduce((sum, s) => sum + s.tools.length, 0)
    console.debug(
      `[mcp-inject] tool search: ${remoteCount} remote + ${localCount} local across ${remoteSources.length + localSources.length} sources → mcp_search + mcp_call`,
    )
  }

  return { enrichConfirmation: enricher, unavailable }
}

/**
 * Check the user's policy for a built-in tool. Returns 'skip' if the tool
 * should be excluded entirely (blocked), or applies resolveConfirmation
 * for dynamic 'ask'/'allow' policy resolution.
 */
const STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
function strictestPolicy(a: string, b: string): 'allow' | 'ask' | 'block' {
  return (STRICTNESS[a] ?? 0) >= (STRICTNESS[b] ?? 0) ? a as 'allow' | 'ask' | 'block' : b as 'allow' | 'ask' | 'block'
}

async function resolveEffectivePolicy(
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  serverName: string,
  toolName: string,
  fallback: string,
): Promise<'allow' | 'ask' | 'block'> {
  const l1 = await settingsStore.getPolicy({
    assistantId: APP_LEVEL_ASSISTANT_ID, userId, serverName, toolName,
  })
  const appPolicy = l1?.policy ?? fallback

  const l2 = await settingsStore.getPolicy({
    assistantId, userId, serverName, toolName,
  })
  const assistantPolicy = l2?.policy ?? fallback

  return strictestPolicy(appPolicy, assistantPolicy)
}

async function applyPolicyOrSkip(
  tool: Tool,
  serverName: string,
  settingsStore: McpSettingsStore,
  assistantId: string,
  userId: string,
  unavailable?: string[],
  /**
   * Tool name to resolve policy against. Defaults to `tool.name`. Multi-instance
   * variants pass the CANONICAL base name here so every instance of a provider
   * shares the provider's single tool policy (no per-instance policy rows).
   */
  policyToolName?: string,
): Promise<'skip' | 'include'> {
  const policyName = policyToolName ?? tool.name
  const fallback = tool.requiresConfirmation ? 'ask' : 'allow'
  const effective = await resolveEffectivePolicy(
    settingsStore, userId, assistantId, serverName, policyName, fallback,
  )

  if (effective === 'block') {
    unavailable?.push(`${tool.name} (blocked by policy)`)
    return 'skip'
  }

  // Add dynamic confirmation resolution so policy changes mid-session
  // take effect (e.g. user changes from 'allow' to 'ask').
  tool.resolveConfirmation = async () => {
    const current = await resolveEffectivePolicy(
      settingsStore, userId, assistantId, serverName, policyName, fallback,
    )
    return current === 'ask'
  }

  return 'include'
}

// ── Multi-instance tool variants ──────────────────────────────
//
// A user can connect more than one account for a single-secret built-in
// provider (GitHub / Notion / Fathom). The OLDEST instance keeps the
// canonical tool names + credentials (so a single-account user is byte-for-byte
// unchanged); each ADDITIONAL instance is injected as a parallel set of tools
// whose names carry a per-instance suffix and whose descriptions are tagged
// with the account's label, bound to that instance's own credentials.
//
// The suffix uses `__` which never appears in a canonical built-in tool name,
// so `baseToolName()` can recover the canonical name for policy resolution and
// the tool-search local-source pluck.

const INSTANCE_TOOL_SEP = '__'

function instanceToolSuffix(instanceId: string, label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'acct'
  const id8 = instanceId.replace(/-/g, '').slice(0, 8)
  return `${INSTANCE_TOOL_SEP}${slug}_${id8}`
}

/** Recover the canonical tool name from a (possibly) instance-suffixed name. */
function baseToolName(name: string): string {
  const i = name.indexOf(INSTANCE_TOOL_SEP)
  return i === -1 ? name : name.slice(0, i)
}

export type ConnectorInstanceRef = { id: string; label: string }

/**
 * Inject label-qualified tool variants for each additional connector instance.
 * `buildToolsForInstance` returns the provider's canonical tool set already
 * bound to the given instance's credentials; this helper renames + tags them
 * and applies the provider's (shared) policy.
 */
async function injectInstanceVariants(opts: {
  provider: string
  extras: ConnectorInstanceRef[]
  settingsStore: McpSettingsStore
  assistantId: string
  userId: string
  tools: Map<string, Tool>
  buildToolsForInstance: (instance: ConnectorInstanceRef) => Tool[]
}): Promise<void> {
  for (const extra of opts.extras) {
    let variantTools: Tool[]
    try {
      variantTools = opts.buildToolsForInstance(extra)
    } catch (err) {
      console.error(`[mcp-inject] ${opts.provider} instance ${extra.id} build failed:`, err)
      continue
    }
    const suffix = instanceToolSuffix(extra.id, extra.label)
    for (const tool of variantTools) {
      const canonical = tool.name
      const variant: Tool = {
        ...tool,
        name: `${canonical}${suffix}`,
        description: `[${extra.label}] ${tool.description}`,
      }
      if (
        (await applyPolicyOrSkip(variant, opts.provider, opts.settingsStore, opts.assistantId, opts.userId, undefined, canonical)) === 'include'
      ) {
        opts.tools.set(variant.name, variant)
      }
    }
  }
}

async function injectGoogleTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  userTimezone?: string,
  unavailable?: string[],
  gdriveFilesStore?: GDriveFilesStore,
  /**
   * Per-connector refresh-token override (Stage 5 of the team-connector
   * promotion). When a key is present (e.g. 'gcal' → async () => refresh_token),
   * that closure supplies the refresh token instead of the legacy
   * `connectorStore.getCredentials(userId, connectorId)` lookup. Lets the
   * caller drive injection from team-native `connector_instance` rows whose
   * credentials don't live in `mcp_connectors`.
   *
   * Note: auto-disconnect-on-revoke is skipped for overridden connectors
   * (we can't flip a bit on a row we didn't read from mcp_connectors).
   * Operators see the revocation in logs and re-connect via the team
   * settings UI.
   */
  credsOverridePerConnector?: Partial<Record<string, () => Promise<string | null>>>,
  /**
   * Connector-action audit deps — when set, the Gmail `sendMessage`
   * callback wraps its execute with a `connector_action` Episode +
   * audit row emit (per `connector-actions.md`). Absent → Gmail sends
   * as before, just without the brain-level audit trail.
   */
  connectorActionAudit?: ConnectorActionAudit,
  /**
   * Per-assistant capability grants store (#4 in
   * `connector-actions.md`). When set, the Gmail / GCal write callbacks
   * call `assertActionAllowed` BEFORE the network call. On rejection
   * the tool throws a structured error and writes NO audit row (the
   * action never started). Absent → no enforcement (back-compat with
   * legacy boot configurations).
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
  /**
   * Authoritative primary email domain for the acting assistant's
   * workspace. Used by the GCal audit hook to detect "internal-only"
   * attendees → `audience_clearance='internal'`. Absent / null → every
   * attendee is treated as external and `audience_clearance='public'`.
   */
  workspaceDomain?: string | null,
): Promise<ConfirmationEnricher> {
  const googleCfg = getConnectorConfig('google')
  if (!googleCfg) return async (_t, input) => input

  const clientId = googleCfg.clientId
  const clientSecret = googleCfg.clientSecret

  // ── Token prevalidation + cache ─────────────────────────────
  // Validate tokens once up-front instead of letting each tool call
  // discover failures independently. Caches valid tokens so all tool
  // calls within the same request reuse the same access token.
  const tokenCache = new Map<string, string>()  // connectorId → accessToken
  const revokedConnectors = new Set<string>()

  function isTokenRevoked(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('invalid_grant') || msg.includes('expired or revoked')
  }

  async function readRefreshToken(connectorId: string): Promise<string | null> {
    const override = credsOverridePerConnector?.[connectorId]
    if (override) return override()
    const creds = await connectorStore.getCredentials(userId, connectorId)
    return creds?.client_secret ?? null
  }

  async function prevalidateToken(connectorId: string): Promise<boolean> {
    const refreshToken = await readRefreshToken(connectorId)
    if (!refreshToken) return false
    try {
      const token = await refreshGoogleAccessToken(refreshToken, clientId, clientSecret)
      tokenCache.set(connectorId, token)
      return true
    } catch (err) {
      if (isTokenRevoked(err)) {
        revokedConnectors.add(connectorId)
        if (!credsOverridePerConnector?.[connectorId]) {
          // Auto-disconnect only for the legacy path. Team-native revocations
          // need admin action via the team settings UI.
          connectorStore.setConnected(userId, connectorId, false)
            .catch((e) => console.error(`[mcp-inject] failed to auto-disconnect ${connectorId}:`, e))
        }
        console.warn(`[mcp-inject] ${connectorId}: token revoked — ${credsOverridePerConnector?.[connectorId] ? 'team-native instance, admin must reconnect' : 'auto-disconnected'}`)
        return false
      }
      // Transient error (network blip) — still inject tools, let them retry
      console.warn(`[mcp-inject] ${connectorId}: token prevalidation failed (transient), injecting tools anyway:`, err)
      return true
    }
  }

  async function getAccessToken(connectorId: string): Promise<string> {
    // Return cached token if available (from prevalidation)
    const cached = tokenCache.get(connectorId)
    if (cached) return cached
    // Fallback: refresh on demand (transient prevalidation failure, or token expired mid-request)
    const refreshToken = await readRefreshToken(connectorId)
    if (!refreshToken) throw new Error(`${connectorId} not connected`)
    const token = await refreshGoogleAccessToken(refreshToken, clientId, clientSecret)
    tokenCache.set(connectorId, token)
    return token
  }

  // ── Prevalidate all connected Google connectors in parallel ──
  const gcalRaw = connectors.find((c) => c.connectorId === 'gcal' && c.connected)
  const gmailRaw = connectors.find((c) => c.connectorId === 'gmail' && c.connected)
  const gdriveRaw = connectors.find((c) => c.connectorId === 'gdrive' && c.connected)

  await Promise.all([
    gcalRaw ? prevalidateToken('gcal') : Promise.resolve(false),
    gmailRaw ? prevalidateToken('gmail') : Promise.resolve(false),
    gdriveRaw ? prevalidateToken('gdrive') : Promise.resolve(false),
  ])

  // Google Calendar — Layer 1 (connected + not revoked) + Layer 2 (enabled for this assistant)
  const gcal = gcalRaw && !revokedConnectors.has('gcal') ? gcalRaw : undefined
  const gcalEnabled = gcal && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gcal'))
  if (revokedConnectors.has('gcal')) {
    unavailable?.push('Google Calendar (credentials expired — tell the user to reconnect: "Type /connect gcal to re-authorize.")')
  } else if (!gcal || !gcalEnabled) {
    unavailable?.push('Google Calendar & Tasks (not connected or disabled for this assistant) — if the user asks to add/check tasks, calendar events, or reminders, reply: "I\'ll need Calendar access first. Type /connect gcal to authorize."')
  }
  if (gcal && gcalEnabled) {
    try {
      // Read per-user gcal config (e.g. sendUpdates preference)
      const gcalConfig = await connectorStore.getConfig(userId, 'gcal')
      const sendUpdates = (gcalConfig.sendUpdates as 'all' | 'externalOnly' | 'none' | undefined) ?? 'all'

      // Local helper — derive `audience_clearance` from the attendee
      // list per the GCal contract in connector-actions.md:
      //   - all attendees on `workspaceDomain` (or none) → 'internal'
      //   - any external attendee                       → 'public'
      // `workspaceDomain` is the authoritative primary domain — wired
      // from the chat route. When absent, default to 'public' (the
      // safer ceiling).
      function deriveAudienceFromAttendees(attendees?: string[]): 'internal' | 'public' {
        if (!workspaceDomain || !attendees || attendees.length === 0) return 'internal'
        const dom = `@${workspaceDomain.toLowerCase()}`
        const allInternal = attendees.every((a) => a.toLowerCase().endsWith(dom))
        return allInternal ? 'internal' : 'public'
      }

      async function gateGcalAction(actionKind: string): Promise<void> {
        if (!assistantConnectorGrantsStore) return
        const { assertActionAllowed } = await import('../safety/assert-action-allowed.js')
        const allowed = await assertActionAllowed(
          assistantConnectorGrantsStore,
          assistantId,
          'gcal',
          actionKind,
        )
        if (!allowed.ok) throw new Error(allowed.details)
      }

      type GCalEventLike = {
        id?: string | null
        summary?: string | null
        description?: string | null
        location?: string | null
        attendees?: Array<{ email?: string }>
        start?: { dateTime?: string; date?: string }
        end?: { dateTime?: string; date?: string }
      }

      async function emitGcalAudit(
        actionKind: 'create_event' | 'update_event' | 'delete_event',
        audienceClearance: 'public' | 'internal',
        payload: Record<string, unknown>,
        status: 'executed' | 'failed' | 'denied',
        externalId: string | null,
      ): Promise<void> {
        if (!connectorActionAudit) return
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            {
              connectorId: 'gcal',
              actionKind,
              audienceClearance,
              status,
              externalId,
              payload,
            },
          )
        } catch (auditErr) {
          console.warn(
            `[mcp-inject] gcal connector_action audit emit failed (${actionKind}/${status}, suppressed):`,
            auditErr instanceof Error ? auditErr.message : String(auditErr),
          )
        }
      }

      const calTools = createGoogleCalendarTools({
        listEvents: async (params) => {
          const token = await getAccessToken('gcal')
          return listCalendarEvents(token, params)
        },
        getEvent: async (eventId, calendarId) => {
          const token = await getAccessToken('gcal')
          return getCalendarEvent(token, eventId, calendarId)
        },
        createEvent: async (event) => {
          await gateGcalAction('googleCalendarCreateEvent')
          const token = await getAccessToken('gcal')
          const audience = deriveAudienceFromAttendees(event.attendees)
          const auditPayload: Record<string, unknown> = {
            summary: event.summary,
            start: event.start,
            end: event.end,
            description: event.description,
            location: event.location,
            attendees: event.attendees ?? [],
          }
          try {
            const result = (await createCalendarEvent(token, event, 'primary', sendUpdates)) as GCalEventLike | null
            const eventId = result?.id ?? null
            await emitGcalAudit('create_event', audience, auditPayload, 'executed', eventId)
            return result
          } catch (err) {
            await emitGcalAudit('create_event', audience, {
              ...auditPayload,
              error: err instanceof Error ? err.message : String(err),
            }, 'failed', null)
            throw err
          }
        },
        updateEvent: async (eventId, updates) => {
          await gateGcalAction('googleCalendarUpdateEvent')
          const token = await getAccessToken('gcal')
          const attendeeEmails = updates.attendees
          const audience = deriveAudienceFromAttendees(attendeeEmails)
          const auditPayload: Record<string, unknown> = {
            event_id: eventId,
            updates: { ...updates },
          }
          try {
            const result = await updateCalendarEvent(token, eventId, updates, 'primary', sendUpdates)
            await emitGcalAudit('update_event', audience, auditPayload, 'executed', eventId)
            return result
          } catch (err) {
            await emitGcalAudit('update_event', audience, {
              ...auditPayload,
              error: err instanceof Error ? err.message : String(err),
            }, 'failed', null)
            throw err
          }
        },
        deleteEvent: async (eventId, calendarId) => {
          await gateGcalAction('googleCalendarDeleteEvent')
          const token = await getAccessToken('gcal')
          // Snapshot the event BEFORE delete so the audit captures
          // what was removed (delete is the first DESTRUCTIVE
          // connector action — operators need to see what was lost).
          // Best-effort: if the snapshot fetch fails we still proceed
          // with the delete, just without rich payload data.
          let snapshot: GCalEventLike | null = null
          try {
            snapshot = (await getCalendarEvent(token, eventId, calendarId)) as GCalEventLike
          } catch (snapErr) {
            console.warn('[mcp-inject] gcal delete: snapshot fetch failed:', snapErr instanceof Error ? snapErr.message : String(snapErr))
          }
          const audience = deriveAudienceFromAttendees(
            snapshot?.attendees?.map((a) => a.email ?? '').filter(Boolean),
          )
          const auditPayload: Record<string, unknown> = {
            event_id: eventId,
            prior_snapshot: snapshot
              ? {
                  summary: snapshot.summary,
                  start: snapshot.start,
                  end: snapshot.end,
                  description: snapshot.description,
                  location: snapshot.location,
                  attendees: snapshot.attendees ?? [],
                }
              : null,
          }
          try {
            await deleteCalendarEvent(token, eventId, calendarId, sendUpdates)
            await emitGcalAudit('delete_event', audience, auditPayload, 'executed', eventId)
          } catch (err) {
            await emitGcalAudit('delete_event', audience, {
              ...auditPayload,
              error: err instanceof Error ? err.message : String(err),
            }, 'failed', null)
            throw err
          }
        },
      }, userTimezone)
      for (const tool of calTools) {
        if (await applyPolicyOrSkip(tool, 'gcal', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }
      console.debug(`[mcp-inject] Google Calendar: injected tools`)
    } catch (err) {
      console.error('[mcp-inject] Google Calendar injection failed:', err)
    }
  }

  // Gmail — Layer 1 (connected + not revoked) + Layer 2 (enabled for this assistant)
  const gmail = gmailRaw && !revokedConnectors.has('gmail') ? gmailRaw : undefined
  const gmailEnabled = gmail && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gmail'))
  if (revokedConnectors.has('gmail')) {
    unavailable?.push('Gmail (credentials expired — tell the user: "Type /connect gmail to re-authorize.")')
  } else if (!gmail || !gmailEnabled) {
    unavailable?.push('Gmail (not connected or disabled for this assistant) — if the user asks to send or read email, reply: "I\'ll need Gmail access first. Type /connect gmail to authorize."')
  }
  if (gmail && gmailEnabled) {
    try {
      const gmailTools = createGmailTools({
        listMessages: async (params) => {
          const token = await getAccessToken('gmail')
          return listGmailMessages(token, params)
        },
        getMessage: async (messageId) => {
          const token = await getAccessToken('gmail')
          return getGmailMessage(token, messageId)
        },
        sendMessage: async (params) => {
          // Per-assistant capability gate (#4) — `assertActionAllowed`
          // throws a structured envelope when the assistant has no
          // grant for `send_email`. No audit row written (action never
          // started); the model surfaces the error to the user.
          if (assistantConnectorGrantsStore) {
            const { assertActionAllowed } = await import('../safety/assert-action-allowed.js')
            const allowed = await assertActionAllowed(
              assistantConnectorGrantsStore,
              assistantId,
              'gmail',
              'gmailSendMessage',
            )
            if (!allowed.ok) {
              throw new Error(allowed.details)
            }
          }

          const token = await getAccessToken('gmail')
          // Connector-action audit wrap (per `connector-actions.md`).
          // With the payload classifier (#3) in place, the email body
          // CAN be recorded in the audit payload — the classifier
          // guarantees the recorded content is at-or-below the
          // computed ceiling. In shadow mode the body is still
          // recorded but a `classifier_would_have_denied` warning
          // attaches; in enforce mode a deny short-circuits before the
          // network call.
          //
          // v1 `audienceClearance='public'` for all recipients —
          // per-recipient classification (internal vs external) is a
          // future enhancement.
          const auditPayload = {
            to: params.to,
            subject: params.subject,
            has_body: Boolean(params.body),
            body_length: params.body?.length ?? 0,
            body: params.body ?? '',
          }

          // Preflight: classifier decides BEFORE the network call. In
          // enforce mode + breach → deny without sending. In shadow
          // mode the audit captures the warning but execution proceeds.
          let preflight: ConnectorActionPreflight | undefined
          if (connectorActionAudit) {
            preflight = connectorActionAudit.preflight({
              audienceClearance: 'public',
              payload: auditPayload,
            })
            if (preflight.shouldDeny) {
              try {
                await connectorActionAudit.emit(
                  { userId, assistantId },
                  {
                    connectorId: 'gmail',
                    actionKind: 'send_email',
                    audienceClearance: 'public',
                    status: 'denied',
                    payload: auditPayload,
                    preflight,
                  },
                )
              } catch (auditErr) {
                console.warn(
                  '[mcp-inject] gmail classifier-deny audit emit failed:',
                  auditErr instanceof Error ? auditErr.message : String(auditErr),
                )
              }
              throw new Error(
                `This email contains content the classifier blocked (matched patterns: ${preflight.classifierMatches.join(', ')}). Revise the message and try again.`,
              )
            }
          }

          try {
            const result = await sendGmailMessage(token, params)
            if (connectorActionAudit) {
              try {
                await connectorActionAudit.emit(
                  { userId, assistantId },
                  {
                    connectorId: 'gmail',
                    actionKind: 'send_email',
                    audienceClearance: 'public',
                    status: 'executed',
                    externalId: result?.id ?? null,
                    payload: auditPayload,
                    preflight,
                  },
                )
              } catch (auditErr) {
                console.warn(
                  '[mcp-inject] gmail connector_action audit emit failed (best-effort, suppressed):',
                  auditErr instanceof Error ? auditErr.message : String(auditErr),
                )
              }
            }
            return result
          } catch (err) {
            if (connectorActionAudit) {
              try {
                await connectorActionAudit.emit(
                  { userId, assistantId },
                  {
                    connectorId: 'gmail',
                    actionKind: 'send_email',
                    audienceClearance: 'public',
                    status: 'failed',
                    payload: {
                      ...auditPayload,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    preflight,
                  },
                )
              } catch (auditErr) {
                console.warn(
                  '[mcp-inject] gmail connector_action audit emit failed (failure path, suppressed):',
                  auditErr instanceof Error ? auditErr.message : String(auditErr),
                )
              }
            }
            throw err
          }
        },
      })
      for (const tool of gmailTools) {
        if (await applyPolicyOrSkip(tool, 'gmail', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }
      console.debug('[mcp-inject] Gmail: injected tools')
    } catch (err) {
      console.error('[mcp-inject] Gmail injection failed:', err)
    }
  }

  // Google Drive (+ Docs, Sheets, Slides) — Layer 1 (connected + not revoked) + Layer 2 (enabled)
  const gdrive = gdriveRaw && !revokedConnectors.has('gdrive') ? gdriveRaw : undefined
  const gdriveEnabled = gdrive && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gdrive'))
  if (revokedConnectors.has('gdrive')) {
    unavailable?.push('Google Drive, Docs, Sheets & Slides (credentials expired — tell the user: "Type /connect gdrive to re-authorize.")')
  } else if (!gdrive || !gdriveEnabled) {
    unavailable?.push('Google Drive, Docs, Sheets & Slides (not connected or disabled for this assistant) — if the user asks to create or open a doc, slide, spreadsheet, or Excel file, reply: "I\'ll need Drive access first. Type /connect gdrive to authorize."')
  }
  if (gdrive && gdriveEnabled) {
    try {
      // Load per-user gdrive config — the authorized-files list is the set of
      // Google Docs/Sheets/Slides the user has explicitly picked via the
      // Google Picker. Writes against any of these files auto-approve because
      // the Picker itself is the consent ceremony. See
      // docs/architecture/integrations/mcp.md → "The `gdrive` connector".
      //
      // Legacy rows may still have `allowedPaths` (the pre-drive.file whitelist)
      // — migrate file-type entries in-place so confirmation still works.
      const gdriveConfig = await connectorStore.getConfig(userId, 'gdrive')
      let gdriveAuthorizedFiles = (gdriveConfig.authorizedFiles as AuthorizedFile[] | undefined) ?? []
      if (!gdriveAuthorizedFiles.length && Array.isArray(gdriveConfig.allowedPaths)) {
        type LegacyPath = { id: string; name: string; type: 'file' | 'folder' }
        const legacy = gdriveConfig.allowedPaths as LegacyPath[]
        gdriveAuthorizedFiles = legacy
          .filter((p) => p && p.type === 'file' && typeof p.id === 'string')
          .map((p) => ({ id: p.id, name: p.name, mimeType: 'application/octet-stream', addedAt: new Date(0).toISOString() }))
      }

      // Records a newly-created Drive file: (1) appends to the in-memory
      // authorizedFiles array so follow-up writes in the same turn skip the
      // confirmation prompt, (2) persists the addition to the gdrive
      // connector config, and (3) inserts into gdrive_files for
      // findGDriveFiles search. Persistence is fire-and-forget — a DB hiccup
      // shouldn't mask a successful Google create.
      const recordCreated = (
        kind: GDriveFileKind,
        externalId: string,
        title: string,
        url: string,
        mimeType: string,
      ): void => {
        const entry: AuthorizedFile = { id: externalId, name: title, mimeType, addedAt: new Date().toISOString() }
        gdriveAuthorizedFiles.push(entry)
        connectorStore
          .setConfig(userId, 'gdrive', { authorizedFiles: gdriveAuthorizedFiles })
          .catch((e) => console.error('[mcp-inject] failed to persist authorizedFiles after create:', e))
        if (gdriveFilesStore) {
          gdriveFilesStore
            .insert({ userId, kind, externalId, title, url })
            .catch((e) => console.error('[mcp-inject] failed to record gdrive_files row:', e))
        }
      }

      // Opportunistic title sync on read. No-op if the store isn't wired.
      const syncOnRead = (externalId: string, title: string): void => {
        if (!gdriveFilesStore) return
        gdriveFilesStore
          .updateOnAccess(userId, externalId, title)
          .catch((e) => console.error('[mcp-inject] updateOnAccess failed:', e))
      }

      // Drive tools
      const driveTools = createGoogleDriveTools({
        listFiles: async (params) => {
          const token = await getAccessToken('gdrive')
          return listDriveFiles(token, params)
        },
        getFile: async (fileId) => {
          const token = await getAccessToken('gdrive')
          return getDriveFile(token, fileId)
        },
        getFileContent: async (fileId, exportMimeType) => {
          const token = await getAccessToken('gdrive')
          return getDriveFileContent(token, fileId, exportMimeType)
        },
        createFile: async (params) => {
          const token = await getAccessToken('gdrive')
          return createDriveFile(token, params)
        },
        updateFile: async (fileId, params) => {
          const token = await getAccessToken('gdrive')
          return updateDriveFileContent(token, fileId, params)
        },
      }, gdriveAuthorizedFiles)
      for (const tool of driveTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Docs tools
      const docsTools = createGoogleDocsTools({
        getContent: async (documentId) => {
          const token = await getAccessToken('gdrive')
          const doc = await getDocContent(token, documentId)
          syncOnRead(documentId, doc.title)
          return doc
        },
        appendText: async (documentId, text) => {
          const token = await getAccessToken('gdrive')
          return appendToDoc(token, documentId, text)
        },
        replaceText: async (documentId, findText, replaceText) => {
          const token = await getAccessToken('gdrive')
          return replaceInDoc(token, documentId, findText, replaceText)
        },
        create: async (title) => {
          const token = await getAccessToken('gdrive')
          const doc = await createDocument(token, title)
          recordCreated('doc', doc.documentId, doc.title, doc.url, 'application/vnd.google-apps.document')
          return doc
        },
      }, gdriveAuthorizedFiles)
      for (const tool of docsTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Sheets tools
      const sheetsTools = createGoogleSheetsTools({
        getSpreadsheetInfo: async (spreadsheetId) => {
          const token = await getAccessToken('gdrive')
          const info = await getSpreadsheetInfo(token, spreadsheetId)
          syncOnRead(spreadsheetId, info.title)
          return info
        },
        readRange: async (spreadsheetId, range) => {
          const token = await getAccessToken('gdrive')
          return readSheetRange(token, spreadsheetId, range)
        },
        writeRange: async (spreadsheetId, range, values) => {
          const token = await getAccessToken('gdrive')
          return writeSheetRange(token, spreadsheetId, range, values)
        },
        appendRows: async (spreadsheetId, range, values) => {
          const token = await getAccessToken('gdrive')
          return appendSheetRows(token, spreadsheetId, range, values)
        },
        create: async (title) => {
          const token = await getAccessToken('gdrive')
          const sheet = await createSpreadsheet(token, title)
          recordCreated('sheet', sheet.spreadsheetId, sheet.title, sheet.url, 'application/vnd.google-apps.spreadsheet')
          return sheet
        },
        format: async (spreadsheetId, opts) => {
          const token = await getAccessToken('gdrive')
          return formatSpreadsheet(token, spreadsheetId, opts)
        },
        batchUpdate: async (spreadsheetId, requests) => {
          const token = await getAccessToken('gdrive')
          return batchUpdateSpreadsheet(token, spreadsheetId, requests)
        },
      }, gdriveAuthorizedFiles)
      for (const tool of sheetsTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Slides tools — structured read + placeholder-targeted, atomic write.
      // See docs/architecture/integrations/google-slides.md.
      const slidesTools = createGoogleSlidesTools({
        getPresentationInfo: async (presentationId) => {
          const token = await getAccessToken('gdrive')
          const info = await getPresentationInfo(token, presentationId)
          syncOnRead(presentationId, info.title)
          return info
        },
        getSlideContent: async (presentationId, slideIndex) => {
          const token = await getAccessToken('gdrive')
          return getSlideContent(token, presentationId, slideIndex)
        },
        getSlideThumbnail: async (presentationId, slideObjectId, options) => {
          const token = await getAccessToken('gdrive')
          return getSlideThumbnail(token, presentationId, slideObjectId, options)
        },
        createSlide: async (presentationId, args) => {
          const token = await getAccessToken('gdrive')
          return slidesCreateSlide(token, presentationId, args)
        },
        updateSlideContent: async (presentationId, args) => {
          const token = await getAccessToken('gdrive')
          return slidesUpdateSlideContent(token, presentationId, args)
        },
        insertImage: async (presentationId, args) => {
          const token = await getAccessToken('gdrive')
          return slidesInsertImage(token, presentationId, args)
        },
        deleteSlide: async (presentationId, slideObjectId) => {
          const token = await getAccessToken('gdrive')
          return slidesDeleteSlide(token, presentationId, slideObjectId)
        },
        reorderSlides: async (presentationId, slideObjectIds, insertionIndex) => {
          const token = await getAccessToken('gdrive')
          return slidesReorderSlides(token, presentationId, slideObjectIds, insertionIndex)
        },
        duplicateSlide: async (presentationId, slideObjectId, insertionIndex) => {
          const token = await getAccessToken('gdrive')
          return slidesDuplicateSlide(token, presentationId, slideObjectId, insertionIndex)
        },
        batchUpdate: async (presentationId, requests) => {
          const token = await getAccessToken('gdrive')
          return batchUpdateSlides(token, presentationId, requests)
        },
        createPresentation: async (title) => {
          const token = await getAccessToken('gdrive')
          const pres = await createPresentation(token, title)
          recordCreated('slide', pres.presentationId, pres.title, pres.url, 'application/vnd.google-apps.presentation')
          return pres
        },
      }, gdriveAuthorizedFiles)
      for (const tool of slidesTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // findGDriveFiles — local index of files this assistant has created.
      // Only inject when a store is wired (unit tests without DB skip this).
      if (gdriveFilesStore) {
        const findTools = createGDriveFilesTools(gdriveFilesStore, userId)
        for (const tool of findTools) {
          if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      console.debug('[mcp-inject] Google Drive (Drive/Docs/Sheets/Slides): injected tools')
    } catch (err) {
      console.error('[mcp-inject] Google Drive injection failed:', err)
    }
  }

  // Google Tasks — bundled with gcal (same OAuth credentials, Tasks scope added to gcal)
  if (revokedConnectors.has('gcal')) {
    unavailable?.push('Google Tasks (credentials expired — tell the user: "Type /connect gcal to re-authorize.")')
  }
  if (gcal && gcalEnabled) {
    try {
      const tasksTools = createGoogleTasksTools({
        listTaskLists: async (params) => {
          const token = await getAccessToken('gcal')
          return listTaskLists(token, params)
        },
        listTasks: async (params) => {
          const token = await getAccessToken('gcal')
          return listGoogleTasks(token, params)
        },
        getTask: async (taskListId, taskId) => {
          const token = await getAccessToken('gcal')
          return getGoogleTask(token, taskListId, taskId)
        },
        createTask: async (taskListId, task) => {
          const token = await getAccessToken('gcal')
          return createGoogleTask(token, taskListId, task)
        },
        updateTask: async (taskListId, taskId, updates) => {
          const token = await getAccessToken('gcal')
          return updateGoogleTask(token, taskListId, taskId, updates)
        },
        deleteTask: async (taskListId, taskId) => {
          const token = await getAccessToken('gcal')
          return deleteGoogleTask(token, taskListId, taskId)
        },
      })
      for (const tool of tasksTools) {
        if (await applyPolicyOrSkip(tool, 'gcal', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }
      console.debug('[mcp-inject] Google Tasks: injected tools (via gcal)')
    } catch (err) {
      console.error('[mcp-inject] Google Tasks injection failed:', err)
    }
  }

  // Build a confirmation enricher that fetches real data for calendar/tasks tools.
  // This prevents AI hallucination and shows human-readable details in the
  // Approve/Deny prompt instead of opaque IDs.
  const gcalConnected = gcal && gcalEnabled
  const enricher: ConfirmationEnricher = async (toolName, input) => {
    if (!gcalConnected) return input

    // ── Google Tasks: fetch title so the user sees "記得 Call 大隻佬" not "eHXMFJ..." ──
    if (toolName === 'googleTasksUpdateTask' || toolName === 'googleTasksDeleteTask') {
      const taskId = input.taskId as string | undefined
      const taskListId = (input.taskListId as string | undefined) ?? '@default'
      if (!taskId) return input

      try {
        const token = await getAccessToken('gcal')
        const task = await getGoogleTask(token, taskListId, taskId)
        // Replace raw IDs with human-readable fields
        const { taskId: _tid, taskListId: _tlid, ...rest } = input
        return {
          task: task.title,
          ...rest,
          ...(task.due ? { due: task.due } : {}),
        }
      } catch (err) {
        console.warn('[mcp-inject] Failed to enrich task confirmation:', err)
        return input
      }
    }

    // ── Google Calendar: fetch event summary/attendees ──
    if (toolName !== 'googleCalendarUpdateEvent' && toolName !== 'googleCalendarDeleteEvent') return input

    const eventId = input.eventId as string | undefined
    if (!eventId) return input

    try {
      const token = await getAccessToken('gcal')
      const event = await getCalendarEvent(token, eventId)
      const summary = (event as Record<string, unknown>).summary as string | undefined
      const start = (event as Record<string, unknown>).start as { dateTime?: string; date?: string } | undefined
      const end = (event as Record<string, unknown>).end as { dateTime?: string; date?: string } | undefined
      const attendees = ((event as Record<string, unknown>).attendees as Array<{ email: string }> | undefined)
        ?.map(a => a.email)

      if (toolName === 'googleCalendarUpdateEvent') {
        return {
          ...input,
          currentSummary: summary ?? input.currentSummary,
          currentStart: start?.dateTime ?? start?.date ?? input.currentStart,
          currentEnd: end?.dateTime ?? end?.date ?? input.currentEnd,
          currentAttendees: attendees ?? input.currentAttendees,
        }
      }
      // googleCalendarDeleteEvent
      return {
        ...input,
        summary: summary ?? input.summary,
        startTime: start?.dateTime ?? start?.date ?? input.startTime,
        endTime: end?.dateTime ?? end?.date ?? input.endTime,
        attendees: attendees ?? input.attendees,
      }
    } catch (err) {
      console.warn('[mcp-inject] Failed to enrich confirmation with real event data:', err)
      return input
    }
  }

  return enricher
}

// ── Built-in GitHub connector ────────────────────────────────

async function injectGitHubTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /**
   * Optional credential-source override (Stage 5 of the team-connector
   * promotion). When provided, replaces the default
   * `connectorStore.getCredentials(userId, 'github')` lookup. Lets the
   * caller drive injection from a team-native `connector_instance` row
   * whose credentials don't live in `mcp_connectors`.
   */
  credsOverride?: () => Promise<string | null>,
  /**
   * Additional connected GitHub instances (multi-account). The primary
   * (oldest) instance is served by the canonical tools above; each of these
   * gets a label-qualified variant set bound to its own PAT via
   * `resolveInstanceCreds`. Only passed on the personal base load.
   */
  extraInstances?: ConnectorInstanceRef[],
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
): Promise<void> {
  const github = connectors.find((c) => c.connectorId === 'github' && c.connected)
  const githubEnabled = github && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'github'))

  if (!github || !githubEnabled) {
    unavailable?.push('GitHub (not connected or disabled for this assistant) — if the user asks about repos, issues, or PRs, reply: "I\'ll need GitHub access first. Type /connect github to authorize."')
    return
  }

  // Build the GitHub tool set bound to a given PAT source. Reused for the
  // primary instance and (renamed) for each extra account.
  function buildTools(getPat: () => Promise<string>): Tool[] {
    return createGitHubTools({
      searchRepositories: async (params) => searchRepositories(await getPat(), params),
      getRepository: async (owner, repo) => getRepository(await getPat(), owner, repo),
      listIssues: async (owner, repo, params) => listIssues(await getPat(), owner, repo, params),
      getIssue: async (owner, repo, issueNumber) => getIssue(await getPat(), owner, repo, issueNumber),
      listPullRequests: async (owner, repo, params) => listPullRequests(await getPat(), owner, repo, params),
      getPullRequest: async (owner, repo, pullNumber) => getPullRequest(await getPat(), owner, repo, pullNumber),
      createIssue: async (owner, repo, params) => createIssue(await getPat(), owner, repo, params),
      createIssueComment: async (owner, repo, issueNumber, body) => createIssueComment(await getPat(), owner, repo, issueNumber, body),
      getFileContents: async (owner, repo, path, ref) => getFileContents(await getPat(), owner, repo, path, ref),
      createOrUpdateFile: async (owner, repo, params) => createOrUpdateFile(await getPat(), owner, repo, params),
    })
  }

  async function getPat(): Promise<string> {
    if (credsOverride) {
      const pat = await credsOverride()
      if (!pat) throw new Error('GitHub not connected (team-native override returned no creds)')
      return pat
    }
    const creds = await connectorStore.getCredentials(userId, 'github')
    if (!creds) throw new Error('GitHub not connected')
    return creds.client_secret
  }

  try {
    const ghTools = buildTools(getPat)

    for (const tool of ghTools) {
      if (await applyPolicyOrSkip(tool, 'github', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }

    // Extra GitHub accounts → label-qualified variant tool sets.
    if (!credsOverride && extraInstances?.length && resolveInstanceCreds) {
      await injectInstanceVariants({
        provider: 'github',
        extras: extraInstances,
        settingsStore, assistantId, userId, tools,
        buildToolsForInstance: (inst) =>
          buildTools(async () => {
            const pat = await resolveInstanceCreds(inst.id)
            if (!pat) throw new Error(`GitHub instance ${inst.id} has no credentials`)
            return pat
          }),
      })
    }

    console.debug(`[mcp-inject] GitHub: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra account(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] GitHub injection failed:', err)
  }
}

// ── Built-in Notion connector ──────────────────────────────

async function injectNotionTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** See `injectGitHubTools` — same role. */
  credsOverride?: () => Promise<string | null>,
  /** Additional connected Notion instances (multi-workspace). See `injectGitHubTools`. */
  extraInstances?: ConnectorInstanceRef[],
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
): Promise<void> {
  if (!getConnectorConfig('notion')) return

  const notion = connectors.find((c) => c.connectorId === 'notion' && c.connected)
  const notionEnabled = notion && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'notion'))

  if (!notion || !notionEnabled) {
    unavailable?.push('Notion (not connected or disabled for this assistant) — if the user asks to search or update Notion pages/databases, reply: "I\'ll need Notion access first. Type /connect notion to authorize."')
    return
  }

  // Notion uses a long-lived access token stored in client_secret. Build the
  // tool set bound to a given token source — reused per account.
  function buildTools(getAccessToken: () => Promise<string>): Tool[] {
    return createNotionTools({
      search: async (params) => searchNotion(await getAccessToken(), params),
      getPage: async (pageId) => getNotionPage(await getAccessToken(), pageId),
      getDatabase: async (databaseId) => getNotionDatabase(await getAccessToken(), databaseId),
      queryDatabase: async (databaseId, params) => queryNotionDatabase(await getAccessToken(), databaseId, params),
      createPage: async (params) => createNotionPage(await getAccessToken(), params),
      updatePage: async (pageId, params) => updateNotionPage(await getAccessToken(), pageId, params),
      appendBlocks: async (pageId, content) => appendNotionBlocks(await getAccessToken(), pageId, content),
    })
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

  try {
    const notionTools = buildTools(getAccessToken)

    for (const tool of notionTools) {
      if (await applyPolicyOrSkip(tool, 'notion', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }

    if (!credsOverride && extraInstances?.length && resolveInstanceCreds) {
      await injectInstanceVariants({
        provider: 'notion',
        extras: extraInstances,
        settingsStore, assistantId, userId, tools,
        buildToolsForInstance: (inst) =>
          buildTools(async () => {
            const token = await resolveInstanceCreds(inst.id)
            if (!token) throw new Error(`Notion instance ${inst.id} has no credentials`)
            return token
          }),
      })
    }

    console.debug(`[mcp-inject] Notion: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra workspace(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] Notion injection failed:', err)
  }
}

// ── Built-in Fathom connector ──────────────────────────────
// Read-only meeting note ingestion. The token manager rotates the refresh
// token on every refresh and persists the new tuple back into the
// connector_instance.credentials envelope. See
// docs/architecture/integrations/fathom.md.

async function injectFathomTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** See `injectGitHubTools` — same role. Returns the encoded FathomTokens JSON blob. */
  credsOverride?: () => Promise<string | null>,
  /** Persistence override for team-native rows; defaults to the user-scoped connectorStore. */
  persistOverride?: (encoded: string) => Promise<void>,
  /** Additional connected Fathom instances (multi-account). See `injectGitHubTools`. */
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

  if (!fathom || !fathomEnabled) {
    unavailable?.push('Fathom (not connected or disabled for this assistant) — if the user asks about meeting transcripts, summaries, or action items, reply: "I\'ll need Fathom access first. Type /connect fathom to authorize."')
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
    const fathomTools = buildTools(makeTokenManager(loadEncodedTokens, persistEncoded))

    for (const tool of fathomTools) {
      if (await applyPolicyOrSkip(tool, 'fathom', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }

    if (!credsOverride && extraInstances?.length && resolveInstanceCreds && persistInstanceCreds) {
      await injectInstanceVariants({
        provider: 'fathom',
        extras: extraInstances,
        settingsStore, assistantId, userId, tools,
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
