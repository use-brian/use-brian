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
import { SensitivityAccumulator, isSensitivity, minSensitivity } from '@sidanclaw/core'
import type { PipelineBResult, Sensitivity, Tool, ToolContext } from '@sidanclaw/core'
import { query } from '../db/client.js'
import type { BrainKeyScope } from '../db/brain-keys-store.js'
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
}

/**
 * Tool names a `read` brain key can call. Every other tool is omitted from
 * `tools/list` and rejected on `tools/call`.
 */
const READ_TOOL_NAMES = new Set<string>([
  // Unified read
  'searchBrain',
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
])

function text(body: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: body }],
    ...(isError ? { isError: true } : {}),
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
