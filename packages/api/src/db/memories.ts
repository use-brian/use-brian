import type { AccessContext, EntityLinksStore, Sensitivity } from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { getPool, query } from './client.js'
import { emitMentionedEdges } from './edge-hooks.js'

export type { AccessContext }

// Commitment-memory tag conventions (SV 2026-05-14). See
// docs/historical/decisions-log.md → "SV — Commitment-memory
// convention" and corrections.md → "Commitment-memory lifecycle".
//
// `commitment:open` marks an unresolved brain-held commitment; the row is
// open while `valid_to IS NULL`. Resolution = D.7 supersession (the
// commitment-lifecycle worker calls updateMemory() to swap `commitment:open`
// for `commitment:resolved`, which tombstones the old row).
export const COMMITMENT_OPEN_TAG = 'commitment:open'
export const COMMITMENT_RESOLVED_TAG = 'commitment:resolved'
export function commitmentKindTag(kind: string): string {
  return `commitment:${kind}`
}

export type Memory = {
  id: string
  assistantId: string
  userId: string
  appId: string | null
  workspaceId: string | null
  // Post-Phase-4 (mig 177): `type` and `category` columns dropped. The
  // single semantic axis is `tags`; identity facts moved to entity
  // attributes (see updateSelfProfile + getOrCreateSelfEntity).
  scope: string
  tags: string[]
  summary: string
  detail: string | null
  confidence: number
  sensitivity: Sensitivity
  source: string
  sourceSessionId: string | null
  recallCount: number
  lastRecalledAt: Date | null
  createdAt: Date
  updatedAt: Date
  // Universal column set (mig 128 / WU-2.1). See data-model.md §Universal
  // visibility shape. WU-2.2 reads/writes these; downstream WUs (4.5
  // authorship-NOT-NULL, 6.8 retraction tool, 5.x retrieval) extend usage.
  createdByUserId: string | null
  createdByAssistantId: string | null
  sourceEpisodeId: string | null
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  retractedBy: string | null
  // Staged-memory snapshot (mig 165). Set on INSERT only when the
  // writer is a model — never updated. Downstream consumers
  // (workspace-prompt-evolution worker, review UI delta display) read
  // these to compute "what did the user change about the model's
  // original save". NULL on rows older than mig 165 and on
  // user/manual-authored rows.
  originalScope: string | null
  originalSensitivity: string | null
  originalSummary: string | null
}

const MEMORY_SELECT = `
  id, assistant_id as "assistantId", user_id as "userId", app_id as "appId",
  workspace_id as "workspaceId",
  scope, tags, summary, detail, confidence, sensitivity, source,
  source_session_id as "sourceSessionId",
  recall_count as "recallCount", useful_recall_count as "usefulRecallCount",
  last_recalled_at as "lastRecalledAt",
  created_at as "createdAt", updated_at as "updatedAt",
  created_by_user_id as "createdByUserId",
  created_by_assistant_id as "createdByAssistantId",
  source_episode_id as "sourceEpisodeId",
  verified_by_user_id as "verifiedByUserId",
  verified_at as "verifiedAt",
  valid_from as "validFrom",
  valid_to as "validTo",
  superseded_by as "supersededBy",
  retracted_at as "retractedAt",
  retracted_reason as "retractedReason",
  retracted_by as "retractedBy",
  original_scope as "originalScope",
  original_sensitivity as "originalSensitivity",
  original_summary as "originalSummary"
`

// WU-4.2b: user-facing reads now compose `buildAccessPredicate(ctx, opts)`
// (workspace + visibility-double + optional clearance) instead of the
// legacy `clearanceClause()` snippet. System-only reads
// (`listMemoriesWithMetrics`, worker enumerations, `consolidation_logs`
// queries) keep their per-(assistant, user|workspace) signatures —
// they intentionally bypass per-viewer projection per
// `permissions.md` § Privileged-service exception.

/**
 * Create a new memory. Authorship (`createdByUserId`, `createdByAssistantId`,
 * `sourceEpisodeId`) is stamped from caller context per the universal column
 * set (mig 128 / WU-2.1). WU-4.5 enforces `createdByUserId` NOT NULL at the
 * store layer via `assertAuthorshipPresent` — the DB column itself stays
 * nullable (mig 128 header note) so legacy rows remain valid.
 *
 * `validFrom` defaults to `now()` via the column default; `validTo`,
 * `supersededBy`, and the retraction trio remain NULL on create.
 *
 * WU-1.7 edge hook: when `params.linkedEntityIds` is non-empty AND an
 * `entityLinks` store is passed, a `memory → entity` `mentioned` edge is
 * emitted per id, fire-and-forget, after the memory row is written. Edge
 * failures never affect the memory save (see `edge-hooks.ts`). Both
 * arguments are optional so existing call sites keep compiling unchanged.
 */
export async function createMemory(
  params: {
    assistantId: string
    userId: string
    appId?: string
    scope?: string
    tags?: string[]
    summary: string
    detail?: string
    confidence?: number
    source?: string
    sourceSessionId?: string
    workspaceId?: string
    sensitivity: Sensitivity
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    createdByUserId: string
    createdByAssistantId?: string
    sourceEpisodeId?: string
    /** Entity ids this memory mentions — each gets a `mentioned` edge
     *  (WU-1.7). Optional; empty/absent means no edge emission. */
    linkedEntityIds?: readonly string[]
  },
  entityLinks?: EntityLinksStore,
): Promise<Memory> {
  assertAuthorshipPresent('createMemory', params.createdByUserId)
  // `workspace_id` falls back to the row's assistant's workspace when
  // the caller omits it: every memory must be workspace-partitioned
  // (company-brain hard-isolation; migration 146 makes the column NOT
  // NULL). A bare NULL would orphan the row from the workspace-scoped
  // Brain and the retrieval access predicate.
  //
  // Staged-memory snapshot (mig 165): when the writer is a model
  // (source='model', the default), capture scope/sensitivity/summary
  // into original_* so the review UI + workspace-prompt-evolution
  // worker can compute user-correction deltas later. User/manual
  // writes leave the originals NULL — there's nothing to compare
  // against because the user is the source of truth on first write.
  //
  // Post-Phase-4 (mig 177): `type` and `category` columns are gone.
  // Voice rules ride on `tags: [..., 'voice']` (voice-extractor);
  // identity facts go through `updateSelfProfile` (entity attribute
  // write), not here.
  const effectiveSource = params.source ?? 'model'
  const effectiveScope = params.scope ?? 'shared'
  const isModelWrite = effectiveSource === 'model'
  // Primary widens on WRITE → `workspace_shared` (visibility-double
  // resolution; sensitivity.md § "saveMemory resolution" + "Primary
  // widens"). The primary assistant is the workspace reflector — its
  // memories ARE the shared workspace brain, not one siloed assistant's
  // private inferences, so they must be readable by every other
  // assistant in the workspace (doc, app, standard), bounded only by
  // each reader's clearance. We persist `assistant_id = NULL` for a
  // primary writer (keeping `user_id`, so the row is `workspace_shared`:
  // cross-assistant, still per-user) instead of `assistant_id = self`
  // (`personal`, which only the primary + that one assistant can read).
  // (`memories.assistant_id` was relaxed to NULLABLE in migration 240.)
  //
  // Enforced HERE, at the single INSERT chokepoint, rather than
  // per-writer: every memory writer (chat saveMemory, Pipeline B
  // extraction, consolidation) funnels through this helper, so a primary
  // memory can never be written siloed regardless of caller. `kind` is
  // derived from the `assistant_id` FK (always resolvable at write time).
  // Standard/app assistants keep `assistant_id = self` — their per-user
  // behavioural inferences SHOULD stay siloed. Provenance is untouched:
  // `created_by_assistant_id` still records the authoring primary, and
  // the consolidation/soul system-worker reads treat a primary's
  // null-assistant rows as OWNED by that primary (see
  // `getMemoryIndexSystem` et al. + `listMemoryUsers`).
  //
  // Guard: only null `assistant_id` when `user_id` is set — otherwise the
  // row would be (NULL, NULL), which `memories_visibility_check` blocks.
  const result = await query<Memory>(
    `INSERT INTO memories (
       assistant_id, user_id, app_id, workspace_id,
       scope, tags, summary, detail,
       confidence, sensitivity, source, source_session_id,
       created_by_user_id, created_by_assistant_id, source_episode_id,
       original_scope, original_sensitivity, original_summary,
       compartments
     )
     VALUES (
             CASE
               WHEN $2::uuid IS NOT NULL
                AND (SELECT kind FROM assistants WHERE id = $1::uuid) = 'primary'
               THEN NULL
               ELSE $1::uuid
             END,
             $2, $3, COALESCE($4, (SELECT workspace_id FROM assistants WHERE id = $1)),
             $5, $6, $7, $8,
             $9, $10, $11, $12,
             $13, $14, $15,
             $16, $17, $18, $19)
     RETURNING ${MEMORY_SELECT}`,
    [
      params.assistantId, params.userId, params.appId ?? null, params.workspaceId ?? null,
      effectiveScope, params.tags ?? [],
      params.summary, params.detail ?? null,
      params.confidence ?? 0.8, params.sensitivity, effectiveSource,
      params.sourceSessionId ?? null,
      params.createdByUserId,
      params.createdByAssistantId ?? null,
      params.sourceEpisodeId ?? null,
      isModelWrite ? effectiveScope : null,
      isModelWrite ? params.sensitivity : null,
      isModelWrite ? params.summary : null,
      params.compartments ?? [],
    ],
  )
  const memory = result.rows[0]

  // Fire-and-forget `mentioned` edges. Only fires when the graph store
  // is wired AND the memory carries a workspace (edges are
  // workspace-partitioned) AND at least one entity id is supplied.
  // `void` — never awaited on the caller's path, never able to throw
  // into the memory save.
  if (entityLinks && memory.workspaceId && params.linkedEntityIds && params.linkedEntityIds.length > 0) {
    // Edge trust source mirrors the memory's: a user-authored memory
    // yields a `'user'` edge, everything else falls back to `'model'`
    // (memory `source` is a free `string`, so it is normalized here to
    // the `EntitySource` union the edge row requires).
    const edgeSource = params.source === 'user' ? 'user' : 'model'
    void emitMentionedEdges(entityLinks, params.createdByUserId, {
      sourceKind: 'memory',
      sourceId: memory.id,
      entityIds: params.linkedEntityIds,
      workspaceId: memory.workspaceId,
      source: edgeSource,
      userId: params.userId,
      assistantId: params.assistantId,
      sourceEpisodeId: params.sourceEpisodeId ?? null,
    })
  }
  return memory
}

/**
 * Update an existing memory via **supersession-on-write** (company-brain
 * WU-2.2 / D.7). The semantically-replaced row is tombstoned
 * (`valid_to=now()`, `superseded_by=<new_id>`) and a new row carrying the
 * merged fields is inserted with `valid_from=now()` and a fresh UUID.
 *
 * The new row inherits the old row's authorship, visibility, source, and
 * audit columns; only the fields explicitly passed in `updates` change.
 * Operational counters (recall_count, useful_recall_count, last_recalled_at,
 * query_hashes, recall_days) reset on the new row — they track usage of
 * this version of the assertion, not the underlying fact. Consolidation
 * scoring fields (consolidation_score, promoted_at) also reset.
 *
 * Returns the **new** Memory row (with its fresh UUID) or `null` when no
 * active row matches `id` (already tombstoned, or never existed). The
 * transaction rolls back on any failure mid-flight.
 *
 * `sensitivity` is included for operator declassify/reclassify flows — see
 * docs/architecture/platform/sensitivity.md. `scope` + `workspaceId` cover
 * promote-to-workspace / demote-to-personal flows driven from the Memory
 * tab — see docs/architecture/context-engine/memory-system.md
 * ("Promote to workspace").
 */
export async function updateMemory(
  id: string,
  updates: {
    summary?: string
    detail?: string
    confidence?: number
    tags?: string[]
    sensitivity?: Sensitivity
    scope?: 'shared' | 'workspace'
    workspaceId?: string | null
  },
): Promise<Memory | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    try {
      // Lock the active version. If none matches (already tombstoned, or
      // id doesn't exist), nothing to supersede — bail before the INSERT.
      const lockResult = await client.query<Memory>(
        `SELECT ${MEMORY_SELECT} FROM memories
         WHERE id = $1 AND valid_to IS NULL
         FOR UPDATE`,
        [id],
      )
      const old = lockResult.rows[0]
      if (!old) {
        await client.query('ROLLBACK')
        return null
      }

      // Merge updates over the old row. Untouched fields carry through.
      const next = {
        summary: updates.summary ?? old.summary,
        detail: updates.detail !== undefined ? updates.detail : old.detail,
        confidence: updates.confidence ?? old.confidence,
        tags: updates.tags ?? old.tags,
        sensitivity: updates.sensitivity ?? old.sensitivity,
        scope: updates.scope ?? old.scope,
        workspaceId: updates.workspaceId !== undefined ? updates.workspaceId : old.workspaceId,
      }

      // Insert the new version. Authorship + audit columns carry the old
      // row's values forward (original author is preserved through edits —
      // per-version authorship is a D.8 follow-up). Operational counters
      // and consolidation fields reset to baseline. `workspace_id` falls
      // back to the assistant's workspace (COALESCE) as a NOT-NULL safety
      // net — migration 146 — so supersession can never orphan a row.
      // Carry original_* forward verbatim through the supersession chain —
      // these are immutable snapshots of the model's first save (mig 165),
      // so every superseded version of the row still points at the same
      // "what did the model originally claim" signal.
      const insertResult = await client.query<Memory>(
        `INSERT INTO memories (
           assistant_id, user_id, app_id, workspace_id,
           scope, tags, summary, detail, confidence,
           sensitivity, source, source_session_id,
           created_by_user_id, created_by_assistant_id, source_episode_id,
           verified_by_user_id, verified_at,
           original_scope, original_sensitivity, original_summary,
           valid_from
         )
         VALUES ($1, $2, $3, COALESCE($4, (SELECT workspace_id FROM assistants WHERE id = $1)), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now())
         RETURNING ${MEMORY_SELECT}`,
        [
          old.assistantId, old.userId, old.appId, next.workspaceId,
          next.scope, next.tags, next.summary, next.detail, next.confidence,
          next.sensitivity, old.source, old.sourceSessionId,
          old.createdByUserId, old.createdByAssistantId, old.sourceEpisodeId,
          old.verifiedByUserId, old.verifiedAt,
          old.originalScope, old.originalSensitivity, old.originalSummary,
        ],
      )
      const newRow = insertResult.rows[0]

      // Tombstone the old row, pointing OLD → NEW.
      await client.query(
        `UPDATE memories
           SET valid_to = now(),
               superseded_by = $2,
               updated_at = now()
         WHERE id = $1`,
        [id, newRow.id],
      )

      await client.query('COMMIT')
      return newRow
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}

/**
 * Get a memory by ID (full detail).
 */
export async function getMemoryById(ctx: AccessContext, id: string): Promise<Memory | null> {
  // valid_to IS NULL hides superseded versions (WU-2.2 / D.7). For
  // historical lookups use getMemoryHistory(id) instead.
  // WU-4.2b: universal projection (workspace + visibility-double +
  // optional clearance ceiling) keeps cross-workspace ID lookups
  // from leaking rows.
  const ap = buildAccessPredicate(ctx, { startIdx: 2 })
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories WHERE id = $1 AND ${ap.sql} AND valid_to IS NULL`,
    [id, ...ap.params],
  )
  return result.rows[0] ?? null
}

/**
 * System-level read — bypasses per-viewer projection. Used by the
 * consolidation worker's dedup/REM/Deep loops, which operate across
 * every user's memory for a given (assistant, user|workspace) tuple
 * and therefore can't fit the universal-projection model. See
 * `permissions.md` § Privileged-service exception.
 */
export async function getMemoryByIdSystem(id: string): Promise<Memory | null> {
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories WHERE id = $1 AND valid_to IS NULL`,
    [id],
  )
  return result.rows[0] ?? null
}

/**
 * Full-text search memories. Returns matching memories ranked by relevance.
 * Uses prefix matching (`:*`) so partial words like "yy" match "yyy".
 * Falls back to ILIKE when FTS yields no results (covers CJK and very
 * short queries where tsvector tokenization may miss).
 */
export async function searchMemories(
  ctx: AccessContext,
  params: { searchQuery: string; limit?: number },
): Promise<Memory[]> {
  const limit = params.limit ?? 10
  const raw = params.searchQuery.trim()

  // Build a prefix tsquery: "hello world" → "hello:* & world:*"
  const prefixTerms = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ''))
    .filter(Boolean)
    .map((t) => `${t}:*`)
    .join(' & ')

  // Try FTS prefix match first
  if (prefixTerms) {
    const ap = buildAccessPredicate(ctx)
    const tsqIdx = ap.nextIdx
    const limIdx = ap.nextIdx + 1
    const result = await query<Memory>(
      `SELECT ${MEMORY_SELECT},
              ts_rank(search_vector, to_tsquery('simple', $${tsqIdx})) as rank
       FROM memories
       WHERE ${ap.sql}
         AND valid_to IS NULL
         AND search_vector @@ to_tsquery('simple', $${tsqIdx})
       ORDER BY rank DESC
       LIMIT $${limIdx}`,
      [...ap.params, prefixTerms, limit],
    )
    if (result.rows.length > 0) return result.rows
  }

  // Fallback: ILIKE on summary + detail (handles CJK, short queries)
  const ap = buildAccessPredicate(ctx)
  const likeIdx = ap.nextIdx
  const tagIdx = ap.nextIdx + 1
  const limIdx = ap.nextIdx + 2
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT}
     FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND (summary ILIKE $${likeIdx} OR detail ILIKE $${likeIdx} OR $${tagIdx} = ANY(tags))
     ORDER BY updated_at DESC
     LIMIT $${limIdx}`,
    [...ap.params, `%${raw}%`, raw, limit],
  )
  return result.rows
}

/**
 * Look up memories by ID prefix (for truncated index IDs like [id:5794afc9]).
 * Uses text prefix matching on the UUID column cast to text.
 */
export async function searchMemoriesByIdPrefix(
  ctx: AccessContext,
  params: { idPrefix: string; limit?: number },
): Promise<Memory[]> {
  const limit = params.limit ?? 1
  const ap = buildAccessPredicate(ctx)
  const pfxIdx = ap.nextIdx
  const limIdx = ap.nextIdx + 1
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND id::text LIKE $${pfxIdx} || '%'
     LIMIT $${limIdx}`,
    [...ap.params, params.idPrefix, limit],
  )
  return result.rows
}

/**
 * Get all identity memories for a user within an assistant (always loaded).
 *
 * ── Phase 4 (retire-memory-type plan) ──
 *
 * Identity is no longer a memory `type` — facts about the user live
 * on the user's self entity (`kind='person'`, `attributes.self=true`)
 * per Phase 2 data migration (mig 176). This function now synthesises
 * Memory-shaped rows from the self entity's attributes JSONB so
 * downstream prompt rendering (`buildMemoryContext` § `## Identity`)
 * stays unchanged. One synthesised Memory per attribute key.
 *
 * If the user has no self entity in this workspace, returns []. The
 * `## Identity` block then renders nothing — same observable result
 * as a pre-Phase-2 user with no identity memories.
 */
export async function getIdentityMemories(ctx: AccessContext): Promise<Memory[]> {
  // Resolve the self entity for this (user, workspace). Phase 2 data
  // migration (mig 176) materialised these for every user with
  // legacy identity rows; future users get one on first
  // `updateSelfProfile` call.
  const selfRow = await query<{
    entityId: string
    displayName: string
    attributes: Record<string, unknown>
    sensitivity: Sensitivity
    updatedAt: Date
  }>(
    `SELECT e.id AS "entityId",
            e.display_name AS "displayName",
            e.attributes,
            e.sensitivity,
            e.updated_at AS "updatedAt"
     FROM users u
     JOIN entities e ON e.id = u.entity_id
     WHERE u.id = $1
       AND e.workspace_id = $2
       AND e.valid_to IS NULL
       AND e.attributes->>'self' = 'true'
     LIMIT 1`,
    [ctx.userId, ctx.workspaceId],
  )
  if (selfRow.rows.length === 0) return []
  const self = selfRow.rows[0]

  // Render each attribute as one Memory row. Skip `self` (the
  // discriminator) and any null/empty values. Humanise common keys;
  // fall back to "<Key>: <value>" for the rest.
  const out: Memory[] = []
  const attrs = self.attributes ?? {}
  for (const [key, rawValue] of Object.entries(attrs)) {
    if (key === 'self') continue
    if (rawValue === null || rawValue === undefined || rawValue === '') continue
    const value = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue)
    out.push({
      // Synthetic id encodes the source entity + attribute key. The
      // context-builder slices the first 8 chars for display
      // (`[id:xxxxxxxx]`); using the entity id prefix makes every
      // attribute line share that prefix — visually correct because
      // they're all from the same self entity. Callers that try to
      // round-trip this id back to getMemoryById will fail (no row
      // exists); identity facts are now read-only via this synthesis.
      id: `${self.entityId}:${key}`,
      assistantId: ctx.assistantId,
      userId: ctx.userId,
      appId: null,
      workspaceId: ctx.workspaceId,
      scope: 'shared',
      tags: ['self-profile'],
      summary: humaniseSelfAttribute(key, value),
      detail: null,
      confidence: 1.0,
      sensitivity: self.sensitivity,
      source: 'user',
      sourceSessionId: null,
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: self.updatedAt,
      updatedAt: self.updatedAt,
      createdByUserId: ctx.userId,
      createdByAssistantId: null,
      sourceEpisodeId: null,
      verifiedByUserId: ctx.userId,
      verifiedAt: self.updatedAt,
      validFrom: self.updatedAt,
      validTo: null,
      supersededBy: null,
      retractedAt: null,
      retractedReason: null,
      retractedBy: null,
      originalScope: null,
      originalSensitivity: null,
      originalSummary: null,
    })
  }
  return out
}

/** Render one self-entity attribute as a natural-language identity line. */
function humaniseSelfAttribute(key: string, value: string): string {
  switch (key) {
    case 'name':
      return `User's name is ${value}`
    case 'birthday':
      return `User's birthday: ${value}`
    case 'location':
      return `User lives in ${value}`
    case 'role':
      return `User's role: ${value}`
    case 'company':
      return `User works at ${value}`
    case 'role_or_company':
      return `User works at/as ${value}`
    case 'pronouns':
      return `User's pronouns: ${value}`
    default:
      return `${key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${value}`
  }
}

/**
 * Resolve the UUID of the user's self entity (`kind='person'`,
 * `attributes.self=true`) in the assistant's workspace. Returns `null` if
 * no workspace is set or no self entity has been materialised yet.
 *
 * Used by the chat route to surface the entity UUID inside the `## Identity`
 * prompt block so the model can anchor research findings via
 * `saveMemory({ entityId })` or `updateSelfProfile` instead of falling back
 * to loose memories. See `docs/architecture/context-engine/memory-system.md`
 * → "Self entity exposure".
 */
export async function getSelfEntityId(ctx: AccessContext): Promise<string | null> {
  if (!ctx.workspaceId) return null
  const result = await query<{ id: string }>(
    `SELECT e.id
     FROM users u
     JOIN entities e ON e.id = u.entity_id
     WHERE u.id = $1
       AND e.workspace_id = $2
       AND e.valid_to IS NULL
       AND e.attributes->>'self' = 'true'
     LIMIT 1`,
    [ctx.userId, ctx.workspaceId],
  )
  return result.rows[0]?.id ?? null
}

/**
 * Get the memory index (summary-only) for building domain summaries.
 * Returns all memories for a user with id, summary, tags. Post-Phase-4
 * `type` is gone — the index is a flat list ordered by `updated_at`.
 * The context-builder filters/orders for prompt rendering (recency
 * with tag chips per the retire-memory-type plan Q1 lock).
 */
export async function getMemoryIndex(
  ctx: AccessContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _validOnly: boolean = false, // WU-2.6 contract surface; WU-2.2 always-filters at SQL so this is a no-op
): Promise<Array<{
  id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity
}>> {
  const ap = buildAccessPredicate(ctx)
  const result = await query<{ id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity }>(
    `SELECT id, summary, tags, app_id as "appId", sensitivity
     FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND confidence > 0
     ORDER BY updated_at DESC`,
    [...ap.params],
  )
  return result.rows
}

/**
 * System-worker assistant-scope SQL that folds in a primary's
 * `workspace_shared` memories (`assistant_id IS NULL`).
 *
 * After migrations 240 (relax NOT NULL) + 241 (backfill) a primary
 * assistant's memories are stored `workspace_shared` (assistant_id =
 * NULL, user_id + workspace_id kept).
 * For consolidation / soul synthesis those rows are OWNED by the primary
 * that authored them, so a system read keyed on the primary MUST include
 * them, while a read keyed on any other assistant must NOT (sibling
 * assistants stay siloed to their own rows — only the primary's brain is
 * shared). The `kind='primary'` guard on the NULL branch enforces this:
 * it only fires when `$idx` is the workspace's primary.
 *
 * `a` / `w` are the (optionally alias-qualified) `assistant_id` /
 * `workspace_id` columns; qualify them consistently with the query. The
 * worker reaches a primary via `listMemoryUsers` /
 * `listWorkspaceMemoryGroups`, which fold a null author back to the
 * workspace's primary so `user_souls` / `consolidation_logs` (both
 * `assistant_id NOT NULL`) keep a concrete id.
 */
function systemAssistantScopeSql(a: string, w: string, idx: number): string {
  return `(${a} = $${idx}
           OR (${a} IS NULL
               AND (SELECT kind FROM assistants WHERE id = $${idx}) = 'primary'
               AND ${w} = (SELECT workspace_id FROM assistants WHERE id = $${idx})))`
}

/**
 * System-level memory index for the consolidation worker. Filters on
 * `(assistant_id, user_id)` only — no workspace partition, no
 * visibility-double, no clearance ceiling. See `permissions.md`
 * § Privileged-service exception. Folds in the primary's workspace_shared
 * rows via `systemAssistantScopeSql` (migrations 240-241).
 */
export async function getMemoryIndexSystem(
  assistantId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _validOnly: boolean = false,
): Promise<Array<{
  id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity
}>> {
  const result = await query<{ id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity }>(
    `SELECT id, summary, tags, app_id as "appId", sensitivity
     FROM memories
     WHERE ${systemAssistantScopeSql('assistant_id', 'workspace_id', 1)} AND user_id = $2
       AND valid_to IS NULL
       AND confidence > 0
     ORDER BY updated_at DESC`,
    [assistantId, userId],
  )
  return result.rows
}

/**
 * Ranked, capped slice of the index for per-turn system prompt
 * injection. See MemoryStore.getIndexRanked in
 * packages/core/src/memory/types.ts for semantics.
 *
 * Returns the top-`limit` memories ordered by
 * `(last_recalled_at DESC NULLS LAST, recall_count DESC, updated_at DESC)`,
 * plus the total count (before LIMIT) via a window function so callers
 * can render a "N more" footer in a single round trip.
 *
 * Post-Phase-4 (retire-memory-type): no per-type filter. Identity is no
 * longer a memory; the `## Identity` block renders from self entity
 * attributes via `getIdentityMemories`. All remaining memory rows
 * surface in this index.
 */
export async function getMemoryIndexRanked(
  ctx: AccessContext,
  limit: number,
): Promise<{
  rows: Array<{ id: string; summary: string; tags: string[]; sensitivity: Sensitivity; createdAt: Date }>
  totalCount: number
}> {
  const ap = buildAccessPredicate(ctx)
  const limIdx = ap.nextIdx
  const result = await query<{
    id: string; summary: string; tags: string[]; sensitivity: Sensitivity; createdAt: Date; total: string
  }>(
    `SELECT id, summary, tags, sensitivity,
            created_at as "createdAt",
            COUNT(*) OVER () AS total
     FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND confidence > 0
     ORDER BY last_recalled_at DESC NULLS LAST, recall_count DESC, updated_at DESC
     LIMIT $${limIdx}`,
    [...ap.params, limit],
  )
  const totalCount = result.rows.length > 0 ? Number(result.rows[0].total) : 0
  const rows = result.rows.map((r) => ({
    id: r.id, summary: r.summary, tags: r.tags, sensitivity: r.sensitivity, createdAt: r.createdAt,
  }))
  return { rows, totalCount }
}

/**
 * Track a memory recall (fire-and-forget, non-blocking).
 */
export async function trackRecall(memoryId: string, queryHash?: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await query(
    `UPDATE memories SET
       recall_count = recall_count + 1,
       last_recalled_at = now(),
       recall_days = CASE
         WHEN $2 = ANY(recall_days) THEN recall_days
         ELSE array_append(recall_days, $2)
       END,
       query_hashes = CASE
         WHEN $3::TEXT IS NOT NULL AND NOT ($3::TEXT = ANY(query_hashes))
         THEN array_append(query_hashes, $3::TEXT)
         ELSE query_hashes
       END
     WHERE id = $1`,
    [memoryId, today, queryHash ?? null],
  )
}

/**
 * Track whether a recalled memory was actually useful (fire-and-forget).
 * Only increments on positive signal — unused recalls are implicit (recall_count - useful_recall_count).
 */
export async function trackRecallOutcome(memoryId: string, useful: boolean): Promise<void> {
  if (!useful) return
  await query(
    `UPDATE memories SET useful_recall_count = useful_recall_count + 1 WHERE id = $1`,
    [memoryId],
  )
}

/**
 * List memories with pagination and optional scope filter. Post-Phase-4
 * the `type` filter is gone — callers that want to narrow by category
 * pass `tag` (or filter client-side on tags) instead.
 */
export async function listMemories(
  ctx: AccessContext,
  params: { tag?: string; scope?: string; limit?: number; offset?: number } = {},
): Promise<{ memories: Memory[]; total: number }> {
  const limit = params.limit ?? 20
  const offset = params.offset ?? 0
  const ap = buildAccessPredicate(ctx)
  const conditions: string[] = [ap.sql, 'valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (params.tag) { conditions.push(`$${idx} = ANY(tags)`); values.push(params.tag); idx++ }
  if (params.scope) { conditions.push(`scope = $${idx}`); values.push(params.scope); idx++ }

  const where = conditions.join(' AND ')

  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text FROM memories WHERE ${where}`,
    values,
  )
  const total = parseInt(countResult.rows[0].count, 10)

  values.push(limit, offset)
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${where}
     ORDER BY updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  )
  return { memories: result.rows, total }
}

/**
 * Delete a single memory by ID.
 */
export async function deleteMemory(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM memories WHERE id = $1`,
    [id],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Walk the supersession chain for a memory and return every version in
 * chronological order (oldest first). The input id may name any version
 * in the chain — the recursive CTE walks both directions via
 * `superseded_by` so the caller doesn't need to know the head/tail.
 *
 * Provides per-primitive support for D.7's cross-primitive
 * `getRowHistory(primitive, row_id)` tool that WU-5.5 will wire up at the
 * retrieval surface. `include_retracted=true` is the D.7 default;
 * retracted versions appear in the chain. Hard-deleted versions do not
 * appear (they're gone from the table); the memory_purges audit table is
 * WU-6.8's concern.
 *
 * `currentId` is the id of the active version (`valid_to IS NULL`), or
 * `null` if every version in the chain has been tombstoned without a
 * successor — a defensive edge case that should not arise from normal
 * supersession but can if a tombstone was applied directly via SQL.
 */
export async function getMemoryHistory(id: string): Promise<{
  chain: Memory[]
  currentId: string | null
}> {
  // Postgres requires UNION ALL inside recursive CTEs; the outer UNION
  // (non-recursive) dedups the seed row that appears in both walks.
  const result = await query<Memory>(
    `WITH RECURSIVE
       forward AS (
         SELECT * FROM memories WHERE id = $1
         UNION ALL
         SELECT m.* FROM memories m JOIN forward f ON m.id = f.superseded_by
       ),
       backward AS (
         SELECT * FROM memories WHERE id = $1
         UNION ALL
         SELECT m.* FROM memories m JOIN backward b ON m.superseded_by = b.id
       ),
       chain AS (
         SELECT * FROM forward UNION SELECT * FROM backward
       )
     SELECT ${MEMORY_SELECT} FROM chain
     ORDER BY valid_from ASC, created_at ASC`,
    [id],
  )
  const chain = result.rows
  const current = chain.find((row) => row.validTo === null) ?? null
  return { chain, currentId: current?.id ?? null }
}

/**
 * List open commitment-memories — rows tagged `commitment:open` whose
 * supersession chain has not yet closed (`valid_to IS NULL`). Drives the
 * commitment-lifecycle worker (see
 * `packages/core/src/memory/commitment-lifecycle-worker.ts`), which hands
 * each row to a domain resolver and supersedes when the resolution
 * condition clears.
 *
 * Filters are intentionally narrow — the worker drains in batches and
 * runtime callers (e.g. a per-workspace tick) supply scope. `assistantId`
 * + `workspaceId` are independent: pass either, both, or neither.
 *
 * See docs/architecture/brain/corrections.md → "Commitment-memory
 * lifecycle" and decisions-log.md → "SV — Commitment-memory convention".
 */
export async function listOpenCommitments(params: {
  workspaceId?: string | null
  assistantId?: string | null
  limit?: number
}): Promise<Memory[]> {
  const limit = params.limit ?? 200
  const conditions: string[] = [
    `valid_to IS NULL`,
    `tags @> ARRAY[$1]::text[]`,
  ]
  const values: unknown[] = [COMMITMENT_OPEN_TAG]
  let idx = 2
  if (params.assistantId) {
    conditions.push(`assistant_id = $${idx}`)
    values.push(params.assistantId)
    idx++
  }
  if (params.workspaceId !== undefined && params.workspaceId !== null) {
    conditions.push(`workspace_id = $${idx}`)
    values.push(params.workspaceId)
    idx++
  }
  values.push(limit)
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC
     LIMIT $${idx}`,
    values,
  )
  return result.rows
}

/**
 * Paginated list of unverified memories within a workspace, oldest
 * first. Backs the staged-memory review queue surfaced in the
 * dashboard. "Unverified" means the row was saved by a model and no
 * user has yet acknowledged it (confirm / adjust / delete) —
 * `verified_by_user_id IS NULL`. The companion partial index
 * `idx_memories_unverified_workspace` (mig 165) makes this scan
 * narrow even on a large workspace.
 *
 * Cursor is a base64-opaque "created_at, id" pair — see callers for
 * encoding. Pass `cursor=undefined` for the first page. A NULL cursor
 * (or a malformed one) restarts from the head.
 *
 * System-level — the route layer enforces workspace membership
 * before calling.
 */
export async function listUnverifiedByWorkspace(
  workspaceId: string,
  limit: number,
  cursor?: { createdAt: Date; id: string },
): Promise<Memory[]> {
  const values: unknown[] = [workspaceId]
  let cursorClause = ''
  if (cursor) {
    values.push(cursor.createdAt, cursor.id)
    // Strict cursor pagination — order is (created_at DESC, id DESC) so
    // ties on created_at don't yield duplicate rows across pages.
    cursorClause = `AND (created_at, id) < ($2, $3)`
  }
  values.push(limit)
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE workspace_id = $1
       AND verified_by_user_id IS NULL
       AND valid_to IS NULL
       AND retracted_at IS NULL
       ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  )
  return result.rows
}

/**
 * Count of unverified memories within a workspace — backs the
 * memory-review pending pill in the top-bar chrome and the "X pending"
 * badge on the review page itself. Same partial-index scan as
 * `listUnverifiedByWorkspace`, just `count(*)` instead of `SELECT *`.
 *
 * System-level — caller (route) enforces workspace membership.
 */
export async function countUnverifiedByWorkspace(
  workspaceId: string,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM memories
     WHERE workspace_id = $1
       AND verified_by_user_id IS NULL
       AND valid_to IS NULL
       AND retracted_at IS NULL`,
    [workspaceId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

/**
 * In-place stamp of `verified_by_user_id` + `verified_at` on the active
 * version of a memory row — no supersession, no audit envelope, just
 * the verification touch. The `confirm` path uses this directly; the
 * `adjust` path uses it after the field-by-field supersession write so
 * the new version also carries the verification stamp.
 *
 * `updateMemory` carries the existing `verified_by_user_id` /
 * `verified_at` forward when superseding (`memories.ts` line 303), so
 * calling this *before* an adjust would not survive the supersession.
 * Callers therefore stamp the post-supersession row.
 *
 * Returns the freshly-stamped row, or `null` if the id has no active
 * version (already tombstoned). System-level — caller enforces auth.
 */
export async function markVerifiedDirect(
  memoryId: string,
  verifiedByUserId: string,
): Promise<Memory | null> {
  const result = await query<Memory>(
    `UPDATE memories
        SET verified_by_user_id = $2,
            verified_at = now(),
            updated_at = now()
      WHERE id = $1
        AND valid_to IS NULL
      RETURNING ${MEMORY_SELECT}`,
    [memoryId, verifiedByUserId],
  )
  return result.rows[0] ?? null
}

/**
 * Operational-state prune candidates.
 *
 * Post-Phase-4 (retire-memory-type Q4 lock): the pre-filter is the
 * `operational-state` tag instead of `type='context'`. Any callsite
 * (cron executor, telegram session, etc.) that emits short-lived
 * operational state SHOULD tag it `operational-state` so this prune
 * sweeps it. Without the tag, the row stays — accepted lossiness
 * because the regex confirmation step downstream guards against
 * false positives anyway (see `CRON_OPERATIONAL_PATTERNS` in
 * `packages/core/src/consolidation/phases.ts`).
 *
 * Used by `runCronOperationalPrune` in
 * `packages/core/src/consolidation/phases.ts`.
 *
 * minAgeDays accepts fractional values (0.25 = 6 hours).
 */
export async function listCronContextCandidatesForPrune(
  assistantId: string,
  userId: string,
  minAgeDays: number,
): Promise<Array<{ id: string; summary: string; detail: string | null }>> {
  const result = await query<{ id: string; summary: string; detail: string | null }>(
    `SELECT m.id, m.summary, m.detail
       FROM memories m
      WHERE ${systemAssistantScopeSql('m.assistant_id', 'm.workspace_id', 1)}
        AND m.user_id = $2
        AND m.valid_to IS NULL
        AND 'operational-state' = ANY(m.tags)
        AND m.source = 'model'
        AND m.created_at < now() - make_interval(secs => $3::double precision * 86400)`,
    [assistantId, userId, minAgeDays],
  )
  return result.rows
}

/**
 * Count total memories for a user within an assistant. Used for plan-based caps.
 * See docs/architecture/platform/cost-and-pricing.md.
 */
export async function countMemories(ctx: AccessContext): Promise<number> {
  const ap = buildAccessPredicate(ctx)
  const result = await query<{ count: string }>(
    `SELECT count(*)::text FROM memories
     WHERE ${ap.sql} AND valid_to IS NULL`,
    [...ap.params],
  )
  return parseInt(result.rows[0].count, 10)
}

/**
 * Get memory stats for an assistant/user: total count + total recall count.
 *
 * Post-Phase-4: no more `byType` breakdown — the type axis is gone.
 * Callers that historically rendered per-type counts now show just
 * the total; tag-based breakdowns are a follow-up if needed.
 */
export async function getMemoryStats(ctx: AccessContext): Promise<{
  total: number
  totalRecalls: number
}> {
  const ap = buildAccessPredicate(ctx)
  const result = await query<{ count: string; recalls: string }>(
    `SELECT count(*)::text, coalesce(sum(recall_count), 0)::text as recalls
     FROM memories
     WHERE ${ap.sql} AND valid_to IS NULL`,
    [...ap.params],
  )
  const row = result.rows[0]
  return {
    total: parseInt(row?.count ?? '0', 10),
    totalRecalls: parseInt(row?.recalls ?? '0', 10),
  }
}

// ── Deep consolidation helpers ─────────────────────────────────

export type MemoryWithMetricsRow = {
  id: string
  assistantId: string
  userId: string
  appId: string | null
  scope: string
  summary: string
  detail: string | null
  tags: string[]
  confidence: number
  sensitivity: Sensitivity
  recallCount: number
  usefulRecallCount: number
  uniqueQueries: number
  recallDays: number
  ageDays: number
  createdAt: Date
}

/**
 * Read every memory for (assistant, user) with the scoring signals the
 * Deep consolidation phase needs. `ageDays`, `uniqueQueries`, `recallDays`
 * are computed server-side so the caller stays clock-free.
 */
export async function listMemoriesWithMetrics(
  assistantId: string,
  userId: string,
): Promise<MemoryWithMetricsRow[]> {
  const result = await query<MemoryWithMetricsRow>(
    `SELECT id,
            assistant_id as "assistantId",
            user_id as "userId",
            app_id as "appId",
            scope, summary, detail, tags, confidence, sensitivity,
            recall_count as "recallCount",
            useful_recall_count as "usefulRecallCount",
            coalesce(array_length(query_hashes, 1), 0) as "uniqueQueries",
            coalesce(array_length(recall_days, 1), 0) as "recallDays",
            GREATEST(EXTRACT(EPOCH FROM (now() - created_at)) / 86400, 0)::int as "ageDays",
            created_at as "createdAt"
     FROM memories
     WHERE ${systemAssistantScopeSql('assistant_id', 'workspace_id', 1)} AND user_id = $2 AND valid_to IS NULL`,
    [assistantId, userId],
  )
  return result.rows
}

/**
 * Persist a computed consolidation score. When `boostConfidence` is true,
 * raise confidence to max(current, 0.95) and stamp `promoted_at`.
 */
export async function writeConsolidationScore(
  id: string,
  score: number,
  boostConfidence: boolean,
): Promise<void> {
  if (boostConfidence) {
    await query(
      `UPDATE memories SET
         consolidation_score = $2,
         confidence = GREATEST(confidence, 0.95),
         promoted_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [id, score],
    )
    return
  }
  await query(
    `UPDATE memories SET consolidation_score = $2, updated_at = now() WHERE id = $1`,
    [id, score],
  )
}

/**
 * Fetch SOUL synthesis inputs.
 *
 * ── Phase 4 (retire-memory-type) ──
 *
 * Identity is no longer a memory type — it lives on the user's self
 * entity (`kind='person'`, `attributes.self=true`). This function now
 * returns `(selfEntityAttributes, preferences)`:
 *   - `selfEntityAttributes`: the JSONB blob from the user's self
 *     entity in this workspace (or null if no self entity exists yet)
 *   - `preferences`: all surviving memories that aren't already
 *     captured on the self entity. We use the full memory set here
 *     (excluding self-profile-tagged rows that pre-Phase-2 might
 *     still exist) since the preference/context distinction is gone.
 *
 * The Deep consolidation SOUL prompt template consumes both inputs.
 *
 * When `appId` is null, returns shared-scope memories. When `appId`
 * is a string, returns memories attached to that specific app.
 */
export async function listForSoulSynthesis(
  assistantId: string,
  userId: string,
  appId: string | null,
): Promise<{
  selfEntityAttributes: Record<string, unknown> | null
  preferences: Memory[]
}> {
  // Look up the user's self entity. SOUL synthesis runs against the
  // assistant's workspace; the self entity lives in that same
  // workspace per `getOrCreateSelfEntity`'s materialisation policy.
  const selfRow = await query<{ attributes: Record<string, unknown> }>(
    `SELECT e.attributes
     FROM users u
     JOIN entities e ON e.id = u.entity_id
     JOIN assistants a ON a.id = $1
     WHERE u.id = $2
       AND e.workspace_id = a.workspace_id
       AND e.valid_to IS NULL
       AND e.attributes->>'self' = 'true'
     LIMIT 1`,
    [assistantId, userId],
  )
  const selfAttrs = selfRow.rows[0]?.attributes ?? null

  // System-worker read (Deep consolidation). `(assistant_id, user_id)`
  // filter — see `permissions.md` § Privileged-service exception.
  const scopeClause = appId === null
    ? `scope = 'shared'`
    : `app_id = $3`
  const params: unknown[] = appId === null
    ? [assistantId, userId]
    : [assistantId, userId, appId]

  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${systemAssistantScopeSql('assistant_id', 'workspace_id', 1)} AND user_id = $2
       AND valid_to IS NULL
       AND ${scopeClause}
       AND NOT ('self-profile' = ANY(tags))
     ORDER BY confidence DESC, updated_at DESC`,
    params,
  )

  return { selfEntityAttributes: selfAttrs, preferences: result.rows }
}

/**
 * Upsert a SOUL row. Empty content is rejected — callers suppress that
 * case before calling so we don't accidentally nuke an existing SOUL with
 * a "no signal" result from the synthesiser.
 */
export async function upsertSoul(
  assistantId: string,
  userId: string,
  appId: string | null,
  content: string,
): Promise<void> {
  if (!content.trim()) return
  if (appId === null) {
    await query(
      `INSERT INTO user_souls (assistant_id, user_id, app_id, content)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (assistant_id, user_id, app_id)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [assistantId, userId, content],
    )
    return
  }
  await query(
    `INSERT INTO user_souls (assistant_id, user_id, app_id, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (assistant_id, user_id, app_id)
     DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    [assistantId, userId, appId, content],
  )
}

/**
 * Append a row to `consolidation_logs`. Called by every phase that
 * performed work so the audit trail stays complete.
 */
export async function logConsolidation(params: {
  assistantId: string
  userId: string
  phase: 'light' | 'rem' | 'deep' | 'reflection'
  summary: string
  memoriesAffected: string[]
}): Promise<void> {
  await query(
    `INSERT INTO consolidation_logs (assistant_id, user_id, phase, summary, memories_affected)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.assistantId, params.userId, params.phase, params.summary, params.memoriesAffected],
  )
}

/**
 * Enumerate the distinct (assistant_id, user_id) tuples with any memories.
 * Used by the consolidation worker to pick which users need a tick.
 */
export async function listMemoryUsers(): Promise<Array<{ assistantId: string; userId: string }>> {
  // A primary's memories are stored `workspace_shared` (assistant_id
  // NULL; migrations 240-241). Fold a null author back to the workspace's
  // primary so the worker processes them under that primary's real id
  // (its system reads re-include the null rows via systemAssistantScopeSql,
  // and user_souls / consolidation_logs keep a concrete assistant_id).
  // Rows whose workspace has no primary (orphaned shared memories) are
  // dropped — there is no owner to consolidate them under.
  const result = await query<{ assistantId: string; userId: string }>(
    `SELECT DISTINCT "assistantId", "userId" FROM (
       SELECT COALESCE(
                m.assistant_id,
                (SELECT a.id FROM assistants a
                  WHERE a.workspace_id = m.workspace_id AND a.kind = 'primary'
                  LIMIT 1)
              ) AS "assistantId",
              m.user_id AS "userId"
         FROM memories m
        WHERE m.valid_to IS NULL
     ) t
     WHERE "assistantId" IS NOT NULL`,
    [],
  )
  return result.rows
}

/**
 * Most recent `consolidation_logs.created_at` for (assistant, user, phase).
 * Null means "phase has never run for this user". Used for cadence gating.
 */
export async function getLastPhaseAt(
  assistantId: string,
  userId: string,
  phase: 'light' | 'rem' | 'deep' | 'reflection',
): Promise<Date | null> {
  const result = await query<{ createdAt: Date }>(
    `SELECT max(created_at) as "createdAt" FROM consolidation_logs
     WHERE assistant_id = $1 AND user_id = $2 AND phase = $3`,
    [assistantId, userId, phase],
  )
  return result.rows[0]?.createdAt ?? null
}

/**
 * Has this (assistant, user) been active lately? Active = any enabled
 * scheduled job, OR a user-role message in a human-facing channel
 * (cron / assistant-call / notification excluded) within the last 7 days.
 *
 * The consolidation worker calls this to skip REM + Deep for ghost users.
 * Light stays ungated (it's free).
 *
 * We query `session_messages.role='user'` rather than `sessions.last_active_at`
 * on purpose: the cron executor's delivery upsert bumps `last_active_at` on
 * the user-facing session every time a scheduled job fires, which would mask
 * genuine ghosts if we keyed off that column.
 */
export async function hasRecentActivity(
  assistantId: string,
  userId: string,
): Promise<boolean> {
  const result = await query<{ active: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM scheduled_jobs
         WHERE assistant_id = $1 AND user_id = $2 AND enabled = true
       )
       OR EXISTS (
         SELECT 1
         FROM session_messages sm
         JOIN sessions s ON s.id = sm.session_id
         WHERE s.assistant_id = $1 AND s.user_id = $2
           AND s.channel_type NOT IN ('cron', 'assistant-call', 'notification')
           AND sm.role = 'user'
           AND sm.created_at >= now() - interval '7 days'
       )
     ) AS active`,
    [assistantId, userId],
  )
  return result.rows[0]?.active ?? false
}

/**
 * Get SOUL content for a user within an assistant.
 */
export async function getSoul(assistantId: string, userId: string, appId?: string): Promise<string | null> {
  // Get shared SOUL
  const shared = await query<{ content: string }>(
    `SELECT content FROM user_souls WHERE assistant_id = $1 AND user_id = $2 AND app_id IS NULL`,
    [assistantId, userId],
  )

  // Get app SOUL if appId provided
  let appSoul: string | null = null
  if (appId) {
    const app = await query<{ content: string }>(
      `SELECT content FROM user_souls WHERE assistant_id = $1 AND user_id = $2 AND app_id = $3`,
      [assistantId, userId, appId],
    )
    appSoul = app.rows[0]?.content || null
  }

  const sharedContent = shared.rows[0]?.content || null

  if (!sharedContent && !appSoul) return null
  const parts = [sharedContent, appSoul].filter(Boolean)
  return parts.join('\n\n')
}

// ── Worker lock (row-based, connection-frugal) ───────────────────

import { randomUUID } from 'node:crypto'

/**
 * Default TTL for a freshly-acquired lock. Heartbeats extend it on a
 * 1/3-TTL cadence; the consolidation tick is the longest current caller
 * (~tens of seconds), so 90s gives ~3 heartbeats per typical run and
 * survives a missed beat without releasing.
 */
const DEFAULT_LOCK_TTL_MS = 90_000

/**
 * Run `fn` under a row-based worker lock.
 *
 * Acquisition, heartbeat, and release each check out a pool connection
 * for ~10ms (one statement) and return it immediately. The connection
 * is **not** held for the duration of `fn()` — that was the old
 * `pg_advisory_lock` pattern, which tied lock-hold to connection-hold
 * and pinned a whole pool slot for every running worker tick. With
 * `db-f1-micro` capped at 25 connections, two concurrent worker ticks
 * + studio-page fan-out exhausted the pool (2026-05-25 incident).
 *
 * Mechanism:
 *   1. UPSERT a row in `worker_locks` keyed by `lockId`. The ON CONFLICT
 *      predicate `WHERE expires_at < now()` lets us reclaim a lock left
 *      behind by a crashed worker. If the predicate matches and the row
 *      ends up holding our `holder_id`, `acquired` is true.
 *   2. Spawn a heartbeat that re-`UPDATE`s `expires_at` every TTL/3 while
 *      our `holder_id` still owns the row. If we lose ownership
 *      (someone else's takeover after expiry) the UPDATE no-ops and the
 *      heartbeat stays quiet — `fn()` continues but its writes will not
 *      be coordinated with the new holder. This is acceptable for the
 *      worker scenarios here (each is idempotent on its work units).
 *   3. Run `fn()`.
 *   4. DELETE the row, gated on `holder_id` so we never wipe a row we
 *      no longer own.
 *
 * Returns true if acquired and `fn()` ran (regardless of `fn()`'s
 * success — the worker reports its own errors), false if another holder
 * still owns the unexpired lock.
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md`
 * → "Lock pattern" + `docs/architecture/platform/database-schema.md`
 * → `worker_locks` table.
 */
export async function withWorkerLock(
  lockId: number,
  fn: () => Promise<void>,
  options?: { holderLabel?: string; ttlMs?: number },
): Promise<boolean> {
  const ttlMs = options?.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const holderId = randomUUID()
  const holderLabel = options?.holderLabel ?? 'unspecified'

  // (1) Acquire. UPSERT — INSERT if no row, take over on conflict only
  // when the existing row has expired. RETURNING `holder_id = $2` lets
  // us distinguish "we acquired/took over" from "row exists, was not
  // expired, you didn't get it".
  const ack = await query<{ acquired: boolean }>(
    `INSERT INTO worker_locks (lock_id, holder_id, expires_at, acquired_at, holder_label)
     VALUES ($1, $2::uuid, now() + ($3 || ' milliseconds')::interval, now(), $4)
     ON CONFLICT (lock_id) DO UPDATE
       SET holder_id    = EXCLUDED.holder_id,
           expires_at   = EXCLUDED.expires_at,
           acquired_at  = EXCLUDED.acquired_at,
           holder_label = EXCLUDED.holder_label
       WHERE worker_locks.expires_at < now()
     RETURNING (holder_id = $2::uuid) AS acquired`,
    [lockId, holderId, String(ttlMs), holderLabel],
  )
  if (!ack.rows[0]?.acquired) return false

  // (2) Heartbeat. Extends our TTL while fn() runs. Gated on holder_id
  // so a stale heartbeat (after a peer took over) is a no-op, not a
  // hijack. Errors are swallowed: the lock will simply expire and the
  // next worker will reclaim it. Failing the worker on a heartbeat
  // glitch is the wrong trade — fn() should finish if it can.
  const heartbeatInterval = Math.max(1_000, Math.floor(ttlMs / 3))
  const heartbeat = setInterval(() => {
    void query(
      `UPDATE worker_locks
          SET expires_at = now() + ($2 || ' milliseconds')::interval
        WHERE lock_id = $1 AND holder_id = $3::uuid`,
      [lockId, String(ttlMs), holderId],
    ).catch(() => {
      /* heartbeat failures: silent. Lock will expire; peer will recover. */
    })
  }, heartbeatInterval)
  // Don't keep the event loop alive just to heartbeat; if the process
  // is otherwise idle the worker is between ticks anyway.
  heartbeat.unref?.()

  try {
    await fn()
  } finally {
    clearInterval(heartbeat)
    // (3) Release. Gated on holder_id so we never delete a row that
    // another worker has taken over (would be a correctness bug if it
    // wiped a live holder). Errors are swallowed: at worst the row
    // hangs around until its TTL expires, then the next acquire
    // reclaims it via the ON CONFLICT branch.
    await query(
      `DELETE FROM worker_locks WHERE lock_id = $1 AND holder_id = $2::uuid`,
      [lockId, holderId],
    ).catch(() => {})
  }
  return true
}


// ── Workspace memory queries ─────────────────────────────────────

export async function getWorkspaceIdentityMemories(ctx: AccessContext): Promise<Memory[]> {
  // Workspace identity = team-wide identity facts. Post-Phase-4
  // (retire-memory-type): there's no `type='identity'` anymore;
  // identity-flavoured team rows are conventionally tagged
  // `self-profile` for the (rare) team-self case. Most teams have
  // no rows here. Per-individual identity lives on the user's self
  // entity (see `getIdentityMemories`).
  const ap = buildAccessPredicate(ctx)
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${ap.sql}
       AND 'self-profile' = ANY(tags)
       AND valid_to IS NULL
     ORDER BY confidence DESC, updated_at DESC`,
    [...ap.params],
  )
  return result.rows
}

export async function getWorkspaceMemoryIndex(
  ctx: AccessContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _validOnly: boolean = false, // WU-2.6 contract surface; WU-2.2 always-filters at SQL so this is a no-op
): Promise<Array<{
  id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity
}>> {
  const ap = buildAccessPredicate(ctx)
  const result = await query<{ id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity }>(
    `SELECT id, summary, tags, app_id as "appId", sensitivity
     FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND confidence > 0
     ORDER BY updated_at DESC`,
    [...ap.params],
  )
  return result.rows
}

/**
 * System-level workspace memory index for the team consolidation
 * worker. Filters on `(assistant_id, workspace_id)` only — see
 * `permissions.md` § Privileged-service exception.
 */
export async function getWorkspaceMemoryIndexSystem(
  assistantId: string,
  workspaceId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _validOnly: boolean = false,
): Promise<Array<{
  id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity
}>> {
  const result = await query<{ id: string; summary: string; tags: string[]; appId: string | null; sensitivity: Sensitivity }>(
    `SELECT id, summary, tags, app_id as "appId", sensitivity
     FROM memories
     WHERE ${systemAssistantScopeSql('assistant_id', 'workspace_id', 1)} AND workspace_id = $2
       AND valid_to IS NULL
       AND confidence > 0
     ORDER BY updated_at DESC`,
    [assistantId, workspaceId],
  )
  return result.rows
}

/**
 * Fetch all workspace memories carrying a specific tag (e.g. 'voice').
 * Returns full records so the L1 loader can render summary + detail;
 * for indexed (summary-only) consumption use `getWorkspaceMemoryIndex`.
 * See `docs/architecture/feed/voice-learning.md` for the consumer.
 *
 * Post-Phase-4 (retire-memory-type Q3 lock): function name preserved
 * for test-stub stability; argument renamed `tag` to reflect that
 * the DB column `category` is gone and we now narrow by tag.
 */
export async function getWorkspaceMemoriesByCategory(
  ctx: AccessContext,
  tag: string,
): Promise<Memory[]> {
  const ap = buildAccessPredicate(ctx)
  const tagIdx = ap.nextIdx
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${ap.sql}
       AND $${tagIdx} = ANY(tags)
       AND valid_to IS NULL
     ORDER BY confidence DESC, updated_at DESC`,
    [...ap.params, tag],
  )
  return result.rows
}

export async function searchWorkspaceMemories(
  ctx: AccessContext,
  params: { searchQuery: string; limit?: number },
): Promise<Memory[]> {
  const limit = params.limit ?? 5
  const raw = params.searchQuery.trim()
  if (!raw) return []

  const prefixTerms = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, ''))
    .filter((w) => w.length > 0)
    .map((w) => `${w}:*`)
    .join(' & ')

  if (prefixTerms) {
    const ap = buildAccessPredicate(ctx)
    const tsqIdx = ap.nextIdx
    const limIdx = ap.nextIdx + 1
    const result = await query<Memory>(
      `SELECT ${MEMORY_SELECT},
              ts_rank(search_vector, to_tsquery('simple', $${tsqIdx})) as rank
       FROM memories
       WHERE ${ap.sql}
         AND valid_to IS NULL
         AND search_vector @@ to_tsquery('simple', $${tsqIdx})
       ORDER BY rank DESC
       LIMIT $${limIdx}`,
      [...ap.params, prefixTerms, limit],
    )
    if (result.rows.length > 0) return result.rows
  }

  const ap = buildAccessPredicate(ctx)
  const likeIdx = ap.nextIdx
  const tagIdx = ap.nextIdx + 1
  const limIdx = ap.nextIdx + 2
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT}
     FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND (summary ILIKE $${likeIdx} OR detail ILIKE $${likeIdx} OR $${tagIdx} = ANY(tags))
     ORDER BY updated_at DESC
     LIMIT $${limIdx}`,
    [...ap.params, `%${raw}%`, raw, limit],
  )
  return result.rows
}

/**
 * System-level brain search — full-text search over a workspace's memories,
 * partitioned by `workspace_id` and capped at a sensitivity ceiling.
 *
 * Unlike `searchWorkspaceMemories`, this applies NO visibility-double
 * (user_id / assistant_id) projection: it is a privileged-service path (see
 * permissions.md § Privileged-service exception) for the workspace-scoped
 * brain MCP server, which authenticates a whole workspace rather than a
 * (user, assistant) pair. The `workspace_id` partition is the hard-isolation
 * boundary; `clearance` is the sensitivity gate.
 *
 * Backs `searchBrain` in the programmatic-access MCP surface — see
 * docs/architecture/features/programmatic-access.md.
 */
export async function searchMemoriesByWorkspaceSystem(params: {
  workspaceId: string
  searchQuery: string
  clearance: Sensitivity
  limit?: number
}): Promise<Memory[]> {
  const limit = params.limit ?? 10
  const raw = params.searchQuery.trim()
  if (!raw) return []

  const prefixTerms = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-zA-Z0-9一-鿿]/g, ''))
    .filter((w) => w.length > 0)
    .map((w) => `${w}:*`)
    .join(' & ')

  if (prefixTerms) {
    const result = await query<Memory>(
      `SELECT ${MEMORY_SELECT},
              ts_rank(search_vector, to_tsquery('simple', $2)) as rank
       FROM memories
       WHERE workspace_id = $1
         AND valid_to IS NULL
         AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
         AND search_vector @@ to_tsquery('simple', $2)
       ORDER BY rank DESC
       LIMIT $4`,
      [params.workspaceId, prefixTerms, params.clearance, limit],
    )
    if (result.rows.length > 0) return result.rows
  }

  // Fallback: ILIKE on summary/detail + tag match. Covers CJK / short
  // queries the `simple` tsquery config tokenizes poorly.
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT}
     FROM memories
     WHERE workspace_id = $1
       AND valid_to IS NULL
       AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
       AND (summary ILIKE $2 OR detail ILIKE $2 OR $4 = ANY(tags))
     ORDER BY updated_at DESC
     LIMIT $5`,
    [params.workspaceId, `%${raw}%`, params.clearance, raw, limit],
  )
  return result.rows
}

export async function searchWorkspaceMemoriesByIdPrefix(
  ctx: AccessContext,
  params: { idPrefix: string; limit?: number },
): Promise<Memory[]> {
  const limit = params.limit ?? 1
  const ap = buildAccessPredicate(ctx)
  const pfxIdx = ap.nextIdx
  const limIdx = ap.nextIdx + 1
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${ap.sql}
       AND valid_to IS NULL
       AND id::text LIKE $${pfxIdx} || '%'
     LIMIT $${limIdx}`,
    [...ap.params, params.idPrefix, limit],
  )
  return result.rows
}

/**
 * List workspace-scoped memories (paginated, filterable by type).
 */
export async function listWorkspaceMemories(
  ctx: AccessContext,
  params: { tag?: string; limit?: number; offset?: number } = {},
): Promise<{ memories: Memory[]; total: number }> {
  const limit = params.limit ?? 20
  const offset = params.offset ?? 0
  const ap = buildAccessPredicate(ctx)
  const conditions: string[] = [ap.sql, 'valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  // Post-Phase-4 (retire-memory-type): narrow by tag, not by type.
  if (params.tag) { conditions.push(`$${idx} = ANY(tags)`); values.push(params.tag); idx++ }

  const where = conditions.join(' AND ')

  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text FROM memories WHERE ${where}`,
    values,
  )
  const total = parseInt(countResult.rows[0].count, 10)

  values.push(limit, offset)
  const result = await query<Memory>(
    `SELECT ${MEMORY_SELECT} FROM memories
     WHERE ${where}
     ORDER BY updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  )
  return { memories: result.rows, total }
}

/**
 * Count workspace memories for an assistant. Used by the detach guard.
 */
export async function countWorkspaceMemories(ctx: AccessContext): Promise<number> {
  const ap = buildAccessPredicate(ctx)
  const result = await query<{ count: string }>(
    `SELECT count(*)::text FROM memories
     WHERE ${ap.sql} AND valid_to IS NULL`,
    [...ap.params],
  )
  return parseInt(result.rows[0].count, 10)
}

/**
 * Transfer workspace memories from one assistant to another within the same workspace.
 * Returns the number of memories transferred.
 */
export async function transferWorkspaceMemories(
  fromAssistantId: string,
  toAssistantId: string,
  workspaceId: string,
): Promise<number> {
  const result = await query(
    `UPDATE memories SET assistant_id = $2, updated_at = now()
     WHERE assistant_id = $1 AND workspace_id = $3`,
    [fromAssistantId, toAssistantId, workspaceId],
  )
  return result.rowCount ?? 0
}

/**
 * Bulk bi-temporal supersession of workspace memories by tag overlap
 * (WU-6.11 — the `supersedeMemory` workflow tool). Stamps `valid_to` on
 * every active, non-retracted memory in the workspace whose `tags`
 * overlap any of `tags`. Returns the row count. System-level — the
 * caller is the workflow executor (`memories` carries a `system_bypass`
 * RLS policy, migration 015).
 */
export async function supersedeMemoriesByTags(params: {
  workspaceId: string
  tags: string[]
  now: Date
}): Promise<number> {
  if (params.tags.length === 0) return 0
  const result = await query(
    `UPDATE memories
        SET valid_to = $2, updated_at = now()
      WHERE workspace_id = $1
        AND tags && $3::text[]
        AND valid_to IS NULL
        AND retracted_at IS NULL`,
    [params.workspaceId, params.now, params.tags],
  )
  return result.rowCount ?? 0
}

/**
 * Delete all workspace memories for an assistant. Used when force-detaching.
 */
export async function deleteWorkspaceMemories(assistantId: string, workspaceId: string): Promise<number> {
  const result = await query(
    `DELETE FROM memories WHERE assistant_id = $1 AND workspace_id = $2`,
    [assistantId, workspaceId],
  )
  return result.rowCount ?? 0
}

export async function listWorkspaceMemoryGroups(): Promise<Array<{ assistantId: string; workspaceId: string }>> {
  // See listMemoryUsers — fold a primary's null-assistant rows back to the
  // workspace's primary so team consolidation processes them under a
  // concrete id (migrations 240-241).
  const result = await query<{ assistantId: string; workspaceId: string }>(
    `SELECT DISTINCT "assistantId", "workspaceId" FROM (
       SELECT COALESCE(
                m.assistant_id,
                (SELECT a.id FROM assistants a
                  WHERE a.workspace_id = m.workspace_id AND a.kind = 'primary'
                  LIMIT 1)
              ) AS "assistantId",
              m.workspace_id AS "workspaceId"
         FROM memories m
        WHERE m.workspace_id IS NOT NULL AND m.valid_to IS NULL
     ) t
     WHERE "assistantId" IS NOT NULL`,
  )
  return result.rows
}

export async function listWorkspaceMemoriesWithMetrics(
  assistantId: string,
  workspaceId: string,
): Promise<MemoryWithMetricsRow[]> {
  const result = await query<MemoryWithMetricsRow>(
    `SELECT id,
            assistant_id as "assistantId",
            user_id as "userId",
            app_id as "appId",
            scope, summary, detail, tags, confidence, sensitivity,
            recall_count as "recallCount",
            useful_recall_count as "usefulRecallCount",
            coalesce(array_length(query_hashes, 1), 0) as "uniqueQueries",
            coalesce(array_length(recall_days, 1), 0) as "recallDays",
            GREATEST(EXTRACT(EPOCH FROM (now() - created_at)) / 86400, 0)::int as "ageDays",
            created_at as "createdAt"
     FROM memories
     WHERE ${systemAssistantScopeSql('assistant_id', 'workspace_id', 1)} AND workspace_id = $2 AND valid_to IS NULL`,
    [assistantId, workspaceId],
  )
  return result.rows
}

export async function getLastWorkspacePhaseAt(
  assistantId: string,
  workspaceId: string,
  phase: 'light' | 'rem' | 'deep' | 'reflection',
): Promise<Date | null> {
  const result = await query<{ created_at: Date }>(
    `SELECT created_at FROM consolidation_logs
     WHERE assistant_id = $1 AND workspace_id = $2 AND phase = $3
     ORDER BY created_at DESC LIMIT 1`,
    [assistantId, workspaceId, phase],
  )
  return result.rows[0]?.created_at ?? null
}

export async function logWorkspaceConsolidation(params: {
  assistantId: string
  workspaceId: string
  phase: 'light' | 'rem' | 'deep' | 'reflection'
  summary: string
  memoriesAffected: string[]
}): Promise<void> {
  await query(
    `INSERT INTO consolidation_logs (id, assistant_id, workspace_id, phase, summary, memories_affected, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
    [params.assistantId, params.workspaceId, params.phase, params.summary, params.memoriesAffected],
  )
}
