/**
 * Brain MCP server — tool surface.
 *
 * Feature-complete bridge over the structured brain. Every write tool here
 * is the chat-side `Tool` instance, wrapped in a per-request adapter — same
 * RLS, same analytics, same audit trail.
 *
 * Spec: docs/architecture/features/programmatic-access.md → "Tool wiring".
 *
 * Read surface (both scopes):
 *   - searchBrain   → bridged `createRetrievalTools.search`, scope-filtered
 *                      across memory/task/contact/company/deal/file/kb_chunk/entity
 *   - getMemory     → bridged `createMemoryTools.getMemory`
 *   - getTask / listTasks
 *   - getContact / listContacts
 *   - getCompany / listCompanies
 *   - getDeal     / listDeals
 *   - fileRead / fileSearch  → bridged `createFileTools` (workspace filesystem)
 *
 * Write surface (`read_write` keys only):
 *   - saveMemory  / deleteMemory
 *   - saveTask    / updateTask / closeTask / reopenTask
 *   - saveContact / updateContact
 *   - saveCompany / updateCompany
 *   - saveDeal    / updateDeal / advanceDealStage
 *   - fileWrite / fileAppend / fileSetMeta / fileDelete
 *   - saveFileToBrain / saveFileBytes
 *
 * The file tools are present only when the deployment has a blob client
 * configured (`opts.fileTools` set); a files-less deploy simply omits them.
 * Both byte-preserving saves bridge: `saveFileToBrain` by REFERENCE (it takes
 * a cache `fileId` — the bytes already entered via the HTTP upload route, not
 * over MCP), and `saveFileBytes` by VALUE (the caller supplies raw bytes as
 * base64, size-capped in the tool). Authoring text (`fileWrite`) bridges
 * cleanly too. Only `sendFile` stays unbridged — it attaches a document to a
 * chat reply, and the MCP surface has no chat channel to deliver on (the tool
 * would error on its missing-collector gate anyway).
 *
 * Deprecated aliases retained for one cycle:
 *   - ingestToBrain   → thin wrapper over saveMemory (legacy schema)
 *   - searchKnowledge → thin wrapper over searchBrain (scope='kb_chunk')
 *
 * Component tag: [COMP:api/brain-mcp].
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  SensitivityAccumulator,
  isSensitivity,
  minSensitivity,
  applyOps,
  buildUndoEntry,
  markdownToBlocks,
  normalizeMarkdownBlocks,
  pageToMarkdown,
  rankPagesByTitle,
  listPageTemplates,
  instantiatePageTemplate,
  pageTemplateIds,
  withFreshBlockIds,
  PAGE_TEMPLATE_CATEGORIES,
  pageTemplateCategorySchema,
} from '@sidanclaw/core'
import type {
  BindingConfig,
  Block,
  DocPageStore,
  Op,
  Page,
  PipelineBResult,
  SavedViewStore,
  Sensitivity,
  Tool,
  ToolContext,
  Embedder,
} from '@sidanclaw/core'
import { query } from '../db/client.js'
import { searchRecording as searchRecordingFn, readRecordingRange, type RecordingSegmentHit } from '../db/retrieval-store.js'
import { searchFileSegments as searchFileSegmentsFn, readFileSegmentRange, type FileSegmentHit } from '../db/retrieval-store.js'
import type { BrainKeyScope } from '../db/brain-keys-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import { toEpisodeSensitivity } from '../episode-sensitivity.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { BRAIN_WRITE_TOOL_SIGNALS, notifyBrainChange } from '../brain-stream/notify.js'

/**
 * Best-effort row id extraction from a chat-tool result. Most write tools
 * return either a primitive id string or a JSON-shaped object with one of
 * `id`, `memoryId`, `taskId`, `contactId`, `companyId`, `dealId`. When none
 * match, the NOTIFY ships without `rowId` and the client refetches the list.
 */
function extractRowId(data: unknown): string | undefined {
  if (typeof data === 'string') {
    const trimmed = data.trim()
    // Try JSON-first since most chat tools serialize objects.
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        return extractRowId(parsed)
      } catch {
        // fall through to bare-string handling
      }
    }
    // Bare UUID-shaped string is rare but supported.
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
      ? trimmed
      : undefined
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['id', 'memoryId', 'taskId', 'contactId', 'companyId', 'dealId', 'rowId']) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

/**
 * Chat-side task tool set, reused as boot-time singletons. Brain-key task
 * writes emit the same analytics events as chat writes because the chat
 * tools' `onEvent` reads from the per-call `ToolContext` the bridge fills in
 * (channelType: 'programmatic', sessionId: 'brain-key:<id>').
 */
export type BrainTaskTools = {
  saveTask: Tool
  getTask: Tool
  listTasks: Tool
  updateTask: Tool
  closeTask: Tool
  reopenTask: Tool
}

export type BrainMemoryTools = {
  saveMemory: Tool
  getMemory: Tool
  deleteMemory: Tool
}

export type BrainCrmTools = {
  saveContact: Tool
  getContact: Tool
  listContacts: Tool
  updateContact: Tool
  saveCompany: Tool
  getCompany: Tool
  listCompanies: Tool
  updateCompany: Tool
  saveDeal: Tool
  getDeal: Tool
  listDeals: Tool
  updateDeal: Tool
  advanceDealStage: Tool
}

export type BrainRetrievalTools = {
  search: Tool
  getEntity: Tool
}

/**
 * Workspace filesystem tools from `createFileTools`. Optional on `BuildOpts`:
 * present only when the deployment has a blob client (GCS / local-disk), so a
 * files-less deploy omits the file surface entirely rather than exposing tools
 * whose backing API is null. Includes both byte-preserving saves —
 * `saveFileToBrain` (promotes a cached upload by id) and `saveFileBytes`
 * (persists base64 bytes the caller supplies). Only `sendFile` is excluded
 * (no chat channel to deliver on).
 */
export type BrainFileTools = {
  fileWrite: Tool
  fileAppend: Tool
  fileRead: Tool
  fileSearch: Tool
  fileSetMeta: Tool
  fileDelete: Tool
  saveFileToBrain: Tool
  saveFileBytes: Tool
}

/**
 * Doc-page stores for the brain MCP page surface (`readPage` / `editPage` /
 * `deletePage`). Optional on `BuildOpts` — a deploy that doesn't build the doc
 * stores omits the whole page surface rather than exposing tools with no
 * backing store (mirrors `BrainFileTools`). Both stores are the SAME concrete
 * singletons the chat-side doc tools use (`createDbSavedViewStore` /
 * `createDbDocPageStore`), so a brain-key page read/edit/delete runs through
 * the identical RLS-gated SQL — `queryWithRLS(userId, …)` keyed on the
 * resolved (owner, primary-assistant) principal — and `editPage` reuses the
 * very CAS + undo-capture path the chat editor's `patchPage` uses.
 *
 *   - `savedViewStore` — `list` (title search + `listPages` enumeration) +
 *     `remove` (RLS delete; the `saved_views` FK cascade drops nested child
 *     pages, per migration 210) + `createDraft` (the `createPage` seam) +
 *     `getById` (resolve + workspace-confirm a `createPage` `parentPageId`
 *     before nesting under it — same parent guard the chat `createSubPage`
 *     tool runs).
 *   - `docPageStore`   — `getVersionedPage` (RLS read → markdown / access
 *     confirm) + `applyPatch` (atomic version CAS + `last_undo` capture).
 */
export type BrainDocTools = {
  savedViewStore: Pick<SavedViewStore, 'list' | 'remove' | 'createDraft' | 'getById'>
  docPageStore: Pick<DocPageStore, 'getVersionedPage' | 'applyPatch'>
  /**
   * Custom page templates (migration 281). When wired, `listPageTemplates`
   * also surfaces the workspace's custom templates, `createPageFromTemplate`
   * resolves a custom template id (a uuid) to its stored blocks, and
   * `createPageTemplate` persists a new workspace template. Optional — a
   * deploy without the store still serves the built-in catalog (read +
   * instantiate), but `createPageTemplate` (no built-in fallback) is omitted.
   */
  pageTemplateStore?: Pick<PageTemplateStore, 'list' | 'getById' | 'create'>
}

/** Cap on `readPage` title-search matches surfaced to the agent. */
const READ_PAGE_MAX_MATCHES = 10
/** `listPages`: default row count, and the hard cap a caller can request. */
const LIST_PAGES_DEFAULT = 50
const LIST_PAGES_MAX = 200
/** Cap on a page's Markdown body so one huge page can't blow the MCP reply. */
const READ_PAGE_MARKDOWN_CAP = 16_000
/** Cap on `editPage` content so a single edit can't balloon the page row. */
const MAX_EDIT_CHARS = 32_000

/**
 * The historical fixed clearance ceiling for a programmatic credential.
 * Since migration 262 the brain MCP binds to the workspace's PRIMARY
 * assistant and reads at `effectiveBrainClearance(primary.clearance,
 * key.max_clearance)` — this constant survives as (a) the OAuth-token cap
 * (oauth_authorizations has no per-grant override yet), (b) the pre-262
 * backfill value, and (c) the defensive fallback when the bound assistant
 * row carries no parseable clearance. See programmatic-access.md →
 * "Permissions & clearance" and the agent-facing-capability-surface plan §12.1.
 */
export const BRAIN_KEY_CLEARANCE: Sensitivity = 'internal'

/**
 * Effective read/write clearance for a brain-MCP call: the bound (primary)
 * assistant's clearance, capped by the key's `max_clearance` when set.
 * NULL cap = the primary's clearance governs (the new-key default).
 */
export function effectiveBrainClearance(
  assistantClearance: Sensitivity,
  maxClearance: Sensitivity | null,
): Sensitivity {
  return maxClearance ? minSensitivity(assistantClearance, maxClearance) : assistantClearance
}

const MAX_INGEST_CHARS = 16_000

export type BrainTool = {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
}

type BuildOpts = {
  workspaceId: string
  scope: BrainKeyScope
  /** The authenticating key's id — recorded as provenance on writes. */
  keyId: string
  /**
   * Per-credential clearance cap from auth (`brain_keys.max_clearance`, or
   * the fixed 'internal' for OAuth tokens). NULL = the bound primary
   * assistant's clearance governs. See `effectiveBrainClearance`.
   */
  maxClearance: Sensitivity | null
  /**
   * The shared agent capability toolset (agent-facing capability surface
   * §3/§4) — Tier-1 control-plane/bridge reads and Tier-2 configure-gated
   * writes. Reads are exposed on both key scopes; writes only when the key
   * is `read_write` AND `agentWritesEnabled` (the bound primary assistant
   * holds the `configure` grant — resolved by the server before build).
   */
  agentTools?: { reads: Map<string, Tool>; writes: Map<string, Tool> }
  /** Pre-resolved configure gate for this request (see `resolveAgentGate`). */
  agentWritesEnabled?: boolean
  memoryTools: BrainMemoryTools
  taskTools: BrainTaskTools
  crmTools: BrainCrmTools
  retrievalTools: BrainRetrievalTools
  /**
   * Query embedder for the dedicated `searchRecording` tool's vector arm
   * (recording-to-brain). Optional — without it, recording retrieval degrades
   * to keyword (ILIKE) search, which still works (and works before a
   * recording's segments are embedded). See db/retrieval-store.ts → searchRecording.
   */
  embedder?: Pick<Embedder, 'embed'>
  /**
   * Workspace filesystem tools. Optional — omitted on deployments without a
   * blob client, where the file primitive has no backing store. When absent,
   * `buildBrainTools` exposes no file tools.
   */
  fileTools?: BrainFileTools
  /**
   * Programmatic ingest entry to Pipeline B. When wired, `ingestToBrain` in its
   * default (`decompose: true`) mode materializes an Episode and runs the brain
   * extraction pipeline — entities / edges / memories / tasks — instead of a flat
   * memory write. Omitted in files-less / test builds, where `ingestToBrain`
   * falls back to the direct `saveMemory` path. Boot-built in
   * `apps/api/src/index.ts` via `createBrainEpisodeIngestor`.
   */
  ingest?: BrainEpisodeIngestor
  /**
   * Doc-page stores for the `readPage` / `editPage` / `deletePage` surface.
   * Optional — a deploy that omits it exposes no page tools (mirrors
   * `fileTools`). `readPage` rides both key scopes; `editPage` / `deletePage`
   * are write tools (`read_write` keys only). See `BrainDocTools`.
   */
  docTools?: BrainDocTools
}

/**
 * Tool names a `read` brain key can call. Every other tool is omitted from
 * `tools/list` and rejected on `tools/call`.
 */
const READ_TOOL_NAMES = new Set<string>([
  // Unified read
  'searchBrain',
  // Scoped single-recording retrieval (recording-to-brain)
  'searchRecording',
  // Scoped single-file retrieval (large-content-artifacts)
  'searchFileContent',
  // Deprecated read alias
  'searchKnowledge',
  // Entity read + edge discovery
  'getEntity',
  // Per-primitive single-row fetches and list filters
  'getMemory',
  'getTask',
  'listTasks',
  'getContact',
  'listContacts',
  'getCompany',
  'listCompanies',
  'getDeal',
  'listDeals',
  // Workspace files (read) — present only when fileTools are wired
  'fileRead',
  'fileSearch',
  // Doc pages (read) — present only when docTools are wired
  'readPage',
  'listPages',
  'listPageTemplates',
])

function text(body: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: body }],
    ...(isError ? { isError: true } : {}),
  }
}

/** Truncate a page's Markdown export so one large page can't blow the reply. */
function capPageMarkdown(md: string): string {
  if (md.length <= READ_PAGE_MARKDOWN_CAP) return md
  return `${md.slice(0, READ_PAGE_MARKDOWN_CAP)}\n\n…[truncated — read a smaller page or narrow the request]`
}

/**
 * Build the doc-page tools (`readPage` / `editPage` / `deletePage`). All three
 * resolve the per-request principal via `resolveCtx` and pass its `userId`
 * straight into the RLS-gated stores, so a brain-key page op is confined to the
 * key's workspace + the bound primary assistant's clearance exactly like every
 * other bridged tool. `readPage` is a read tool (both scopes); `editPage` /
 * `deletePage` are writes (filtered to `read_write` keys by `buildBrainTools`).
 *
 * Reuse, not reinvention:
 *   - `readPage`   → `rankPagesByTitle` (the `findPage` matcher) + `pageToMarkdown`
 *                    (the `exportPage` / `findPage` page-to-Markdown path).
 *   - `listPages`  → the same RLS-scoped `savedViewStore.list`, filtered by an
 *                    optional case-insensitive `titlePrefix` and recency-ranked.
 *   - `editPage`   → builds an `Op[]` and runs it through `applyOps` +
 *                    `docPageStore.applyPatch` — the same validated CAS +
 *                    `last_undo` capture the chat editor's `patchPage` uses.
 *   - `deletePage` → confirms RLS-scoped access via `getVersionedPage`, then
 *                    `savedViewStore.remove` (RLS `DELETE`; the `saved_views`
 *                    FK cascade drops nested child pages per migration 210).
 *   - `listPageTemplates` (read) + `createPageFromTemplate` (write) → the
 *                    shared Notion-style template catalog (`@sidanclaw/core`
 *                    `listPageTemplates` / `instantiatePageTemplate`). The
 *                    create path reuses the same `createDraft` seam as
 *                    `createPage`, seeding the page with the template's blocks
 *                    + icon. See docs/architecture/features/doc-templates.md.
 *   - `createPageTemplate` (write) → persists a NEW workspace custom template
 *                    (`pageTemplateStore.create`, migration 281) from a Markdown
 *                    body parsed with the same `markdownToBlocks` +
 *                    `normalizeMarkdownBlocks` path. Present only when the
 *                    optional `pageTemplateStore` is wired (no built-in
 *                    fallback). See doc-templates.md → "Custom templates".
 *
 * Spec pointer (file is OSS, not present in this repo):
 * docs/architecture/integrations/mcp.md → brain MCP page tools.
 */
function buildDocPageTools(
  docTools: BrainDocTools,
  resolveCtx: () => Promise<ToolContext | { error: string }>,
  workspaceId: string,
): {
  readPage: BrainTool
  listPages: BrainTool
  editPage: BrainTool
  deletePage: BrainTool
  createPage: BrainTool
  listPageTemplates: BrainTool
  createPageFromTemplate: BrainTool
  createPageTemplate: BrainTool
} {
  const { savedViewStore, docPageStore, pageTemplateStore } = docTools

  const readPage: BrainTool = {
    name: 'readPage',
    description:
      'Read a workspace doc page as Markdown. Pass `pageId` to read a specific ' +
      'page, or `title` to find one by name (case-insensitive, ranked by ' +
      'closeness). When several pages match a `title`, the call returns the ' +
      'ranked list (each `{ pageId, title }`) WITHOUT content — pick one and ' +
      're-call with its `pageId`. When exactly one matches, its Markdown body ' +
      "is returned directly. Scoped to the key's workspace and clearance — a " +
      'page you cannot access reads as not-found.',
    inputSchema: {
      pageId: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('Read one specific page by id (e.g. a `pageId` from a prior search).'),
      title: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('Find a page by title (or partial title). Omit when reading by `pageId`.'),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : ''
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!pageId && !title) {
        return text('Pass `pageId` to read a page, or `title` to search by name.', true)
      }

      // Read-by-id: RLS hides cross-workspace rows, so a null read is both
      // "not found" and "no access" — never leak which.
      if (pageId) {
        const current = await docPageStore.getVersionedPage(ctx.userId, pageId)
        if (!current) {
          return text(`Page not found: ${pageId}. It may not exist or you may not have access.`, true)
        }
        return text(capPageMarkdown(pageToMarkdown(current.page, current.title)))
      }

      // Search-by-title: RLS-scoped list, then the shared title ranker.
      const rows = await savedViewStore.list({ userId: ctx.userId, workspaceId, state: 'all' })
      const matches = rankPagesByTitle(rows, title, READ_PAGE_MAX_MATCHES)
      if (matches.length === 0) {
        return text(`No page matches "${title}". It may not exist or you may not have access.`)
      }
      if (matches.length === 1) {
        const current = await docPageStore.getVersionedPage(ctx.userId, matches[0].id)
        if (!current) {
          return text(`Page not found: ${matches[0].id}. It may not exist or you may not have access.`, true)
        }
        return text(capPageMarkdown(pageToMarkdown(current.page, current.title)))
      }
      const list = matches
        .map((m) => `- ${m.name} (pageId: ${m.id})`)
        .join('\n')
      return text(
        `${matches.length} pages match "${title}". Re-call readPage with the right pageId:\n${list}`,
      )
    },
  }

  // ── listPages ─────────────────────────────────────────────────
  //
  // Enumerate workspace doc pages as `{ pageId, title }` rows — the page
  // analog of `fileSearch`, and the companion `readPage` lacks (it finds at
  // most one page, by title). Reuses the same RLS-scoped `savedViewStore.list`
  // read `readPage`'s title search rides. Saved views carry no tag column, so
  // grouping is by a shared `titlePrefix` (case-insensitive) the caller stamps
  // on related pages — that is how a programmatic writer (e.g. a tool that
  // persists its own plan/record pages) lists just its own. Ids + titles only;
  // call `readPage` with a `pageId` for content.
  const listPages: BrainTool = {
    name: 'listPages',
    description:
      'List workspace doc pages as `{ pageId, title }` rows, most-recently-updated ' +
      'first. Optional `titlePrefix` returns only pages whose title starts with it ' +
      '(case-insensitive) — stamp a shared prefix on related pages to group them. ' +
      `Optional \`limit\` caps the rows (default ${LIST_PAGES_DEFAULT}, max ${LIST_PAGES_MAX}). ` +
      'Returns ids + titles only; call `readPage` with a `pageId` for full content. ' +
      "Scoped to the key's workspace and clearance.",
    inputSchema: {
      titlePrefix: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('Only pages whose title starts with this text (case-insensitive).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_PAGES_MAX)
        .optional()
        .describe(`Max rows to return (default ${LIST_PAGES_DEFAULT}).`),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const prefix = typeof args.titlePrefix === 'string' ? args.titlePrefix.trim().toLowerCase() : ''
      const rawLimit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : LIST_PAGES_DEFAULT
      const limit = Math.min(Math.max(rawLimit, 1), LIST_PAGES_MAX)

      // Same RLS-scoped list readPage's title search uses; ranking here is
      // recency (updatedAt desc) rather than title closeness.
      const rows = await savedViewStore.list({ userId: ctx.userId, workspaceId, state: 'all' })
      const matched = (prefix ? rows.filter((r) => (r.name ?? '').toLowerCase().startsWith(prefix)) : rows)
        .slice()
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit)
      if (matched.length === 0) {
        return text(
          prefix ? `No pages whose title starts with "${args.titlePrefix}".` : 'No pages in this workspace.',
        )
      }
      const list = matched.map((r) => `- ${r.name} (pageId: ${r.id})`).join('\n')
      return text(`${matched.length} page(s):\n${list}`)
    },
  }

  const editPage: BrainTool = {
    name: 'editPage',
    description:
      'Edit an existing workspace doc page. Two modes: `mode: "append"` adds ' +
      'your Markdown `content` to the END of the page, `mode: "replace"` ' +
      'replaces the entire page body with `content` (the title is kept). ' +
      'Content is parsed as Markdown into the page block format. The edit goes ' +
      'through the same validated, version-checked path the in-app editor uses ' +
      '(atomic compare-and-swap with single-step undo capture), so a concurrent ' +
      'edit is detected and reported rather than silently clobbered. Scoped to ' +
      "the key's workspace and clearance.",
    inputSchema: {
      pageId: z.string().min(1).max(128).describe('The id of the page to edit.'),
      content: z
        .string()
        .min(1)
        .max(MAX_EDIT_CHARS)
        .describe('Markdown content to append, or to replace the whole body with.'),
      mode: z
        .enum(['append', 'replace'])
        .optional()
        .describe('`append` (default) adds to the end; `replace` swaps the entire body.'),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : ''
      const content = typeof args.content === 'string' ? args.content : ''
      const mode = args.mode === 'replace' ? 'replace' : 'append'
      if (!pageId) return text('Provide a `pageId` to edit.', true)
      if (!content.trim()) return text('Provide non-empty `content`.', true)

      // 1. RLS-scoped read confirms access AND gives the CAS base version.
      //    Never trust the input id without this — a null read is no-access.
      const current = await docPageStore.getVersionedPage(ctx.userId, pageId)
      if (!current) {
        return text(`Page not found: ${pageId}. It may not exist or you may not have access.`, true)
      }

      // 2. Build the new block list from the Markdown content. `replace`
      //    swaps the whole body; `append` keeps existing blocks and adds the
      //    new ones. `normalizeMarkdownBlocks` runs the same expansion the
      //    chat path applies so inline Markdown lands as canonical blocks.
      const newBlocks = normalizeMarkdownBlocks(markdownToBlocks(content))
      if (newBlocks.length === 0) {
        return text('The content produced no blocks — provide some Markdown text.', true)
      }

      // 3. Express the change as the canonical `Op[]`: replace = delete every
      //    existing block then append the new ones; append = just add. Running
      //    it through `applyOps` (the same engine `patchPage` uses) gives us a
      //    validated working copy + the inverse for single-step undo.
      const ops: Op[] = []
      if (mode === 'replace') {
        for (const b of current.page.blocks) ops.push({ op: 'delete', blockId: b.id })
      }
      for (const b of newBlocks) ops.push({ op: 'add', block: b })

      let nextPage: Page
      try {
        nextPage = applyOps(current.page, ops).page
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Could not apply the edit: ${msg}`, true)
      }

      // 4. Atomic compare-and-swap with undo capture — the legacy `patchPage`
      //    DB seam. `null` means a concurrent writer bumped the version first.
      const undo = buildUndoEntry(current.page, ops, {}, current.version + 1)
      let result: { newVersion: number } | null
      try {
        result = await docPageStore.applyPatch({
          userId: ctx.userId,
          pageId,
          expectedVersion: current.version,
          nextPage,
          undo,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Failed to save the edit: ${msg}`, true)
      }
      if (!result) {
        return text('The page was updated concurrently. Re-read it and retry the edit.', true)
      }

      // Note: doc pages have their own realtime path (the doc-sync service for
      // live collaborative docs); they're NOT part of the brain-stream NOTIFY
      // surface (`BrainPrimitive` covers memory/task/CRM/file/entity only), so
      // no `notifyBrainChange` here. The web reads the page via the saved-views
      // / doc endpoints, which reflect this committed version on next fetch.
      return text(
        `Edited page "${current.title}" (${mode === 'replace' ? 'replaced body' : 'appended content'}). ` +
          `New version ${result.newVersion}.`,
      )
    },
  }

  const deletePage: BrainTool = {
    name: 'deletePage',
    description:
      'Permanently delete a workspace doc page by id. Any pages nested under ' +
      'it are deleted too (the page tree cascades). There is no undo over MCP ' +
      '— the `read_write` scope is the authorization. The key must be able to ' +
      "access the page (it's scoped to the key's workspace and clearance) or " +
      'the call reports not-found.',
    inputSchema: {
      pageId: z.string().min(1).max(128).describe('The id of the page to delete.'),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : ''
      if (!pageId) return text('Provide a `pageId` to delete.', true)

      // Confirm RLS-scoped access BEFORE deleting — never trust the input id.
      // A page the key can't see reads null here, so we report not-found
      // rather than issuing a delete that RLS would no-op anyway.
      const current = await docPageStore.getVersionedPage(ctx.userId, pageId)
      if (!current) {
        return text(`Page not found: ${pageId}. It may not exist or you may not have access.`, true)
      }

      let removed: boolean
      try {
        removed = await savedViewStore.remove(ctx.userId, pageId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Failed to delete the page: ${msg}`, true)
      }
      if (!removed) {
        return text(`Page not deleted: ${pageId}. It may have already been removed.`, true)
      }

      // No brain-stream NOTIFY — doc pages aren't a `BrainPrimitive` (see the
      // editPage note above); the sidebar re-reads the saved-views list.
      return text(`Deleted page "${current.title}" (${pageId}).`)
    },
  }

  // ── createPage ────────────────────────────────────────────────
  //
  // The only create path on this surface — `editPage` requires an existing
  // `pageId` and refuses to mint one. Persists through the same
  // `savedViewStore.createDraft` seam the chat `renderPage` tool uses (RLS
  // keyed on the resolved principal), so a brain-key page is born identical
  // to one authored in-app. Markdown body is parsed with the same
  // `markdownToBlocks` + `normalizeMarkdownBlocks` expansion `editPage` runs.
  const createPage: BrainTool = {
    name: 'createPage',
    description:
      'Create a NEW workspace doc page from a `title` and optional Markdown ' +
      '`content`. Pass `parentPageId` (an existing page id, e.g. from ' +
      '`listPages`) to file the new page NESTED UNDER that parent in the ' +
      'sidebar tree; omit it for a top-level page. Returns the new `pageId` — ' +
      'use `editPage` to add more or `readPage` to read it back. This is the ' +
      'only way to create a page; `editPage` only edits existing pages. ' +
      "Scoped to the key's workspace.",
    inputSchema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe('Title for the new page.'),
      content: z
        .string()
        .max(MAX_EDIT_CHARS)
        .optional()
        .describe('Optional Markdown body. Omit to create an empty page.'),
      parentPageId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Optional id of an existing page to nest the new page under (the ' +
            'Notion sub-page primitive). Omit for a top-level page.',
        ),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return text('Provide a `title` for the new page.', true)
      const content = typeof args.content === 'string' ? args.content : ''

      // Resolve + workspace-confirm the parent before nesting under it (same
      // guard the chat `createSubPage` tool runs). `getById` is RLS-scoped to
      // the resolved principal, so a null read means "no access / not found";
      // the explicit workspace check additionally refuses a parent in another
      // workspace the principal happens to belong to — the brain key binds to
      // exactly one workspace, so a cross-workspace nest would mint an orphan.
      const parentPageId =
        typeof args.parentPageId === 'string' ? args.parentPageId : undefined
      if (parentPageId) {
        const parent = await savedViewStore.getById(ctx.userId, parentPageId)
        if (!parent || parent.workspaceId !== workspaceId) {
          return text(
            `Parent page not found: ${parentPageId}. It may have been deleted, ` +
              'or it may live in another workspace. Omit `parentPageId` to ' +
              'create a top-level page.',
            true,
          )
        }
      }

      // Build the initial block list from the Markdown body (same expansion
      // the chat path + `editPage` apply). An empty body still needs one
      // block so the page is well-formed.
      const blocks: Block[] = content.trim()
        ? normalizeMarkdownBlocks(markdownToBlocks(content))
        : []
      if (blocks.length === 0) {
        blocks.push({ kind: 'text', id: randomUUID(), text: '' })
      }

      // Prose page: the legacy `entity` / `viewType` columns are placeholders
      // (the block list is the authoritative content), mirroring `renderPage`'s
      // non-data default binding.
      const binding = { entity: 'tasks', viewType: 'table' } as BindingConfig
      try {
        const draft = await savedViewStore.createDraft({
          userId: ctx.userId,
          workspaceId,
          // External-agent (brain-MCP) page write — bot-authored page event.
          writtenBy: 'system',
          name: title,
          nameOrigin: 'user',
          icon: null,
          entity: 'tasks',
          viewType: 'table',
          binding,
          page: { blocks },
          nestParentId: parentPageId ?? null,
        })
        const nestedNote = parentPageId
          ? ` nested under ${parentPageId}`
          : ''
        return text(
          `Created page "${title}" (pageId: ${draft.id})${nestedNote}. Use editPage to add more, or readPage to read it back.`,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Failed to create the page: ${msg}`, true)
      }
    },
  }

  // ── listPageTemplates ─────────────────────────────────────────
  //
  // A read tool surfacing the shared Notion-style template catalog
  // (`@sidanclaw/core` `listPageTemplates`) — the same registry the editor
  // slash menu reads. Catalog-only (no bodies), so the agent can pick a
  // `templateId` to pass to `createPageFromTemplate`. Workspace-independent
  // (the catalog is a code constant), but it still resolves the principal so a
  // `read`-scope key behaves identically to every other read tool.
  const listPageTemplatesTool: BrainTool = {
    name: 'listPageTemplates',
    description:
      'List the available doc-page templates (Notion-style starters like ' +
      'meeting notes, weekly review, project plan). Returns each template as ' +
      '`{ id, name, description, icon, category }`. Pick an `id` and pass it ' +
      'to `createPageFromTemplate` to create a pre-structured page.',
    inputSchema: {},
    async handler() {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const builtin = listPageTemplates().map(
        (r) => `- ${r.icon} ${r.name} (id: ${r.id}, category: ${r.category}): ${r.description}`,
      )
      // Workspace custom templates (migration 281), when the store is wired.
      let custom: string[] = []
      if (pageTemplateStore) {
        const rows = await pageTemplateStore.list(ctx.userId, workspaceId)
        custom = rows.map(
          (r) =>
            `- ${r.icon ?? '📄'} ${r.name} (id: ${r.id}, category: ${r.category}, custom)` +
            (r.description ? `: ${r.description}` : ''),
        )
      }
      const all = [...builtin, ...custom]
      return text(`${all.length} page templates:\n${all.join('\n')}`)
    },
  }

  // ── createPageFromTemplate ────────────────────────────────────
  //
  // A write tool that creates a NEW page seeded from a template. Reuses the
  // shared `instantiatePageTemplate` (markdown→blocks via the same path
  // `createPage` runs) and the same `savedViewStore.createDraft` seam — so a
  // template-born page is identical to one authored in-app, with the template's
  // emoji as the page icon. `title` overrides the template's suggested title.
  const createPageFromTemplate: BrainTool = {
    name: 'createPageFromTemplate',
    description:
      'Create a NEW workspace doc page pre-filled from a template. Call ' +
      '`listPageTemplates` first to get a `templateId`. The page is seeded with ' +
      "the template's structure (headings, lists, checklists, tables) and its " +
      'icon; date placeholders resolve to today. Pass `title` to override the ' +
      "template's suggested title. Returns the new `pageId`. Scoped to the " +
      "key's workspace.",
    inputSchema: {
      templateId: z
        .string()
        .min(1)
        .max(128)
        .describe('The template id from `listPageTemplates` (e.g. "meeting-notes").'),
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional title override. Omit to use the template's suggested title."),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const templateId = typeof args.templateId === 'string' ? args.templateId.trim() : ''
      if (!templateId) return text('Provide a `templateId` (see listPageTemplates).', true)
      const titleOverride =
        typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined

      // Built-in slug → instantiate the Markdown catalog. Otherwise fall back
      // to a workspace CUSTOM template (a uuid) resolved from the store, whose
      // stored blocks get fresh ids so they never collide with an existing page.
      let resolved: { title: string; icon: string | null; blocks: Block[] } | null = null
      const instance = instantiatePageTemplate(templateId, { titleOverride })
      if (instance) {
        resolved = { title: instance.title, icon: instance.icon, blocks: instance.blocks }
      } else if (pageTemplateStore) {
        const custom = await pageTemplateStore.getById(ctx.userId, templateId)
        if (custom) {
          resolved = {
            title: titleOverride ?? custom.name,
            icon: custom.icon,
            blocks: withFreshBlockIds(custom.blocks, () => randomUUID()),
          }
        }
      }
      if (!resolved) {
        return text(
          `Unknown template: ${templateId}. Call listPageTemplates for valid ids ` +
            `(built-in: ${pageTemplateIds().join(', ')}; custom templates list there too).`,
          true,
        )
      }

      // Same default binding placeholder + createDraft seam as `createPage`
      // (the block list is the authoritative content).
      const binding = { entity: 'tasks', viewType: 'table' } as BindingConfig
      try {
        const draft = await savedViewStore.createDraft({
          userId: ctx.userId,
          workspaceId,
          // External-agent (brain-MCP) page write — bot-authored page event.
          writtenBy: 'system',
          name: resolved.title,
          nameOrigin: 'user',
          icon: resolved.icon,
          entity: 'tasks',
          viewType: 'table',
          binding,
          page: { blocks: resolved.blocks },
        })
        return text(
          `Created page "${resolved.title}" from template "${templateId}" (pageId: ${draft.id}). ` +
            'Use editPage to add more, or readPage to read it back.',
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Failed to create the page: ${msg}`, true)
      }
    },
  }

  // ── createPageTemplate ────────────────────────────────────────
  //
  // A write tool that persists a NEW workspace CUSTOM template (migration 281).
  // The inverse of `createPageFromTemplate`: instead of instantiating a template
  // into a page, it snapshots a Markdown body into a reusable, workspace-shared
  // template row. The body is parsed with the SAME `markdownToBlocks` +
  // `normalizeMarkdownBlocks` path `createPage` runs, so a template authored
  // over MCP carries the identical canonical block list a hand-authored one
  // would — and `createPageFromTemplate` (which re-mints block ids via
  // `withFreshBlockIds`) can instantiate it straight away. Strictly needs the
  // optional `pageTemplateStore` — there is no built-in catalog to fall back to
  // (the code catalog is read-only), so the tool is registered only when the
  // store is wired; the in-handler guard is defensive.
  const createPageTemplate: BrainTool = {
    name: 'createPageTemplate',
    description:
      'Create a NEW reusable workspace page template from Markdown. The template ' +
      'is saved to the workspace gallery (shared with every member) and can then ' +
      'be instantiated into pages with `createPageFromTemplate`; its id also ' +
      'appears in `listPageTemplates` (labelled custom). Provide a `name`, a ' +
      `\`category\` (one of: ${PAGE_TEMPLATE_CATEGORIES.join(', ')}), and the ` +
      'template body as Markdown `content` (headings, lists, checklists, tables, ' +
      'callouts — the same Markdown `createPage` accepts). Optional `description` ' +
      "and `icon` (an emoji). Returns the new templateId. Scoped to the key's " +
      'workspace.',
    inputSchema: {
      name: z
        .string()
        .min(1)
        .max(256)
        .describe('Display name for the template (shown in the gallery).'),
      category: pageTemplateCategorySchema.describe(
        `Gallery category: one of ${PAGE_TEMPLATE_CATEGORIES.join(', ')}.`,
      ),
      content: z
        .string()
        .min(1)
        .max(MAX_EDIT_CHARS)
        .describe('Markdown body — the page skeleton this template seeds.'),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe('Optional one-line description shown in the gallery.'),
      icon: z
        .string()
        .max(16)
        .optional()
        .describe("Optional emoji glyph; seeds the template's (and seeded page's) icon."),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      // Strictly needs the custom-template store — there is no built-in fallback
      // (unlike listPageTemplates / createPageFromTemplate, which serve the code
      // catalog). A deploy without the store never registers this tool; guard
      // defensively in case it is reached anyway.
      if (!pageTemplateStore?.create) {
        return text('Custom page templates are not enabled on this deployment.', true)
      }
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name) return text('Provide a `name` for the template.', true)
      const category = pageTemplateCategorySchema.safeParse(args.category)
      if (!category.success) {
        return text(
          `Provide a valid \`category\` (one of: ${PAGE_TEMPLATE_CATEGORIES.join(', ')}).`,
          true,
        )
      }
      const content = typeof args.content === 'string' ? args.content : ''
      const description =
        typeof args.description === 'string' && args.description.trim()
          ? args.description.trim()
          : null
      const icon = typeof args.icon === 'string' && args.icon.trim() ? args.icon.trim() : null

      // Same Markdown → blocks expansion `createPage` / `editPage` run, so a
      // template body lands as the identical canonical block list a hand-authored
      // page would. A template must carry at least one block (the store's
      // `blocks` schema enforces min(1) too).
      const blocks = normalizeMarkdownBlocks(markdownToBlocks(content))
      if (blocks.length === 0) {
        return text('The `content` produced no blocks — provide some Markdown text.', true)
      }

      try {
        const created = await pageTemplateStore.create(ctx.userId, {
          workspaceId,
          name,
          description,
          icon,
          category: category.data,
          blocks,
        })
        return text(
          `Created page template "${created.name}" (templateId: ${created.id}, category: ${created.category}). ` +
            'Pass this id to createPageFromTemplate to mint a page from it.',
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Failed to create the template: ${msg}`, true)
      }
    },
  }

  return {
    readPage,
    listPages,
    editPage,
    deletePage,
    createPage,
    listPageTemplates: listPageTemplatesTool,
    createPageFromTemplate,
    createPageTemplate,
  }
}

/**
 * Build the brain tool surface for one authenticated key. The returned list
 * is scope-filtered — a `read` key never sees a write tool.
 */
export function buildBrainTools(opts: BuildOpts): BrainTool[] {
  const resolveCtx = makeBrainContextResolver(opts.workspaceId, opts.keyId, opts.maxClearance)
  const workspaceId = opts.workspaceId

  // ── Unified read: searchBrain (bridged from createRetrievalTools.search)
  const searchBrain = bridgeCoreTool(opts.retrievalTools.search, resolveCtx, workspaceId, {
    nameOverride: 'searchBrain',
    descriptionOverride:
      'Search the company brain. Returns rows from the workspace memory, tasks, ' +
      'CRM (contacts/companies/deals), files, knowledge base, and entity graph. ' +
      'Optional `scope` (single primitive name or omit for all). Clearance-filtered ' +
      "to the key's ceiling, scoped to the key's workspace.",
  })

  // ── Scoped recording retrieval: searchRecording (recording-to-brain).
  // Hand-rolled (not bridged) — it routes into the dedicated `searchRecording`
  // scope handler, which is intentionally NOT in KNOWN_SCOPES so an unscoped
  // searchBrain never floods on a recording's 70-110 segments. Vector + ILIKE
  // fused, scoped to one recording, through queryWithRLS + the access predicate.
  const searchRecordingTool: BrainTool = {
    name: 'searchRecording',
    description:
      'Retrieve passages from ONE transcribed recording, scoped to that recording only ' +
      '(never the whole company brain). Pass the recording Episode id as `recordingId` plus a `query`; ' +
      'returns the most relevant segments with `start_ms` timestamps and `speaker`, so you can cite the ' +
      'exact moment ("around 47:12, Priya said ..."). For a summarize/overview intent that spans many ' +
      'segments, page sequential windows with `fromIndex`/`toIndex` instead of relying on top-K. ' +
      'Never returns the whole transcript at once.',
    inputSchema: {
      recordingId: z.string().uuid(),
      query: z.string().default(''),
      topK: z.number().int().min(1).max(20).optional(),
      fromIndex: z.number().int().min(0).optional(),
      toIndex: z.number().int().min(0).optional(),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const recordingId = String(args.recordingId ?? '')
      if (!recordingId) return text('recordingId is required', true)
      if (!ctx.workspaceId) return text('No workspace is bound to this call.', true)
      const actor = {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        assistantKind: ctx.assistantKind ?? 'standard',
        clearance: ctx.clearance,
        compartments: ctx.compartments,
      }
      try {
        let hits: RecordingSegmentHit[]
        if (typeof args.fromIndex === 'number') {
          const from = args.fromIndex
          const to = typeof args.toIndex === 'number' ? args.toIndex : from + 9
          hits = await readRecordingRange(actor, { recordingId, fromIndex: from, toIndex: to })
        } else {
          hits = await searchRecordingFn(
            actor,
            { recordingId, query: String(args.query ?? ''), topK: typeof args.topK === 'number' ? args.topK : undefined },
            opts.embedder ? { embedder: opts.embedder } : undefined,
          )
        }
        return text(JSON.stringify(hits, null, 2))
      } catch (err) {
        return text(`searchRecording failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    },
  }

  // ── Scoped file retrieval: searchFileContent (large-content-artifacts §1.4).
  // Hand-rolled twin of searchRecordingTool over `file_segments`. Unlike
  // recordings, file_segment ALSO rides general searchBrain (capped per
  // artifact); this tool is the precision surface inside ONE stored document.
  const searchFileContentTool: BrainTool = {
    name: 'searchFileContent',
    description:
      'Retrieve passages from ONE stored document (a workspace file artifact), scoped to that file only ' +
      '(never the whole company brain). Pass the `fileId` (from a file_segment searchBrain hit or a file ' +
      'listing) plus a `query`; returns the most relevant sections, each with its `segment_index` and ' +
      '`heading_path` breadcrumb so you can cite the exact place. For a summarize/overview intent, page ' +
      'sequential windows with `fromIndex`/`toIndex` instead of relying on top-K. ' +
      'Never returns the whole document at once.',
    inputSchema: {
      fileId: z.string().uuid(),
      query: z.string().default(''),
      topK: z.number().int().min(1).max(20).optional(),
      fromIndex: z.number().int().min(0).optional(),
      toIndex: z.number().int().min(0).optional(),
    },
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      const fileId = String(args.fileId ?? '')
      if (!fileId) return text('fileId is required', true)
      if (!ctx.workspaceId) return text('No workspace is bound to this call.', true)
      const actor = {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        assistantKind: ctx.assistantKind ?? 'standard',
        clearance: ctx.clearance,
        compartments: ctx.compartments,
      }
      try {
        let hits: FileSegmentHit[]
        if (typeof args.fromIndex === 'number') {
          const from = args.fromIndex
          const to = typeof args.toIndex === 'number' ? args.toIndex : from + 9
          hits = await readFileSegmentRange(actor, { fileId, fromIndex: from, toIndex: to })
        } else {
          hits = await searchFileSegmentsFn(
            actor,
            { fileId, query: String(args.query ?? ''), topK: typeof args.topK === 'number' ? args.topK : undefined },
            opts.embedder ? { embedder: opts.embedder } : undefined,
          )
        }
        return text(JSON.stringify(hits, null, 2))
      } catch (err) {
        return text(`searchFileContent failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    },
  }

  // ── Entity read + edge discovery: getEntity (bridged from createRetrievalTools.getEntity).
  // The one read path that surfaces an entity's existing edges + resolves its
  // underlying entity UUID — the prerequisite for writing an edge via a save
  // tool's `links` field. See programmatic-access.md → "Tool surface".
  const getEntity = bridgeCoreTool(opts.retrievalTools.getEntity, resolveCtx, workspaceId, {
    descriptionOverride:
      'Fetch one brain entity by id or display name, with a rollup that embeds its existing ' +
      'relationship edges (plus recent episodes, memory, and open tasks). Use this to (a) resolve ' +
      "an entity's UUID before writing an edge via a save tool's `links` field, and (b) read which " +
      'edges already exist so you do not duplicate them. `walk_depth` / `walk_edge_types` expand the ' +
      "neighbourhood. Clearance-filtered to the key's ceiling, scoped to the key's workspace.",
  })

  // ── Deprecated read alias: searchKnowledge → searchBrain(scope='kb_chunk')
  const searchKnowledge: BrainTool = {
    name: 'searchKnowledge',
    description:
      'DEPRECATED — call searchBrain with `scope: "kb_chunk"` instead. ' +
      'Search the workspace knowledge base only.',
    inputSchema: {
      query: z.string().min(1).describe('What to look for, in natural language'),
    },
    async handler(args) {
      return searchBrain.handler({ ...args, scope: 'kb_chunk' })
    },
  }

  // ── Memory bridges
  const saveMemory = bridgeCoreTool(opts.memoryTools.saveMemory, resolveCtx, workspaceId)
  const getMemory = bridgeCoreTool(opts.memoryTools.getMemory, resolveCtx, workspaceId)
  const deleteMemory = bridgeCoreTool(opts.memoryTools.deleteMemory, resolveCtx, workspaceId)

  // ── ingestToBrain — programmatic capture into the brain.
  // Default (`decompose: true`) runs Pipeline B via the injected `opts.ingest`:
  // it materializes an Episode and extracts entities / edges / memories / tasks
  // from the content (the same decomposition the chat + connector paths get),
  // then reports what landed. `decompose: false` is the weaker discovery path —
  // a direct `saveMemory` write of the verbatim content, fast and cheap, for an
  // atomic fact already distilled. The direct path is also the fallback when no
  // `ingest` capability is wired (files-less / test builds). See
  // programmatic-access.md → "Tool wiring" and ingest-pipeline.md → "Active capture".
  const ingestToBrain: BrainTool = {
    name: 'ingestToBrain',
    description:
      'Save content into the company brain. By default this runs the brain ' +
      'extraction pipeline over the content: it writes the structured rows it ' +
      'finds — entities (people, companies, projects, products), the relationship ' +
      'edges between them, durable memories, and tasks — deduping against what ' +
      'already exists, and returns a summary of what was extracted. Call it once ' +
      'per coherent unit (one project, document, or topic) with a short ' +
      '`sourceLabel`, rather than pasting many unrelated things in one call — ' +
      'extraction quality drops on mixed blobs. Set `decompose: false` to skip ' +
      'extraction and store the content verbatim as a single memory (faster and ' +
      'cheaper — for a short atomic fact you have already distilled, not a raw document).',
    inputSchema: {
      content: z
        .string()
        .min(1)
        .max(MAX_INGEST_CHARS)
        .describe(
          'The text to ingest — ideally one coherent unit (a project readme, a meeting note, a person profile).',
        ),
      sourceLabel: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Short label for where this came from (e.g. the project or file name). Stored as provenance; in decompose:false mode it becomes the memory title.',
        ),
      decompose: z
        .boolean()
        .optional()
        .describe(
          'Default true — extract entities, edges, memories, and tasks. Set false to store the content as a single memory without extraction.',
        ),
      title: z
        .string()
        .max(200)
        .optional()
        .describe('Deprecated alias for sourceLabel; retained for back-compat.'),
    },
    async handler(args) {
      const content = String(args.content ?? '').trim()
      if (!content) return text('Provide non-empty content.', true)
      const rawLabel =
        (typeof args.sourceLabel === 'string' && args.sourceLabel.trim()) ||
        (typeof args.title === 'string' && args.title.trim()) ||
        ''
      const sourceLabel = rawLabel || undefined
      // Default to the smart path; `decompose: false` opts into the direct save.
      const decompose = args.decompose !== false

      if (decompose && opts.ingest) {
        const ctx = await resolveCtx()
        if ('error' in ctx) return text(ctx.error, true)
        let result: PipelineBResult
        try {
          result = await opts.ingest({
            workspaceId,
            userId: ctx.userId,
            assistantId: ctx.assistantId,
            content,
            occurredAt: new Date(),
            sourceLabel,
            // Brain-key Episodes are stamped at the credential's effective
            // clearance ceiling (primary assistant's clearance capped by the
            // key's max_clearance), collapsed into the 4-value Episode tier
            // vocabulary (confidential → private).
            sensitivity: toEpisodeSensitivity(ctx.clearance ?? BRAIN_KEY_CLEARANCE),
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return text(`Ingest failed: ${msg}`, true)
        }
        return text(formatIngestResult(result, sourceLabel))
      }

      // Direct discovery path — flat memory, the prior behavior. Used when
      // `decompose: false` or no ingest capability is wired. `team` matches the
      // saveMemory enum's workspace-shared scope; the sensitivity stamp is
      // governed by the context accumulator (seeded at BRAIN_KEY_CLEARANCE in
      // makeBrainContextResolver), so the write defaults to `internal`.
      const summary = sourceLabel || firstLine(content)
      return saveMemory.handler({
        summary,
        detail: content,
        scope: 'team',
        tags: ['programmatic', `brain-key:${opts.keyId.slice(0, 8)}`],
      })
    },
  }

  // ── Task bridges (unchanged from prior version — chat-side onEvent reads ctx)
  const taskBridges = [
    bridgeCoreTool(opts.taskTools.saveTask, resolveCtx, workspaceId),
    bridgeCoreTool(opts.taskTools.getTask, resolveCtx, workspaceId),
    bridgeCoreTool(opts.taskTools.listTasks, resolveCtx, workspaceId),
    bridgeCoreTool(opts.taskTools.updateTask, resolveCtx, workspaceId),
    bridgeCoreTool(opts.taskTools.closeTask, resolveCtx, workspaceId),
    bridgeCoreTool(opts.taskTools.reopenTask, resolveCtx, workspaceId),
  ]

  // ── CRM bridges
  const crmBridges = [
    bridgeCoreTool(opts.crmTools.saveContact, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.getContact, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.listContacts, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.updateContact, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.saveCompany, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.getCompany, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.listCompanies, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.updateCompany, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.saveDeal, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.getDeal, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.listDeals, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.updateDeal, resolveCtx, workspaceId),
    bridgeCoreTool(opts.crmTools.advanceDealStage, resolveCtx, workspaceId),
  ]

  // ── File bridges (workspace filesystem). Present only when a blob client is
  // configured (opts.fileTools set). Both byte-preserving saves are bridged:
  // `saveFileToBrain` references a cached upload by id (bytes entered via the
  // HTTP upload route), and `saveFileBytes` takes raw bytes inline as base64
  // (size-capped in the tool). Descriptions are re-authored for the
  // programmatic surface — the chat copy references chat-only concepts (the #
  // Workspace Files L1 block, the staged_write approval flow, comment-thread
  // cards) that don't exist here. The `read_write` scope is the write
  // authorization; the bridge calls execute() directly, so the chat-side
  // requiresConfirmation / requiresCapability gates do not run (every brain-MCP
  // write works this way).
  const fileBridges: BrainTool[] = opts.fileTools
    ? [
        bridgeCoreTool(opts.fileTools.fileRead, resolveCtx, workspaceId, {
          descriptionOverride:
            'Read one workspace file by id or path. Returns the full content plus metadata ' +
            '(title, summary, tags, sensitivity, mime, size). Clearance-filtered to the ' +
            "key's ceiling, scoped to the key's workspace.",
        }),
        bridgeCoreTool(opts.fileTools.fileSearch, resolveCtx, workspaceId, {
          descriptionOverride:
            'Search workspace files by title / summary / tags / name. Returns a compact ' +
            'projection (id, path, name, title, summary, mime, size_bytes, tags, ' +
            'sensitivity, updated_at) — use fileRead for full content. Optional `tag` ' +
            '(exact match) and `parent_path` (folder scope). For a single search across ' +
            "every brain primitive use searchBrain with scope='file' instead.",
        }),
        bridgeCoreTool(opts.fileTools.fileWrite, resolveCtx, workspaceId, {
          descriptionOverride:
            'Create or overwrite a workspace file with text content you author (you supply ' +
            'the body). Files are workspace-shared, durable, and searchable — use them for ' +
            'shared artifacts (drafts, reports, specs), and saveMemory for short unstructured ' +
            'notes. `path` is required and must be unique; overwriting an existing path ' +
            'returns a conflict — pass the existing id to fileSetMeta, or fileDelete first. ' +
            '`title` / `summary` improve discovery; optional `links` attach entity edges.',
        }),
        bridgeCoreTool(opts.fileTools.fileAppend, resolveCtx, workspaceId, {
          descriptionOverride:
            'Append text to an existing workspace file by id or path (read-modify-write; ' +
            'concurrent appends are best-effort). Include any leading newline in `content`. ' +
            'Returns the file with its new size.',
        }),
        bridgeCoreTool(opts.fileTools.fileSetMeta, resolveCtx, workspaceId, {
          descriptionOverride:
            'Update metadata on an existing file: title, summary, tags, related_ids, ' +
            'sensitivity. Path / name / content are not editable here — to rename, ' +
            'fileDelete then fileWrite at the new path. Optional `links` attach entity edges.',
        }),
        bridgeCoreTool(opts.fileTools.fileDelete, resolveCtx, workspaceId, {
          descriptionOverride:
            'Permanently delete a workspace file (metadata row + stored bytes). No ' +
            'in-product undo (the storage bucket keeps a 30-day soft-delete recoverable by ' +
            'ops only). Authorized by the `read_write` scope — there is no separate ' +
            'confirmation over MCP.',
        }),
        bridgeCoreTool(opts.fileTools.saveFileBytes, resolveCtx, workspaceId, {
          descriptionOverride:
            'Save a file to the workspace brain from raw bytes you supply as base64 (an image, ' +
            'PDF, or document), preserving the EXACT original bytes. Use this when you hold a ' +
            "file's bytes directly. To author NEW text content use fileWrite (UTF-8). `path` is " +
            'required and must be unique (an overwrite returns a conflict — fileDelete first or ' +
            'pass a new path); `mime` is required (binary cannot be inferred). Large files are ' +
            'rejected (keep under ~10 MB) — bigger files must be uploaded through the app. ' +
            'Stores only; to extract entities/memories from the content, distill it to text and ' +
            'call ingestToBrain. Clearance and workspace are scoped to the key.',
        }),
        bridgeCoreTool(opts.fileTools.saveFileToBrain, resolveCtx, workspaceId, {
          descriptionOverride:
            'Promote a previously UPLOADED file into the workspace brain, preserving the ' +
            'original bytes. Pass the `fileId` of an upload already in the file cache (e.g. one ' +
            'staged through the app upload route) — this tool references that cached upload, it ' +
            'does NOT carry bytes itself. To send bytes inline over MCP use saveFileBytes; to ' +
            "author text use fileWrite. If the id is unknown or expired the call errors. Scoped " +
            "to the key's workspace and clearance.",
        }),
      ]
    : []

  // ── Doc-page tools (readPage / editPage / deletePage). Present only when the
  // doc stores are wired (opts.docTools set) — mirrors the file surface. The
  // same RLS-gated stores the chat doc tools use: `readPage` rides both scopes,
  // `editPage` / `deletePage` are filtered to read_write keys by the split below.
  const docPageTools = opts.docTools
    ? buildDocPageTools(opts.docTools, resolveCtx, workspaceId)
    : null

  // ── Agent capability toolset (agent-facing capability surface §3/§4).
  // Reads ride both scopes; writes require read_write + the configure gate
  // (pre-resolved by the server into `agentWritesEnabled`). Same bridge as
  // every other tool — one Tool instance, per-request context.
  const agentReadBridges: BrainTool[] = opts.agentTools
    ? [...opts.agentTools.reads.values()].map((t) => bridgeCoreTool(t, resolveCtx, workspaceId))
    : []
  const agentWriteBridges: BrainTool[] =
    opts.agentTools && opts.scope === 'read_write' && opts.agentWritesEnabled
      ? [...opts.agentTools.writes.values()].map((t) => bridgeCoreTool(t, resolveCtx, workspaceId))
      : []
  const agentReadNames = new Set(agentReadBridges.map((t) => t.name))

  const all: BrainTool[] = [
    // Reads
    searchBrain,
    searchRecordingTool,
    searchFileContentTool,
    searchKnowledge,
    getEntity,
    getMemory,
    ...taskBridges.filter((t) => t.name === 'getTask' || t.name === 'listTasks'),
    ...crmBridges.filter((t) =>
      t.name === 'getContact' || t.name === 'listContacts' ||
      t.name === 'getCompany' || t.name === 'listCompanies' ||
      t.name === 'getDeal' || t.name === 'listDeals',
    ),
    ...fileBridges.filter((t) => t.name === 'fileRead' || t.name === 'fileSearch'),
    ...(docPageTools
      ? [docPageTools.readPage, docPageTools.listPages, docPageTools.listPageTemplates]
      : []),
    ...agentReadBridges,
    // Writes
    saveMemory,
    deleteMemory,
    ingestToBrain,
    ...taskBridges.filter((t) =>
      t.name === 'saveTask' || t.name === 'updateTask' ||
      t.name === 'closeTask' || t.name === 'reopenTask',
    ),
    ...crmBridges.filter((t) =>
      t.name === 'saveContact' || t.name === 'updateContact' ||
      t.name === 'saveCompany' || t.name === 'updateCompany' ||
      t.name === 'saveDeal' || t.name === 'updateDeal' ||
      t.name === 'advanceDealStage',
    ),
    ...fileBridges.filter((t) =>
      t.name === 'fileWrite' || t.name === 'fileAppend' ||
      t.name === 'fileSetMeta' || t.name === 'fileDelete' ||
      t.name === 'saveFileBytes' || t.name === 'saveFileToBrain',
    ),
    ...(docPageTools
      ? [
          docPageTools.editPage,
          docPageTools.deletePage,
          docPageTools.createPage,
          docPageTools.createPageFromTemplate,
          // Custom-template authoring has no built-in fallback, so it is exposed
          // only when the `pageTemplateStore` is wired (mirrors the store gate
          // inside the handler). Built-in catalog tools above need no store.
          ...(opts.docTools?.pageTemplateStore ? [docPageTools.createPageTemplate] : []),
        ]
      : []),
    ...agentWriteBridges,
  ]
  return opts.scope === 'read'
    ? all.filter((t) => READ_TOOL_NAMES.has(t.name) || agentReadNames.has(t.name))
    : all
}

/**
 * Pre-resolve the configure gate for one request: does the workspace's
 * bound (primary) assistant hold the `configure` capability? Called by the
 * server before tool registration so `tools/list` reflects the gate. One
 * system-level lookup; the per-call context resolver re-reads authority
 * lazily as before.
 */
export async function resolveAgentGate(workspaceId: string): Promise<boolean> {
  const target = await resolveWriteTarget(workspaceId)
  if (!target) return false
  const caps = await loadActiveCapabilities(target.assistantId)
  return caps.has('configure')
}

/**
 * Per-request `ToolContext` resolver. Brain keys are workspace-scoped, but
 * the chat-side tools take a per-call `(userId, assistantId, …)` principal.
 * We bind to the workspace owner + its PRIMARY assistant — the key acts
 * with the primary's authority. `clearance` is the effective ceiling
 * (`effectiveBrainClearance(primary.clearance, key.max_clearance)`) so
 * retrieval and sensitivity-gated reads see the right cap, and the
 * primary's compartments + active capability grants ride along. Memoized so
 * every bridged tool in a single MCP request shares one workspace lookup.
 *
 * The `sensitivity` accumulator is seeded at the effective clearance so that
 * write tools default their sensitivity stamp to the tier the key reads at.
 * `saveMemory` stamps `context.sensitivity?.max ?? 'public'`; the chat path
 * builds an accumulator that rises as the model reads sources, but a
 * brain-key call has no in-turn reads to raise it. Without a seed every
 * programmatic write would land at baseline `public` (readable by the
 * lowest-clearance assistant) — seeding at the ceiling keeps the invariant
 * that a write never lands below the tier the key itself reads at. The
 * write ceiling (`assistantClearance`) is the same effective tier: a key
 * capped at `public` cannot author `internal` rows through the primary.
 *
 * `sessionId` is a fresh UUID per request — a brain-key call has no real
 * `sessions` row, and every downstream column that stores it is UUID-typed
 * (`memories.source_session_id`, `analytics_events.session_id`, …). The
 * brain-key trace lives in `channelType: 'programmatic'` + `channelId: keyId`,
 * which carry through to analytics without needing a non-UUID sessionId.
 */
function makeBrainContextResolver(
  workspaceId: string,
  keyId: string,
  maxClearance: Sensitivity | null,
): () => Promise<ToolContext | { error: string }> {
  let cached: ToolContext | { error: string } | undefined
  return async () => {
    if (cached !== undefined) return cached
    const target = await resolveWriteTarget(workspaceId)
    if (!target) {
      cached = { error: 'This workspace has no assistant to bind the call to.' }
      return cached
    }
    const clearance = effectiveBrainClearance(target.clearance, maxClearance)
    const activeCapabilities = await loadActiveCapabilities(target.assistantId)
    const sensitivity = new SensitivityAccumulator()
    sensitivity.note(clearance)
    cached = {
      userId: target.ownerUserId,
      assistantId: target.assistantId,
      sessionId: randomUUID(),
      appId: target.assistantId,
      channelType: 'programmatic',
      channelId: keyId,
      workspaceId,
      assistantKind: target.kind,
      activeCapabilities,
      clearance,
      assistantClearance: clearance,
      compartments: target.compartments,
      assistantCompartments: target.compartments,
      assistantDefaultCompartments: target.defaultCompartments,
      sensitivity,
      abortSignal: new AbortController().signal,
    }
    return cached
  }
}

type BridgeOverrides = {
  nameOverride?: string
  descriptionOverride?: string
}

/**
 * Adapt a core `Tool<z.ZodObject>` to a `BrainTool`. Extracts the Zod
 * `.shape` for `tools/list`, then on call re-parses the args (defaults +
 * coercions are load-bearing — many tool schemas rely on Zod defaults),
 * resolves the per-request context, runs `execute`, and maps `ToolResult`
 * → `CallToolResult`.
 *
 * `nameOverride` / `descriptionOverride` let the brain-MCP surface present a
 * tool under a different label than the chat catalog uses (e.g. chat's
 * `search` is exposed here as `searchBrain` for namespace clarity).
 *
 * Exported for the assistant MCP endpoint (`routes/assistant-mcp.ts`),
 * which bridges the same agent toolset with an assistant-bound context.
 */
export function bridgeCoreTool(
  coreTool: Tool,
  resolveCtx: () => Promise<ToolContext | { error: string }>,
  workspaceId: string,
  overrides?: BridgeOverrides,
): BrainTool {
  const shape = (coreTool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape
  // Resolve the realtime-stream signal once at build time. The `nameOverride`
  // (e.g. `search` → `searchBrain`) is a label change for `tools/list`; the
  // signal still keys off the underlying core tool's name, so a renamed read
  // tool stays absent from the write map and never notifies.
  const notifySignal = BRAIN_WRITE_TOOL_SIGNALS[coreTool.name]
  return {
    name: overrides?.nameOverride ?? coreTool.name,
    description: overrides?.descriptionOverride ?? coreTool.description,
    inputSchema: shape,
    async handler(args) {
      const ctx = await resolveCtx()
      if ('error' in ctx) return text(ctx.error, true)
      let parsed: unknown
      try {
        parsed = coreTool.inputSchema.parse(args)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return text(`Invalid input: ${msg}`, true)
      }
      const result = await coreTool.execute(parsed, ctx)
      const body =
        typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      if (notifySignal && !result.isError) {
        // Fire-and-forget — a NOTIFY hiccup must not break a successful
        // write. The web reads the row via the existing brain endpoints,
        // so a missed signal degrades gracefully (no realtime ping; the
        // change still appears on the next refresh / event).
        void notifyBrainChange({
          workspaceId,
          primitive: notifySignal.primitive,
          rowId: extractRowId(result.data),
          action: notifySignal.action,
        })
      }
      return result.isError ? text(body, true) : text(body)
    },
  }
}

/** First non-empty line of `s`, truncated to a memory-summary length. */
function firstLine(s: string): string {
  const line = (s.split('\n').find((l) => l.trim()) ?? s).trim()
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/**
 * Render a Pipeline B extraction result as a compact report for the calling
 * agent — counts plus a few entity names, so the model can see what landed and
 * avoid re-ingesting the same content. Mirrors the shape an agent expects back
 * from a write tool: a short, parseable confirmation, not raw rows.
 */
function formatIngestResult(r: PipelineBResult, sourceLabel?: string): string {
  const head = sourceLabel
    ? `Ingested "${sourceLabel}" into the brain (episode ${r.episodeId.slice(0, 8)}).`
    : `Ingested into the brain (episode ${r.episodeId.slice(0, 8)}).`

  if (!r.extracted) {
    return (
      `${head} The extractor could not parse the content, so nothing structured ` +
      `was saved. Retry, or call again with decompose:false to store it as a single memory.`
    )
  }

  const ents = r.entitiesWritten
  const total =
    ents.length + r.edgesWritten.length + r.memoriesWritten.length + r.tasksWritten.length
  if (total === 0) {
    return `${head} No durable entities, edges, memories, or tasks were found in this content.`
  }

  const lines = [head, 'Extracted:']
  if (ents.length) {
    const shown = ents.slice(0, 8).map((e) => `${e.displayName} (${e.kind})`).join(', ')
    const more = ents.length > 8 ? `, +${ents.length - 8} more` : ''
    lines.push(`- ${ents.length} ${plural(ents.length, 'entity', 'entities')}: ${shown}${more}`)
  }
  if (r.edgesWritten.length) {
    lines.push(
      `- ${r.edgesWritten.length} relationship ${plural(r.edgesWritten.length, 'edge', 'edges')}`,
    )
  }
  if (r.memoriesWritten.length) {
    lines.push(
      `- ${r.memoriesWritten.length} ${plural(r.memoriesWritten.length, 'memory', 'memories')}`,
    )
  }
  if (r.tasksWritten.length) {
    lines.push(`- ${r.tasksWritten.length} ${plural(r.tasksWritten.length, 'task', 'tasks')}`)
  }
  if (r.ephemeralCount) {
    lines.push(`- ${r.ephemeralCount} ephemeral item(s) skipped (not durable)`)
  }
  return lines.join('\n')
}

/** The (owner, assistant) authority a brain-key call binds to. */
export type BrainWriteTarget = {
  ownerUserId: string
  assistantId: string
  /** The bound assistant's own clearance — feeds `effectiveBrainClearance`. */
  clearance: Sensitivity
  kind: 'primary' | 'standard' | 'app'
  /** MLS compartment grant. NULL = universe. */
  compartments: string[] | null
  defaultCompartments: string[]
}

/**
 * Resolve the (owner, assistant) authority a brain-key call binds to. The
 * brain key is workspace-level, but the chat-side tools take a concrete
 * `(userId, assistantId)` principal — we bind to the workspace owner and
 * its PRIMARY assistant (`assistants.kind='primary'`, unique per workspace
 * since migration 110), so the key acts with the primary's authority:
 * clearance, compartments, and capability grants all derive from this row.
 * Oldest-by-created_at is kept only as a defensive fallback for a
 * pre-backfill workspace with no primary (should not fire post-migration
 * 193). System-level query: the request is API-key authed, not
 * user-session authed. Returns null when the workspace has no assistant.
 */
async function resolveWriteTarget(workspaceId: string): Promise<BrainWriteTarget | null> {
  const result = await query<{
    ownerUserId: string
    assistantId: string
    clearance: string | null
    kind: string | null
    compartments: string[] | null
    defaultCompartments: string[] | null
  }>(
    `SELECT w.owner_user_id AS "ownerUserId",
            a.id            AS "assistantId",
            a.clearance     AS "clearance",
            a.kind          AS "kind",
            a.compartments  AS "compartments",
            a.default_compartments AS "defaultCompartments"
     FROM workspaces w
     JOIN LATERAL (
       SELECT id, clearance, kind, compartments, default_compartments
       FROM assistants
       WHERE workspace_id = w.id
       ORDER BY (kind = 'primary') DESC, created_at ASC
       LIMIT 1
     ) a ON true
     WHERE w.id = $1`,
    [workspaceId],
  )
  const row = result.rows[0]
  if (!row || !row.assistantId) return null
  return {
    ownerUserId: row.ownerUserId,
    assistantId: row.assistantId,
    // Defensive: an unparseable clearance falls back to the historical
    // fixed ceiling rather than widening.
    clearance: isSensitivity(row.clearance) ? row.clearance : BRAIN_KEY_CLEARANCE,
    kind: row.kind === 'primary' || row.kind === 'app' ? row.kind : 'standard',
    compartments: row.compartments ?? null,
    defaultCompartments: row.defaultCompartments ?? [],
  }
}

/**
 * Active named-capability grants on the bound assistant
 * (`assistant_capabilities`, migration 061). The brain MCP uses this set the
 * same way the chat route does: to gate which `requiresCapability`-tagged
 * tools are exposed, and to thread `activeCapabilities` onto the
 * `ToolContext`. System-level query — same posture as `resolveWriteTarget`.
 */
async function loadActiveCapabilities(assistantId: string): Promise<ReadonlySet<string>> {
  const result = await query<{ capability: string }>(
    `SELECT capability FROM assistant_capabilities
     WHERE assistant_id = $1 AND revoked_at IS NULL`,
    [assistantId],
  )
  return new Set(result.rows.map((r) => r.capability))
}
