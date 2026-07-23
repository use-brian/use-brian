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

import { buildToolIndex, createMcpSearchTools, createGoogleCalendarTools, createGmailTools, createGoogleTasksTools, createGoogleDriveTools, createGoogleDocsTools, createGoogleSheetsTools, createGoogleSlidesTools, createGDriveFilesTools, createGitHubTools, createNotionTools, createFathomTools, createShopifyTools, createKnowledgeTools, createAgentmailTools, createMailboxTools } from '@use-brian/core'
import type { Tool, McpSettingsStore, McpServerConfig, KnowledgeStoreInterface, KnowledgeRepoWriter, AuthorizedFile, GDriveFilesStore, GDriveFileKind, LocalSource, RemoteSource, EngineHooks, FilesApi, AgentmailToolApi, MailboxApi, MailboxAccountRouter } from '@use-brian/core'
import { getGlobalEmailInboxProvider, type EmailInboxProvider } from '../agentmail/provider.js'
import { renderEmailBody } from '@use-brian/channels'
import { createMailboxApi } from '../mailbox/mailbox-api.js'
import { createSearchEmailArchiveTool, getGlobalMailboxArchiveDeps } from '../mailbox/archive-search-tool.js'
import { createSyncMailboxNowTool, getGlobalMailboxSyncDeps } from '../mailbox/sync-tool.js'
import type { MailboxAccountSettings } from '../mailbox/types.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../connector-action-port.js'
import { workspacePolicyAsSettingsStore } from '../db/workspace-tool-policy-store.js'
import { discoverMcpServer, callRemoteMcpTool } from './client.js'
import { gateToolsOnActionGrants } from '../safety/assert-action-allowed.js'
import { createHealthReporter, wrapToolsWithHealthProbe, connectorReconnectNotice, classifyConnectorAuthError, type HealthReporter } from './connector-health.js'
import { buildConnectorAuthHeaders, mergeValidatedHeaders, preflightHeadersToRecord, actorIdentityHeaders, type ActorIdentity } from './auth-headers.js'
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
import {
  createShopifyTokenManager,
  unpackShopifyTokens, packShopifyTokens,
  getShop as getShopifyShop,
  listProducts as listShopifyProducts,
  getProduct as getShopifyProduct,
  listOrders as listShopifyOrders,
  getOrder as getShopifyOrder,
  searchCustomers as searchShopifyCustomers,
  getCustomer as getShopifyCustomer,
  getInventoryLevels as getShopifyInventoryLevels,
  listCollections as listShopifyCollections,
  listDraftOrders as listShopifyDraftOrders,
  listDiscounts as listShopifyDiscounts,
  listAbandonedCheckouts as listShopifyAbandonedCheckouts,
  getPayoutsSummary as getShopifyPayoutsSummary,
  listDisputes as listShopifyDisputes,
  listContent as listShopifyContent,
  fetchOrdersRange as fetchShopifyOrdersRange,
  updateProduct as updateShopifyProduct,
  createProduct as createShopifyProduct,
  createDraftOrder as createShopifyDraftOrder,
  sendDraftOrderInvoice as sendShopifyDraftOrderInvoice,
  addTags as addShopifyTags,
  updateCustomer as updateShopifyCustomer,
  setInventoryQuantity as setShopifyInventoryQuantity,
  createFulfillment as createShopifyFulfillment,
  createDiscountCode as createShopifyDiscountCode,
  createContent as createShopifyContent,
  cancelOrder as cancelShopifyOrder,
  refundOrder as refundShopifyOrder,
  completeDraftOrder as completeShopifyDraftOrder,
} from '../shopify/client.js'
import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTORS } from '@use-brian/shared'
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
 * `packages/api/src/boot.ts`; see `BOOT_INJECTED_BUILTIN_TOOLS` in
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
  shopify: [
    'shopifyGetShop',
    'shopifyListProducts',
    'shopifyGetProduct',
    'shopifyListOrders',
    'shopifyGetOrder',
    'shopifySearchCustomers',
    'shopifyGetCustomer',
    'shopifyGetInventoryLevels',
    'shopifyListCollections',
    'shopifyListDraftOrders',
    'shopifyListDiscounts',
    'shopifyListAbandonedCheckouts',
    'shopifyGetPayoutsSummary',
    'shopifyListDisputes',
    'shopifyListContent',
    'shopifySalesReport',
    'shopifyUpdateProduct',
    'shopifyCreateProduct',
    'shopifyCreateDraftOrder',
    'shopifySendDraftOrderInvoice',
    'shopifyAddTags',
    'shopifyUpdateCustomer',
    'shopifySetInventory',
    'shopifyCreateFulfillment',
    'shopifyCreateDiscountCode',
    'shopifyCreateContent',
    'shopifyCancelOrder',
    'shopifyRefundOrder',
    'shopifyCompleteDraftOrder',
  ],
  agentmail: [
    'agentmailSendMessage',
    'agentmailSearchThreads',
    'agentmailCreateDraft',
  ],
  imap: [
    'imapSearchMessages',
    'imapGetMessage',
    'imapSendMessage',
    'searchEmailArchive',
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
  /**
   * KB repo write-back port (docs/architecture/features/knowledge-base.md →
   * "Assistant direct edits"). Only meaningful with `allowKnowledgeWrites`.
   */
  knowledgeRepoWriter?: KnowledgeRepoWriter
  /**
   * Whether this surface may expose the KB WRITE tools
   * (`updateKnowledgeEntry`, `addKnowledgeEntry` repo mode). Set `true`
   * ONLY on interactive surfaces with a live in-conversation Approve/Deny
   * loop (web chat, platform channel pipeline). Workflow, A2A, scheduled,
   * and public-API paths keep the default `false` — the tools are then
   * neither injected nor `mcp_search`-discoverable (closed world). Fail
   * closed.
   */
  allowKnowledgeWrites?: boolean
  gdriveFilesStore?: GDriveFilesStore
  /**
   * Stage 4/5 of the team-connector promotion: when the turn is on a
   * team-owned assistant, these stores enable member-exposure grant and
   * team-native instance consumption. Personal assistants and back-compat
   * paths can omit them.
   */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  /**
   * Shared workspace tool policy (migration 312). When present, a team-owned
   * (`scope='workspace'`) connector's tools resolve allow/ask/block from here
   * instead of the acting user's `mcp_tool_settings`, so any sufficiently-
   * cleared member governs the shared assistant. Personal / granted connectors
   * keep the per-user path. See docs/plans/workspace-owned-connector-transfer.md §2C.
   */
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
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
   * Threaded into every built-in injector; `gateToolsOnActionGrants`
   * wraps each registry-classified write/destructive tool so its
   * execute runs `assertActionAllowed` first. Absent → no enforcement
   * (legacy call sites, tests).
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
  /**
   * Tool-use interception port (remote MCP only). Threaded into
   * `createMcpSearchTools` so `preToolUse` can inject/overwrite outbound
   * headers (merged over the connector's stored-credential headers),
   * rewrite args, or block; `postToolUse` observes the result. The open
   * build leaves this unset; the platform supplies the config-driven impl.
   * See `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks
  /**
   * The acting user's resolved identity for this turn (server-side, from the
   * authenticated session — never model output). When set, connectors that
   * opted in (`config.sendActorIdentity`) receive `X-UseBrian-Actor-*` (+ legacy `X-Sidanclaw-Actor-*`) headers
   * at highest precedence. The call site resolves it cheaply (web = email;
   * channels = the webhook's native id + email). See
   * `docs/architecture/engine/tool-hooks.md`.
   */
  actorIdentity?: ActorIdentity
  /**
   * Workspace-files byte layer. When set, `gmailSendMessage` can attach
   * workspace files as real MIME parts (stat → gates → readBytes in core,
   * per `docs/architecture/integrations/gmail.md` → "Attachments").
   * Absent → attachment requests fail honestly; plain sends unchanged.
   */
  filesApi?: FilesApi
  /**
   * The on-demand introspection lane (ability audit §6-c/d): operational-
   * visibility read tools (pending approvals, scheduled jobs, research runs,
   * session history, ...) registered as an `mcp_search` LOCAL SOURCE
   * (`serverName: 'introspection'`), never direct-injected — "whenever it's
   * triggered → inject", so the per-turn prompt cost stays flat. The call
   * site passes them only for workspace PRIMARY assistants (they read
   * workspace-operational state). All read-only; they bypass the L1/L2
   * connector-policy pipeline by design (first-party reads, no policy rows).
   * See `docs/architecture/engine/introspection-tools.md`.
   */
  introspectionTools?: Tool[]
  /**
   * Assistant Email vendor seam (docs/architecture/integrations/agentmail.md).
   * When set AND the workspace holds connected `agentmail` connector
   * instances (one per inbox, decision D1), the three assistant-mailbox
   * tools inject through the team-native overlay. Absent (no
   * AGENTMAIL_API_KEY, OSS default) → the surface is dark and nothing is
   * announced.
   */
  emailInboxProvider?: EmailInboxProvider | null
}): Promise<McpInjectionResult> {
  const {
    userId, assistantId, tools, connectorStore, settingsStore, assistantConnectorStore,
    userTimezone, knowledgeStore, knowledgeRepoWriter, allowKnowledgeWrites = false,
    gdriveFilesStore,
    connectorGrantStore, connectorInstanceStore, workspaceToolPolicyStore, assistantTeamId,
    connectorActionAudit, assistantConnectorGrantsStore, workspaceDomain,
    keepBuiltinsDirect = false, engineHooks, actorIdentity, filesApi,
    introspectionTools, emailInboxProvider,
  } = params

  const unavailable: string[] = []

  // Call-time connector-liveness writer (migration 294). Passed to the built-in
  // injectors so a 401/403 at tool-call time flips the backing instance to
  // `auth_failed` and a success resets it. Fire-and-forget; no-op without a
  // connector-instance store. See mcp/connector-health.ts.
  const reportHealth = createHealthReporter(connectorInstanceStore)

  // ── Workspace connector-scoping gate (SECURITY — incidents 2026-06-01,
  //    2026-06-02, 2026-07-14) ──
  //
  // The base load below pulls `userId`'s personal (scope='user') connectors.
  // For a workspace assistant, `userId` is resolved to the workspace OWNER via
  // `getConnectorUserId` in the route — so base-loading here would hand the
  // owner's personal credentials to the workspace. That leaks in two
  // directions: with teammates present it exposes the owner's private
  // connectors to every member (owner impersonation), and even solo it
  // dissolves the boundary between the owner's OWN workspaces — a connector
  // connected in workspace A becomes callable from workspace B, defeating the
  // context separation multiple workspaces exist for.
  //
  // Exposure is the injection boundary for EVERY workspace, any member count:
  // a workspace assistant's tools come SOLELY from team-native
  // (scope='workspace') instances + member-exposure grants (`connector_grant`)
  // — both applied as overlays further down. Connect-in-context auto-exposes
  // to the active workspace, so the bootstrap flow still works. Only a
  // workspace-less personal assistant base-loads the owner's personal set —
  // there is no workspace boundary to cross. (The solo-workspace base load
  // this gate used to allow via `isSoloWorkspaceSystem` was removed
  // 2026-07-14, clean break, no grant backfill.)
  //
  // See docs/architecture/integrations/mcp.md → "Workspace connector scoping"
  // and `resolveConnectorInstances` (the Stage-5 intent this enforces).
  const loadOwnerPersonalConnectors = !assistantTeamId

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
    /** Static operational headers from `config.preflightHeaders` (validated at merge). */
    preflightHeaders: Record<string, string>
    /** Opt-in: send the acting user's `X-UseBrian-Actor-*` identity to this connector. */
    sendActorIdentity: boolean
    /** Opt-in: send the acting user's `X-UseBrian-Media-Token` capability to this connector. */
    sendMediaToken: boolean
  }> = connectors
    .filter((c) => c.connected && c.url)
    .map((c) => ({ connectorId: c.connectorId, name: c.name, url: c.url!, instanceId: c.id, updatedAt: c.updatedAt, preflightHeaders: preflightHeadersToRecord(c.config), sendActorIdentity: c.config?.sendActorIdentity === true, sendMediaToken: c.config?.sendMediaToken === true }))

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
          preflightHeaders: preflightHeadersToRecord(inst.config),
          sendActorIdentity: inst.config?.sendActorIdentity === true,
          sendMediaToken: inst.config?.sendMediaToken === true,
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
  // Reserved-namespace identity headers, built once per turn (the actor is
  // constant for the turn). Only attached to connectors that opted in, and
  // merged LAST so neither user config nor auth can shadow the assertion.
  const actorHeaders = actorIdentity ? actorIdentityHeaders(actorIdentity) : null
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
  active.forEach((c, i) => {
    // Layer the connector's static preflight headers (config) over its auth
    // headers (credentials) — preflight wins on a name clash, both validated
    // and deduped in mergeValidatedHeaders. The merged set travels on
    // discovery + every mcp_call; a runtime preToolUse hook can still override
    // it per call. See docs/architecture/engine/tool-hooks.md.
    let merged = mergeValidatedHeaders(resolvedHeaders[i], c.preflightHeaders)
    if (actorHeaders && c.sendActorIdentity) {
      merged = mergeValidatedHeaders(merged, actorHeaders)
    }
    if (mediaTokenHeader && c.sendMediaToken) {
      merged = mergeValidatedHeaders(merged, mediaTokenHeader)
    }
    registerAuthHeaders(c.url, merged ?? {})
  })

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
  // For credentialed built-ins a user can connect more than one account.
  // The OLDEST connected instance per provider keeps the canonical tools (so
  // single-account users are unchanged); each additional instance is exposed
  // as a label-qualified variant set bound to its own credentials. Requires
  // the instance store for per-instance credential reads/writes.
  //
  // Derived from the registry: every credentialed official connector is
  // multi-instance at runtime unless marked `single_instance` (gcs — a
  // workspace-level storage binding, not a user account). Contract when
  // adding a connector: either consume its extras in its injector below
  // (the injectGitHubTools / injectGoogleTools pattern) or mark the registry
  // entry `single_instance` — a provider in this list whose injector ignores
  // extras ships a silently-dead second account. Checklist:
  // docs/architecture/integrations/mcp.md → "Adding a new built-in connector tool".
  const MULTI_INSTANCE_RUNTIME_PROVIDERS = OFFICIAL_CONNECTORS
    .filter((c) => c.auth_type !== 'none' && !c.single_instance)
    .map((c) => c.id)
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
  await injectGitHubTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, extrasByProvider.get('github'), resolveInstanceCreds, { report: reportHealth }, assistantConnectorGrantsStore)
  await injectNotionTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, extrasByProvider.get('notion'), resolveInstanceCreds, { report: reportHealth }, assistantConnectorGrantsStore)
  await injectFathomTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, undefined, extrasByProvider.get('fathom'), resolveInstanceCreds, persistInstanceCreds)
  await injectShopifyTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable, undefined, undefined, extrasByProvider.get('shopify'), resolveInstanceCreds, persistInstanceCreds, { report: reportHealth }, assistantConnectorGrantsStore)
  await injectMailboxTools({
    connectors, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable,
    connectorInstanceStore, connectorActionAudit, assistantConnectorGrantsStore,
    healthProbe: { report: reportHealth },
  })
  const enricher = await injectGoogleTools(connectors, connectorStore, settingsStore, userId, assistantId, assistantConnectorStore, tools, userTimezone, unavailable, gdriveFilesStore, undefined, connectorActionAudit, assistantConnectorGrantsStore, workspaceDomain, filesApi, extrasByProvider, resolveInstanceCreds, reportHealth)

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
        // Health gate (migration 294): a granted connector whose credentials
        // died is announced as needing reconnect rather than injected, so the
        // model doesn't burn its tool budget on a dead connector.
        if (g.instance.healthStatus === 'auth_failed') {
          unavailable.push(connectorReconnectNotice(p, g.instance.label))
          continue
        }
        const grantorConnectors = await connectorStore.list(g.grantedByUserId).catch(() => [])
        // Bind the granted built-in connector to the EXACT exposed instance
        // (`g.instance.id`), NOT `connectorStore.getCredentials(grantor, provider)`.
        // That lookup is `ORDER BY created_at ASC LIMIT 1` — the grantor's OLDEST
        // connected account of this provider — which can be a personal instance
        // that carries no `connector_grant` and was never exposed to the
        // workspace. Threading only the health-probe `instanceId` (below) left
        // credential resolution on the legacy provider-wide path, so a workspace
        // assistant sent mail from a personal Gmail (incident 2026-07-08,
        // fls.com.hk: exposed hinson.wong@deltadefi.io lost to older personal
        // wongkahinhinson@gmail.com). Mirrors the team-native overlay's
        // `getCredentialsSystem(inst.id)` binding. See
        // docs/architecture/integrations/mcp.md → "Grant overlay instance binding".
        // Fail-closed: without `connectorInstanceStore` we cannot bind to the
        // instance, so we inject nothing rather than risk the wrong account.
        const boundGrantCreds = async (): Promise<string | null> => {
          if (!connectorInstanceStore) return null
          const creds = await connectorInstanceStore.getCredentialsSystem(g.instance.id)
          return creds?.client_secret ?? null
        }
        if (p === 'github') {
          await injectGitHubTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined, boundGrantCreds, undefined, undefined, { report: reportHealth, instanceId: g.instance.id }, assistantConnectorGrantsStore)
        } else if (p === 'notion') {
          await injectNotionTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined, boundGrantCreds, undefined, undefined, { report: reportHealth, instanceId: g.instance.id }, assistantConnectorGrantsStore)
        } else if (p === 'fathom') {
          await injectFathomTools(grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined)
        } else if (p === 'shopify') {
          // Rotated tuples persist back into the EXPOSED instance row (the
          // Fathom team-path deferral doesn't apply: updateCredentialsSystem
          // gives us the system-level writer the rotation needs).
          await injectShopifyTools(
            grantorConnectors, connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, undefined,
            boundGrantCreds,
            async (encoded) => {
              if (!connectorInstanceStore) throw new Error('Shopify token rotation needs the instance store')
              await connectorInstanceStore.updateCredentialsSystem(g.instance.id, { client_id: 'shopify_oauth', client_secret: encoded })
            },
            undefined, undefined, undefined,
            { report: reportHealth, instanceId: g.instance.id },
            assistantConnectorGrantsStore,
          )
        } else if (p === 'imap') {
          // The user's corporate mailbox exposed to the workspace. Bind to
          // the EXACT exposed instance (the typed 'imap' credentials blob) —
          // the same instance-binding rule as the incident-2026-07-08 fix.
          await injectMailboxTools({
            connectors: grantorConnectors, settingsStore, userId: g.grantedByUserId, assistantId,
            assistantConnectorStore, tools,
            connectorInstanceStore, connectorActionAudit, assistantConnectorGrantsStore,
            instanceIdOverride: g.instance.id,
            healthProbe: { report: reportHealth },
          })
        } else if (p === 'gcal' || p === 'gmail' || p === 'gdrive') {
          // Scope the injector to the GRANTED provider only. `injectGoogleTools`
          // injects every connected Google provider it sees in `connectors`, so
          // passing the grantor's full list would let an ungranted sibling
          // service (e.g. a personal Calendar) ride along on a granted Gmail.
          await injectGoogleTools([{ connectorId: p, connected: true }], connectorStore, settingsStore, g.grantedByUserId, assistantId, assistantConnectorStore, tools, userTimezone, undefined, gdriveFilesStore, { [p]: boundGrantCreds }, connectorActionAudit, assistantConnectorGrantsStore, workspaceDomain, filesApi)
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

      // Team-owned connectors are governed by the SHARED workspace policy, not
      // any single user's mcp_tool_settings. Swap the settings store for a
      // workspace-keyed adapter so allow/ask/block resolves from
      // workspace_tool_policy. Falls back to the per-user store when the shared
      // policy store isn't wired (legacy call sites / tests).
      const teamPolicyStore = workspaceToolPolicyStore
        ? workspacePolicyAsSettingsStore(workspaceToolPolicyStore, assistantTeamId)
        : settingsStore

      // Synthesize a "connectors" array that looks like the legacy per-user
      // one, so the per-provider injectors' enable checks and discovery
      // logic don't need to change. `credsOverride` / `credsOverridePerConnector`
      // reroute the actual credential reads.
      const syntheticConnectors: Array<{ connectorId: string; connected: boolean; url?: string | null }> = []

      for (const inst of teamNative) {
        if (!inst.connected) continue
        const p = inst.provider
        // Assistant Email instances are one-per-inbox (decision D1) and inject
        // as ONE tool set over ALL inboxes below — not first-instance-wins.
        if (p === 'agentmail') continue
        if (overlaidByTeam.has(p)) continue    // first team-native per provider wins
        overlaidByTeam.add(p)
        // Health gate (migration 294): a team-native connector whose credentials
        // died (401 at call time) is announced as needing reconnect and NOT
        // re-injected — the exact fix for the dead-GitHub-token incident, where
        // the model burned its tool budget calling a 401ing connector. Reconnect
        // resets health to 'ok'. See docs/architecture/integrations/connector-health.md.
        if (inst.healthStatus === 'auth_failed') {
          unavailable.push(connectorReconnectNotice(p, inst.label))
          continue
        }
        syntheticConnectors.push({ connectorId: p, connected: true, url: inst.url ?? null })

        if (p === 'github') {
          await injectGitHubTools(
            syntheticConnectors,
            connectorStore,
            teamPolicyStore,     // team-owned: policy from workspace_tool_policy
            userId,              // userId still binds credentials + assistant enable-state
            assistantId,
            assistantConnectorStore,
            tools,
            undefined,
            async () => {
              const creds = await connectorInstanceStore.getCredentialsSystem(inst.id)
              return creds?.client_secret ?? null
            },
            undefined,
            undefined,
            { report: reportHealth, instanceId: inst.id },
            assistantConnectorGrantsStore,
          )
        } else if (p === 'notion') {
          await injectNotionTools(
            syntheticConnectors,
            connectorStore,
            teamPolicyStore,     // team-owned: policy from workspace_tool_policy
            userId,
            assistantId,
            assistantConnectorStore,
            tools,
            undefined,
            async () => {
              const creds = await connectorInstanceStore.getCredentialsSystem(inst.id)
              return creds?.client_secret ?? null
            },
            undefined,
            undefined,
            { report: reportHealth, instanceId: inst.id },
            assistantConnectorGrantsStore,
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
        } else if (p === 'shopify') {
          await injectShopifyTools(
            syntheticConnectors,
            connectorStore,
            teamPolicyStore,     // team-owned: policy from workspace_tool_policy
            userId,
            assistantId,
            assistantConnectorStore,
            tools,
            undefined,
            async () => {
              const creds = await connectorInstanceStore.getCredentialsSystem(inst.id)
              return creds?.client_secret ?? null
            },
            // Rotated tuples persist back into the team-scoped row via the
            // system-level writer (the Fathom deferral above predates it).
            async (encoded) => {
              await connectorInstanceStore.updateCredentialsSystem(inst.id, { client_id: 'shopify_oauth', client_secret: encoded })
            },
            undefined, undefined, undefined,
            { report: reportHealth, instanceId: inst.id },
            assistantConnectorGrantsStore,
          )
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
          teamPolicyStore,       // team-owned: policy from workspace_tool_policy
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
          filesApi,
        )
      }

      if (overlaidByTeam.size > 0) {
        console.debug(`[mcp-inject] team-native overlay: re-injected ${overlaidByTeam.size} provider(s) from team-scoped connector_instance rows`)
      }

      // ── Assistant Email (agentmail) — one tool set over ALL inboxes ──
      // Instances are one-per-inbox (decision D1); the tools take an
      // optional `fromInbox` instead of per-instance variant suffixes. Dark
      // without the provider (no AGENTMAIL_API_KEY) — nothing is announced.
      // Explicit param wins; otherwise the boot-bound global (the late-bound
      // seam — see provider.ts).
      const effectiveEmailProvider = emailInboxProvider ?? getGlobalEmailInboxProvider()
      if (effectiveEmailProvider) {
        const inboxInstances = teamNative
          .filter((i) => i.provider === 'agentmail' && i.connected && i.healthStatus !== 'auth_failed')
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        const agentmailEnabled =
          !assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'agentmail')
        if (inboxInstances.length > 0 && agentmailEnabled) {
          await injectAgentmailTools({
            provider: effectiveEmailProvider,
            inboxes: inboxInstances.map((i) => ({
              address: (i.connectedEmail ?? i.label).toLowerCase(),
            })),
            settingsStore: workspaceToolPolicyStore
              ? workspacePolicyAsSettingsStore(workspaceToolPolicyStore, assistantTeamId)
              : settingsStore,
            userId,
            assistantId,
            tools,
            unavailable,
            connectorActionAudit,
            assistantConnectorGrantsStore,
          })
        } else if (inboxInstances.length === 0) {
          unavailable.push(
            'Assistant Email (no assistant inbox provisioned in this workspace) — if the user wants the assistant to have its own email address, point them to Studio → Channels → Add channel → Email.',
          )
        }
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
        const repoConnected = sources.length > 0

        // KB write exposure (docs/architecture/features/knowledge-base.md →
        // "Assistant direct edits"): repo write tools exist only when this
        // surface allows knowledge writes (interactive chat), the writer
        // port is wired, AND a source's cached PAT probe says push access
        // (`write_access` — migration 310; NULL/false = read-only, fail
        // closed). Not injected ⇒ not `mcp_search`-discoverable.
        const writableSources = sources
          .filter((s) => s.writeAccess === true)
          .map((s) => ({ id: s.id, repo: s.repo }))
        const writeEnabled =
          allowKnowledgeWrites && !!knowledgeRepoWriter && writableSources.length > 0

        const kbTools = createKnowledgeTools(knowledgeStore, {
          repoConnected,
          allowWrites: allowKnowledgeWrites,
          repoWriter: writeEnabled ? knowledgeRepoWriter : undefined,
          writableSources: writeEnabled ? writableSources : [],
          requesterLabel: actorIdentity?.email ?? null,
        })
        for (const tool of kbTools) {
          tools.set(tool.name, tool)
          kbToolNames.push(tool.name)
        }

        // Capability honesty: on a write-capable surface with a repo-synced
        // KB but no writable source, say so precisely — the model can then
        // explain the fix instead of hunting for a tool that isn't there.
        if (allowKnowledgeWrites && repoConnected && !writeEnabled) {
          const repos = sources.map((s) => s.repo).join(', ')
          unavailable.push(
            knowledgeRepoWriter
              ? `knowledge base editing (the GitHub token backing ${repos} is read-only — needs push permission; reconnect it with a read-write token in Studio → Connectors to enable assistant edits)`
              : 'knowledge base editing (not configured on this server)',
          )
        }

        console.debug(`[mcp-inject] Knowledge: injected ${kbTools.length} tools (repo connected: ${repoConnected}, writable sources: ${writableSources.length}, writes: ${writeEnabled})`)
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

  // Introspection bucket — the on-demand lane for operational-visibility
  // reads (pending approvals, scheduled jobs, research runs, session
  // history, ...). These tools never sat in the direct `tools` map (no pluck
  // needed): they enter ONLY through the search index, so the model discovers
  // them via `mcp_search` exactly when the turn asks an operational question
  // ("what's pending on me?", "did that research finish?") and calls via
  // `mcp_call` — the founder-locked "whenever it's triggered → inject"
  // contract (ability audit §6-c/d). Gated to the workflow-direct path too:
  // `keepBuiltinsDirect` skips search-pair plucking but introspection reads
  // are chat-surface tools — the call site only passes them for interactive
  // workspace-primary turns.
  if (!keepBuiltinsDirect && introspectionTools && introspectionTools.length > 0) {
    localSources.push({ kind: 'local', serverName: 'introspection', tools: introspectionTools })
    console.log(`[mcp-inject] introspection lane: ${introspectionTools.length} on-demand tools`)
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
      // A preflight hook may pass `overrides`, merged over the stored-
      // credential headers (override wins, re-validated) just before the
      // wire call. See docs/architecture/engine/tool-hooks.md.
      callMcpTool: (serverUrl, toolName, input, overrides) =>
        callRemoteMcpTool(serverUrl, toolName, input, mergeValidatedHeaders(headersByUrl.get(serverUrl), overrides)),
      hooks: engineHooks,
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

/**
 * `unavailable[]` copy for a connector that is NOT connected (or is disabled
 * for this assistant).
 *
 * These notices state a FACT and name the surface that fixes it. They must
 * never embed a quotable reply sentence: on 2026-07-21 the gdrive notice
 * carried the script `reply: "I'll need Drive access first. Type /connect
 * gdrive to authorize."`, and a model that had wrongly concluded Gmail was
 * unavailable re-instantiated that template for Gmail, telling the user to
 * run `/connect gmail` while `gmailSendMessage` sat injected and usable.
 * A fill-in-the-blank refusal script in Layer 1 gets filled in.
 *
 * Point at Studio > Connectors, not at `/connect`: this text is read on
 * every channel, and `/connect` only exists on Telegram.
 *
 * Spec: `docs/architecture/integrations/mcp.md` -> "Unavailable capabilities".
 */
function notConnectedNotice(displayName: string, capabilities: string): string {
  return (
    `${displayName}: not connected for this assistant, so ${capabilities} are unavailable this turn. ` +
    'If the user asks for one, say so plainly in your own words and point them to Studio then Connectors to connect it. ' +
    'Do not quote this notice back to them, and do not claim a tool call failed.'
  )
}

/**
 * `unavailable[]` copy for a connector that IS connected but whose stored
 * credentials no longer work. Distinct from {@link notConnectedNotice}: here
 * reconnecting genuinely is the remedy.
 */
function expiredCredentialsNotice(displayName: string): string {
  return (
    `${displayName}: connected, but its stored credentials expired or were revoked, so its tools are not loaded this turn. ` +
    'Tell the user it needs reconnecting in Studio then Connectors. Do not offer any other cause.'
  )
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
   * `connector-actions.md`). When set, every registry-classified
   * write/destructive tool in this injector's Google sets is wrapped by
   * `gateToolsOnActionGrants` so `assertActionAllowed` runs BEFORE the
   * network call. On rejection the tool throws a structured error and
   * writes NO audit row (the action never started). Absent → no
   * enforcement (back-compat with legacy boot configurations).
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
  /**
   * Authoritative primary email domain for the acting assistant's
   * workspace. Used by the GCal audit hook to detect "internal-only"
   * attendees → `audience_clearance='internal'`. Absent / null → every
   * attendee is treated as external and `audience_clearance='public'`.
   */
  workspaceDomain?: string | null,
  /**
   * Workspace-files byte layer — enables `gmailSendMessage` attachments
   * (resolution + gates run in core; see `google-gmail.ts`). Absent →
   * attachment requests fail honestly inside the tool.
   */
  filesApi?: FilesApi,
  /**
   * Multi-account extras (personal base load only). Additional connected
   * instances per Google provider beyond the primary — each is injected as a
   * label-qualified variant tool set bound to its own refresh token via
   * `resolveInstanceCreds`, mirroring the GitHub/Notion/Fathom pattern. The
   * team-native / grant overlay paths never pass these (overlays stay
   * provider-level, first instance wins).
   */
  extrasByProvider?: Map<string, ConnectorInstanceRef[]>,
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /**
   * Call-time liveness writer for the extra instances (migration 294): a
   * 401/403/invalid_grant inside a variant tool call flips that instance to
   * `auth_failed`. The PRIMARY keeps the legacy prevalidation +
   * auto-disconnect path above instead.
   */
  healthReport?: HealthReporter,
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

  // ── Per-instance tokens (multi-account extras) ────────────────
  // An EXTRA Google account resolves its own refresh token off its
  // connector_instance row, lazily at first tool call — no prevalidation, so
  // a dead extra account never delays the primary's injection; it surfaces
  // through the variant's health probe (`wrapToolsWithHealthProbe` classifies
  // the thrown invalid_grant) on first use instead. Same request-scoped cache
  // as the primary, keyed by instance id.
  async function getAccessTokenForInstance(instanceId: string): Promise<string> {
    const cacheKey = `inst:${instanceId}`
    const cached = tokenCache.get(cacheKey)
    if (cached) return cached
    const refreshToken = resolveInstanceCreds ? await resolveInstanceCreds(instanceId) : null
    if (!refreshToken) throw new Error(`Google account instance ${instanceId} has no credentials`)
    const token = await refreshGoogleAccessToken(refreshToken, clientId, clientSecret)
    tokenCache.set(cacheKey, token)
    return token
  }

  // Suffix → per-instance token getter, populated as variant sets are
  // injected below. Lets the confirmation enricher resolve the RIGHT
  // account's token for a suffixed tool name (`googleCalendarUpdateEvent__work_1a2b3c4d`).
  const instanceTokenBySuffix = new Map<string, () => Promise<string>>()

  /** Extras for one Google provider — only on the personal base load. */
  function googleExtras(provider: 'gcal' | 'gmail' | 'gdrive'): ConnectorInstanceRef[] {
    if (credsOverridePerConnector || !resolveInstanceCreds) return []
    return extrasByProvider?.get(provider) ?? []
  }

  /** Wrap a variant tool set with the per-instance health probe (when wired). */
  function probeVariant(built: Tool[], instanceId: string): Tool[] {
    return healthReport ? wrapToolsWithHealthProbe(built, instanceId, healthReport) : built
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
    unavailable?.push(expiredCredentialsNotice('Google Calendar'))
  } else if (!gcal || !gcalEnabled) {
    unavailable?.push(notConnectedNotice('Google Calendar and Google Tasks', 'calendar events, tasks, and reminders'))
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

      // Tool set bound to one account's token source — built once for the
      // primary (canonical names) and once per extra account (suffixed
      // variants). The audit emitters, action gates, and sendUpdates config
      // are provider-level and intentionally shared across accounts.
      const buildCalTools = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGoogleCalendarTools({
        listEvents: async (params) => {
          const token = await getToken()
          return listCalendarEvents(token, params)
        },
        getEvent: async (eventId, calendarId) => {
          const token = await getToken()
          return getCalendarEvent(token, eventId, calendarId)
        },
        createEvent: async (event) => {
          const token = await getToken()
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
          const token = await getToken()
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
          const token = await getToken()
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
      }, userTimezone), 'gcal', assistantConnectorGrantsStore, assistantId)
      const calTools = buildCalTools(() => getAccessToken('gcal'))
      for (const tool of calTools) {
        if (await applyPolicyOrSkip(tool, 'gcal', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Extra Google Calendar accounts → label-qualified variant sets bound
      // to their own tokens (the Tasks variants ride the same suffix in the
      // Tasks section below).
      const gcalExtras = googleExtras('gcal')
      if (gcalExtras.length) {
        await injectInstanceVariants({
          provider: 'gcal',
          extras: gcalExtras,
          settingsStore, assistantId, userId, tools,
          buildToolsForInstance: (inst) => {
            const getToken = () => getAccessTokenForInstance(inst.id)
            instanceTokenBySuffix.set(instanceToolSuffix(inst.id, inst.label), getToken)
            return probeVariant(buildCalTools(getToken), inst.id)
          },
        })
      }
      console.debug(`[mcp-inject] Google Calendar: injected tools${gcalExtras.length ? ` (+${gcalExtras.length} extra account(s))` : ''}`)
    } catch (err) {
      console.error('[mcp-inject] Google Calendar injection failed:', err)
    }
  }

  // Gmail — Layer 1 (connected + not revoked) + Layer 2 (enabled for this assistant)
  const gmail = gmailRaw && !revokedConnectors.has('gmail') ? gmailRaw : undefined
  const gmailEnabled = gmail && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gmail'))
  if (revokedConnectors.has('gmail')) {
    unavailable?.push(expiredCredentialsNotice('Gmail'))
  } else if (!gmail || !gmailEnabled) {
    unavailable?.push(notConnectedNotice('Gmail', 'sending and reading email'))
  }
  if (gmail && gmailEnabled) {
    try {
      // Tool set bound to one account's token source (primary + per-extra
      // variants, same shape as the gcal builder above). The grants gate,
      // audit wrap, and classifier preflight are provider-level — shared
      // across accounts by design.
      const buildGmailToolSet = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGmailTools({
        listMessages: async (params) => {
          const token = await getToken()
          return listGmailMessages(token, params)
        },
        getMessage: async (messageId) => {
          const token = await getToken()
          return getGmailMessage(token, messageId)
        },
        sendMessage: async (params) => {
          const token = await getToken()
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
            cc: params.cc ?? [],
            bcc: params.bcc ?? [],
            from: params.from ?? null,
            subject: params.subject,
            has_body: Boolean(params.body),
            body_length: params.body?.length ?? 0,
            body: params.body ?? '',
            // Attachment METADATA only — never bytes. Filenames ride
            // through the payload classifier with the rest.
            attachment_count: params.attachments?.length ?? 0,
            attachments: (params.attachments ?? []).map((a) => ({
              name: a.filename,
              mime: a.mime,
              size_bytes: a.data.byteLength,
            })),
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
      }, { filesApi }), 'gmail', assistantConnectorGrantsStore, assistantId)
      const gmailTools = buildGmailToolSet(() => getAccessToken('gmail'))
      for (const tool of gmailTools) {
        if (await applyPolicyOrSkip(tool, 'gmail', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Extra Gmail accounts → label-qualified variant sets bound to their
      // own tokens.
      const gmailExtras = googleExtras('gmail')
      if (gmailExtras.length) {
        await injectInstanceVariants({
          provider: 'gmail',
          extras: gmailExtras,
          settingsStore, assistantId, userId, tools,
          buildToolsForInstance: (inst) => {
            const getToken = () => getAccessTokenForInstance(inst.id)
            instanceTokenBySuffix.set(instanceToolSuffix(inst.id, inst.label), getToken)
            return probeVariant(buildGmailToolSet(getToken), inst.id)
          },
        })
      }
      console.debug(`[mcp-inject] Gmail: injected tools${gmailExtras.length ? ` (+${gmailExtras.length} extra account(s))` : ''}`)
    } catch (err) {
      console.error('[mcp-inject] Gmail injection failed:', err)
    }
  }

  // Google Drive (+ Docs, Sheets, Slides) — Layer 1 (connected + not revoked) + Layer 2 (enabled)
  const gdrive = gdriveRaw && !revokedConnectors.has('gdrive') ? gdriveRaw : undefined
  const gdriveEnabled = gdrive && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gdrive'))
  if (revokedConnectors.has('gdrive')) {
    unavailable?.push(expiredCredentialsNotice('Google Drive, Docs, Sheets and Slides'))
  } else if (!gdrive || !gdriveEnabled) {
    unavailable?.push(notConnectedNotice('Google Drive, Docs, Sheets and Slides', 'creating or opening docs, slides, spreadsheets, and Excel files'))
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

      // Per-account tool-set builders — instantiated for the primary below
      // and re-bound per extra account in the variants block after the four
      // families. `gdriveAuthorizedFiles`, `recordCreated`, and `syncOnRead`
      // are per-USER state (Picker consent + created-file index),
      // intentionally shared across accounts.
      const buildDriveTools = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGoogleDriveTools({
        listFiles: async (params) => {
          const token = await getToken()
          return listDriveFiles(token, params)
        },
        getFile: async (fileId) => {
          const token = await getToken()
          return getDriveFile(token, fileId)
        },
        getFileContent: async (fileId, exportMimeType) => {
          const token = await getToken()
          return getDriveFileContent(token, fileId, exportMimeType)
        },
        createFile: async (params) => {
          const token = await getToken()
          return createDriveFile(token, params)
        },
        updateFile: async (fileId, params) => {
          const token = await getToken()
          return updateDriveFileContent(token, fileId, params)
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId)
      const driveTools = buildDriveTools(() => getAccessToken('gdrive'))
      for (const tool of driveTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Docs tools
      const buildDocsTools = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGoogleDocsTools({
        getContent: async (documentId) => {
          const token = await getToken()
          const doc = await getDocContent(token, documentId)
          syncOnRead(documentId, doc.title)
          return doc
        },
        appendText: async (documentId, text) => {
          const token = await getToken()
          return appendToDoc(token, documentId, text)
        },
        replaceText: async (documentId, findText, replaceText) => {
          const token = await getToken()
          return replaceInDoc(token, documentId, findText, replaceText)
        },
        create: async (title) => {
          const token = await getToken()
          const doc = await createDocument(token, title)
          recordCreated('doc', doc.documentId, doc.title, doc.url, 'application/vnd.google-apps.document')
          return doc
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId)
      const docsTools = buildDocsTools(() => getAccessToken('gdrive'))
      for (const tool of docsTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Sheets tools
      const buildSheetsTools = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGoogleSheetsTools({
        getSpreadsheetInfo: async (spreadsheetId) => {
          const token = await getToken()
          const info = await getSpreadsheetInfo(token, spreadsheetId)
          syncOnRead(spreadsheetId, info.title)
          return info
        },
        readRange: async (spreadsheetId, range) => {
          const token = await getToken()
          return readSheetRange(token, spreadsheetId, range)
        },
        writeRange: async (spreadsheetId, range, values) => {
          const token = await getToken()
          return writeSheetRange(token, spreadsheetId, range, values)
        },
        appendRows: async (spreadsheetId, range, values) => {
          const token = await getToken()
          return appendSheetRows(token, spreadsheetId, range, values)
        },
        create: async (title) => {
          const token = await getToken()
          const sheet = await createSpreadsheet(token, title)
          recordCreated('sheet', sheet.spreadsheetId, sheet.title, sheet.url, 'application/vnd.google-apps.spreadsheet')
          return sheet
        },
        format: async (spreadsheetId, opts) => {
          const token = await getToken()
          return formatSpreadsheet(token, spreadsheetId, opts)
        },
        batchUpdate: async (spreadsheetId, requests) => {
          const token = await getToken()
          return batchUpdateSpreadsheet(token, spreadsheetId, requests)
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId)
      const sheetsTools = buildSheetsTools(() => getAccessToken('gdrive'))
      for (const tool of sheetsTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Slides tools — structured read + placeholder-targeted, atomic write.
      // See docs/architecture/integrations/google-slides.md.
      const buildSlidesTools = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGoogleSlidesTools({
        getPresentationInfo: async (presentationId) => {
          const token = await getToken()
          const info = await getPresentationInfo(token, presentationId)
          syncOnRead(presentationId, info.title)
          return info
        },
        getSlideContent: async (presentationId, slideIndex) => {
          const token = await getToken()
          return getSlideContent(token, presentationId, slideIndex)
        },
        getSlideThumbnail: async (presentationId, slideObjectId, options) => {
          const token = await getToken()
          return getSlideThumbnail(token, presentationId, slideObjectId, options)
        },
        createSlide: async (presentationId, args) => {
          const token = await getToken()
          return slidesCreateSlide(token, presentationId, args)
        },
        updateSlideContent: async (presentationId, args) => {
          const token = await getToken()
          return slidesUpdateSlideContent(token, presentationId, args)
        },
        insertImage: async (presentationId, args) => {
          const token = await getToken()
          return slidesInsertImage(token, presentationId, args)
        },
        deleteSlide: async (presentationId, slideObjectId) => {
          const token = await getToken()
          return slidesDeleteSlide(token, presentationId, slideObjectId)
        },
        reorderSlides: async (presentationId, slideObjectIds, insertionIndex) => {
          const token = await getToken()
          return slidesReorderSlides(token, presentationId, slideObjectIds, insertionIndex)
        },
        duplicateSlide: async (presentationId, slideObjectId, insertionIndex) => {
          const token = await getToken()
          return slidesDuplicateSlide(token, presentationId, slideObjectId, insertionIndex)
        },
        batchUpdate: async (presentationId, requests) => {
          const token = await getToken()
          return batchUpdateSlides(token, presentationId, requests)
        },
        createPresentation: async (title) => {
          const token = await getToken()
          const pres = await createPresentation(token, title)
          recordCreated('slide', pres.presentationId, pres.title, pres.url, 'application/vnd.google-apps.presentation')
          return pres
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId)
      const slidesTools = buildSlidesTools(() => getAccessToken('gdrive'))
      for (const tool of slidesTools) {
        if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Extra Drive accounts → label-qualified variants of all four families,
      // each bound to its own token. `findGDriveFiles` is deliberately NOT
      // variant-injected: it reads the per-user created-file index, not the
      // Drive API — one copy serves every account.
      const gdriveExtras = googleExtras('gdrive')
      if (gdriveExtras.length) {
        await injectInstanceVariants({
          provider: 'gdrive',
          extras: gdriveExtras,
          settingsStore, assistantId, userId, tools,
          buildToolsForInstance: (inst) => {
            const getToken = () => getAccessTokenForInstance(inst.id)
            instanceTokenBySuffix.set(instanceToolSuffix(inst.id, inst.label), getToken)
            return probeVariant([
              ...buildDriveTools(getToken),
              ...buildDocsTools(getToken),
              ...buildSheetsTools(getToken),
              ...buildSlidesTools(getToken),
            ], inst.id)
          },
        })
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

      console.debug(`[mcp-inject] Google Drive (Drive/Docs/Sheets/Slides): injected tools${gdriveExtras.length ? ` (+${gdriveExtras.length} extra account(s))` : ''}`)
    } catch (err) {
      console.error('[mcp-inject] Google Drive injection failed:', err)
    }
  }

  // Google Tasks — bundled with gcal (same OAuth credentials, Tasks scope added to gcal)
  if (revokedConnectors.has('gcal')) {
    unavailable?.push(expiredCredentialsNotice('Google Tasks'))
  }
  if (gcal && gcalEnabled) {
    try {
      const buildTasksTools = (getToken: () => Promise<string>) => gateToolsOnActionGrants(createGoogleTasksTools({
        listTaskLists: async (params) => {
          const token = await getToken()
          return listTaskLists(token, params)
        },
        listTasks: async (params) => {
          const token = await getToken()
          return listGoogleTasks(token, params)
        },
        getTask: async (taskListId, taskId) => {
          const token = await getToken()
          return getGoogleTask(token, taskListId, taskId)
        },
        createTask: async (taskListId, task) => {
          const token = await getToken()
          return createGoogleTask(token, taskListId, task)
        },
        updateTask: async (taskListId, taskId, updates) => {
          const token = await getToken()
          return updateGoogleTask(token, taskListId, taskId, updates)
        },
        deleteTask: async (taskListId, taskId) => {
          const token = await getToken()
          return deleteGoogleTask(token, taskListId, taskId)
        },
      }), 'gcal', assistantConnectorGrantsStore, assistantId)
      const tasksTools = buildTasksTools(() => getAccessToken('gcal'))
      for (const tool of tasksTools) {
        if (await applyPolicyOrSkip(tool, 'gcal', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }

      // Tasks ride the gcal credential, so each extra Calendar account also
      // gets its Tasks variants (same suffix as its Calendar set above).
      const tasksExtras = googleExtras('gcal')
      if (tasksExtras.length) {
        await injectInstanceVariants({
          provider: 'gcal',
          extras: tasksExtras,
          settingsStore, assistantId, userId, tools,
          buildToolsForInstance: (inst) =>
            probeVariant(buildTasksTools(() => getAccessTokenForInstance(inst.id)), inst.id),
        })
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

    // Multi-account: a suffixed variant name enriches with ITS OWN account's
    // token; canonical names use the primary's. An unrecognized suffix (a
    // non-Google variant, or a stale name) leaves the input unenriched.
    const canonicalName = baseToolName(toolName)
    const suffix = toolName.slice(canonicalName.length)
    const getEnrichToken = suffix ? instanceTokenBySuffix.get(suffix) : () => getAccessToken('gcal')

    // ── Google Tasks: fetch title so the user sees "記得 Call 大隻佬" not "eHXMFJ..." ──
    if (canonicalName === 'googleTasksUpdateTask' || canonicalName === 'googleTasksDeleteTask') {
      const taskId = input.taskId as string | undefined
      const taskListId = (input.taskListId as string | undefined) ?? '@default'
      if (!taskId || !getEnrichToken) return input

      try {
        const token = await getEnrichToken()
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
    if (canonicalName !== 'googleCalendarUpdateEvent' && canonicalName !== 'googleCalendarDeleteEvent') return input

    const eventId = input.eventId as string | undefined
    if (!eventId || !getEnrichToken) return input

    try {
      const token = await getEnrichToken()
      const event = await getCalendarEvent(token, eventId)
      const summary = (event as Record<string, unknown>).summary as string | undefined
      const start = (event as Record<string, unknown>).start as { dateTime?: string; date?: string } | undefined
      const end = (event as Record<string, unknown>).end as { dateTime?: string; date?: string } | undefined
      const attendees = ((event as Record<string, unknown>).attendees as Array<{ email: string }> | undefined)
        ?.map(a => a.email)

      if (canonicalName === 'googleCalendarUpdateEvent') {
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
  /**
   * Call-time liveness probe (migration 294). When set, the built tools are
   * wrapped so a 401/403 flips the backing connector_instance to `auth_failed`
   * (and a success resets it). `instanceId` overrides the resolved primary id —
   * needed on the team-native / grant paths whose synthetic connector array
   * carries no id. See mcp/connector-health.ts.
   */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
): Promise<void> {
  const github = connectors.find((c) => c.connectorId === 'github' && c.connected)
  const githubEnabled = github && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'github'))

  if (!github || !githubEnabled) {
    unavailable?.push(notConnectedNotice('GitHub', 'repositories, issues, and pull requests'))
    return
  }

  // Build the GitHub tool set bound to a given PAT source. Reused for the
  // primary instance and (renamed) for each extra account.
  function buildTools(getPat: () => Promise<string>): Tool[] {
    return gateToolsOnActionGrants(createGitHubTools({
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
    }), 'github', assistantConnectorGrantsStore, assistantId)
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

  const primaryInstanceId = healthProbe?.instanceId ?? (github as { id?: string }).id ?? null
  try {
    const built = buildTools(getPat)
    const ghTools = healthProbe && primaryInstanceId
      ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
      : built

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
        buildToolsForInstance: (inst) => {
          const variant = buildTools(async () => {
            const pat = await resolveInstanceCreds(inst.id)
            if (!pat) throw new Error(`GitHub instance ${inst.id} has no credentials`)
            return pat
          })
          return healthProbe ? wrapToolsWithHealthProbe(variant, inst.id, healthProbe.report) : variant
        },
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
  /** Call-time liveness probe (migration 294). See `injectGitHubTools`. */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
): Promise<void> {
  if (!getConnectorConfig('notion')) return

  const notion = connectors.find((c) => c.connectorId === 'notion' && c.connected)
  const notionEnabled = notion && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'notion'))

  if (!notion || !notionEnabled) {
    unavailable?.push(notConnectedNotice('Notion', 'searching and updating Notion pages and databases'))
    return
  }

  // Notion uses a long-lived access token stored in client_secret. Build the
  // tool set bound to a given token source — reused per account.
  function buildTools(getAccessToken: () => Promise<string>): Tool[] {
    return gateToolsOnActionGrants(createNotionTools({
      search: async (params) => searchNotion(await getAccessToken(), params),
      getPage: async (pageId) => getNotionPage(await getAccessToken(), pageId),
      getDatabase: async (databaseId) => getNotionDatabase(await getAccessToken(), databaseId),
      queryDatabase: async (databaseId, params) => queryNotionDatabase(await getAccessToken(), databaseId, params),
      createPage: async (params) => createNotionPage(await getAccessToken(), params),
      updatePage: async (pageId, params) => updateNotionPage(await getAccessToken(), pageId, params),
      appendBlocks: async (pageId, content) => appendNotionBlocks(await getAccessToken(), pageId, content),
    }), 'notion', assistantConnectorGrantsStore, assistantId)
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
    const builtNotion = buildTools(getAccessToken)
    const notionTools = healthProbe && primaryInstanceId
      ? wrapToolsWithHealthProbe(builtNotion, primaryInstanceId, healthProbe.report)
      : builtNotion

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
        buildToolsForInstance: (inst) => {
          const variant = buildTools(async () => {
            const token = await resolveInstanceCreds(inst.id)
            if (!token) throw new Error(`Notion instance ${inst.id} has no credentials`)
            return token
          })
          return healthProbe ? wrapToolsWithHealthProbe(variant, inst.id, healthProbe.report) : variant
        },
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

// ── Built-in Shopify connector ─────────────────────────────
// Store reads + safe v1 writes (docs/architecture/integrations/shopify.md).
// Credentials are a per-shop tuple: pasted `shpat_` tokens are static; OAuth
// tokens are expiring with a ROTATING refresh token, so like Fathom each
// account gets its own token manager whose persist is bound to that
// instance's row (persist-before-use — a lost persist bricks the connection).

async function injectShopifyTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** See `injectGitHubTools` — same role. Returns the encoded ShopifyTokens JSON blob. */
  credsOverride?: () => Promise<string | null>,
  /** Persistence override for grant/team-native rows; defaults to the user-scoped connectorStore. */
  persistOverride?: (encoded: string) => Promise<void>,
  /** Additional connected Shopify instances (multi-store). See `injectGitHubTools`. */
  extraInstances?: ConnectorInstanceRef[],
  /** Load an extra instance's encoded token tuple. */
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /** Persist a rotated token tuple back to an extra instance. */
  persistInstanceCreds?: (instanceId: string, clientId: string, secret: string) => Promise<void>,
  /** Call-time liveness probe (migration 294). See `injectGitHubTools`. */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
): Promise<void> {
  const shopify = connectors.find((c) => c.connectorId === 'shopify' && c.connected)
  const shopifyEnabled = shopify && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'shopify'))

  if (!shopify || !shopifyEnabled) {
    unavailable?.push(notConnectedNotice('Shopify', 'store products, orders, customers, and inventory'))
    return
  }

  async function loadEncodedTokens(): Promise<string | null> {
    if (credsOverride) return credsOverride()
    const creds = await connectorStore.getCredentials(userId, 'shopify')
    return creds?.client_secret ?? null
  }

  async function persistEncoded(encoded: string): Promise<void> {
    if (persistOverride) {
      await persistOverride(encoded)
      return
    }
    await connectorStore.upsert(userId, {
      connectorId: 'shopify',
      name: 'Shopify',
      connected: true,
      credentials: { client_id: 'shopify_oauth', client_secret: encoded },
    })
  }

  // App credentials (SHOPIFY_CLIENT_ID/SECRET) are only needed to refresh an
  // expiring OAuth token — resolved lazily inside the manager so pasted
  // static tokens work with zero app registration.
  function makeTokenManager(
    load: () => Promise<string | null>,
    persist: (encoded: string) => Promise<void>,
  ) {
    return createShopifyTokenManager({
      getAppConfig: () => getConnectorConfig('shopify'),
      store: {
        async getTokens() {
          const encoded = await load()
          return encoded ? unpackShopifyTokens(encoded) : null
        },
        async persistTokens(tokens) {
          await persist(packShopifyTokens(tokens))
        },
      },
    })
  }

  function buildTools(tm: ReturnType<typeof makeTokenManager>): Tool[] {
    return gateToolsOnActionGrants(createShopifyTools({
      getShop: async () => getShopifyShop(await tm.getAuth()),
      listProducts: async (params) => listShopifyProducts(await tm.getAuth(), params),
      getProduct: async (productId) => getShopifyProduct(await tm.getAuth(), productId),
      listOrders: async (params) => listShopifyOrders(await tm.getAuth(), params),
      getOrder: async (orderId) => getShopifyOrder(await tm.getAuth(), orderId),
      searchCustomers: async (params) => searchShopifyCustomers(await tm.getAuth(), params),
      getCustomer: async (customerId) => getShopifyCustomer(await tm.getAuth(), customerId),
      getInventoryLevels: async (params) => getShopifyInventoryLevels(await tm.getAuth(), params),
      listCollections: async (params) => listShopifyCollections(await tm.getAuth(), params),
      listDraftOrders: async (params) => listShopifyDraftOrders(await tm.getAuth(), params),
      listDiscounts: async (params) => listShopifyDiscounts(await tm.getAuth(), params),
      listAbandonedCheckouts: async (params) => listShopifyAbandonedCheckouts(await tm.getAuth(), params),
      getPayoutsSummary: async (params) => getShopifyPayoutsSummary(await tm.getAuth(), params),
      listDisputes: async (params) => listShopifyDisputes(await tm.getAuth(), params),
      listContent: async (params) => listShopifyContent(await tm.getAuth(), params),
      fetchOrdersRange: async (params) => fetchShopifyOrdersRange(await tm.getAuth(), params),
      updateProduct: async (params) => updateShopifyProduct(await tm.getAuth(), params),
      createProduct: async (params) => createShopifyProduct(await tm.getAuth(), params),
      createDraftOrder: async (params) => createShopifyDraftOrder(await tm.getAuth(), params),
      sendDraftOrderInvoice: async (draftOrderId) => sendShopifyDraftOrderInvoice(await tm.getAuth(), draftOrderId),
      addTags: async (resource, resourceId, tags) => addShopifyTags(await tm.getAuth(), resource, resourceId, tags),
      updateCustomer: async (params) => updateShopifyCustomer(await tm.getAuth(), params),
      setInventoryQuantity: async (params) => setShopifyInventoryQuantity(await tm.getAuth(), params),
      createFulfillment: async (params) => createShopifyFulfillment(await tm.getAuth(), params),
      createDiscountCode: async (params) => createShopifyDiscountCode(await tm.getAuth(), params),
      createContent: async (params) => createShopifyContent(await tm.getAuth(), params),
      cancelOrder: async (params) => cancelShopifyOrder(await tm.getAuth(), params),
      refundOrder: async (params) => refundShopifyOrder(await tm.getAuth(), params),
      completeDraftOrder: async (params) => completeShopifyDraftOrder(await tm.getAuth(), params),
    }), 'shopify', assistantConnectorGrantsStore, assistantId)
  }

  const primaryInstanceId = healthProbe?.instanceId ?? (shopify as { id?: string }).id ?? null
  try {
    const built = buildTools(makeTokenManager(loadEncodedTokens, persistEncoded))
    const shopifyTools = healthProbe && primaryInstanceId
      ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
      : built

    for (const tool of shopifyTools) {
      if (await applyPolicyOrSkip(tool, 'shopify', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }

    // Extra stores → label-qualified variant tool sets, each with its own
    // token manager bound to its own instance row.
    if (!credsOverride && extraInstances?.length && resolveInstanceCreds && persistInstanceCreds) {
      await injectInstanceVariants({
        provider: 'shopify',
        extras: extraInstances,
        settingsStore, assistantId, userId, tools,
        buildToolsForInstance: (inst) => {
          const variant = buildTools(makeTokenManager(
            () => resolveInstanceCreds(inst.id),
            (encoded) => persistInstanceCreds(inst.id, 'shopify_oauth', encoded),
          ))
          return healthProbe ? wrapToolsWithHealthProbe(variant, inst.id, healthProbe.report) : variant
        },
      })
    }

    console.debug(`[mcp-inject] Shopify: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra store(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] Shopify injection failed:', err)
  }
}

// ── Company mailbox (imap) injection ──────────────────────────
//
// The USER'S own corporate mailbox (mailbox-imap.md) — the third identity
// lane beside gmail (the user's Google account) and agentmail (the
// assistant's own address). Single account per user (D11, `single_instance`
// in the registry). Credentials are the typed `type:'imap'` blob on the
// user-scoped connector_instance; `imapSendMessage` reuses the Gmail
// governance chain verbatim: `ask` classification + write-grant gate
// (registry-derived), the connector_actions `send_email` audit with the
// payload-classifier preflight before the network call, and the
// confidential-turn egress refusal inside the core tool.

async function injectMailboxTools(params: {
  connectors: Array<{ connectorId: string; connected: boolean; id?: string; createdAt?: Date; name?: string }>
  settingsStore: McpSettingsStore
  userId: string
  assistantId: string
  assistantConnectorStore: AssistantConnectorStore | undefined
  tools: Map<string, Tool>
  unavailable?: string[]
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  connectorActionAudit?: ConnectorActionAudit
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /** Grant-overlay path: bind to this EXACT exposed instance id. */
  instanceIdOverride?: string | null
  healthProbe?: { report: HealthReporter }
}): Promise<void> {
  const {
    connectors, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable,
    connectorInstanceStore, connectorActionAudit, assistantConnectorGrantsStore, instanceIdOverride, healthProbe,
  } = params

  const imapConnectors = connectors.filter((c) => c.connectorId === 'imap' && c.connected)
  const imapEnabled = imapConnectors.length > 0 && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'imap'))
  if (!imapEnabled) {
    unavailable?.push(notConnectedNotice('Company email (IMAP)', "searching, reading, and sending from the user's own corporate mailbox"))
    return
  }
  if (!connectorInstanceStore) return  // credentials live only on the instance row — nothing to bind
  const store = connectorInstanceStore

  // Which instances to bind. The grant overlay pins ONE exposed instance
  // (`instanceIdOverride`, same one-per-provider limit every other connector's
  // grant overlay has); the base path binds EVERY connected mailbox — this is
  // the multi-account surface (D11 retired), the AgentMail `fromInbox` router
  // ported. Primary = first-connected (createdAt asc): the default when the
  // model omits `account`.
  const rows = (instanceIdOverride
    ? imapConnectors.filter((c) => c.id === instanceIdOverride)
    : [...imapConnectors])
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))

  // Health rides at the API level, per instance, so a mailbox whose auth died
  // flips ITS OWN row — never a sibling's — and the read-only archive tool
  // (built below) stays outside it. Mirrors `wrapToolsWithHealthProbe`'s
  // auth-error classification.
  const withHealth = (raw: MailboxApi, instanceId: string): MailboxApi => {
    if (!healthProbe) return raw
    const report = healthProbe.report
    const guard = async <R>(op: () => Promise<R>): Promise<R> => {
      try {
        const r = await op()
        report(instanceId, 'ok')
        return r
      } catch (err) {
        if (classifyConnectorAuthError(err)) report(instanceId, 'auth_failed', err instanceof Error ? err.message : String(err))
        throw err
      }
    }
    return {
      searchMessages: (p) => guard(() => raw.searchMessages(p)),
      getMessage: (id) => guard(() => raw.getMessage(id)),
      sendMessage: (p) => guard(() => raw.sendMessage(p)),
    }
  }

  // Audit-wrapped send (the Gmail pattern): classifier preflight decides
  // BEFORE the network call; executed/failed both audit. v1
  // `audienceClearance='public'` for all recipients, like gmail. `from` is the
  // sending mailbox (the resolved account), not null — the multi-account audit.
  const withAudit = (raw: MailboxApi, fromEmail: string): MailboxApi => ({
    searchMessages: (p) => raw.searchMessages(p),
    getMessage: (id) => raw.getMessage(id),
    sendMessage: async (p) => {
      const auditPayload = {
        to: p.to,
        from: fromEmail,
        subject: p.subject,
        has_body: Boolean(p.body),
        body_length: p.body?.length ?? 0,
        body: p.body ?? '',
        in_reply_to: p.inReplyTo ?? null,
      }
      let preflight: ConnectorActionPreflight | undefined
      if (connectorActionAudit) {
        preflight = connectorActionAudit.preflight({ audienceClearance: 'public', payload: auditPayload })
        if (preflight.shouldDeny) {
          try {
            await connectorActionAudit.emit(
              { userId, assistantId },
              { connectorId: 'imap', actionKind: 'send_email', audienceClearance: 'public', status: 'denied', payload: auditPayload, preflight },
            )
          } catch (auditErr) {
            console.warn('[mcp-inject] imap classifier-deny audit emit failed:', auditErr instanceof Error ? auditErr.message : String(auditErr))
          }
          throw new Error(
            `This email contains content the classifier blocked (matched patterns: ${preflight.classifierMatches.join(', ')}). Revise the message and try again.`,
          )
        }
      }
      try {
        const result = await raw.sendMessage(p)
        if (connectorActionAudit) {
          try {
            await connectorActionAudit.emit(
              { userId, assistantId },
              { connectorId: 'imap', actionKind: 'send_email', audienceClearance: 'public', status: 'executed', externalId: result.messageId, payload: auditPayload, preflight },
            )
          } catch (auditErr) {
            console.warn('[mcp-inject] imap connector_action audit emit failed (best-effort, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
          }
        }
        return result
      } catch (err) {
        if (connectorActionAudit) {
          try {
            await connectorActionAudit.emit(
              { userId, assistantId },
              {
                connectorId: 'imap', actionKind: 'send_email', audienceClearance: 'public', status: 'failed',
                payload: { ...auditPayload, error: err instanceof Error ? err.message : String(err) },
                preflight,
              },
            )
          } catch (auditErr) {
            console.warn('[mcp-inject] imap connector_action audit emit failed (failure path, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
          }
        }
        throw err
      }
    },
  })

  try {
    // Build a bound MailboxApi per connected mailbox + resolve its
    // authoritative email (the value the model passes as `account`; the label
    // can be renamed so it is NOT the identity). A creds-missing instance is
    // skipped rather than surfaced as a dead tool.
    const bound: Array<{ instanceId: string; email: string; api: MailboxApi }> = []
    for (const row of rows) {
      const instanceId = row.id ?? instanceIdOverride ?? null
      if (!instanceId) continue
      let email: string
      try {
        const creds = await store.getAuthCredentialsSystem(instanceId)
        if (!creds || creds.type !== 'imap') continue
        email = creds.email
      } catch { continue }
      const boundId = instanceId
      const getSettings = async (): Promise<MailboxAccountSettings> => {
        const creds = await store.getAuthCredentialsSystem(boundId)
        if (!creds || creds.type !== 'imap') {
          throw new Error('Company mailbox is not connected (no imap credentials on the instance)')
        }
        const { type: _t, ...settings } = creds
        return settings
      }
      const rawApi = createMailboxApi({ cacheKey: boundId, getSettings })
      bound.push({ instanceId: boundId, email, api: withHealth(withAudit(rawApi, email), boundId) })
    }
    if (bound.length === 0) {
      unavailable?.push(notConnectedNotice('Company email (IMAP)', "searching, reading, and sending from the user's own corporate mailbox"))
      return
    }

    // One tool set over an account router — primary (first-connected) is the
    // default sender; `account` selects a sibling by email.
    const router: MailboxAccountRouter = {
      list: () => bound.map((b, i) => ({ email: b.email, isPrimary: i === 0 })),
      get: (email) => bound.find((b) => b.email.trim().toLowerCase() === email.trim().toLowerCase())?.api,
    }
    const built = gateToolsOnActionGrants(createMailboxTools(router), 'imap', assistantConnectorGrantsStore, assistantId)

    // Archive search (Phase 2) — injected only when boot wired the archive
    // seam (DB + embedder). Read-only; a DB search must not flip connector
    // health, so it rides OUTSIDE the per-instance api health wrap. Owner + the
    // instance set are bound here, never model inputs.
    const archiveDeps = getGlobalMailboxArchiveDeps()
    const withArchive = archiveDeps
      ? [
          ...built,
          createSearchEmailArchiveTool({
            ownerUserId: userId,
            accounts: bound.map((b, i) => ({ instanceId: b.instanceId, email: b.email, isPrimary: i === 0 })),
            deps: archiveDeps,
          }),
        ]
      : built

    // On-demand sync (sync-on-connect's twin) — injected only when boot wired
    // the sync seam. Same bound account set as the archive tool; the instance
    // is bound here, never a model input.
    const syncDeps = getGlobalMailboxSyncDeps()
    const withSync = syncDeps
      ? [
          ...withArchive,
          createSyncMailboxNowTool({
            accounts: bound.map((b, i) => ({ instanceId: b.instanceId, email: b.email, isPrimary: i === 0 })),
            deps: syncDeps,
          }),
        ]
      : withArchive
    for (const tool of withSync) {
      if (await applyPolicyOrSkip(tool, 'imap', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }
    console.debug(`[mcp-inject] Company mailbox (imap): injected tools for ${bound.length} mailbox(es)`)
  } catch (err) {
    console.error('[mcp-inject] Company mailbox (imap) injection failed:', err)
  }
}

// ── Assistant Email (agentmail) injection ─────────────────────
//
// The assistant's OWN mailbox tools (agentmail.md → "Connector tools").
// One tool set covers every workspace inbox (decision D1): the tools take an
// optional `fromInbox` and default to the workspace's first (oldest) inbox.
// Sends and drafts reuse the Gmail governance chain — `ask` classification
// (OFFICIAL_CONNECTOR_TOOLS), the connector_actions audit + payload
// classifier preflight here, and the confidential-turn egress refusal inside
// the core tool.

async function injectAgentmailTools(params: {
  provider: EmailInboxProvider
  /** Workspace inboxes, oldest first — the first is the default sender. */
  inboxes: Array<{ address: string }>
  settingsStore: McpSettingsStore
  userId: string
  assistantId: string
  tools: Map<string, Tool>
  unavailable?: string[]
  connectorActionAudit?: ConnectorActionAudit
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
}): Promise<void> {
  const { provider, inboxes, settingsStore, userId, assistantId, tools, unavailable, connectorActionAudit, assistantConnectorGrantsStore } = params

  const auditedEgress = async <T>(
    actionKind: 'send_email' | 'draft_email',
    payload: Record<string, unknown>,
    run: () => Promise<T>,
    externalIdOf: (result: T) => string | null,
  ): Promise<T> => {
    let preflight: ConnectorActionPreflight | undefined
    if (connectorActionAudit) {
      preflight = connectorActionAudit.preflight({ audienceClearance: 'public', payload })
      if (preflight.shouldDeny) {
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            { connectorId: 'agentmail', actionKind, audienceClearance: 'public', status: 'denied', payload, preflight },
          )
        } catch (auditErr) {
          console.warn('[mcp-inject] agentmail classifier-deny audit emit failed:', auditErr instanceof Error ? auditErr.message : String(auditErr))
        }
        throw new Error(
          `This email contains content the classifier blocked (matched patterns: ${preflight.classifierMatches.join(', ')}). Revise the message and try again.`,
        )
      }
    }
    try {
      const result = await run()
      if (connectorActionAudit) {
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            { connectorId: 'agentmail', actionKind, audienceClearance: 'public', status: 'executed', externalId: externalIdOf(result), payload, preflight },
          )
        } catch (auditErr) {
          console.warn('[mcp-inject] agentmail connector_action audit emit failed (best-effort, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
        }
      }
      return result
    } catch (err) {
      if (connectorActionAudit) {
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            {
              connectorId: 'agentmail', actionKind, audienceClearance: 'public', status: 'failed',
              payload: { ...payload, error: err instanceof Error ? err.message : String(err) },
              preflight,
            },
          )
        } catch (auditErr) {
          console.warn('[mcp-inject] agentmail connector_action audit emit failed (failure path, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
        }
      }
      throw err
    }
  }

  const api: AgentmailToolApi = {
    async listInboxes() {
      return inboxes.map((inbox, i) => ({ address: inbox.address, isDefault: i === 0 }))
    },
    async send(p) {
      const payload = {
        from: p.inboxAddress,
        to: p.to,
        cc: p.cc ?? [],
        bcc: p.bcc ?? [],
        subject: p.subject,
        has_body: Boolean(p.body),
        body_length: p.body.length,
        body: p.body,
      }
      // The model composes `body` in markdown; render the
      // multipart/alternative pair at this egress boundary (the audit
      // payload above keeps the raw markdown for the classifier).
      const rendered = renderEmailBody(p.body)
      return auditedEgress(
        'send_email',
        payload,
        () =>
          provider.sendMessage(p.inboxAddress, {
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            subject: p.subject,
            text: rendered.text,
            html: rendered.html,
          }),
        (r) => r.messageId,
      )
    },
    async searchThreads(p) {
      const result = await provider.listThreads(p.inboxAddress, {
        limit: p.limit,
        senders: p.senders,
        subject: p.subjectContains,
      })
      // Projection (connector-result rule): documented fields only, never
      // raw vendor JSON.
      return result.threads.map((t) => ({
        threadId: t.threadId,
        inbox: t.inboxId,
        subject: t.subject,
        preview: t.preview,
        senders: t.senders,
        timestamp: t.timestamp,
        messageCount: t.messageCount,
      }))
    },
    async createDraft(p) {
      const payload = {
        from: p.inboxAddress,
        to: p.to,
        cc: p.cc ?? [],
        bcc: p.bcc ?? [],
        subject: p.subject,
        has_body: Boolean(p.body),
        body_length: p.body.length,
        body: p.body,
        send_at: p.sendAt ?? null,
      }
      // Same markdown → text+html rendering as send — a draft (scheduled or
      // human-sent) leaves as the exact bodies stored here.
      const rendered = renderEmailBody(p.body)
      const draft = await auditedEgress(
        'draft_email',
        payload,
        () =>
          provider.createDraft(p.inboxAddress, {
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            subject: p.subject,
            text: rendered.text,
            html: rendered.html,
            sendAt: p.sendAt,
            inReplyTo: p.inReplyTo,
          }),
        (r) => r.draftId,
      )
      return { draftId: draft.draftId, sendAt: draft.sendAt }
    },
  }

  try {
    for (const tool of gateToolsOnActionGrants(createAgentmailTools(api), 'agentmail', assistantConnectorGrantsStore, assistantId)) {
      if (await applyPolicyOrSkip(tool, 'agentmail', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }
    console.debug(`[mcp-inject] Assistant Email: injected tools over ${inboxes.length} inbox(es)`)
  } catch (err) {
    console.error('[mcp-inject] Assistant Email injection failed:', err)
  }
}
