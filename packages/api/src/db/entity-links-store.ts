import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { admitEntityLinkCreate } from '../workspace-access/entity-link-create-admission.js'
import type {
  AccessContext,
  EdgeType,
  EntityLinkCreateParams,
  EntityLinkRecord,
  EntityLinksStore,
  EntitySource,
  LinkKind,
} from '@use-brian/core'
import type { Sensitivity } from '@use-brian/core'
import type pg from 'pg'
import { buildAccessPredicate } from './access-predicate.js'
import { queryWithRLS, getAppPool, applyRLSGucs } from './client.js'
import { ContextScopeAccumulator, DerivedScopeError, bindScopeSources, boundScopeSources, deriveWriteScope, type ScopeSource, type SessionContextAuthority } from '@use-brian/core'
import { getMemoryById } from './memories.js'
import { readRetainedContextFrame, writeRetainedContextFrame } from './session-context-revisions.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'

/**
 * `entity_links` store. Schema spec:
 *   docs/plans/company-brain/data-model.md §Entity Links (lines 152-234).
 *
 * Edge vocabulary is defined in `@use-brian/core` (`EDGE_TYPES`); writes
 * pass the value through, the DB CHECK / enum (when added by migration
 * 126) enforces the locked vocabulary at the persistence boundary.
 *
 * Sensitivity inheritance: migration 126 ships an insert trigger that
 * writes `sensitivity = MAX(endpoints)` and propagates the visibility
 * double. The store passes through any explicit `sensitivity` the
 * caller provides; the trigger overwrites it. Until the trigger lands,
 * the explicit value (or the column DEFAULT 'internal') is what
 * persists.
 */

const FULL_SELECT = `
  id,
  source_kind AS "sourceKind",
  source_id AS "sourceId",
  target_kind AS "targetKind",
  target_id AS "targetId",
  edge_type AS "edgeType",
  attributes,
  source,
  verified_by_user_id AS "verifiedByUserId",
  verified_at AS "verifiedAt",
  valid_from AS "validFrom",
  valid_to AS "validTo",
  retracted_at AS "retractedAt",
  retracted_reason AS "retractedReason",
  source_episode_id AS "sourceEpisodeId",
  sensitivity,
  compartments,
  project_ids AS "projectIds",
  workspace_id AS "workspaceId",
  user_id AS "userId",
  assistant_id AS "assistantId",
  created_at AS "createdAt"
`

type EntityLinkRow = {
  id: string
  sourceKind: string
  sourceId: string
  targetKind: string
  targetId: string
  edgeType: string
  attributes: Record<string, unknown> | null
  source: string
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  retractedAt: Date | null
  retractedReason: string | null
  sourceEpisodeId: string | null
  sensitivity: string
  compartments: string[]
  projectIds: string[]
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdAt: Date
}

function toLink(row: EntityLinkRow): EntityLinkRecord {
  return {
    id: row.id,
    sourceKind: row.sourceKind as LinkKind,
    sourceId: row.sourceId,
    targetKind: row.targetKind as LinkKind,
    targetId: row.targetId,
    edgeType: row.edgeType as EdgeType,
    attributes: row.attributes ?? {},
    source: row.source as EntitySource,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    retractedAt: row.retractedAt,
    retractedReason: row.retractedReason,
    sourceEpisodeId: row.sourceEpisodeId,
    sensitivity: row.sensitivity as Sensitivity,
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
    workspaceId: row.workspaceId,
    userId: row.userId,
    assistantId: row.assistantId,
    createdAt: row.createdAt,
  }
}

// ── Raw SQL helpers ──────────────────────────────────────────────────

/**
 * Insert a new link — ASSERT-EXISTS, not append. The actor for RLS is
 * derived from the caller: `userId` if present, else `assistantId`-
 * owner, else `workspaceId`-member. Since the create path is invoked by
 * routes that already authenticated, the visibility-double caller is
 * responsible for supplying at least one of `userId` / `assistantId`
 * (CHECK constraint mirrors).
 *
 * RLS is engaged using `userId` when supplied; otherwise the row is
 * written as system-internal under the workspace partition.
 *
 * Idempotency (migration 354): one ACTIVE row per (workspace, source,
 * target, edge_type) — `idx_entity_links_active_identity`, partial on
 * `valid_to IS NULL AND retracted_at IS NULL`. Re-asserting an edge
 * that already exists returns the EXISTING row instead of inserting a
 * duplicate. This is the seam that ended the 2026-07-22 incident where
 * the chat-retrieval local-match re-minted the same `mentioned` edge on
 * every recall (one edge 946x, 85% of the table duplicates): edge
 * writers are fire-and-forget by design, so uniqueness must live here,
 * by construction, not in caller discipline. A row created with an
 * explicit `validTo` is born outside the partial index and inserts
 * plainly — closed historical windows never collide, and a closed or
 * retracted edge can always be re-opened as a fresh active row.
 */
export async function createEntityLink(
  actorUserId: string,
  params: EntityLinkCreateParams,
  transactionClient?: pg.PoolClient,
  freshOnly = false,
): Promise<EntityLinkRecord> {
  if (!transactionClient) {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, actorUserId)
      const link = await createEntityLink(actorUserId, params, client)
      await client.query('COMMIT')
      return link
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const admission = await admitEntityLinkCreate(transactionClient, actorUserId, params)
  params = admission.params
  const run = transactionClient
    ? transactionClient.query.bind(transactionClient)
    : <T extends pg.QueryResultRow>(sql: string, values: unknown[]) => queryWithRLS<T>(actorUserId, sql, values)
  // Pass NULL for valid_from/valid_to when omitted — the DB default
  // (`now()` / `NULL`) handles the "currently active" case. Explicit
  // values flow through for past-relationship encoding ("Kinson left
  // DeltaDeFi in August 2025" → validTo set on creation).
  //
  // The retry/read fallback remains for a concurrent retract that can
  // remove the active row between conflict arbitration and RETURNING.
  // A duplicate active edge is updated in place so its Team/Project
  // scope can only narrow by unioning the newly observed evidence.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await run<EntityLinkRow>(
      `INSERT INTO entity_links (
         source_kind, source_id, target_kind, target_id, edge_type,
         attributes, source,
         sensitivity, workspace_id, user_id, assistant_id,
         source_episode_id, compartments, project_ids,
         valid_from, valid_to
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7,
         $8, $9, $10, $11,
         $12, $13::text[], $14::uuid[],
         COALESCE($15::timestamptz, now()), $16::timestamptz
       )
       ON CONFLICT (workspace_id, source_kind, source_id, target_kind, target_id, edge_type)
         WHERE valid_to IS NULL AND retracted_at IS NULL
         ${freshOnly ? 'DO NOTHING' : `DO UPDATE SET
           ${admission.ready ? `user_id = EXCLUDED.user_id,
           assistant_id = EXCLUDED.assistant_id,
           sensitivity = EXCLUDED.sensitivity,` : ''}
           compartments = ARRAY(
             SELECT DISTINCT unnest(entity_links.compartments || EXCLUDED.compartments)
             ORDER BY 1
           ),
           project_ids = ARRAY(
             SELECT DISTINCT unnest(entity_links.project_ids || EXCLUDED.project_ids)
             ORDER BY 1
           )
         ${admission.ready ? `WHERE NOT entity_links.scope_held
           AND (entity_links.user_id IS NULL OR entity_links.user_id = EXCLUDED.user_id)
           AND (entity_links.assistant_id IS NULL OR entity_links.assistant_id = EXCLUDED.assistant_id)
           AND entity_links.compartments <@ EXCLUDED.compartments
           AND entity_links.project_ids <@ EXCLUDED.project_ids
           AND array_position(ARRAY['public','internal','confidential'],entity_links.sensitivity)
             <= array_position(ARRAY['public','internal','confidential'],EXCLUDED.sensitivity)` : ''}`}
       RETURNING ${FULL_SELECT}`,
      [
        params.sourceKind,
        params.sourceId,
        params.targetKind,
        params.targetId,
        params.edgeType,
        JSON.stringify(params.attributes ?? {}),
        params.source,
        params.sensitivity ?? 'internal',
        params.workspaceId,
        params.userId ?? null,
        params.assistantId ?? null,
        params.sourceEpisodeId ?? null,
        params.compartments ?? [],
        params.projectIds ?? [],
        params.validFrom ?? null,
        params.validTo ?? null,
      ],
    )
    if (result.rows[0]) return toLink(result.rows[0])
    if (freshOnly || admission.ready) throw new WorkspaceAccessError('context_not_available', 404)

    const existing = await run<EntityLinkRow>(
      `SELECT ${FULL_SELECT} FROM entity_links
        WHERE workspace_id = $1
          AND source_kind = $2 AND source_id = $3
          AND target_kind = $4 AND target_id = $5
          AND edge_type = $6
          AND valid_to IS NULL AND retracted_at IS NULL
        LIMIT 1`,
      [
        params.workspaceId,
        params.sourceKind,
        params.sourceId,
        params.targetKind,
        params.targetId,
        params.edgeType,
      ],
    )
    if (existing.rows[0]) return toLink(existing.rows[0])
  }
  throw new Error(
    `entity_links: create raced a concurrent retract twice for ` +
      `${params.sourceKind}:${params.sourceId} → ${params.targetKind}:${params.targetId} (${params.edgeType})`,
  )
}

export async function getEntityLinkById(
  ctx: AccessContext,
  id: string,
): Promise<EntityLinkRecord | null> {
  const ap = buildAccessPredicate(ctx, { startIdx: 2 })
  const result = await queryWithRLS<EntityLinkRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entity_links WHERE id = $1 AND ${ap.sql}`,
    [id, ...ap.params],
  )
  if (result.rows.length === 0) return null
  return toLink(result.rows[0])
}

export async function walkOutboundLinks(
  ctx: AccessContext,
  sourceKind: LinkKind,
  sourceId: string,
  opts: { edgeTypes?: readonly EdgeType[]; asOf?: Date; limit?: number } = {},
): Promise<EntityLinkRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const ap = buildAccessPredicate(ctx, { startIdx: 5 })
  const values: unknown[] = [sourceKind, sourceId, opts.asOf ?? null, limit, ...ap.params]
  let typeFilter = ''
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    values.push(opts.edgeTypes as unknown as string[])
    typeFilter = `AND edge_type = ANY($${values.length}::text[])`
  }
  const result = await queryWithRLS<EntityLinkRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entity_links
     WHERE source_kind = $1
       AND source_id = $2
       AND retracted_at IS NULL
       AND valid_from <= COALESCE($3::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($3::timestamptz, now()))
       AND ${ap.sql}
       ${typeFilter}
     ORDER BY created_at DESC
     LIMIT $4`,
    values,
  )
  return result.rows.map(toLink)
}

export async function walkInboundLinks(
  ctx: AccessContext,
  targetKind: LinkKind,
  targetId: string,
  opts: { edgeTypes?: readonly EdgeType[]; asOf?: Date; limit?: number } = {},
): Promise<EntityLinkRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const ap = buildAccessPredicate(ctx, { startIdx: 5 })
  const values: unknown[] = [targetKind, targetId, opts.asOf ?? null, limit, ...ap.params]
  let typeFilter = ''
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    values.push(opts.edgeTypes as unknown as string[])
    typeFilter = `AND edge_type = ANY($${values.length}::text[])`
  }
  const result = await queryWithRLS<EntityLinkRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entity_links
     WHERE target_kind = $1
       AND target_id = $2
       AND retracted_at IS NULL
       AND valid_from <= COALESCE($3::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($3::timestamptz, now()))
       AND ${ap.sql}
       ${typeFilter}
     ORDER BY created_at DESC
     LIMIT $4`,
    values,
  )
  return result.rows.map(toLink)
}

/**
 * Workspace-scoped active-edge sweep. Powers the brain graph view —
 * the alternative (walkOutbound per entity) is N+1 against `entity_links`
 * for an N-entity workspace. One query is ~constant.
 *
 * Defaults to entity↔entity edges only (the v1 graph view). Pass
 * explicit `sourceKinds` / `targetKinds` to include memory / file /
 * other link kinds once those become node types in the view.
 */
export async function listEntityLinksForWorkspace(
  ctx: AccessContext,
  opts: {
    sourceKinds?: readonly LinkKind[]
    targetKinds?: readonly LinkKind[]
    asOf?: Date
    limit?: number
  } = {},
): Promise<EntityLinkRecord[]> {
  // The graph route loads up to 5000 raw nodes and budgets six edges per node.
  // A fixed 5000-edge clamp made the expanded snapshot look artificially
  // isolated, which also corrupted the client's community projection.
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 30000)
  const sourceKinds = opts.sourceKinds ?? (['entity'] as const)
  const targetKinds = opts.targetKinds ?? (['entity'] as const)
  const ap = buildAccessPredicate(ctx, { startIdx: 5 })
  const values: unknown[] = [
    sourceKinds as unknown as string[],
    targetKinds as unknown as string[],
    opts.asOf ?? null,
    limit,
    ...ap.params,
  ]
  const result = await queryWithRLS<EntityLinkRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM entity_links
     WHERE source_kind = ANY($1::text[])
       AND target_kind = ANY($2::text[])
       AND retracted_at IS NULL
       AND valid_from <= COALESCE($3::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($3::timestamptz, now()))
       AND ${ap.sql}
     ORDER BY created_at DESC
     LIMIT $4`,
    values,
  )
  return result.rows.map(toLink)
}

/**
 * Count edges where the given entity is on either endpoint. Used by
 * `getEntity` rollup for `summary.edge_count`.
 */
export async function countLinksForEntity(
  ctx: AccessContext,
  entityId: string,
  opts: { asOf?: Date } = {},
): Promise<number> {
  const ap = buildAccessPredicate(ctx, { startIdx: 3 })
  const result = await queryWithRLS<{ n: string }>(
    ctx.userId,
    `SELECT COUNT(*)::text AS n FROM entity_links
     WHERE retracted_at IS NULL
       AND valid_from <= COALESCE($1::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($1::timestamptz, now()))
       AND ${ap.sql}
       AND (
         (source_kind = 'entity' AND source_id = $2)
         OR
         (target_kind = 'entity' AND target_id = $2)
       )`,
    [opts.asOf ?? null, entityId, ...ap.params],
  )
  return Number(result.rows[0]?.n ?? 0)
}

/**
 * Soft-retract a link: stamps `retracted_at`, `retracted_reason`, and
 * closes the bi-temporal window. The row stays queryable for
 * provenance / D.7 audit.
 */
/**
 * Close an active edge — set `valid_to` without touching
 * `retracted_at`. Used for supersession-on-update (FK change closes
 * the prior relationship; new FK opens a new one) and for the
 * `closeLinks` parameter on update tools. The row stays visible to
 * `walkOutbound`/`walkInbound` when `asOf` falls inside its closed
 * window; that's the point of the bi-temporal model.
 *
 * Returns null when the edge is missing, already retracted, or
 * already has a `valid_to` set (idempotent — closing an
 * already-closed edge is a no-op).
 */
export async function closeEntityLinkAt(
  actorUserId: string,
  id: string,
  validTo: Date,
): Promise<EntityLinkRecord | null> {
  const result = await queryWithRLS<EntityLinkRow>(
    actorUserId,
    `UPDATE entity_links
        SET valid_to = $2
      WHERE id = $1
        AND retracted_at IS NULL
        AND valid_to IS NULL
      RETURNING ${FULL_SELECT}`,
    [id, validTo],
  )
  if (result.rows.length === 0) return null
  return toLink(result.rows[0])
}

export async function retractEntityLink(
  actorUserId: string,
  id: string,
  reason: string,
): Promise<EntityLinkRecord | null> {
  const result = await queryWithRLS<EntityLinkRow>(
    actorUserId,
    `UPDATE entity_links
        SET retracted_at = now(),
            retracted_reason = $2,
            valid_to = COALESCE(valid_to, now())
      WHERE id = $1
        AND retracted_at IS NULL
      RETURNING ${FULL_SELECT}`,
    [id, reason],
  )
  if (result.rows.length === 0) return null
  return toLink(result.rows[0])
}

/** Retained graph support starts with canonical Memory endpoints; IDs alone do not grant it. */
function requireMemoryLinkAuthority(authority: SessionContextAuthority, ctx?: AccessContext): void {
  const e = authority.execution, access = e.security.access
  if (!(authority.accumulator instanceof ContextScopeAccumulator) || e.ownership.kind !== 'workspace'
    || e.identity.kind !== 'attended' || e.identity.principal.kind !== 'workspace_member'
    || e.identity.principal.userId !== access.userId || e.ownership.workspaceId !== access.workspaceId || e.surface.readOnly || access.sharedAudience
    || access.assistantId !== e.assistant.id || e.surface.systemRead || e.surface.clientSelfMemory
    || ctx && (ctx.systemRead || ctx.clientSelfMemory || ctx.userId !== access.userId || ctx.workspaceId !== access.workspaceId || ctx.assistantId !== e.assistant.id)) {
    throw new DerivedScopeError('scope_evidence_missing')
  }
}
async function completeMemoryLinkRoots(authority: SessionContextAuthority, initial: readonly ScopeSource[]): Promise<ScopeSource[]> {
  const roots = new ContextScopeAccumulator({ sources: [...initial] }), workspace = authority.execution.security.access.workspaceId
  roots.note({ sources: [...await readExternalSourceAncestors(workspace, initial), ...await readApplicationFieldAncestors(workspace, initial)] })
  return roots.evidence.sources ?? []
}
async function createRetainedMemoryLink(params: EntityLinkCreateParams, authority: SessionContextAuthority): Promise<EntityLinkRecord> {
  requireMemoryLinkAuthority(authority)
  params = structuredClone(params)
  const e = authority.execution, access = e.security.access
  if (params.sourceKind !== 'memory' || params.targetKind !== 'memory' || params.validTo || params.sourceEpisodeId
    || params.userId !== access.userId || params.workspaceId !== access.workspaceId || params.assistantId !== e.assistant.id) {
    throw new DerivedScopeError('scope_evidence_missing')
  }
  const endpoints = []
  for (const id of [params.sourceId, params.targetId]) {
    const memory = await getMemoryById(access, id, undefined, undefined, authority)
    if (!memory) throw new DerivedScopeError('scope_source_changed')
    endpoints.push(memory)
  }
  const sources = await completeMemoryLinkRoots(authority, [...authority.accumulator.evidence.sources ?? [],
    ...endpoints.flatMap(memory => [...boundScopeSources(memory), {
      resourceKind: 'memory', resourceId: memory.id, version: memory.scopeVersion, workspaceId: access.workspaceId,
      userId: memory.userId, assistantId: memory.assistantId, sensitivity: memory.sensitivity,
      compartments: memory.compartments, projectIds: memory.projectIds,
    }]),
  ])
  const scope = deriveWriteScope({ producer: 'memory-explicit-link', sources }, {
    workspaceId: params.workspaceId, userId: access.userId, assistantId: e.assistant.id,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments ?? [], projectIds: params.projectIds ?? [],
  }, access.userId)
  return writeRetainedContextFrame(authority, sources, async client => {
    const link = await createEntityLink(access.userId, { ...params, ...scope }, client, true)
    const source = (await client.query<{ source: ScopeSource }>("SELECT read_admitted_native_scope_snapshot($1,'entity_link',$2) || jsonb_build_object('resourceKind','entity_link','resourceId',$2::text) AS source", [params.workspaceId, link.id])).rows[0]?.source
    if (!source?.version) throw new DerivedScopeError('scope_evidence_missing')
    await client.query('SELECT record_admitted_memory_link_derivation($1,$2,$3,$4,$5)',
      [params.workspaceId, link.id, source.version, 'memory-explicit-link', JSON.stringify(sources)])
    return bindScopeSources(link, [source, ...sources])
  })
}
async function readRetainedMemoryLink(ctx: AccessContext, id: string, authority: SessionContextAuthority): Promise<EntityLinkRecord | null> {
  requireMemoryLinkAuthority(authority, ctx)
  ctx = structuredClone(ctx)
  const root = await readRetainedContextFrame(authority, authority.accumulator.evidence.sources ?? [], async client =>
    (await client.query<{ source: ScopeSource | null }>("SELECT read_admitted_native_scope_snapshot($1,'entity_link',$2) || jsonb_build_object('resourceKind','entity_link','resourceId',$2::text) AS source", [ctx.workspaceId, id])).rows[0]?.source)
  if (!root || !root.version) return null
  let sources = await completeMemoryLinkRoots(authority, [...authority.accumulator.evidence.sources ?? [], root])
  const link = await readRetainedContextFrame(authority, sources, async client => {
    const ap = buildAccessPredicate(ctx, { startIdx: 3 })
    const row = (await client.query<EntityLinkRow>(`SELECT ${FULL_SELECT} FROM entity_links WHERE id=$1 AND scope_version::text=$2 AND ${ap.sql}`, [id, root.version, ...ap.params])).rows[0]
    return row ? toLink(row) : null
  })
  if (!link) return null
  if (link.sourceKind !== 'memory' || link.targetKind !== 'memory') throw new DerivedScopeError('scope_evidence_missing')
  const endpointSources: ScopeSource[] = []
  for (const endpoint of [link.sourceId, link.targetId]) {
    const memory = await getMemoryById(ctx, endpoint, undefined, undefined, authority)
    if (!memory) throw new DerivedScopeError('scope_source_changed')
    endpointSources.push(...boundScopeSources(memory), {
      resourceKind: 'memory', resourceId: memory.id, version: memory.scopeVersion, workspaceId: ctx.workspaceId,
      userId: memory.userId, assistantId: memory.assistantId, sensitivity: memory.sensitivity,
      compartments: memory.compartments, projectIds: memory.projectIds,
    })
  }
  sources = await completeMemoryLinkRoots(authority, [...sources, ...endpointSources])
  return readRetainedContextFrame(authority, sources, async client => {
    const current = (await client.query<{ allowed: boolean }>('SELECT memory_link_current_ancestry_allows($1,$2,$3) AS allowed', [ctx.workspaceId, id, root.version])).rows[0]?.allowed
    if (current !== true) throw new DerivedScopeError('scope_source_changed')
    return bindScopeSources(link, [...sources])
  })
}

// ── Factory ──────────────────────────────────────────────────────────

export function createDbEntityLinksStore(): EntityLinksStore {
  return {
    createRetainedMemoryLink,
    getRetainedMemoryLink: readRetainedMemoryLink,
    async create(params) {
      const actor = params.userId ?? params.assistantId
      if (!actor) {
        // Mirrors the CHECK constraint in 126_entity_links.sql — fail
        // fast with a clear message rather than letting Postgres throw
        // a generic constraint violation.
        throw new Error('entity_links: at least one of userId / assistantId must be provided')
      }
      // `actorUserId` for RLS: prefer the human userId if present,
      // otherwise fall back to the assistantId so RLS treats this as
      // an assistant-owned write. The RLS policy (forthcoming in
      // migration 125/126 + WS-4) handles either shape.
      return createEntityLink(params.userId ?? actor, params)
    },
    getById: (ctx, id) => getEntityLinkById(ctx, id),
    walkOutbound: (ctx, sourceKind, sourceId, opts) =>
      walkOutboundLinks(ctx, sourceKind, sourceId, opts ?? {}),
    walkInbound: (ctx, targetKind, targetId, opts) =>
      walkInboundLinks(ctx, targetKind, targetId, opts ?? {}),
    countForEntity: (ctx, entityId, opts) =>
      countLinksForEntity(ctx, entityId, opts ?? {}),
    listForWorkspace: (ctx, opts) => listEntityLinksForWorkspace(ctx, opts ?? {}),
    closeAt: (actorUserId, id, validTo) => closeEntityLinkAt(actorUserId, id, validTo),
    retract: (actorUserId, id, reason) => retractEntityLink(actorUserId, id, reason),
  }
}
