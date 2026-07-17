import type {
  AccessContext,
  EntityCreateParams,
  EntityKind,
  EntityLinksStore,
  EntityListRow,
  EntityRecord,
  EntityRollup,
  EntityRollupEmbedded,
  EntityRollupSummary,
  EntitySource,
  EntityStore,
  EntitySupersedePatch,
  EntityUpdateFields,
  GetEntityOpts,
} from '@use-brian/core'
import type { Sensitivity } from '@use-brian/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'

/**
 * `entities` store. Schema spec:
 *   docs/plans/company-brain/data-model.md §Entities (lines 43-104).
 *
 * Rollup contract:
 *   docs/architecture/brain/retrieval-layer.md §"Sub-resource expansion".
 *
 * WU-1.2 ships CRUD + a skeleton `getEntity` rollup (entity row + edge
 * summary/embedded). WU-1.8 wires the cross-primitive rollup
 * (memory / tasks / files counts + embedded sections). WU-5.2 extends
 * the rollup so `as_of` projects through both endpoints of every JOIN
 * (link AND primitive) and wires real `recent_episodes` / `episode_count`
 * against `episodes` (mig 129). The fan-out helpers live inline rather
 * than in each primitive's store to keep the per-WU blast radius to a
 * single file (per execution-plan brief). `kb_chunks` rollup wiring
 * stays stubbed — deferred to WU-3.7 even though the table exists
 * (mig 132). Sensitivity-clearance projection is WS-4 (WU-4.2).
 *
 * WU-1.5 (Q24 enforcement) is retired: pre-unification, `createEntity`
 * rejected direct inserts for `kind='person'|'company'|'deal'` to force
 * them through the CRM specialization tables. Mig 296 dropped those
 * tables — every kind now inserts directly here, and the CRM tools in
 * `crm.ts` are thin projections over this store.
 */

// (Removed) `CRM_SPECIALIZED_KINDS` guard. Post CRM→entity unification
// (docs/architecture/features/crm.md) there is no `contacts` /
// `companies` / `deals` specialization row to orphan — a person / company
// / deal IS just an `entities` row with its typed fields in `attributes`.
// `createEntity` accepts every kind directly; the CRM tools in `crm.ts`
// are thin projections over this store.

const FULL_SELECT = `
  id,
  kind,
  display_name AS "displayName",
  canonical_id AS "canonicalId",
  aliases,
  attributes,
  sensitivity,
  workspace_id AS "workspaceId",
  user_id AS "userId",
  assistant_id AS "assistantId",
  created_by_user_id AS "createdByUserId",
  created_by_assistant_id AS "createdByAssistantId",
  source_episode_id AS "sourceEpisodeId",
  source_session_id AS "sourceSessionId",
  source,
  verified_by_user_id AS "verifiedByUserId",
  verified_at AS "verifiedAt",
  valid_from AS "validFrom",
  valid_to AS "validTo",
  superseded_by AS "supersededBy",
  retracted_at AS "retractedAt",
  retracted_reason AS "retractedReason",
  retracted_by AS "retractedBy",
  centrality,
  centrality_computed_at AS "centralityComputedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const COMPACT_SELECT = `
  id,
  kind,
  display_name AS "displayName",
  canonical_id AS "canonicalId",
  sensitivity,
  workspace_id AS "workspaceId",
  source
`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type EntityRow = {
  id: string
  kind: string
  displayName: string
  canonicalId: string | null
  aliases: string[] | null
  attributes: Record<string, unknown> | null
  sensitivity: string
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string
  createdByAssistantId: string | null
  sourceEpisodeId: string | null
  sourceSessionId: string | null
  source: string
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  retractedBy: string | null
  centrality: number | string
  centralityComputedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toEntity(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    canonicalId: row.canonicalId,
    aliases: row.aliases ?? [],
    attributes: row.attributes ?? {},
    sensitivity: row.sensitivity as Sensitivity,
    workspaceId: row.workspaceId,
    userId: row.userId,
    assistantId: row.assistantId,
    createdByUserId: row.createdByUserId,
    createdByAssistantId: row.createdByAssistantId,
    sourceEpisodeId: row.sourceEpisodeId,
    sourceSessionId: row.sourceSessionId,
    source: row.source as EntitySource,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    supersededBy: row.supersededBy,
    retractedAt: row.retractedAt,
    retractedReason: row.retractedReason,
    retractedBy: row.retractedBy,
    centrality: typeof row.centrality === 'string' ? Number(row.centrality) : row.centrality,
    centralityComputedAt: row.centralityComputedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type EntityCompactRow = {
  id: string
  kind: string
  displayName: string
  canonicalId: string | null
  sensitivity: string
  workspaceId: string
  source: string
}

function toEntityListRow(row: EntityCompactRow): EntityListRow {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    canonicalId: row.canonicalId,
    sensitivity: row.sensitivity as Sensitivity,
    workspaceId: row.workspaceId,
    source: row.source as EntitySource,
  }
}

// ── Raw SQL helpers ──────────────────────────────────────────────────

export async function createEntity(params: EntityCreateParams): Promise<EntityRecord> {
  assertAuthorshipPresent('createEntity', params.createdByUserId)
  const result = await queryWithRLS<EntityRow>(
    params.createdByUserId,
    `INSERT INTO entities (
       kind, display_name, canonical_id, aliases, attributes, sensitivity,
       workspace_id, user_id, assistant_id,
       created_by_user_id, created_by_assistant_id, source_episode_id,
       source, compartments, source_session_id
     )
     VALUES (
       $1, $2, $3, $4::text[], $5::jsonb, $6,
       $7, $8, $9,
       $10, $11, $12,
       $13, $14::text[], $15
     )
     RETURNING ${FULL_SELECT}`,
    [
      params.kind,
      params.displayName,
      params.canonicalId ?? null,
      normalizeAliasArray(params.aliases ?? []),
      JSON.stringify(params.attributes ?? {}),
      params.sensitivity ?? 'internal',
      params.workspaceId,
      params.userId ?? null,
      params.assistantId ?? null,
      params.createdByUserId,
      params.createdByAssistantId ?? null,
      params.sourceEpisodeId ?? null,
      params.source,
      params.compartments ?? [],
      params.sourceSessionId ?? null,
    ],
  )
  return toEntity(result.rows[0])
}

/**
 * Normalize aliases for storage: lowercase + trim + dedup + drop empty.
 * Mirrors the contract `noteAlias` / write-time resolver enforce so
 * persisted rows are clean regardless of caller.
 */
function normalizeAliasArray(input: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const norm = raw.trim().toLowerCase()
    if (norm.length === 0 || norm.length > 200) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

/**
 * Self-entity materialisation — Identity Phase 2 groundwork.
 *
 * Returns the `kind='person'` entity row representing the user
 * themselves. Creates it lazily on first call and stamps
 * `users.entity_id` for follow-up calls to short-circuit.
 *
 * The self-entity is an ordinary `kind='person'` entities row with
 * `attributes.self=true` as the discriminator — it represents the user,
 * not a CRM contact. (Historical note: pre-unification a Q24 guard in
 * `createEntity` blocked raw `kind='person'` inserts to force contacts
 * through the CRM specialization tables; mig 296 dropped those tables
 * and the guard with them, so this insert no longer bypasses anything.)
 *
 * Workspace scoping: the self entity is created in the *passed*
 * workspace. A user with two workspaces ends up with one self entity
 * per workspace (they're different facts — the Sidan Labs you can be
 * different from the personal-account you), and `users.entity_id`
 * tracks only the most recent one. This is a deliberate punt; full
 * cross-workspace self-entity reconciliation is a follow-up if the
 * scenario arises.
 *
 * Spec: docs/architecture/brain/corrections.md.
 *
 * [COMP:brain/self-entity]
 */
export async function getOrCreateSelfEntity(params: {
  userId: string
  workspaceId: string
  displayName: string
}): Promise<EntityRecord> {
  // Fast path: users.entity_id already set + entity exists.
  const existing = await query<{ entityId: string | null }>(
    `SELECT entity_id AS "entityId" FROM users WHERE id = $1`,
    [params.userId],
  )
  const existingId = existing.rows[0]?.entityId
  if (existingId) {
    const row = await query<EntityRow>(
      `SELECT ${FULL_SELECT} FROM entities
       WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL`,
      [existingId, params.workspaceId],
    )
    if (row.rows[0]) return toEntity(row.rows[0])
    // entity_id stale (cross-workspace, deleted, or wrong workspace)
    // — fall through and create a new one for this workspace.
  }

  // Materialise. attributes.self=true is the discriminator for
  // follow-up tools that need to distinguish self entities from
  // regular contacts.
  const created = await query<EntityRow>(
    `INSERT INTO entities (
       kind, display_name, attributes, sensitivity,
       workspace_id, user_id, assistant_id,
       created_by_user_id, source
     )
     VALUES (
       'person', $1, $2::jsonb, 'internal',
       $3, $4, NULL,
       $4, 'user'
     )
     RETURNING ${FULL_SELECT}`,
    [params.displayName, JSON.stringify({ self: true }), params.workspaceId, params.userId],
  )
  const newEntity = toEntity(created.rows[0])

  // Stamp users.entity_id so subsequent calls skip the materialisation.
  await query(
    `UPDATE users SET entity_id = $1 WHERE id = $2`,
    [newEntity.id, params.userId],
  )

  return newEntity
}

/**
 * Update self-profile attributes on the user's self entity. Creates
 * the entity if it doesn't exist. Merges over existing attributes —
 * pass `{role: null}` to clear a key.
 *
 * Returns the updated entity.
 *
 * [COMP:brain/self-entity]
 */
export async function updateSelfEntityAttributes(params: {
  userId: string
  workspaceId: string
  displayName: string
  attributes: Record<string, unknown>
}): Promise<EntityRecord> {
  const self = await getOrCreateSelfEntity({
    userId: params.userId,
    workspaceId: params.workspaceId,
    displayName: params.displayName,
  })
  // Merge: jsonb concatenation operator (`||`) overrides keys from
  // the right operand. Self entity's existing attributes are preserved
  // unless explicitly overridden by the incoming payload.
  const merged = await query<EntityRow>(
    `UPDATE entities
        SET attributes = attributes || $2::jsonb,
            updated_at = now()
      WHERE id = $1 AND valid_to IS NULL
      RETURNING ${FULL_SELECT}`,
    [self.id, JSON.stringify(params.attributes)],
  )
  if (merged.rows.length === 0) {
    // Entity vanished between the get-or-create and the UPDATE — rare
    // but possible if a concurrent retraction landed. Return the
    // pre-update version rather than throw; the next call will
    // re-materialise.
    return self
  }
  return toEntity(merged.rows[0])
}

export async function getEntityById(
  ctx: AccessContext,
  id: string,
  opts: { asOf?: Date } = {},
): Promise<EntityRecord | null> {
  // WU-4.2b: universal projection (workspace + visibility-double +
  // optional clearance) gates cross-workspace UUID lookups.
  const ap = buildAccessPredicate(ctx, { startIdx: 3 })
  const result = await queryWithRLS<EntityRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entities
     WHERE id = $1
       AND valid_from <= COALESCE($2::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($2::timestamptz, now()))
       AND ${ap.sql}`,
    [id, opts.asOf ?? null, ...ap.params],
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

/**
 * System-level read — bypasses per-viewer projection. Used by D.7
 * audit / row-history surfaces (`getEntityHistory` consumers) and the
 * ingest pipeline's entity-dedup lookups. See `permissions.md`
 * § Privileged-service exception.
 */
export async function getEntityByIdSystem(
  actorUserId: string,
  id: string,
  opts: { asOf?: Date } = {},
): Promise<EntityRecord | null> {
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `SELECT ${FULL_SELECT} FROM entities
     WHERE id = $1
       AND valid_from <= COALESCE($2::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($2::timestamptz, now()))`,
    [id, opts.asOf ?? null],
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

export async function findEntityByName(
  ctx: AccessContext,
  displayName: string,
  opts: { kind?: EntityKind; asOf?: Date } = {},
): Promise<EntityRecord | null> {
  const ap = buildAccessPredicate(ctx)
  const nameIdx = ap.nextIdx
  const asOfIdx = ap.nextIdx + 1
  const values: unknown[] = [...ap.params, displayName, opts.asOf ?? null]
  let kindFilter = ''
  if (opts.kind) {
    values.push(opts.kind)
    kindFilter = `AND kind = $${values.length}`
  }
  // Match display_name OR any registered alias. Aliases are stored
  // lowercase; the input is lowercased for both sides of the OR.
  // `= ANY(aliases)` is GIN-indexable; the lower(display_name) leg is
  // a btree-on-expression candidate at workspace scale.
  const result = await queryWithRLS<EntityRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entities
     WHERE ${ap.sql}
       AND (lower(display_name) = lower($${nameIdx}) OR lower($${nameIdx}) = ANY(aliases))
       AND valid_from <= COALESCE($${asOfIdx}::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($${asOfIdx}::timestamptz, now()))
       ${kindFilter}
     ORDER BY (lower(display_name) = lower($${nameIdx})) DESC,
              created_at DESC
     LIMIT 1`,
    values,
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

/**
 * System-level lookup — bypasses per-viewer projection so the ingest
 * pipeline's entity-dedup pass can find matches written by any author
 * in the workspace. See `permissions.md` § Privileged-service exception.
 */
export async function findEntityByNameSystem(
  actorUserId: string,
  workspaceId: string,
  displayName: string,
  opts: { kind?: EntityKind; asOf?: Date } = {},
): Promise<EntityRecord | null> {
  const values: unknown[] = [workspaceId, displayName, opts.asOf ?? null]
  let kindFilter = ''
  if (opts.kind) {
    values.push(opts.kind)
    kindFilter = `AND kind = $${values.length}`
  }
  // Match display_name OR any registered alias (see findEntityByName
  // for the rationale on indexing + ordering).
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `SELECT ${FULL_SELECT} FROM entities
     WHERE workspace_id = $1
       AND (lower(display_name) = lower($2) OR lower($2) = ANY(aliases))
       AND valid_from <= COALESCE($3::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($3::timestamptz, now()))
       ${kindFilter}
     ORDER BY (lower(display_name) = lower($2)) DESC,
              created_at DESC
     LIMIT 1`,
    values,
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

export async function findEntitiesByCanonicalId(
  ctx: AccessContext,
  canonicalId: string,
  opts: { asOf?: Date } = {},
): Promise<EntityRecord[]> {
  const ap = buildAccessPredicate(ctx)
  const cidIdx = ap.nextIdx
  const asOfIdx = ap.nextIdx + 1
  const result = await queryWithRLS<EntityRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entities
     WHERE ${ap.sql}
       AND canonical_id = $${cidIdx}
       AND valid_from <= COALESCE($${asOfIdx}::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($${asOfIdx}::timestamptz, now()))
     ORDER BY created_at DESC`,
    [...ap.params, canonicalId, opts.asOf ?? null],
  )
  return result.rows.map(toEntity)
}

/**
 * System-level lookup — bypasses per-viewer projection so the ingest
 * pipeline's entity-dedup pass can match against canonical_id rows
 * written by any author in the workspace.
 */
export async function findEntitiesByCanonicalIdSystem(
  actorUserId: string,
  workspaceId: string,
  canonicalId: string,
  opts: { asOf?: Date } = {},
): Promise<EntityRecord[]> {
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `SELECT ${FULL_SELECT} FROM entities
     WHERE workspace_id = $1
       AND canonical_id = $2
       AND valid_from <= COALESCE($3::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($3::timestamptz, now()))
     ORDER BY created_at DESC`,
    [workspaceId, canonicalId, opts.asOf ?? null],
  )
  return result.rows.map(toEntity)
}

/**
 * Self-healing read — find live entity clusters that collide on
 * (workspace_id, kind, lower(display_name)). Drives the `dedupeEntities`
 * chat tool and any future background dedupe phase. System-level: skips
 * the per-viewer projection so the dedupe surface mirrors what Pipeline
 * B sees when it writes.
 */
export async function findEntityDuplicateClustersSystem(
  actorUserId: string,
  workspaceId: string,
  opts: { limit?: number; kind?: EntityKind } = {},
): Promise<{ kind: EntityKind; displayNameNormalized: string; entityIds: string[] }[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const values: unknown[] = [workspaceId]
  let kindFilter = ''
  if (opts.kind) {
    values.push(opts.kind)
    kindFilter = `AND kind = $${values.length}`
  }
  values.push(limit)
  const limitIdx = values.length
  const result = await queryWithRLS<{
    kind: string
    display_name_normalized: string
    entity_ids: string[]
  }>(
    actorUserId,
    `SELECT
        kind,
        lower(display_name) AS display_name_normalized,
        array_agg(id ORDER BY created_at ASC, id ASC) AS entity_ids
       FROM entities
      WHERE workspace_id = $1
        AND valid_to IS NULL
        ${kindFilter}
      GROUP BY kind, lower(display_name)
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT $${limitIdx}`,
    values,
  )
  return result.rows.map((r) => ({
    kind: r.kind as EntityKind,
    displayNameNormalized: r.display_name_normalized,
    entityIds: r.entity_ids,
  }))
}

/**
 * System-level workspace listing — returns full `EntityRecord` rows
 * (including `aliases` + `attributes`) for live entities in the
 * workspace, ordered newest-first. Backs the alias clusterer pass
 * inside `runEntityDedupe`.
 */
export async function listLiveEntitiesForWorkspaceSystem(
  actorUserId: string,
  workspaceId: string,
  opts: { limit?: number; kind?: EntityKind } = {},
): Promise<EntityRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
  const values: unknown[] = [workspaceId]
  let kindFilter = ''
  if (opts.kind) {
    values.push(opts.kind)
    kindFilter = `AND kind = $${values.length}`
  }
  values.push(limit)
  const limitIdx = values.length
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `SELECT ${FULL_SELECT} FROM entities
      WHERE workspace_id = $1
        AND valid_to IS NULL
        ${kindFilter}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}`,
    values,
  )
  return result.rows.map(toEntity)
}

/**
 * Cross-kind dedup read — find live entities that share
 * `(workspace_id, lower(display_name))` but split across kinds. Most
 * common cause: the extraction LLM classifies the same thing as a
 * `company` on one pass and a `project` on the next, leaving two
 * entity rows that the within-kind pass cannot collapse.
 *
 * `entityIds` is co-sorted with `kinds` so the caller can apply a
 * survivor priority (CRM kinds beat structural kinds — see
 * `runEntityDedupe`). Only clusters with `count <= maxClusterSize`
 * are returned so legitimately-ambiguous broadly-shared names
 * (e.g. "Apple" the company vs "apple" the product across many
 * extractions) don't get auto-collapsed.
 */
export async function findCrossKindDuplicateClustersSystem(
  actorUserId: string,
  workspaceId: string,
  opts: { limit?: number; maxClusterSize?: number } = {},
): Promise<{ displayNameNormalized: string; kinds: EntityKind[]; entityIds: string[]; createdAts: Date[] }[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const maxCluster = Math.min(Math.max(opts.maxClusterSize ?? 10, 2), 100)
  const result = await queryWithRLS<{
    display_name_normalized: string
    kinds: string[]
    entity_ids: string[]
    created_ats: Date[]
  }>(
    actorUserId,
    `SELECT
        lower(display_name) AS display_name_normalized,
        array_agg(kind       ORDER BY created_at ASC, id ASC) AS kinds,
        array_agg(id         ORDER BY created_at ASC, id ASC) AS entity_ids,
        array_agg(created_at ORDER BY created_at ASC, id ASC) AS created_ats
       FROM entities
      WHERE workspace_id = $1
        AND valid_to IS NULL
      GROUP BY lower(display_name)
     HAVING COUNT(DISTINCT kind) > 1
        AND COUNT(*) <= $2
      ORDER BY COUNT(*) DESC
      LIMIT $3`,
    [workspaceId, maxCluster, limit],
  )
  return result.rows.map((r) => ({
    displayNameNormalized: r.display_name_normalized,
    kinds: r.kinds as EntityKind[],
    entityIds: r.entity_ids,
    createdAts: r.created_ats,
  }))
}

// ── Alias mutators ────────────────────────────────────────────────────

/**
 * Append a lowercased alias to an entity's `aliases`. Idempotent —
 * duplicate aliases are de-duped. Returns `conflict` (with the other
 * entity's id) when the alias is already bound to a different live
 * entity in the same workspace; the caller surfaces that to the user
 * who decides whether to merge or split.
 *
 * RLS-gated (the caller must have workspace membership). Empty / >200
 * char aliases throw — caller normalizes / validates input.
 */
export async function addEntityAlias(
  actorUserId: string,
  entityId: string,
  alias: string,
): Promise<
  | { kind: 'ok'; entity: EntityRecord }
  | { kind: 'conflict'; conflictingEntityId: string }
  | { kind: 'not_found' }
> {
  const normalized = alias.trim().toLowerCase()
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error('alias must be 1-200 characters after trim')
  }

  // Look up the target entity (and its workspace) under RLS.
  const target = await queryWithRLS<{ workspaceId: string; displayName: string }>(
    actorUserId,
    `SELECT workspace_id AS "workspaceId", display_name AS "displayName"
       FROM entities
      WHERE id = $1 AND valid_to IS NULL`,
    [entityId],
  )
  if (target.rows.length === 0) return { kind: 'not_found' }
  const { workspaceId, displayName } = target.rows[0]

  // Self-alias check — adding an entity's own display_name as alias is
  // a no-op (lookups already match display_name). Still allowed so
  // callers don't have to special-case; just don't store the redundancy.
  if (displayName.toLowerCase() === normalized) {
    const fresh = await queryWithRLS<EntityRow>(
      actorUserId,
      `SELECT ${FULL_SELECT} FROM entities WHERE id = $1`,
      [entityId],
    )
    return { kind: 'ok', entity: toEntity(fresh.rows[0]) }
  }

  // Conflict check — does another live entity in this workspace already
  // claim this alias (or have it as its display_name)? GIN-indexed.
  const conflict = await queryWithRLS<{ id: string }>(
    actorUserId,
    `SELECT id FROM entities
      WHERE workspace_id = $1
        AND id <> $2
        AND valid_to IS NULL
        AND (lower(display_name) = $3 OR $3 = ANY(aliases))
      LIMIT 1`,
    [workspaceId, entityId, normalized],
  )
  if (conflict.rows.length > 0) {
    return { kind: 'conflict', conflictingEntityId: conflict.rows[0].id }
  }

  // Append + dedup in a single statement so concurrent writers can't
  // race a duplicate in.
  const updated = await queryWithRLS<EntityRow>(
    actorUserId,
    `UPDATE entities
        SET aliases = (
              SELECT array_agg(DISTINCT a)
                FROM unnest(aliases || ARRAY[$2]::text[]) AS a
            ),
            updated_at = now()
      WHERE id = $1 AND valid_to IS NULL
      RETURNING ${FULL_SELECT}`,
    [entityId, normalized],
  )
  if (updated.rows.length === 0) return { kind: 'not_found' }
  return { kind: 'ok', entity: toEntity(updated.rows[0]) }
}

export async function removeEntityAlias(
  actorUserId: string,
  entityId: string,
  alias: string,
): Promise<EntityRecord | null> {
  const normalized = alias.trim().toLowerCase()
  if (normalized.length === 0) return null
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `UPDATE entities
        SET aliases = array_remove(aliases, $2),
            updated_at = now()
      WHERE id = $1 AND valid_to IS NULL
      RETURNING ${FULL_SELECT}`,
    [entityId, normalized],
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

export async function listEntities(
  ctx: AccessContext,
  opts: { kind?: EntityKind; limit?: number; offset?: number; asOf?: Date } = {},
): Promise<EntityListRow[]> {
  // Ceiling 1001 = the graph route's max ask (`nodeLimit + 1` at its 1000
  // cap — the +1 is the truncation sentinel). The old 200 ceiling silently
  // starved `GET /api/brain/graph` on entity-heavy workspaces: a 560-entity
  // brain rendered 200 nodes with `truncated: false` (no badge), because the
  // route never saw enough candidates to know the cap had tripped.
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1001)
  const offset = Math.max(opts.offset ?? 0, 0)
  const ap = buildAccessPredicate(ctx)
  const asOfIdx = ap.nextIdx
  const limIdx = ap.nextIdx + 1
  const offIdx = ap.nextIdx + 2
  const values: unknown[] = [...ap.params, opts.asOf ?? null, limit, offset]
  let kindFilter = ''
  if (opts.kind) {
    values.push(opts.kind)
    kindFilter = `AND kind = $${values.length}`
  }
  const result = await queryWithRLS<EntityCompactRow>(
    ctx.userId,
    `SELECT ${COMPACT_SELECT} FROM entities
     WHERE ${ap.sql}
       AND valid_from <= COALESCE($${asOfIdx}::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($${asOfIdx}::timestamptz, now()))
       ${kindFilter}
     ORDER BY updated_at DESC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map(toEntityListRow)
}

/**
 * In-place entity update by id, matched under the caller's viewer
 * projection (read/write symmetry — the write-path half of the
 * "access-scoped" rule in `docs/architecture/features/crm.md`): a
 * caller must never patch a row that reads hide from them, or one
 * member's write mutates another principal's private record while
 * every list/get correctly hides it (the 2026-07-05 dedupe incident's
 * surviving write sibling).
 *
 * `access` present → the full universal access predicate is embedded in
 * the UPDATE's WHERE. Absent (legacy writers holding only a user id) →
 * falls back to the user-axis projection (`user_id IS NULL OR user_id =
 * actor`), the same fallback shape the dedupe scan documents.
 */
export async function updateEntity(
  actorUserId: string,
  id: string,
  fields: EntityUpdateFields,
  access?: AccessContext,
): Promise<EntityRecord | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (fields.displayName !== undefined) {
    sets.push(`display_name = $${idx++}`)
    values.push(fields.displayName)
  }
  if (fields.canonicalId !== undefined) {
    sets.push(`canonical_id = $${idx++}`)
    values.push(fields.canonicalId)
  }
  if (fields.attributes !== undefined) {
    sets.push(`attributes = $${idx++}::jsonb`)
    values.push(JSON.stringify(fields.attributes))
  }
  if (fields.sensitivity !== undefined) {
    sets.push(`sensitivity = $${idx++}`)
    values.push(fields.sensitivity)
  }
  if (fields.verifiedByUserId !== undefined) {
    sets.push(`verified_by_user_id = $${idx++}`)
    values.push(fields.verifiedByUserId)
  }
  if (fields.verifiedAt !== undefined) {
    sets.push(`verified_at = $${idx++}`)
    values.push(fields.verifiedAt)
  }

  if (sets.length === 0) {
    return access ? getEntityById(access, id) : getEntityByIdSystem(actorUserId, id)
  }

  sets.push('updated_at = now()')
  values.push(id)

  let guard: string
  if (access) {
    const ap = buildAccessPredicate(access, { startIdx: idx + 1 })
    guard = ap.sql
    values.push(...ap.params)
  } else {
    guard = `(user_id IS NULL OR user_id = $${idx + 1})`
    values.push(actorUserId)
  }

  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `UPDATE entities
        SET ${sets.join(', ')}
      WHERE id = $${idx}
        AND ${guard}
      RETURNING ${FULL_SELECT}`,
    values,
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

/**
 * Bi-temporal supersession of a currently-valid entity row.
 *
 * Closes the old row (`valid_to = now()`, `superseded_by = <new id>`)
 * and inserts a fresh row with the merged attributes. Both writes run in
 * one transaction so a reader never sees zero or two live rows for the
 * identity. Mirrors the `tasks.ts` / `crm.ts` supersession pattern.
 *
 * `kind`, `display_name`, `canonical_id`, the visibility double, and the
 * trust signals carry forward from the old row unless the patch
 * overrides them. The new row's `source_episode_id` is the triggering
 * Episode (data-model.md §Provenance pattern — the new row points at the
 * Episode that changed the belief).
 *
 * Returns the new (currently-valid) row, or `null` when `id` does not
 * resolve to a live row.
 */
export async function supersedeEntity(
  actorUserId: string,
  id: string,
  patch: EntitySupersedePatch,
): Promise<EntityRecord | null> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    // Runs on the app pool (app_user, subject to RLS). SET LOCAL actor scope
    // reverts at COMMIT/ROLLBACK to the seeded sentinel, so no stale
    // current_user_id survives onto the pooled connection.
    await client.query(
      `SET LOCAL app.current_user_id = '${actorUserId.replace(/'/g, "''")}'`,
    )
    try {
      // Lock the live row so a concurrent supersede can't double-close it.
      const oldRes = await client.query<EntityRow>(
        `SELECT ${FULL_SELECT} FROM entities
          WHERE id = $1 AND valid_to IS NULL
          FOR UPDATE`,
        [id],
      )
      if (oldRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const old = toEntity(oldRes.rows[0])

      const insertRes = await client.query<EntityRow>(
        `INSERT INTO entities (
           kind, display_name, canonical_id, aliases, attributes, sensitivity,
           workspace_id, user_id, assistant_id,
           created_by_user_id, created_by_assistant_id, source_episode_id,
           source, verified_by_user_id, verified_at,
           source_session_id,
           valid_from, valid_to, superseded_by
         )
         VALUES (
           $1, $2, $3, $4::text[], $5::jsonb, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15,
           $16,
           now(), NULL, NULL
         )
         RETURNING ${FULL_SELECT}`,
        [
          old.kind,
          patch.displayName ?? old.displayName,
          patch.canonicalId !== undefined ? patch.canonicalId : old.canonicalId,
          // Aliases carry forward — user-curated identity data outlives
          // attribute supersession. If the new patch supplies aliases we
          // could merge here; v1 just carries the old set forward.
          old.aliases,
          JSON.stringify(patch.attributes),
          patch.sensitivity ?? old.sensitivity,
          old.workspaceId,
          old.userId,
          old.assistantId,
          old.createdByUserId,
          old.createdByAssistantId,
          patch.sourceEpisodeId !== undefined
            ? patch.sourceEpisodeId
            : old.sourceEpisodeId,
          patch.source ?? old.source,
          old.verifiedByUserId,
          old.verifiedAt,
          // The originating conversation carries forward — supersession
          // changes the belief, not where the row came from.
          old.sourceSessionId,
        ],
      )
      const newRow = insertRes.rows[0]

      await client.query(
        `UPDATE entities
            SET valid_to = now(), superseded_by = $2, updated_at = now()
          WHERE id = $1 AND valid_to IS NULL`,
        [id, newRow.id],
      )

      await client.query('COMMIT')
      return toEntity(newRow)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

/**
 * D.7 supersession audit walker — every version of an entity's chain,
 * oldest → newest by `valid_from`. Bidirectional from any id in the
 * chain (head, tail, or middle) via a recursive CTE that walks
 * `superseded_by` both directions.
 *
 * Viewer-facing variant: the anchor row is gated through
 * `buildAccessPredicate`; every row in a supersession chain shares the
 * same universal-column tuple (per D.7), so the recursive walk inherits
 * the same projection without re-checking each version. The unified
 * `getRowHistory({ primitive, row_id })` surface in `row-history-store.ts`
 * (WU-6.9) calls this from the user-facing tool.
 */
export async function getEntityHistory(ctx: AccessContext, id: string): Promise<EntityRecord[]> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 2 })
  const result = await queryWithRLS<EntityRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT e.id, e.superseded_by
         FROM entities e
        WHERE e.id = $1
          AND ${ap.sql}
       UNION
       SELECT e.id, e.superseded_by
         FROM entities e, chain c
        WHERE e.id = c.superseded_by OR e.superseded_by = c.id
     )
     SELECT ${FULL_SELECT} FROM entities
      WHERE id IN (SELECT id FROM chain)
      ORDER BY valid_from ASC, created_at ASC`,
    [id, ...ap.params],
  )
  return result.rows.map(toEntity)
}

/**
 * System-level supersession audit walker — same chain semantics as
 * `getEntityHistory`, but bypasses per-viewer projection. Reserved for
 * privileged audit / D.7 surfaces (e.g. admin reconciliation).
 */
export async function getEntityHistorySystem(actorUserId: string, id: string): Promise<EntityRecord[]> {
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM entities WHERE id = $1
       UNION
       SELECT e.id, e.superseded_by
         FROM entities e, chain c
        WHERE e.id = c.superseded_by OR e.superseded_by = c.id
     )
     SELECT ${FULL_SELECT} FROM entities
      WHERE id IN (SELECT id FROM chain)
      ORDER BY valid_from ASC, created_at ASC`,
    [id],
  )
  return result.rows.map(toEntity)
}

// ── Cross-primitive rollup helpers (WU-1.8 / WU-5.2) ─────────────────
//
// Each helper walks `entity_links` to find rows of one primitive kind
// linked to the entity, then joins the primitive's table for the row
// payload. Direction-per-primitive mirrors the edge vocabulary in
// `packages/core/src/entities/edges.ts`:
//
//   memory  → entity (e.g., `mentioned`)           : INBOUND  to entity
//   task    → entity (e.g., `mentioned`)           : INBOUND  to entity
//   episode → entity (`mentioned`)                 : INBOUND  to entity
//   entity  → file   (`documented_by`)             : OUTBOUND from entity
//
// Bi-temporal predicate cascades through both endpoints of every JOIN.
// On `entity_links` it gates `retracted_at IS NULL` + `valid_from <= asOf`
// + `(valid_to IS NULL OR valid_to > asOf)`. On the primitive side,
// memories / tasks / workspace_files carry the same universal columns
// (mig 128) so they get the same predicate. Episodes are append-only
// and have no universal columns — they collapse to `ingested_at <= asOf`
// per `episodes-store.ts` ("what the system had observed by time T").
//
// `kb_chunks` count returns 0 — wiring is WU-3.7. Sensitivity ≤
// clearance projection is WS-4 (WU-4.2). RLS handles workspace
// partition today.

/** Bi-temporal predicate fragment for entity_links rows. Parameterized
 *  by the bound-parameter index so callers can compose into their
 *  own argument list. */
function linkTemporalPredicate(asOfParamIdx: number): string {
  const p = `$${asOfParamIdx}`
  return `el.retracted_at IS NULL
        AND el.valid_from <= COALESCE(${p}::timestamptz, now())
        AND (el.valid_to IS NULL OR el.valid_to > COALESCE(${p}::timestamptz, now()))`
}

/** Bi-temporal predicate fragment for a primitive row carrying the
 *  universal columns from mig 128 (`retracted_at`, `valid_from`,
 *  `valid_to`). Parameterized by SQL alias and bound-parameter index so
 *  callers compose it into their existing argument list without
 *  re-binding `asOf`. */
function primitiveTemporalPredicate(alias: string, asOfParamIdx: number): string {
  const p = `$${asOfParamIdx}`
  return `${alias}.retracted_at IS NULL
        AND ${alias}.valid_from <= COALESCE(${p}::timestamptz, now())
        AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > COALESCE(${p}::timestamptz, now()))`
}

const ROLLUP_DEFAULT_LIMIT = 5

type MemoryRollupRow = {
  id: string
  summary: string
  detail: string | null
  tags: string[] | null
  sensitivity: string
  edgeType: string
  createdAt: Date
  updatedAt: Date
}

type TaskRollupRow = {
  id: string
  title: string
  status: string
  assigneeId: string | null
  due: Date | null
  tags: string[] | null
  edgeType: string
  createdAt: Date
  updatedAt: Date
}

type FileRollupRow = {
  id: string
  path: string
  name: string
  title: string | null
  mime: string
  sensitivity: string
  tags: string[] | null
  edgeType: string
  createdAt: Date
  updatedAt: Date
}

type EpisodeRollupRow = {
  id: string
  sourceKind: string
  occurredAt: Date
  ingestedAt: Date
  status: string
  summaryText: string | null
  sensitivity: string
  edgeType: string
  createdAt: Date
}

async function countMemoriesForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date } = {},
): Promise<number> {
  const ap = buildAccessPredicate(ctx, { alias: 'm', startIdx: 3 })
  const result = await queryWithRLS<{ n: string }>(
    ctx.userId,
    `SELECT COUNT(*)::text AS n
       FROM entity_links el
       JOIN memories m ON m.id = el.source_id
      WHERE el.source_kind = 'memory'
        AND el.target_kind = 'entity'
        AND el.target_id = $2
        AND ${ap.sql}
        AND ${linkTemporalPredicate(1)}
        AND ${primitiveTemporalPredicate('m', 1)}`,
    [opts.asOf ?? null, entityId, ...ap.params],
  )
  return Number(result.rows[0]?.n ?? 0)
}

async function getRecentMemoriesForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date; limit?: number } = {},
): Promise<MemoryRollupRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? ROLLUP_DEFAULT_LIMIT, 1), 100)
  const ap = buildAccessPredicate(ctx, { alias: 'm', startIdx: 3 })
  const limIdx = ap.nextIdx
  const result = await queryWithRLS<MemoryRollupRow>(
    ctx.userId,
    `SELECT m.id,
            m.summary,
            m.detail,
            m.tags,
            m.sensitivity,
            el.edge_type AS "edgeType",
            m.created_at AS "createdAt",
            m.updated_at AS "updatedAt"
       FROM entity_links el
       JOIN memories m ON m.id = el.source_id
      WHERE el.source_kind = 'memory'
        AND el.target_kind = 'entity'
        AND el.target_id = $2
        AND ${ap.sql}
        AND ${linkTemporalPredicate(1)}
        AND ${primitiveTemporalPredicate('m', 1)}
      ORDER BY el.created_at DESC
      LIMIT $${limIdx}`,
    [opts.asOf ?? null, entityId, ...ap.params, limit],
  )
  return result.rows
}

async function countOpenTasksForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date } = {},
): Promise<number> {
  const ap = buildAccessPredicate(ctx, { alias: 't', startIdx: 3 })
  const result = await queryWithRLS<{ n: string }>(
    ctx.userId,
    `SELECT COUNT(*)::text AS n
       FROM entity_links el
       JOIN tasks t ON t.id = el.source_id
      WHERE el.source_kind = 'task'
        AND el.target_kind = 'entity'
        AND el.target_id = $2
        AND ${ap.sql}
        AND t.status NOT IN ('done', 'archived')
        AND ${linkTemporalPredicate(1)}
        AND ${primitiveTemporalPredicate('t', 1)}`,
    [opts.asOf ?? null, entityId, ...ap.params],
  )
  return Number(result.rows[0]?.n ?? 0)
}

async function getOpenTasksForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date; limit?: number } = {},
): Promise<TaskRollupRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? ROLLUP_DEFAULT_LIMIT, 1), 100)
  const ap = buildAccessPredicate(ctx, { alias: 't', startIdx: 3 })
  const limIdx = ap.nextIdx
  const result = await queryWithRLS<TaskRollupRow>(
    ctx.userId,
    `SELECT t.id,
            t.title,
            t.status,
            t.assignee_id AS "assigneeId",
            t.due,
            t.tags,
            el.edge_type AS "edgeType",
            t.created_at AS "createdAt",
            t.updated_at AS "updatedAt"
       FROM entity_links el
       JOIN tasks t ON t.id = el.source_id
      WHERE el.source_kind = 'task'
        AND el.target_kind = 'entity'
        AND el.target_id = $2
        AND ${ap.sql}
        AND t.status NOT IN ('done', 'archived')
        AND ${linkTemporalPredicate(1)}
        AND ${primitiveTemporalPredicate('t', 1)}
      ORDER BY el.created_at DESC
      LIMIT $${limIdx}`,
    [opts.asOf ?? null, entityId, ...ap.params, limit],
  )
  return result.rows
}

async function countFilesForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date } = {},
): Promise<number> {
  const ap = buildAccessPredicate(ctx, { alias: 'f', startIdx: 3 })
  const result = await queryWithRLS<{ n: string }>(
    ctx.userId,
    `SELECT COUNT(*)::text AS n
       FROM entity_links el
       JOIN workspace_files f ON f.id = el.target_id
      WHERE el.source_kind = 'entity'
        AND el.source_id = $2
        AND el.target_kind = 'file'
        AND ${ap.sql}
        AND ${linkTemporalPredicate(1)}
        AND ${primitiveTemporalPredicate('f', 1)}`,
    [opts.asOf ?? null, entityId, ...ap.params],
  )
  return Number(result.rows[0]?.n ?? 0)
}

async function getRecentFilesForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date; limit?: number } = {},
): Promise<FileRollupRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? ROLLUP_DEFAULT_LIMIT, 1), 100)
  const ap = buildAccessPredicate(ctx, { alias: 'f', startIdx: 3 })
  const limIdx = ap.nextIdx
  const result = await queryWithRLS<FileRollupRow>(
    ctx.userId,
    `SELECT f.id,
            f.path,
            f.name,
            f.title,
            f.mime,
            f.sensitivity,
            f.tags,
            el.edge_type AS "edgeType",
            f.created_at AS "createdAt",
            f.updated_at AS "updatedAt"
       FROM entity_links el
       JOIN workspace_files f ON f.id = el.target_id
      WHERE el.source_kind = 'entity'
        AND el.source_id = $2
        AND el.target_kind = 'file'
        AND ${ap.sql}
        AND ${linkTemporalPredicate(1)}
        AND ${primitiveTemporalPredicate('f', 1)}
      ORDER BY el.created_at DESC
      LIMIT $${limIdx}`,
    [opts.asOf ?? null, entityId, ...ap.params, limit],
  )
  return result.rows
}

// Episodes use the canonical `mentioned` edge with `source_kind='episode'`
// → INBOUND to entity (matches the memory / task pattern). Episodes are
// append-only and carry no `valid_from`/`valid_to` — the temporal
// predicate on the primitive side collapses to `e.ingested_at <= asOf`
// ("what the system had observed by time T"). Universal projection still
// applies because mig 129 gave episodes the (workspace_id, user_id,
// assistant_id, sensitivity) tuple.
async function countEpisodesForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date } = {},
): Promise<number> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 3 })
  const result = await queryWithRLS<{ n: string }>(
    ctx.userId,
    `SELECT COUNT(*)::text AS n
       FROM entity_links el
       JOIN episodes e ON e.id = el.source_id
      WHERE el.source_kind = 'episode'
        AND el.target_kind = 'entity'
        AND el.target_id = $2
        AND ${ap.sql}
        AND e.ingested_at <= COALESCE($1::timestamptz, now())
        AND ${linkTemporalPredicate(1)}`,
    [opts.asOf ?? null, entityId, ...ap.params],
  )
  return Number(result.rows[0]?.n ?? 0)
}

async function getRecentEpisodesForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date; limit?: number } = {},
): Promise<EpisodeRollupRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? ROLLUP_DEFAULT_LIMIT, 1), 100)
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 3 })
  const limIdx = ap.nextIdx
  const result = await queryWithRLS<EpisodeRollupRow>(
    ctx.userId,
    `SELECT e.id,
            e.source_kind  AS "sourceKind",
            e.occurred_at  AS "occurredAt",
            e.ingested_at  AS "ingestedAt",
            e.status,
            e.summary_text AS "summaryText",
            e.sensitivity,
            el.edge_type   AS "edgeType",
            e.created_at   AS "createdAt"
       FROM entity_links el
       JOIN episodes e ON e.id = el.source_id
      WHERE el.source_kind = 'episode'
        AND el.target_kind = 'entity'
        AND el.target_id = $2
        AND ${ap.sql}
        AND e.ingested_at <= COALESCE($1::timestamptz, now())
        AND ${linkTemporalPredicate(1)}
      ORDER BY el.created_at DESC
      LIMIT $${limIdx}`,
    [opts.asOf ?? null, entityId, ...ap.params, limit],
  )
  return result.rows
}

// TODO(WS-3 WU-3.7): wire to `kb_chunks` for the rollup. The table
// itself ships in mig 132, but rollup wiring is explicitly part of
// WU-3.7 — keep the stub so this WU stays scoped to entities-store.
// No embedded section per the spec — `kb_chunk_count` lives in
// `summary` only.
async function countKbChunksForEntity(): Promise<number> {
  return 0
}

async function getEntityRollup(
  deps: { entityLinks: EntityLinksStore },
  ctx: AccessContext,
  idOrName: string,
  opts: GetEntityOpts = {},
): Promise<EntityRollup | null> {
  const isUuid = UUID_RE.test(idOrName)
  let entity: EntityRecord | null = isUuid
    ? await getEntityById(ctx, idOrName, { asOf: opts.asOf })
    : await findEntityByName(ctx, idOrName, { asOf: opts.asOf })

  if (!entity) return null

  // Defensive workspace guard. RLS + buildAccessPredicate are the
  // primary gates; this catches the cross-workspace UUID-lookup case
  // explicitly so the caller doesn't get a row from a foreign workspace
  // even if a future predicate change loosens the projection.
  if (entity.workspaceId !== ctx.workspaceId) return null

  let followedSupersession: EntityRollup['followedSupersession']
  if (!opts.strictIdentity && entity.supersededBy) {
    const target = await getEntityById(ctx, entity.supersededBy, { asOf: opts.asOf })
    if (target) {
      followedSupersession = {
        fromId: entity.id,
        toId: target.id,
        supersededAt: entity.validTo,
      }
      entity = target
    }
  }

  const edgeLimit = opts.edgeLimit ?? 10
  const targetEntityId = entity.id
  const asOf = opts.asOf

  const [
    edgeCount,
    edgesOutbound,
    edgesInbound,
    memoryCount,
    recentMemory,
    openTaskCount,
    openTasks,
    fileCount,
    files,
    episodeCount,
    recentEpisodes,
    kbChunkCount,
  ] = await Promise.all([
    deps.entityLinks.countForEntity(ctx, targetEntityId, { asOf }),
    deps.entityLinks.walkOutbound(ctx, 'entity', targetEntityId, {
      asOf,
      limit: edgeLimit,
    }),
    deps.entityLinks.walkInbound(ctx, 'entity', targetEntityId, {
      asOf,
      limit: edgeLimit,
    }),
    countMemoriesForEntity(ctx, targetEntityId, { asOf }),
    getRecentMemoriesForEntity(ctx, targetEntityId, { asOf }),
    countOpenTasksForEntity(ctx, targetEntityId, { asOf }),
    getOpenTasksForEntity(ctx, targetEntityId, { asOf }),
    countFilesForEntity(ctx, targetEntityId, { asOf }),
    getRecentFilesForEntity(ctx, targetEntityId, { asOf }),
    countEpisodesForEntity(ctx, targetEntityId, { asOf }),
    getRecentEpisodesForEntity(ctx, targetEntityId, { asOf }),
    countKbChunksForEntity(),
  ])

  // `edge_count` already includes both directions (entity-links-store's
  // `countForEntity` ORs the endpoints). Mirror that on the embedded
  // list: merge outbound + inbound, dedupe by id (self-loops would
  // otherwise double-count), sort by createdAt desc, cap to edgeLimit.
  const seenEdgeIds = new Set<string>()
  const edges = [...edgesOutbound, ...edgesInbound]
    .filter((e) => {
      if (seenEdgeIds.has(e.id)) return false
      seenEdgeIds.add(e.id)
      return true
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, edgeLimit)

  const summary: EntityRollupSummary = {
    edge_count: edgeCount,
    memory_count: memoryCount,
    episode_count: episodeCount,
    open_task_count: openTaskCount,
    file_count: fileCount,
    kb_chunk_count: kbChunkCount,
  }

  const embedded: EntityRollupEmbedded = {
    edges,
    recent_episodes: recentEpisodes,
    recent_memory: recentMemory,
    open_tasks: openTasks,
    files,
  }

  const rollup: EntityRollup = {
    entity,
    summary,
    embedded,
  }
  if (followedSupersession) rollup.followedSupersession = followedSupersession
  return rollup
}

// ── Kind reclassification / CRM promotion ───────────────────────────
//
// The brain-inbox detail panel exposes "change type" to users who notice
// the extractor mis-classified an entity (the canonical case: a company
// extracted as `kind='product'` because the chat phrased it like one).
// Two distinct paths, both entities-only since the CRM unification
// (mig 296 dropped the contacts/companies/deals companion tables):
//
//   1. NON-CRM kind change — direct UPDATE on entities.kind. Allowed
//      between any pair of non-CRM kinds (product, project, topic,
//      event, tenant.* namespaces). Cheap.
//
//   2. CRM PROMOTION — entity goes to kind='person'|'company'|'deal'.
//      Typed CRM fields (email/phone/domain/stage/amount/closeDate)
//      merge into `attributes`, and `canonical_id` picks up the natural
//      key (email for person, domain for company). One UPDATE inside a
//      row-locked transaction so a concurrent promote/supersede can't
//      race.
//
// Demote-from-CRM (e.g. company → product) is intentionally NOT
// supported here. Users who want to drop the CRM specialization retract
// through the corrections surface; reclassifying the entity afterwards
// then goes through path 1.

export type ReclassifyEntityKindParams = {
  /** Target kind. Must NOT be a CRM-specialized kind. */
  kind: EntityKind
}

/**
 * Path 1 — direct kind change between non-CRM kinds. CRM targets are
 * rejected upstream (route validation) and must go through
 * `promoteEntityToCrm` instead, so typed attributes + canonical_id land.
 * Returns `null` when the entity doesn't exist / isn't live / belongs
 * to a workspace the actor can't see.
 */
export async function reclassifyEntityKind(
  actorUserId: string,
  id: string,
  params: ReclassifyEntityKindParams,
): Promise<EntityRecord | null> {
  const result = await queryWithRLS<EntityRow>(
    actorUserId,
    `UPDATE entities
        SET kind = $1, updated_at = now()
      WHERE id = $2 AND valid_to IS NULL
      RETURNING ${FULL_SELECT}`,
    [params.kind, id],
  )
  if (result.rows.length === 0) return null
  return toEntity(result.rows[0])
}

export type PromoteEntityToCrmParams = {
  /** Target CRM kind. */
  kind: 'person' | 'company' | 'deal'
  /** Name override. Defaults to the entity's current display_name. */
  name?: string
  // Common across all kinds.
  tags?: string[]
  // Company-specific.
  domain?: string | null
  // Contact-specific (kind='person').
  email?: string | null
  phone?: string | null
  companyId?: string | null
  // Deal-specific.
  stage?: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
  amount?: number | null
  closeDate?: Date | null
  contactId?: string | null
}

/**
 * Path 2 — atomic CRM promotion. Flips `entities.kind` and merges the
 * typed CRM fields into `attributes` (plus `canonical_id` from the
 * natural key) in one row-locked transaction, with the actor scope SET
 * LOCAL on the connection so RLS still applies.
 *
 * Rejects:
 *   - missing / non-live entity (also covers cross-workspace: an entity
 *     outside the actor's RLS visibility reads as not found)
 *   - deals without a stage value
 *
 * Returns the updated entity (kind = target). `specializationId` is the
 * entity's own id — kept for route-shape compatibility with the
 * pre-unification API, where it was the companion row's id.
 */
export async function promoteEntityToCrm(
  actorUserId: string,
  id: string,
  params: PromoteEntityToCrmParams,
): Promise<{ entity: EntityRecord; specializationId: string }> {
  if (params.kind === 'deal' && !params.stage) {
    throw new Error("Promoting to 'deal' requires a stage value.")
  }
  // Build the attributes patch + canonical_id for the target kind. No
  // specialization row exists post-unification; typed fields live in
  // `attributes`, relationship FKs are set later via updateContact/Deal.
  const attrs: Record<string, unknown> = {}
  if (params.kind === 'company') {
    if (params.domain) attrs.domain = params.domain
    if (params.tags && params.tags.length) attrs.tags = params.tags
  } else if (params.kind === 'person') {
    if (params.email) attrs.email = params.email
    if (params.phone) attrs.phone = params.phone
    if (params.tags && params.tags.length) attrs.tags = params.tags
  } else {
    attrs.stage = params.stage
    if (params.amount != null) attrs.amount = params.amount
    if (params.closeDate) attrs.closeDate = params.closeDate
  }
  const canonical =
    params.kind === 'person'
      ? params.email ?? null
      : params.kind === 'company'
        ? params.domain ?? null
        : null

  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    // Runs on the app pool (app_user, subject to RLS). SET LOCAL actor scope
    // reverts at COMMIT/ROLLBACK to the seeded sentinel, so no stale
    // current_user_id survives onto the pooled connection.
    await client.query(
      `SET LOCAL app.current_user_id = '${actorUserId.replace(/'/g, "''")}'`,
    )
    try {
      // Lock the entity row so a concurrent promote / supersede can't
      // race. The promotion target must be live, non-CRM, and visible
      // to the caller (FOR UPDATE inside the RLS context).
      const entityRes = await client.query<EntityRow>(
        `SELECT ${FULL_SELECT} FROM entities
          WHERE id = $1 AND valid_to IS NULL
          FOR UPDATE`,
        [id],
      )
      if (entityRes.rows.length === 0) {
        await client.query('ROLLBACK')
        throw new Error('Entity not found or not live.')
      }
      const before = toEntity(entityRes.rows[0])
      const effectiveName = params.name?.trim() || before.displayName

      const updRes = await client.query<EntityRow>(
        `UPDATE entities
            SET kind = $1,
                display_name = $2,
                canonical_id = COALESCE($3, canonical_id),
                attributes = attributes || $4::jsonb,
                updated_at = now()
          WHERE id = $5 AND valid_to IS NULL
          RETURNING ${FULL_SELECT}`,
        [params.kind, effectiveName, canonical, JSON.stringify(attrs), id],
      )
      if (updRes.rows.length === 0) {
        // Shouldn't happen given the FOR UPDATE above, but be defensive.
        await client.query('ROLLBACK')
        throw new Error('Entity vanished between lock and update.')
      }
      await client.query('COMMIT')
      const entity = toEntity(updRes.rows[0])
      return { entity, specializationId: entity.id }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Construct an `EntityStore` backed by PostgreSQL.
 *
 * @param deps.entityLinks  Required for the `getEntity` rollup
 *                          (edge summary + embedded edges).
 */
export function createDbEntitiesStore(deps: { entityLinks: EntityLinksStore }): EntityStore {
  return {
    create: (params) => createEntity(params),
    getById: (ctx, id, opts) => getEntityById(ctx, id, opts ?? {}),
    findByName: (ctx, displayName, opts) =>
      findEntityByName(ctx, displayName, opts ?? {}),
    findByNameSystem: (actorUserId, workspaceId, displayName, opts) =>
      findEntityByNameSystem(actorUserId, workspaceId, displayName, opts ?? {}),
    findByCanonicalId: (ctx, canonicalId, opts) =>
      findEntitiesByCanonicalId(ctx, canonicalId, opts ?? {}),
    findByCanonicalIdSystem: (actorUserId, workspaceId, canonicalId, opts) =>
      findEntitiesByCanonicalIdSystem(actorUserId, workspaceId, canonicalId, opts ?? {}),
    listForWorkspace: (ctx, opts) => listEntities(ctx, opts ?? {}),
    findDuplicateClustersSystem: (actorUserId, workspaceId, opts) =>
      findEntityDuplicateClustersSystem(actorUserId, workspaceId, opts ?? {}),
    findCrossKindDuplicateClustersSystem: (actorUserId, workspaceId, opts) =>
      findCrossKindDuplicateClustersSystem(actorUserId, workspaceId, opts ?? {}),
    listLiveEntitiesSystem: (actorUserId, workspaceId, opts) =>
      listLiveEntitiesForWorkspaceSystem(actorUserId, workspaceId, opts ?? {}),
    addAlias: (actorUserId, entityId, alias) =>
      addEntityAlias(actorUserId, entityId, alias),
    removeAlias: (actorUserId, entityId, alias) =>
      removeEntityAlias(actorUserId, entityId, alias),
    update: (actorUserId, id, fields) => updateEntity(actorUserId, id, fields),
    supersedeAttributes: (actorUserId, id, patch) =>
      supersedeEntity(actorUserId, id, patch),
    getEntity: (ctx, idOrName, opts) =>
      getEntityRollup(deps, ctx, idOrName, opts ?? {}),
    getOrCreateSelf: (params) => getOrCreateSelfEntity(params),
    updateSelfProfile: (params) => updateSelfEntityAttributes(params),
  }
}
