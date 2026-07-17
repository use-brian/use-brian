import type { EdgeType, EntityLinksStore, EntitySource, LinkKind } from '@use-brian/core'

/**
 * Edge-write hooks for primitive save-sites (company-brain WU-1.7).
 *
 * Spec: docs/plans/company-brain/data-model.md §Entity Links (Edges).
 * When a brain primitive is saved (a memory, a task, a workspace file,
 * a CRM row), the save-site emits the appropriate `entity_links` edge so
 * the graph layer stays coherent with the primitive layer:
 *
 *   memory  → entity   `mentioned`        — a memory mentions an entity
 *   task    → entity   `mentioned`        — a task references an entity
 *   entity  → file     `documented_by`    — an entity is documented by a file
 *   contact → company  `works_at`         — a person works at a company (CRM)
 *   deal    → company  `engagement_of`    — a deal belongs to a company (CRM)
 *
 * ── Fire-and-forget invariant ────────────────────────────────────────
 * Edge emission MUST NEVER fail or block the original primitive save.
 * The edge is a derived, best-effort projection; the primitive row is
 * the source of truth. Every helper here swallows its own errors (logs
 * at `console.error` for observability) and resolves rather than
 * rejecting. Callers invoke these *after* the primitive write has
 * committed and deliberately do **not** `await` the result on the hot
 * path — see the `void emit...()` call sites in `memories.ts`,
 * `tasks.ts`, `workspace-files.ts`, and `crm.ts`.
 *
 * The `entity_links` insert-trigger (migration 126) overwrites
 * `sensitivity` with `MAX(endpoint sensitivities)`; the helpers pass a
 * conservative `'internal'` default which the trigger supersedes.
 */

/** Shared fire-and-forget shape for one edge insert. */
export type EdgeEmitParams = {
  sourceKind: LinkKind
  sourceId: string
  targetKind: LinkKind
  targetId: string
  edgeType: EdgeType
  workspaceId: string
  /** Trust source for the edge row (`'user'` for human-driven saves,
   *  `'extracted'`/`'model'` for pipeline-driven ones). */
  source: EntitySource
  /** Visibility double — at least one of userId / assistantId is
   *  required (entity_links CHECK constraint). */
  userId?: string | null
  assistantId?: string | null
  attributes?: Record<string, unknown>
  sourceEpisodeId?: string | null
}

/**
 * Emit a single edge, fire-and-forget. Resolves to the new edge id on
 * success or `null` on any failure (insert error, missing endpoint,
 * RLS rejection). Never throws — a thrown edge error must not surface
 * into the primitive save that triggered it.
 */
export async function emitEdgeFireAndForget(
  entityLinks: EntityLinksStore,
  actorUserId: string,
  params: EdgeEmitParams,
): Promise<string | null> {
  try {
    const link = await entityLinks.create({
      sourceKind: params.sourceKind,
      sourceId: params.sourceId,
      targetKind: params.targetKind,
      targetId: params.targetId,
      edgeType: params.edgeType,
      workspaceId: params.workspaceId,
      source: params.source,
      userId: params.userId ?? actorUserId,
      assistantId: params.assistantId ?? null,
      attributes: params.attributes ?? {},
      sourceEpisodeId: params.sourceEpisodeId ?? null,
    })
    return link.id
  } catch (err) {
    // Swallow — the primitive save already committed. Log so a
    // persistent edge-write failure is still visible in production.
    console.error(
      `[edge-hooks] ${params.edgeType} edge emit failed ` +
        `(${params.sourceKind}:${params.sourceId} → ${params.targetKind}:${params.targetId}):`,
      err,
    )
    return null
  }
}

/**
 * Emit `mentioned` edges from a freshly-saved memory or task to the
 * entities it references. One edge per `entityId`; each is independent
 * and fire-and-forget, so a partial failure still lands the rest.
 *
 * `mentioned` has `fromKinds: *` / `toKinds: ['entity']` in the edge
 * vocabulary, so both `'memory'` and `'task'` sources are valid.
 */
export async function emitMentionedEdges(
  entityLinks: EntityLinksStore,
  actorUserId: string,
  params: {
    sourceKind: 'memory' | 'task'
    sourceId: string
    entityIds: readonly string[]
    workspaceId: string
    source: EntitySource
    userId?: string | null
    assistantId?: string | null
    sourceEpisodeId?: string | null
  },
): Promise<void> {
  await Promise.all(
    params.entityIds.map((entityId) =>
      emitEdgeFireAndForget(entityLinks, actorUserId, {
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
        targetKind: 'entity',
        targetId: entityId,
        edgeType: 'mentioned',
        workspaceId: params.workspaceId,
        source: params.source,
        userId: params.userId,
        assistantId: params.assistantId,
        sourceEpisodeId: params.sourceEpisodeId,
      }),
    ),
  )
}

/**
 * Emit `depends_on` edges from a freshly-saved (or freshly-superseded)
 * task to the tasks it depends on. Both endpoints are `'task'` rows;
 * `depends_on` lives in the edge vocabulary (decisions-log 2026-05-14
 * "SV — Edge vocabulary additions"; `edges.ts:66`).
 *
 * v1 append-only semantics. `updateTask({ dependsOn })` emits new
 * edges from the new (supersession) task id; the old task id's edges
 * remain in history. Replace / remove semantics are deferred to v2 —
 * for now, "fix a wrong dependency" means re-emit the desired set from
 * the new task row, or soft-delete and re-create.
 */
export async function emitDependsOnEdges(
  entityLinks: EntityLinksStore,
  actorUserId: string,
  params: {
    sourceTaskId: string
    dependsOnTaskIds: readonly string[]
    workspaceId: string
    source: EntitySource
    userId?: string | null
    assistantId?: string | null
    sourceEpisodeId?: string | null
  },
): Promise<void> {
  await Promise.all(
    params.dependsOnTaskIds.map((targetId) =>
      emitEdgeFireAndForget(entityLinks, actorUserId, {
        sourceKind: 'task',
        sourceId: params.sourceTaskId,
        targetKind: 'task',
        targetId,
        edgeType: 'depends_on',
        workspaceId: params.workspaceId,
        source: params.source,
        userId: params.userId,
        assistantId: params.assistantId,
        sourceEpisodeId: params.sourceEpisodeId,
      }),
    ),
  )
}

/**
 * Emit `documented_by` edges from each referenced entity to a
 * freshly-saved workspace file. The edge direction is entity → file
 * (the entity is documented BY the file), per the edge vocabulary.
 */
export async function emitDocumentedByEdges(
  entityLinks: EntityLinksStore,
  actorUserId: string,
  params: {
    fileId: string
    entityIds: readonly string[]
    workspaceId: string
    source: EntitySource
    userId?: string | null
    assistantId?: string | null
    sourceEpisodeId?: string | null
    /** Commit SHA provenance — stored in the edge's `attributes` JSONB. */
    commitSha?: string
  },
): Promise<void> {
  const attributes = params.commitSha ? { commit_sha: params.commitSha } : {}
  await Promise.all(
    params.entityIds.map((entityId) =>
      emitEdgeFireAndForget(entityLinks, actorUserId, {
        sourceKind: 'entity',
        sourceId: entityId,
        targetKind: 'file',
        targetId: params.fileId,
        edgeType: 'documented_by',
        workspaceId: params.workspaceId,
        source: params.source,
        userId: params.userId,
        assistantId: params.assistantId,
        attributes,
        sourceEpisodeId: params.sourceEpisodeId,
      }),
    ),
  )
}

/**
 * Emit a single entity↔entity CRM relationship edge, fire-and-forget.
 * Used by the CRM write wrappers (`createContact` / `createDeal`) to
 * link the freshly-created contact/deal entity to the company entity
 * it references — `works_at` (person → company) and `engagement_of`
 * (deal → company). Both endpoints are `'entity'` rows: the CRM
 * wrappers create one entity per CRM row and the company's
 * `entities.id` is read from `companies.entity_id`.
 */
export async function emitCrmRelationEdge(
  entityLinks: EntityLinksStore,
  actorUserId: string,
  params: {
    sourceEntityId: string
    targetEntityId: string
    edgeType: 'works_at' | 'engagement_of'
    workspaceId: string
    source: EntitySource
    userId?: string | null
    assistantId?: string | null
  },
): Promise<string | null> {
  return emitEdgeFireAndForget(entityLinks, actorUserId, {
    sourceKind: 'entity',
    sourceId: params.sourceEntityId,
    targetKind: 'entity',
    targetId: params.targetEntityId,
    edgeType: params.edgeType,
    workspaceId: params.workspaceId,
    source: params.source,
    userId: params.userId,
    assistantId: params.assistantId,
  })
}

/**
 * Supersede a CRM relationship edge: when `updateContact({ companyId })`
 * changes the FK, close the prior `works_at` edge from the contact's
 * entity (with `valid_to=now()`, no retraction — the relationship was
 * real, it ended) and open a new one to the incoming company. Same
 * shape for `updateDeal({ companyId })` → `engagement_of`.
 *
 * The "find any active edge of this type from this source" pass is
 * narrow on purpose: most CRM rows have at most one active edge per
 * relationship type. Multiple active `works_at` edges from one contact
 * are legal (concurrent jobs) — this closes the most recent one. The
 * model can use `closeLinks` for finer control.
 *
 * Fire-and-forget at every step: a close failure logs and continues;
 * an open failure logs and continues. Never throws back to the caller.
 */
export async function superseedCrmRelationEdge(
  entityLinks: EntityLinksStore,
  actorUserId: string,
  params: {
    sourceEntityId: string
    /** May be null when the FK was cleared — the old edge still closes,
     *  but no new edge opens (the relationship simply ended). */
    targetEntityId: string | null
    edgeType: 'works_at' | 'engagement_of'
    workspaceId: string
    source: EntitySource
    userId?: string | null
    assistantId?: string | null
    /** Optional override for the close timestamp; defaults to now(). */
    closedAt?: Date
  },
): Promise<{ closed: number; opened: number }> {
  let closed = 0
  let opened = 0
  try {
    // Find active edges of this type from this source via the universal
    // walk. RLS uses the actor's userId.
    const ctx = {
      userId: actorUserId,
      workspaceId: params.workspaceId,
      assistantId: params.assistantId ?? '',
      assistantKind: 'standard' as const,
    }
    const active = await entityLinks.walkOutbound(ctx, 'entity', params.sourceEntityId, {
      edgeTypes: [params.edgeType],
      limit: 20,
    })
    const closeAt = params.closedAt ?? new Date()
    for (const edge of active) {
      const closed_ = await entityLinks.closeAt(actorUserId, edge.id, closeAt)
      if (closed_) closed += 1
    }
  } catch (err) {
    console.error(
      `[edge-hooks] supersede close phase failed (source=entity:${params.sourceEntityId} edge=${params.edgeType}):`,
      err,
    )
  }
  if (params.targetEntityId) {
    const newId = await emitCrmRelationEdge(entityLinks, actorUserId, {
      sourceEntityId: params.sourceEntityId,
      targetEntityId: params.targetEntityId,
      edgeType: params.edgeType,
      workspaceId: params.workspaceId,
      source: params.source,
      userId: params.userId,
      assistantId: params.assistantId,
    })
    if (newId) opened = 1
  }
  return { closed, opened }
}
