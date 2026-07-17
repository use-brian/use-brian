/**
 * Brain page routes for apps/web (company-brain WU-5.9).
 *
 * Mounted at `/api/brain` behind `requireAuth`. Returns the web-shape
 * rollup that `apps/web/src/lib/api/brain.ts` consumes, hiding the
 * server-side rollup row internals from the client.
 *
 * [COMP:brain/entity-rollup-http] [COMP:brain/list-http]
 *
 *   GET /entities/:id?workspaceId=X    — full rollup for the entity panel
 *   GET /list?workspaceId=X&kinds=...  — cross-primitive Brain list view
 *
 * Server-side `entitiesStore.getEntity` already enforces workspace
 * partition, visibility, and sensitivity ceilings via the universal
 * `buildAccessPredicate`. This route adds a workspace-membership gate
 * on top (so a non-member can't probe for entity ids by 404 timing).
 *
 * V1 deferrals:
 *   - `pendingChanges: []` — needs `pending_approvals.approval_payload`
 *     to carry an `entity_ids: UUID[]` field (existing TODO in
 *     `apps/web/src/lib/api/brain.ts`). Tracked as follow-up.
 *   - `knowledge: []` — `kb_chunks` embedded rollup section not yet in
 *     `EntityRollupEmbedded`; only `kb_chunk_count` flows via summary.
 */

import { Router } from 'express'
import type {
  AccessContext,
  EntityKind,
  EntityLinksStore,
  EntityStore,
  RetrievalStore,
  SearchResultRow,
  Sensitivity,
} from '@use-brian/core'
import { query } from '../db/client.js'
import { effectiveReadClearance, effectiveReadCompartments } from '../db/workspace-store.js'
import type { KnowledgeStore } from '../db/knowledge-store.js'

// ── Web-shape contract — keep in sync with apps/web/src/lib/api/brain.ts ─

type BrainPrimitive =
  | 'people'
  | 'companies'
  | 'deals'
  | 'knowledge'
  | 'memories'
  | 'files'
  | 'sessions'
  | 'tasks'

type WebBrainRow = {
  id: string
  kind: BrainPrimitive | EntityKind
  name: string
  summary?: string | null
  sensitivity?: Sensitivity
  createdByUserId?: string | null
  createdByAssistantId?: string | null
  hasPending?: boolean
  /**
   * Task lifecycle status (`todo` | `in_progress` | `blocked` | `done` |
   * `archived`) — only set on `kind:'tasks'` rows. Drives the Brain list's
   * status chip + the "Show completed" partition (see the `/list` route's
   * `taskStatus` param). Absent on every other primitive.
   */
  status?: string
  /** Task tags — only set on `kind:'tasks'` rows (the list's tag chips). */
  tags?: string[]
  /**
   * Task assignee — a `workspace_members` row id (NOT a user id; see
   * docs/architecture/features/tasks.md design decision #2). Only set on
   * `kind:'tasks'` rows; the web client resolves it against the workspace
   * roster for the list's assignee avatar.
   */
  assigneeId?: string | null
}

type WebEntityRollup = {
  id: string
  kind: EntityKind
  name: string
  sensitivity: Sensitivity
  /**
   * Lowercase variant names the brain has seen for this entity. Surfaces
   * the alias-as-data store in the entity drawer so the user can see
   * (and remove) what the system has learned about identity.
   */
  aliases: string[]
  /**
   * Free-form JSONB attributes carried by the entity row. For self
   * entities (`attributes.self === true`) this is where Identity Phase 2
   * (mig 176) lifted the user's profile facts (name, role, location,
   * etc.). Without this projected to the client there is no UI surface
   * that renders post-migration identity data — see mig 177 header.
   */
  attributes: Record<string, unknown>
  authorship: {
    createdByUserId: string | null
    createdByAssistantId: string | null
    sourceEpisodeId: string | null
  }
  summary: {
    memoriesCount: number
    tasksCount: number
    filesCount: number
    knowledgeCount: number
    episodesCount: number
  }
  embedded: {
    recentMemories: WebBrainRow[]
    openTasks: WebBrainRow[]
    files: WebBrainRow[]
    knowledge: WebBrainRow[]
    recentEpisodes: WebBrainRow[]
    edges: { kind: string; targetEntityId: string; targetName: string }[]
  }
  pendingChanges: WebBrainRow[]
}

// ── Rollup row shapes returned by entities-store (internal to that file) ─
// Mirror the locally-defined types in `packages/api/src/db/entities-store.ts`.
// Kept here as `unknown`-narrow runtime guards so future drift fails loud.

type MemoryRollupShape = {
  id: string
  summary: string
  sensitivity: string
  createdByUserId?: string | null
  createdByAssistantId?: string | null
}

type TaskRollupShape = {
  id: string
  title: string
  status?: string
}

type FileRollupShape = {
  id: string
  name: string
  title: string | null
  sensitivity: string
}

type EpisodeRollupShape = {
  id: string
  sourceKind: string
  summaryText: string | null
  sensitivity: string
}

function asPickedRow<T>(row: unknown): T {
  return row as T
}

// ── Helpers ──────────────────────────────────────────────────────────

function toBrainKind(kind: string): EntityKind {
  switch (kind) {
    case 'person':
    case 'company':
    case 'project':
    case 'deal':
    case 'product':
    case 'repository':
      return kind
    default:
      return 'other'
  }
}

function isSensitivity(v: string): v is Sensitivity {
  return v === 'public' || v === 'internal' || v === 'confidential' || v === 'restricted'
}

function safeSensitivity(v: string): Sensitivity {
  return isSensitivity(v) ? v : 'internal'
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
}

function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b
}

/** Stable, sorted-pair key for edge dedup — entity↔knowledge edges
 *  arrive as related-id triples in either direction; the sorted pair
 *  collapses A→B and B→A into one row. */
function edgePairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** A node in the force-directed brain graph. `kind` spans entity kinds
 *  plus the synthetic node kinds (`knowledge`, `skill`, `connector`, and
 *  `memory` — the last only when the caller opts in via `?include=memory`). */
type GraphNode = {
  id: string
  kind: EntityKind | 'knowledge' | 'skill' | 'connector' | 'memory'
  name: string
  sensitivity: Sensitivity
  degree: number
}

/**
 * Resolve the (clearance, assistantId) used for this user's view of a
 * workspace. Workspace membership is the access gate; the clearance
 * ceiling is then resolved in two stages:
 *
 *   1. If `selectedAssistantId` is provided AND that assistant belongs
 *      to this workspace, use its clearance — this is what powers the
 *      floating-pill picker on the brain page so the user can cap the
 *      surface at the selected assistant's level (e.g. picking a
 *      `public` assistant hides internal/confidential rows).
 *   2. Otherwise fall back to the highest-clearance assistant in the
 *      workspace — the historical behaviour for unscoped callers.
 *
 * The viewpoint stays under the reflector branch (`assistantKind =
 * 'primary'`, synthetic all-zeros assistantId) so the assistant_id
 * partition is dropped and the user sees every assistant's rows in the
 * workspace — just bounded by the ceiling. Returns null when the user
 * isn't a workspace member.
 *
 * Cross-workspace race: a stale `selectedAssistantId` that doesn't match
 * any assistant in this workspace is treated as absent (falls back to
 * the workspace-wide ceiling), not an error — workspace switches don't
 * 500 while localStorage catches up.
 */
async function resolveBrainCtx(
  userId: string,
  workspaceId: string,
  selectedAssistantId?: string | null,
): Promise<AccessContext | null> {
  const membership = await query<{
    role: 'owner' | 'admin' | 'member'
    clearance: Sensitivity
    compartments: string[] | null
  }>(
    `SELECT role, clearance, compartments FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  if (membership.rows.length === 0) return null
  const member = membership.rows[0]

  // Stage 1: honour an explicit selection if it's in this workspace.
  let clearance: Sensitivity | null = null
  let viewpointId: string | null = null
  if (selectedAssistantId) {
    const selected = await query<{ id: string; clearance: Sensitivity }>(
      `SELECT id, clearance
         FROM assistants
        WHERE id = $1 AND workspace_id = $2
        LIMIT 1`,
      [selectedAssistantId, workspaceId],
    )
    if (selected.rows[0]) {
      viewpointId = selected.rows[0].id
      clearance = selected.rows[0].clearance
    }
  }

  // Stage 2: fall back to the highest-clearance assistant in the
  // workspace. Membership is verified above; under the workspace model
  // every member can reach all of a workspace's assistants (RLS:
  // owner_user_id = me OR workspace_id IN my workspaces), so the pick
  // is workspace-scoped, NOT owner-scoped. Filtering on owner_user_id
  // was wrong: migration 110 §8g creates kind='primary' assistants with
  // owner_user_id NULL, so an owner filter silently excludes them and
  // the brain view degrades to the empty all-zeros assistant id.
  // Order: restricted > confidential > internal > public.
  if (clearance === null) {
    const assistant = await query<{ id: string; clearance: Sensitivity }>(
      `SELECT id, clearance
         FROM assistants
        WHERE workspace_id = $1
        ORDER BY CASE clearance
                   WHEN 'restricted'   THEN 4
                   WHEN 'confidential' THEN 3
                   WHEN 'internal'     THEN 2
                   WHEN 'public'       THEN 1
                   ELSE 0
                 END DESC
        LIMIT 1`,
      [workspaceId],
    )
    const row = assistant.rows[0]
    viewpointId = row?.id ?? null
    clearance = row?.clearance ?? 'internal'
  }

  // Workspace brain explorer is a reflector surface — set assistantKind
  // = 'primary' so the universal predicate drops the assistant_id
  // partition and the view spans every assistant's rows. The synthetic
  // assistantId is non-functional under the primary branch.
  //
  // Read-side clearance (incident 2026-06-01): the clearance resolved above
  // is an *assistant*-derived ceiling (the selected, or the workspace's
  // highest-clearance, assistant). Bound it by the acting member's clearance
  // so a low-clearance member browsing the brain can't read above their tier.
  // Reuse the membership row already fetched above — no extra query.
  const readClearance = effectiveReadClearance(member.role, member.clearance, clearance)
  // Compartment ceiling: the brain explorer is a primary reflector (universe
  // assistant grant), so the effective grant is the member's own
  // (`member ∩ universe`). A compartment-restricted member browsing the brain
  // is bounded to their compartments; an owner/admin is universe.
  const readCompartments = effectiveReadCompartments(member.role, member.compartments, null)
  return {
    workspaceId,
    userId,
    assistantId: viewpointId ?? '00000000-0000-0000-0000-000000000000',
    assistantKind: 'primary',
    clearance: readClearance,
    compartments: readCompartments,
  }
}

function projectMemoryRow(raw: unknown): WebBrainRow {
  const m = asPickedRow<MemoryRollupShape>(raw)
  return {
    id: m.id,
    kind: 'memories',
    name: m.summary,
    sensitivity: safeSensitivity(m.sensitivity),
    createdByUserId: m.createdByUserId ?? null,
    createdByAssistantId: m.createdByAssistantId ?? null,
  }
}

function projectTaskRow(raw: unknown): WebBrainRow {
  const t = asPickedRow<TaskRollupShape>(raw)
  return {
    id: t.id,
    kind: 'tasks',
    name: t.title,
  }
}

function projectFileRow(raw: unknown): WebBrainRow {
  const f = asPickedRow<FileRollupShape>(raw)
  return {
    id: f.id,
    kind: 'files',
    name: f.title ?? f.name,
    sensitivity: safeSensitivity(f.sensitivity),
  }
}

function projectKnowledgeRow(row: {
  id: string
  title: string
  path: string
  sensitivity: Sensitivity
}): WebBrainRow {
  return {
    id: row.id,
    kind: 'knowledge',
    name: row.title.length > 0 ? row.title : row.path,
    sensitivity: safeSensitivity(row.sensitivity),
  }
}

function projectEpisodeRow(raw: unknown): WebBrainRow {
  const e = asPickedRow<EpisodeRollupShape>(raw)
  return {
    id: e.id,
    kind: 'sessions',
    name: e.summaryText ?? e.sourceKind,
    sensitivity: safeSensitivity(e.sensitivity),
  }
}

// ── Brain list — primitive ↔ retrieval scope mapping ─────────────────

/**
 * Web Brain primitive → retrieval-store `search()` scope. `sessions` has
 * no search scope (episodes aren't a `search()` primitive) and is
 * intentionally absent — a `sessions` filter returns empty in v1.
 *
 * `knowledge` is intentionally absent too: it reads from `knowledge_entries`
 * (the document-level surface that github_sync writes) via
 * `knowledgeStore.listForBrain`, not the `kb_chunks` scope. Chunk-level
 * retrieval still belongs to the `searchKnowledge` chat tool — a browse
 * surface wants one row per doc, not N rows per doc.
 */
const PRIMITIVE_TO_SCOPE: Partial<Record<BrainPrimitive, string>> = {
  people: 'contact',
  companies: 'company',
  deals: 'deal',
  memories: 'memory',
  files: 'file',
  tasks: 'task',
}

/**
 * Task statuses the Brain browse surface treats as "completed" — finished
 * (`done`) and soft-deleted (`archived`). The Brain list hides these by
 * default (a reading/trust surface leads with live work, mirroring the
 * entity rollup's `open_tasks` and the `idx_tasks_workspace_active` partial
 * index); the `taskStatus` param opts them back in. The active statuses
 * (`todo` / `in_progress` / `blocked`) are everything else.
 *
 * This partition lives at the BROWSE layer only — the shared
 * `searchTasksScope` retrieval primitive still returns every status so chat
 * recall can answer "did we finish X?". See docs/architecture/features/tasks.md
 * → "Brain browse surface".
 */
const COMPLETED_TASK_STATUSES = new Set(['done', 'archived'])

type TaskStatusFilter = 'active' | 'completed' | 'all'

function parseTaskStatus(raw: unknown): TaskStatusFilter {
  return raw === 'all' ? 'all' : raw === 'completed' ? 'completed' : 'active'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Project a heterogeneous `SearchResultRow` into the web `WebBrainRow`
 * the Brain list page renders. Returns null for primitives the list
 * view does not surface.
 */
function projectSearchRow(row: SearchResultRow): WebBrainRow | null {
  const sensitivity = safeSensitivity(String(row.sensitivity ?? ''))
  switch (row.primitive) {
    case 'memory':
      return { id: row.row_id, kind: 'memories', name: str(row.summary) ?? '(memory)', sensitivity }
    case 'kb_chunk':
      // Brain list reads knowledge_entries directly (see PRIMITIVE_TO_SCOPE
      // doc above). Drop chunk rows so an all-scopes retrieval search doesn't
      // duplicate them alongside the entry rows we fetched separately.
      return null
    case 'contact':
      return { id: row.row_id, kind: 'people', name: str(row.name) ?? '(contact)', sensitivity }
    case 'company':
      return { id: row.row_id, kind: 'companies', name: str(row.name) ?? '(company)', sensitivity }
    case 'deal': {
      const stage = str(row.stage)
      return { id: row.row_id, kind: 'deals', name: stage ? `Deal (${stage})` : 'Deal', sensitivity }
    }
    case 'file':
      return {
        id: row.row_id,
        kind: 'files',
        name: str(row.title) ?? str(row.name) ?? '(file)',
        sensitivity,
      }
    case 'task': {
      const tags = Array.isArray(row.tags)
        ? row.tags.filter((t): t is string => typeof t === 'string')
        : []
      return {
        id: row.row_id,
        kind: 'tasks',
        name: str(row.title) ?? '(task)',
        sensitivity,
        status: str(row.status) ?? undefined,
        tags: tags.length > 0 ? tags : undefined,
        assigneeId: str(row.assignee_id) ?? undefined,
      }
    }
    case 'entity':
      return {
        id: row.row_id,
        kind: toBrainKind(str(row.kind) ?? 'other'),
        name: str(row.display_name) ?? '(entity)',
        sensitivity,
      }
    default:
      return null
  }
}

// ── Route factory ────────────────────────────────────────────────────

export function brainRoutes(deps: {
  entitiesStore: EntityStore
  entityLinksStore: EntityLinksStore
  retrievalStore: Pick<RetrievalStore, 'search'>
  knowledgeStore: Pick<KnowledgeStore, 'listForBrain' | 'getById' | 'listForGraph' | 'listByIds' | 'getSource'>
  // Procedural-brain graph nodes (2026-06-10). Both optional — without them
  // the graph renders entities + knowledge exactly as before (no skill /
  // connector nodes, no crash). Existing tests + call sites omit them.
  workspaceSkillStore?: import('../db/skill-store.js').WorkspaceSkillStore
  connectorInstanceStore?: Pick<
    import('../db/connector-instance-store.js').ConnectorInstanceStore,
    'listByWorkspaceSystem'
  >
}): Router {
  const {
    entitiesStore,
    entityLinksStore,
    retrievalStore,
    knowledgeStore,
    workspaceSkillStore,
    connectorInstanceStore,
  } = deps
  const router = Router()

  router.get('/entities/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { id } = req.params
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const selectedAssistantId =
      typeof req.query.assistantId === 'string' && req.query.assistantId.length > 0
        ? req.query.assistantId
        : null

    const ctx = await resolveBrainCtx(userId, workspaceId, selectedAssistantId)
    if (ctx === null) {
      // Same 404 as a missing entity so we don't leak workspace existence.
      res.status(404).json({ error: 'Not found' })
      return
    }

    let rollup
    try {
      rollup = await entitiesStore.getEntity(ctx, id)
    } catch (err) {
      console.error('[brain] getEntity failed:', err)
      res.status(500).json({ error: 'Internal error' })
      return
    }
    if (rollup === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    // Resolve target-entity names for the edges section. The rollup
    // returns the edge records; the web page needs each target's display
    // name. Cheap parallel lookups; bounded by the per-rollup edge cap.
    const edgePairs = await Promise.all(
      rollup.embedded.edges.map(async (edge) => {
        const targetId = edge.targetKind === 'entity' ? edge.targetId : null
        let targetName = '(unknown)'
        if (targetId) {
          const target = await entitiesStore.getById(ctx, targetId)
          if (target) targetName = target.displayName
        }
        return {
          kind: edge.edgeType,
          targetEntityId: targetId ?? '',
          targetName,
        }
      }),
    )

    const body: WebEntityRollup = {
      id: rollup.entity.id,
      kind: toBrainKind(rollup.entity.kind),
      name: rollup.entity.displayName,
      sensitivity: safeSensitivity(rollup.entity.sensitivity),
      aliases: rollup.entity.aliases ?? [],
      attributes: rollup.entity.attributes ?? {},
      authorship: {
        createdByUserId: rollup.entity.createdByUserId,
        createdByAssistantId: rollup.entity.createdByAssistantId,
        sourceEpisodeId: rollup.entity.sourceEpisodeId,
      },
      summary: {
        memoriesCount: rollup.summary.memory_count,
        tasksCount: rollup.summary.open_task_count,
        filesCount: rollup.summary.file_count,
        knowledgeCount: rollup.summary.kb_chunk_count,
        episodesCount: rollup.summary.episode_count,
      },
      embedded: {
        recentMemories: rollup.embedded.recent_memory.map(projectMemoryRow),
        openTasks: rollup.embedded.open_tasks.map(projectTaskRow),
        files: rollup.embedded.files.map(projectFileRow),
        knowledge: [],
        recentEpisodes: rollup.embedded.recent_episodes.map(projectEpisodeRow),
        edges: edgePairs,
      },
      pendingChanges: [],
    }

    res.status(200).json(body)
  })

  /**
   * GET /list?workspaceId=X&kinds=memories,companies&q=...&limit=100
   *
   * Cross-primitive list for the Brain list page. Thin wrapper over the
   * retrieval `search()` surface: translates the web `kinds` primitives
   * into retrieval `scope`s, runs one `search()` per scope (or a single
   * all-scopes call when `kinds` is absent), and projects the
   * heterogeneous result rows into the web `WebBrainRow` shape.
   *
   * `taskStatus` (tasks only): `active` (DEFAULT — hides `done`/`archived`,
   * the reading-surface default), `completed` (only `done`/`archived`, backs
   * the "Show completed" reveal), or `all`. The partition is applied here
   * post-projection — the shared `searchTasksScope` still returns every
   * status (chat recall needs finished tasks). See
   * docs/architecture/features/tasks.md → "Brain browse surface".
   *
   * V1 deferrals:
   *   - `sessions` — episodes are not a `search()` scope; a `sessions`
   *     filter returns empty. Wiring `recentEpisodes()` is a follow-up.
   *   - `pending=true` — needs `pending_approvals.approval_payload` to
   *     carry `entity_ids`; returns empty for now (same gap as the
   *     rollup route's `pendingChanges: []`).
   *   - `cursor` / pagination — the Brain page requests `limit=100` and
   *     does not paginate, so `nextCursor` is always `null` for now.
   */
  router.get('/list', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const selectedAssistantId =
      typeof req.query.assistantId === 'string' && req.query.assistantId.length > 0
        ? req.query.assistantId
        : null

    const ctx = await resolveBrainCtx(userId, workspaceId, selectedAssistantId)
    if (ctx === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    // V1 deferral — the "Pending changes" filter needs entity-id-tagged
    // approval payloads; return empty rather than mislabel every row.
    if (req.query.pending === 'true') {
      res.status(200).json({ results: [], nextCursor: null })
      return
    }

    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100

    // Translate web `kinds` → retrieval scopes. Absent `kinds` = every
    // surface (retrieval all-scopes + knowledge).
    const kindsParam = typeof req.query.kinds === 'string' ? req.query.kinds : ''
    const requestedKinds = kindsParam
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
    const allKinds = requestedKinds.length === 0
    const knowledgeRequested = allKinds || requestedKinds.includes('knowledge')
    const scopes: (string | undefined)[] = allKinds
      ? [undefined]
      : requestedKinds
          .map((k) => PRIMITIVE_TO_SCOPE[k as BrainPrimitive])
          .filter((s): s is string => s !== undefined)

    // Kinds were requested but resolved to no source at all (e.g. a
    // sessions-only filter) — return empty rather than fall through to
    // an all-scopes search.
    if (!allKinds && scopes.length === 0 && !knowledgeRequested) {
      res.status(200).json({ results: [], nextCursor: null })
      return
    }

    let merged: WebBrainRow[]
    try {
      const tasks: Promise<WebBrainRow[]>[] = []
      if (scopes.length > 0) {
        tasks.push(
          (async () => {
            // `semantic: false` — the Brain page's search box is a FILTER,
            // not chat recall: a query must only surface rows that literally
            // match (FTS/ILIKE). With the vector arm on, an unscoped query
            // like the workspace's own name embeds near everything in the
            // workspace and "All + search" returns rows that don't contain
            // the text at all.
            const envelopes = await Promise.all(
              scopes.map((scope) =>
                retrievalStore.search(
                  ctx,
                  scope === undefined
                    ? { query: q, limit, semantic: false }
                    : { query: q, scope, limit, semantic: false },
                ),
              ),
            )
            return envelopes
              .flatMap((e) => e.data)
              .map(projectSearchRow)
              .filter((r): r is WebBrainRow => r !== null)
          })(),
        )
      }
      if (knowledgeRequested) {
        tasks.push(
          knowledgeStore
            .listForBrain(ctx, q, limit)
            .then((rows) => rows.map(projectKnowledgeRow)),
        )
      }
      const groups = await Promise.all(tasks)
      merged = groups.flat()
    } catch (err) {
      console.error('[brain] list fetch failed:', err)
      res.status(500).json({ error: 'Internal error' })
      return
    }

    // Task completion partition. The Brain leads with live work, so done +
    // archived tasks drop out by default; `taskStatus=completed` returns only
    // those (the reveal fetch), `all` keeps everything. Only `kind:'tasks'`
    // rows carry a status, so this never touches other primitives.
    const taskStatus = parseTaskStatus(req.query.taskStatus)
    if (taskStatus !== 'all') {
      merged = merged.filter((r) => {
        if (r.kind !== 'tasks') return true
        const completed = COMPLETED_TASK_STATUSES.has(r.status ?? '')
        return taskStatus === 'completed' ? completed : !completed
      })
    }

    const results = merged.slice(0, limit)

    res.status(200).json({ results, nextCursor: null })
  })

  /**
   * GET /facets?workspaceId=X&assistantId=Y
   *
   * Per-primitive presence map for the Brain page filter rail: tells the
   * web UI which primitive chips to render and which to hide because the
   * workspace's brain has no visible row of that kind yet.
   *
   * `present[p]` is true iff there is ≥1 row of that primitive the current
   * viewpoint can see. Each primitive is probed with a cheap `limit:1`
   * empty-query browse against the SAME source `/list` uses, so a chip the
   * facets call surfaces will always have rows behind it when clicked, and
   * a chip it hides would have shown an empty list.
   *
   *   - search-scoped primitives (people/companies/deals/memories/files/
   *     tasks) → `retrievalStore.search(ctx, { query: '', scope, limit: 1 })`,
   *     presence = `.data.length > 0` (same empty-query browse `/list`
   *     relies on).
   *   - `knowledge` → `knowledgeStore.listForBrain(ctx, '', 1)`,
   *     presence = `.length > 0`.
   *   - `sessions` → hard-coded `false`. Episodes are NOT a `search()`
   *     scope and `/list` defers `sessions` (returns empty) in v1, so a
   *     sessions chip would be non-functional — keeping presence false
   *     hides it, consistent with the `/list` deferral.
   *
   * Each per-primitive probe is wrapped in try/catch and defaults to
   * `false` on error, so one slow/failing scope can't 500 the whole
   * endpoint. Membership is still the hard gate: a non-member → 404.
   */
  router.get('/facets', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const selectedAssistantId =
      typeof req.query.assistantId === 'string' && req.query.assistantId.length > 0
        ? req.query.assistantId
        : null

    const ctx = await resolveBrainCtx(userId, workspaceId, selectedAssistantId)
    if (ctx === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    // Per-primitive presence via the same empty-query browse sources as
    // `/list`. Each probe defaults to `false` on error so one slow scope
    // never fails the whole endpoint.
    const presentForScope = async (scope: string): Promise<boolean> => {
      try {
        const envelope = await retrievalStore.search(ctx, { query: '', scope, limit: 1 })
        return envelope.data.length > 0
      } catch (err) {
        console.error(`[brain] facets scope=${scope} probe failed:`, err)
        return false
      }
    }
    const presentForKnowledge = async (): Promise<boolean> => {
      try {
        const rows = await knowledgeStore.listForBrain(ctx, '', 1)
        return rows.length > 0
      } catch (err) {
        console.error('[brain] facets knowledge probe failed:', err)
        return false
      }
    }

    const [people, companies, deals, tasks, memories, files, knowledge] = await Promise.all([
      presentForScope(PRIMITIVE_TO_SCOPE.people!),
      presentForScope(PRIMITIVE_TO_SCOPE.companies!),
      presentForScope(PRIMITIVE_TO_SCOPE.deals!),
      presentForScope(PRIMITIVE_TO_SCOPE.tasks!),
      presentForScope(PRIMITIVE_TO_SCOPE.memories!),
      presentForScope(PRIMITIVE_TO_SCOPE.files!),
      presentForKnowledge(),
    ])

    res.status(200).json({
      present: {
        people,
        companies,
        deals,
        tasks,
        knowledge,
        memories,
        files,
        // Episodes aren't a `search()` scope and `/list` defers `sessions`
        // (returns empty) in v1 — a sessions chip would be non-functional,
        // so report false to keep it hidden, consistent with the deferral.
        sessions: false,
      },
    })
  })

  /**
   * GET /graph?workspaceId=X&assistantId=Y&limit=500
   *
   * Workspace-wide graph snapshot: every entity the viewer can see plus
   * every active (non-retracted, non-expired) entity↔entity edge. Powers
   * the Obsidian-style force-directed `/brain?view=graph` surface.
   *
   * V1 scope:
   *   - Nodes are entities + knowledge + skills + connectors by default.
   *     Memory nodes are OPT-IN via `?include=memory` (the Phase 3 toggle):
   *     including them by default pushes a memory-heavy workspace past ~500
   *     readable nodes and the layout becomes a hairball. When opted in, only
   *     memories LINKED to an already-visible node are added (a relevance lens,
   *     not an exhaustive dump) — disconnected memories never appear. `file` /
   *     `kb_chunk` remain deferred.
   *   - `degree` is computed in-route from the edge list so the client
   *     can size nodes by connection count without a separate query.
   *   - Capped at `limit` nodes (default 500, max 1000). When the cap
   *     trips, `truncated: true` so the client can surface "showing N of
   *     M most-connected" — the v1 store query orders by `created_at`,
   *     so the truncation today is recency, not centrality. Once
   *     `centrality_score` is populated by the consolidation worker it
   *     will become the truncation key.
   *
   * Honors the same `resolveBrainCtx` workspace-membership gate +
   * clearance ceiling as the `/list` and `/entities/:id` routes.
   */
  router.get('/graph', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const selectedAssistantId =
      typeof req.query.assistantId === 'string' && req.query.assistantId.length > 0
        ? req.query.assistantId
        : null
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN
    const nodeLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 500
    // Opt-in node kinds (Phase 3). `?include=memory` adds entity-linked memory
    // nodes; `file` / `kb_chunk` are reserved for later. Comma-separated.
    const includeKinds = new Set(
      (typeof req.query.include === 'string' ? req.query.include : '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    const includeMemory = includeKinds.has('memory')

    const ctx = await resolveBrainCtx(userId, workspaceId, selectedAssistantId)
    if (ctx === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    try {
      // Pull entities, entity_links, and knowledge entries in parallel —
      // they share the same access predicate but are independent reads.
      // Knowledge entries form their own subgraph via `related_ids`
      // (wikilinks resolved by `github_sync`); without them a workspace
      // whose brain is exclusively KB-driven rendered an empty graph
      // even with hundreds of cross-linked docs.
      const [entities, links, knowledgeRows, allSkills] = await Promise.all([
        entitiesStore.listForWorkspace(ctx, { limit: nodeLimit + 1 }),
        // Widen the edge scan to skill/connector kinds so the
        // `references_entity` (skill→entity) and `requires_connector`
        // (skill→connector) edges derived by skill-edge-hooks survive into
        // the graph. Default was entity↔entity only.
        entityLinksStore.listForWorkspace(ctx, {
          sourceKinds: ['entity', 'skill'],
          targetKinds: ['entity', 'memory', 'kb_chunk', 'connector'],
          limit: 5000,
        }),
        knowledgeStore.listForGraph(ctx, nodeLimit + 1),
        workspaceSkillStore
          ? workspaceSkillStore.listForWorkspace(workspaceId, { actingUserId: userId })
          : Promise.resolve([]),
      ])

      // Skills render as additional nodes (they're usually few). Drop
      // archived skills, then cap at `nodeLimit` so a pathological workspace
      // can't blow the node budget. This is ADDITIVE — it deliberately does
      // not touch the entity/knowledge proportional budget below.
      const visibleSkills = allSkills
        .filter((s) => s.state !== 'archived')
        .slice(0, nodeLimit)

      // Entity + knowledge nodes share the same node-cap budget — a
      // workspace whose brain is mostly knowledge entries shouldn't
      // starve the entity layer or vice versa. Truncate proportionally.
      const totalCandidates = entities.length + knowledgeRows.length
      const truncated = totalCandidates > nodeLimit
      const entityBudget = truncated
        ? Math.max(1, Math.round((entities.length / totalCandidates) * nodeLimit))
        : entities.length
      const knowledgeBudget = truncated
        ? Math.max(1, nodeLimit - entityBudget)
        : knowledgeRows.length
      const visibleEntities = entities.slice(0, entityBudget)
      const visibleKnowledge = knowledgeRows.slice(0, knowledgeBudget)
      const visibleIds = new Set<string>([
        ...visibleEntities.map((e) => e.id),
        ...visibleKnowledge.map((k) => k.id),
      ])
      // Skill node ids must be in `visibleIds` BEFORE the edge-degree loop
      // so their `references_entity` / `requires_connector` edges survive
      // the `visibleIds.has(...)` endpoint filter below.
      const visibleSkillIds = new Set(visibleSkills.map((s) => s.rowId))
      for (const id of visibleSkillIds) visibleIds.add(id)

      // Chicken-and-egg connector resolution: a connector node appears
      // ONLY when a VISIBLE skill has a `requires_connector` edge pointing
      // at it. Pre-scan the (already-widened) edge list for those edges,
      // collect the target connector-instance ids, then hydrate just those
      // instances. Done BEFORE the degree loop so the edges survive the
      // endpoint filter.
      const referencedConnectorIds = new Set<string>()
      for (const link of links) {
        if (
          link.edgeType === 'requires_connector' &&
          visibleSkillIds.has(link.sourceId)
        ) {
          referencedConnectorIds.add(link.targetId)
        }
      }
      const visibleConnectors: { id: string; name: string }[] = []
      if (referencedConnectorIds.size > 0 && connectorInstanceStore) {
        const instances = await connectorInstanceStore.listByWorkspaceSystem(workspaceId)
        for (const inst of instances) {
          if (!referencedConnectorIds.has(inst.id)) continue
          visibleIds.add(inst.id)
          visibleConnectors.push({ id: inst.id, name: inst.label || inst.provider })
        }
      }

      // Opt-in memory nodes (Phase 3, `?include=memory`). A memory appears
      // ONLY when it's an endpoint of an edge whose OTHER endpoint is already
      // visible — so memories cluster as satellites around the entities they're
      // about, never as a free-floating cloud. Resolve their display fields via
      // one empty-query memory browse and intersect with the linked ids; the
      // browse window caps how many can resolve (recency-ordered), so a very
      // large memory corpus is a relevance lens, not an exhaustive dump. Added
      // to `visibleIds` BEFORE the degree loop so the entity↔memory edges
      // survive the endpoint filter below.
      // Memories link to entities as `source_kind='memory'`, which the main
      // edge scan above does NOT fetch (its sourceKinds are entity/skill, and
      // memory links outnumber entity links ~4:1 — folding them into the 5000
      // scan would starve the entity edges). So pull memory→entity links
      // SEPARATELY and bounded, keep only those whose entity endpoint is already
      // visible (memories cluster as satellites around the entities they're
      // about, never a free-floating cloud), and cap the node count so a
      // memory-dense workspace — often O(10⁴) memories — can't hairball the
      // layout. `memoryLinks` feeds the degree/edge loop below so the satellites
      // actually connect to their entities.
      const MEMORY_NODE_CAP = 300
      const visibleMemories: { id: string; name: string; sensitivity: Sensitivity }[] = []
      const memoryLinks: typeof links = []
      if (includeMemory) {
        let memoryLinkRows: typeof links = []
        try {
          memoryLinkRows = await entityLinksStore.listForWorkspace(ctx, {
            sourceKinds: ['memory'],
            targetKinds: ['entity'],
            limit: 3000,
          })
        } catch (err) {
          console.error('[brain] graph memory-link fetch failed:', err)
        }
        const linkedMemoryIds = new Set<string>()
        for (const link of memoryLinkRows) {
          if (!visibleIds.has(link.targetId)) continue
          memoryLinks.push(link)
          linkedMemoryIds.add(link.sourceId)
        }
        if (linkedMemoryIds.size > 0) {
          try {
            // Resolve display fields (summary/sensitivity) via one recency-
            // ordered memory browse, intersected with the linked ids. The
            // browse window bounds how many old memories resolve a name; that's
            // acceptable — the satellite view is a relevance lens, not a dump.
            const envelope = await retrievalStore.search(ctx, {
              query: '',
              scope: PRIMITIVE_TO_SCOPE.memories!,
              limit: 2000,
            })
            for (const row of envelope.data) {
              if (visibleMemories.length >= MEMORY_NODE_CAP) break
              const id = row.row_id
              if (!linkedMemoryIds.has(id) || visibleIds.has(id)) continue
              visibleIds.add(id)
              visibleMemories.push({
                id,
                name: str(row.summary) ?? '(memory)',
                sensitivity: safeSensitivity(String(row.sensitivity ?? '')),
              })
            }
          } catch (err) {
            console.error('[brain] graph memory resolution failed:', err)
          }
        }
      }

      // Compute degree from the edge list (only counting edges where
      // both endpoints are visible nodes — dangling edges to entities
      // beyond the cap are dropped so the client never renders an
      // orphan line). The separately-fetched memory→entity links join the
      // scan here so resolved memory nodes connect to their entities; an
      // unresolved memory (beyond the cap) fails the endpoint check and its
      // edge is dropped, so no orphan satellites. Map iterates once.
      const degree = new Map<string, number>()
      const visibleEdges: { id: string; source: string; target: string; type: string; sensitivity: Sensitivity }[] = []
      const seenEdgePairs = new Set<string>()
      for (const link of memoryLinks.length > 0 ? [...links, ...memoryLinks] : links) {
        if (!visibleIds.has(link.sourceId) || !visibleIds.has(link.targetId)) continue
        // Self-loops are technically valid (entity merged with itself
        // during a correction pass) but render as orphan dots that
        // overlap their own node — drop them at the projection layer.
        if (link.sourceId === link.targetId) continue
        degree.set(link.sourceId, (degree.get(link.sourceId) ?? 0) + 1)
        degree.set(link.targetId, (degree.get(link.targetId) ?? 0) + 1)
        seenEdgePairs.add(edgePairKey(link.sourceId, link.targetId))
        visibleEdges.push({
          id: link.id,
          source: link.sourceId,
          target: link.targetId,
          type: link.edgeType,
          sensitivity: safeSensitivity(link.sensitivity),
        })
      }

      // Knowledge↔knowledge edges synthesised from `related_ids` —
      // there's no row id, so use a deterministic "rel:<a>:<b>" key.
      // Dedupe via `seenEdgePairs` (sorted-pair key) so an A.related=[B]
      // + B.related=[A] reciprocal pair only renders once.
      const knowledgeSensitivityById = new Map<string, Sensitivity>(
        visibleKnowledge.map((k) => [k.id, safeSensitivity(k.sensitivity)]),
      )
      for (const k of visibleKnowledge) {
        for (const relId of k.relatedIds) {
          if (!knowledgeSensitivityById.has(relId)) continue
          if (relId === k.id) continue
          const key = edgePairKey(k.id, relId)
          if (seenEdgePairs.has(key)) continue
          seenEdgePairs.add(key)
          degree.set(k.id, (degree.get(k.id) ?? 0) + 1)
          degree.set(relId, (degree.get(relId) ?? 0) + 1)
          // Edge sensitivity is the max of the two endpoints — same
          // monotonicity rule the rest of the brain uses.
          const a = knowledgeSensitivityById.get(k.id) ?? 'internal'
          const b = knowledgeSensitivityById.get(relId) ?? 'internal'
          visibleEdges.push({
            id: `rel:${key}`,
            source: k.id,
            target: relId,
            type: 'related',
            sensitivity: maxSensitivity(a, b),
          })
        }
      }

      const nodes: GraphNode[] = [
        ...visibleEntities.map((e) => ({
          id: e.id,
          kind: toBrainKind(e.kind),
          name: e.displayName,
          sensitivity: safeSensitivity(e.sensitivity),
          degree: degree.get(e.id) ?? 0,
        })),
        ...visibleKnowledge.map((k) => ({
          id: k.id,
          kind: 'knowledge' as const,
          name: k.title.length > 0 ? k.title : k.path,
          sensitivity: safeSensitivity(k.sensitivity),
          degree: degree.get(k.id) ?? 0,
        })),
        ...visibleSkills.map((s) => ({
          id: s.rowId,
          kind: 'skill' as const,
          name: s.name,
          sensitivity: safeSensitivity(s.sensitivity),
          degree: degree.get(s.rowId) ?? 0,
        })),
        ...visibleConnectors.map((c) => ({
          id: c.id,
          kind: 'connector' as const,
          name: c.name,
          sensitivity: 'internal' as Sensitivity,
          degree: degree.get(c.id) ?? 0,
        })),
        ...visibleMemories.map((m) => ({
          id: m.id,
          kind: 'memory' as const,
          name: m.name,
          sensitivity: m.sensitivity,
          degree: degree.get(m.id) ?? 0,
        })),
      ]

      res.status(200).json({ nodes, edges: visibleEdges, truncated })
    } catch (err) {
      console.error('[brain] graph fetch failed:', err)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  /**
   * GET /knowledge/:id?workspaceId=X&assistantId=Y
   *
   * Single knowledge-entry read for the brain detail drawer. Knowledge
   * rows in the brain list have no `entity` row and no inbox primitive,
   * so the generic drawer path (entity rollup + brain-inbox detail)
   * leaves the body blank — this route fills that gap with the document
   * body, path, tags, and sync provenance.
   *
   * Honors the same `resolveBrainCtx` workspace + clearance gate as the
   * other brain routes; `knowledgeStore.getById` adds its own
   * sensitivity-rank filter, so a viewer below the entry's clearance
   * gets a 404 indistinguishable from a missing row.
   */
  router.get('/knowledge/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId =
      typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const selectedAssistantId =
      typeof req.query.assistantId === 'string' && req.query.assistantId.length > 0
        ? req.query.assistantId
        : null

    const ctx = await resolveBrainCtx(userId, workspaceId, selectedAssistantId)
    if (ctx === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    try {
      const entry = await knowledgeStore.getById(ctx, req.params.id)
      if (!entry || entry.workspaceId !== ctx.workspaceId) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      // Entry-reader enrichment: resolve `related_ids` to display refs
      // (wikilink navigation + the rail's related list) and the owning
      // source row (provenance card). Both are best-effort — a resolution
      // failure degrades the reader, it doesn't 500 the read.
      const [related, source] = await Promise.all([
        (entry.relatedIds?.length ?? 0) > 0
          ? knowledgeStore.listByIds(ctx, entry.relatedIds).catch((err) => {
              console.error('[brain] knowledge related resolution failed:', err)
              return []
            })
          : Promise.resolve([]),
        entry.sourceId
          ? knowledgeStore.getSource(entry.sourceId).catch((err) => {
              console.error('[brain] knowledge source fetch failed:', err)
              return null
            })
          : Promise.resolve(null),
      ])
      res.status(200).json({
        id: entry.id,
        path: entry.path,
        title: entry.title,
        summary: entry.summary,
        content: entry.content,
        tags: entry.tags,
        sensitivity: entry.sensitivity,
        sourceId: entry.sourceId,
        sourceSha: entry.sourceSha,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        related: related.map((r) => ({ id: r.id, title: r.title, path: r.path })),
        source: source && source.workspaceId === ctx.workspaceId
          ? {
              id: source.id,
              repo: source.repo,
              branch: source.branch,
              rootPath: source.rootPath,
              lastSyncedAt: source.lastSyncedAt,
            }
          : null,
      })
    } catch (err) {
      console.error('[brain] knowledge fetch failed:', err)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  return router
}
