/**
 * Entity + entity-link types and store interfaces.
 * Implemented by the API layer (packages/api/src/db/entities-store.ts,
 * entity-links-store.ts) and consumed by Pipeline B (WS-3), retrieval
 * (WS-5), corrections (WS-6), and the CRM write wrapper (WU-1.5).
 *
 * Schema spec: docs/plans/company-brain/data-model.md §Entities,
 * §Entity Links. Rollup contract: docs/architecture/brain/retrieval-layer.md
 * §"Sub-resource expansion".
 */

import type { AccessContext } from '../security/access-context.js'
import type { Sensitivity } from '../security/sensitivity.js'

// ── Entity kinds ─────────────────────────────────────────────────────

export const SYSTEM_ENTITY_KINDS = ['person', 'company', 'project', 'product', 'deal', 'repository'] as const
export type SystemEntityKind = typeof SYSTEM_ENTITY_KINDS[number]

/**
 * Either a system-reserved kind ('person' | 'company' | 'project' |
 * 'product' | 'deal' | 'repository') or a tenant-defined namespace
 * (`tenant.<name>`). Tenant-namespace validation lives at the server
 * boundary, not in the type system.
 */
export type EntityKind = SystemEntityKind | string

// ── Trust signal source (docs/architecture/brain/trust-signals.md — Approach W) ───────────────────

export const ENTITY_SOURCES = [
  'user',
  'model',
  'extracted',
  'kb_sync',
  'rem_connection',
  'auto-generated',
  'community',
] as const
export type EntitySource = typeof ENTITY_SOURCES[number]

// ── Edge vocabulary (locked + SV/SV(2) additions, data-model.md:208-230) ──

export const EDGE_TYPES = [
  'works_at',
  'attended',
  'discussed_in',
  'represents',
  'mentioned',
  'signed_contract_with',
  'competes_with',
  'customer_since',
  'engagement_of',
  'target_investor',
  'outreach_strategy_for',
  'mutual_connection',
  'discussed_with',
  'depends_on',
  'mentioned_publicly_at',
  'target_competitor',
  'documented_by',
  'platform_engagement_for',
  'replies_to',
  // Procedural-brain primitive — skill edges (skills-as-procedural-brain-primitive, 2026-06-10).
  // Seeded into entity_link_types by migration 260. `references_entity`/`requires_connector`
  // are derived-from-facts (recomputed on skill edit); `learned_from` is induction provenance;
  // `refines` is the memory→skill link (auto-applied, flagged for review).
  'requires_connector',
  'references_entity',
  'learned_from',
  'refines',
] as const
export type EdgeType = typeof EDGE_TYPES[number]

// ── Link source/target kinds ─────────────────────────────────────────

// `skill` + `connector` added for the procedural-brain primitive (2026-06-10): a skill node
// is a workspace_skills row; a connector node is a connector_instance row. `session` + `assistant`
// are the remaining `learned_from` induction-provenance targets (skill → episode|session|assistant,
// plan §6). source_kind/target_kind are free TEXT in the DB (no CHECK), so these are
// convention-validated here at the type boundary.
export const LINK_KINDS = ['entity', 'memory', 'kb_chunk', 'task', 'event', 'file', 'episode', 'workspace', 'skill', 'connector', 'session', 'assistant'] as const
export type LinkKind = typeof LINK_KINDS[number]

// ── Resolver helper types (WU-1.4) ───────────────────────────────────

/** Candidate row passed to the entity resolver — shape suits both DB rows and in-flight extraction. */
export interface EntityCandidate {
  id: string
  kind: EntityKind
  display_name: string
  canonical_id?: string | null
  attributes?: Record<string, unknown>
}

/** Mention from extraction or chat input that the resolver tries to map onto a candidate. */
export interface EntityMention {
  kind: EntityKind
  display_name: string
  canonical_id?: string | null
  context?: string
}

// ── Records ───────────────────────────────────────────────────────────

export type EntityRecord = {
  id: string
  kind: EntityKind
  displayName: string
  canonicalId: string | null
  /**
   * Lowercase variant names the system has seen for this entity. Powers
   * alias resolution at extraction time (Pipeline B's `writeEntity`) and
   * cross-name lookups (`findByName*`). Curated by the `noteAlias` chat
   * tool and learned by the LLM resolver tier (Phase 2). Stored
   * lowercase; `display_name` retains presentation casing.
   */
  aliases: string[]
  attributes: Record<string, unknown>
  sensitivity: Sensitivity
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string
  createdByAssistantId: string | null
  sourceEpisodeId: string | null
  source: EntitySource
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  retractedBy: string | null
  centrality: number
  centralityComputedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type EntityListRow = Pick<
  EntityRecord,
  'id' | 'kind' | 'displayName' | 'canonicalId' | 'sensitivity' | 'workspaceId' | 'source'
>

export type EntityCreateParams = {
  kind: EntityKind
  displayName: string
  workspaceId: string
  createdByUserId: string
  source: EntitySource
  userId?: string | null
  assistantId?: string | null
  canonicalId?: string | null
  sensitivity?: Sensitivity
  /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
  compartments?: string[]
  attributes?: Record<string, unknown>
  /** Initial alias set (lowercased on write). Defaults to `[]`. */
  aliases?: readonly string[]
  createdByAssistantId?: string | null
  sourceEpisodeId?: string | null
}

export type EntityUpdateFields = {
  displayName?: string
  canonicalId?: string | null
  attributes?: Record<string, unknown>
  sensitivity?: Sensitivity
  verifiedByUserId?: string | null
  verifiedAt?: Date | null
}

/**
 * Fields for `EntityStore.supersedeAttributes`. Everything not set
 * carries forward from the superseded row. `attributes` is the common
 * case — re-extraction merged a fuller picture. `sourceEpisodeId`
 * stamps the *triggering* Episode on the new row per the provenance
 * pattern (data-model.md §Provenance pattern).
 */
export type EntitySupersedePatch = {
  attributes: Record<string, unknown>
  displayName?: string
  canonicalId?: string | null
  sensitivity?: Sensitivity
  /** Triggering Episode for the new row. Defaults to carrying the old row's value. */
  sourceEpisodeId?: string | null
  /** Source of the new row. Defaults to carrying the old row's value. */
  source?: EntitySource
}

export type EntityLinkRecord = {
  id: string
  sourceKind: LinkKind
  sourceId: string
  targetKind: LinkKind
  targetId: string
  edgeType: EdgeType
  attributes: Record<string, unknown>
  source: EntitySource
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  retractedAt: Date | null
  retractedReason: string | null
  sourceEpisodeId: string | null
  sensitivity: Sensitivity
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdAt: Date
}

export type EntityLinkCreateParams = {
  sourceKind: LinkKind
  sourceId: string
  targetKind: LinkKind
  targetId: string
  edgeType: EdgeType
  workspaceId: string
  source: EntitySource
  userId?: string | null
  assistantId?: string | null
  attributes?: Record<string, unknown>
  sensitivity?: Sensitivity
  sourceEpisodeId?: string | null
  /**
   * Bi-temporal validity window. Both default to the column defaults
   * (`validFrom = now()`, `validTo = NULL` — i.e. "currently active").
   * Set `validTo` on creation to record a *past* relationship — e.g.
   * "Kinson left DeltaDeFi in August 2025" is a `works_at` edge that
   * was already closed by the time the chat tool wrote it.
   */
  validFrom?: Date
  validTo?: Date | null
}

// ── Rollup (skeleton — WU-1.8 wires cross-primitive sections) ────────

export type EntityRollupSummary = {
  edge_count: number
  memory_count: number
  episode_count: number
  open_task_count: number
  file_count: number
  kb_chunk_count: number
}

export type EntityRollupEmbedded = {
  edges: EntityLinkRecord[]
  recent_episodes: unknown[]
  recent_memory: unknown[]
  open_tasks: unknown[]
  files: unknown[]
}

export type EntityRollup = {
  entity: EntityRecord
  summary: EntityRollupSummary
  embedded: EntityRollupEmbedded
  followedSupersession?: { fromId: string; toId: string; supersededAt: Date | null }
}

/**
 * Cluster of live entity rows sharing (workspace_id, kind, lower(display_name)).
 * Returned by `EntityStore.findDuplicateClustersSystem` to drive the
 * self-healing dedupe loop. `entityIds` is ordered ascending by
 * `created_at`; the first element is the survivor candidate.
 */
export type DuplicateClusterRow = {
  kind: EntityKind
  displayNameNormalized: string
  entityIds: string[]
}

/**
 * Cluster of live entity rows sharing (workspace_id, lower(display_name))
 * but split across multiple kinds. Returned by
 * `EntityStore.findCrossKindDuplicateClustersSystem` for the second-pass
 * heal that the within-kind cluster cannot collapse. `kinds`, `entityIds`,
 * and `createdAts` are co-indexed and co-sorted by `created_at` ASC.
 */
export type CrossKindClusterRow = {
  displayNameNormalized: string
  kinds: EntityKind[]
  entityIds: string[]
  createdAts: Date[]
}

export type GetEntityOpts = {
  /** Bi-temporal point-in-time. Default = now() (current state). */
  asOf?: Date
  /** Per-rollup edge cap. Default 10 per retrieval.md. */
  edgeLimit?: number
  /** When true, do not auto-follow superseded_by. Used by audit/sync clients. */
  strictIdentity?: boolean
}

// ── Store interfaces ─────────────────────────────────────────────────

export interface EntityStore {
  create(params: EntityCreateParams): Promise<EntityRecord>

  getById(
    ctx: AccessContext,
    id: string,
    opts?: { asOf?: Date },
  ): Promise<EntityRecord | null>

  findByName(
    ctx: AccessContext,
    displayName: string,
    opts?: { kind?: EntityKind; asOf?: Date },
  ): Promise<EntityRecord | null>

  /**
   * System-level lookup — bypasses per-viewer projection so ingest
   * workers can match against entities written by any author in the
   * workspace. See `permissions.md` § Privileged-service exception.
   */
  findByNameSystem(
    actorUserId: string,
    workspaceId: string,
    displayName: string,
    opts?: { kind?: EntityKind; asOf?: Date },
  ): Promise<EntityRecord | null>

  findByCanonicalId(
    ctx: AccessContext,
    canonicalId: string,
    opts?: { asOf?: Date },
  ): Promise<EntityRecord[]>

  /** System-level canonical_id lookup for ingest dedup. */
  findByCanonicalIdSystem(
    actorUserId: string,
    workspaceId: string,
    canonicalId: string,
    opts?: { asOf?: Date },
  ): Promise<EntityRecord[]>

  listForWorkspace(
    ctx: AccessContext,
    opts?: { kind?: EntityKind; limit?: number; offset?: number; asOf?: Date },
  ): Promise<EntityListRow[]>

  /**
   * Self-healing read — find live (valid_to IS NULL) entity rows that
   * collide on (workspace_id, kind, lower(display_name)). Returns one
   * cluster per collision group; each cluster's `entityIds` is sorted
   * ascending by `created_at` so the first id is the natural survivor.
   * Clusters of length 1 (no collision) are omitted.
   *
   * System-level — no AccessContext; the caller is the self-healing
   * orchestrator. Powers the `dedupeEntities` chat tool that calls
   * `mergeEntities()` per non-survivor in each cluster.
   */
  findDuplicateClustersSystem(
    actorUserId: string,
    workspaceId: string,
    opts?: { limit?: number; kind?: EntityKind },
  ): Promise<DuplicateClusterRow[]>

  /**
   * System-level full-record list for a workspace. Returns live
   * (`valid_to IS NULL`) entities ordered newest-first, capped at
   * `limit` (default 200, max 500). Used by self-healing passes that
   * need attribute/alias data the compact `EntityListRow` doesn't
   * carry — most notably the LLM alias clusterer.
   *
   * System-level: bypasses per-viewer projection so heal passes see
   * every author's rows in the workspace.
   */
  listLiveEntitiesSystem(
    actorUserId: string,
    workspaceId: string,
    opts?: { limit?: number; kind?: EntityKind },
  ): Promise<EntityRecord[]>

  /**
   * Cross-kind self-healing read — find entities sharing
   * `(workspace_id, lower(display_name))` but split across kinds.
   * Models the case where the extraction LLM made different kind
   * judgments on different passes (`MeshJS` as both `company` and
   * `project`). Bounded by `maxClusterSize` so noisy short names that
   * happen to recur across many kinds (e.g. one-letter names) aren't
   * auto-collapsed.
   */
  findCrossKindDuplicateClustersSystem(
    actorUserId: string,
    workspaceId: string,
    opts?: { limit?: number; maxClusterSize?: number },
  ): Promise<CrossKindClusterRow[]>

  /**
   * Append a lowercased alias to an entity's `aliases` array.
   * Idempotent — duplicate aliases are de-duped server-side. The same
   * alias bound to a different entity in the same workspace returns
   * `'conflict'` with the conflicting entity id so the caller can
   * surface a resolution prompt to the user. `'not_found'` when the
   * entity doesn't exist or is closed.
   */
  addAlias(
    actorUserId: string,
    entityId: string,
    alias: string,
  ): Promise<
    | { kind: 'ok'; entity: EntityRecord }
    | { kind: 'conflict'; conflictingEntityId: string }
    | { kind: 'not_found' }
  >

  /**
   * Remove an alias from an entity (case-insensitive match). Returns
   * the updated row, or `null` when the entity doesn't exist /
   * alias was not present.
   */
  removeAlias(
    actorUserId: string,
    entityId: string,
    alias: string,
  ): Promise<EntityRecord | null>

  update(
    actorUserId: string,
    id: string,
    fields: EntityUpdateFields,
  ): Promise<EntityRecord | null>

  /**
   * Bi-temporal supersession of a currently-valid entity row.
   *
   * Closes the old row (`valid_to = now()`, `superseded_by = <new id>`)
   * and inserts a fresh row carrying the merged attributes. The new
   * row's `source_episode_id` is the *triggering* Episode — so the
   * audit chain can answer "why did the belief change". `display_name`,
   * `canonical_id`, `kind`, the visibility double, and the trust
   * signals carry forward from the old row unless explicitly patched.
   *
   * Used by Pipeline B when re-extraction discovers new attributes on
   * an entity that already exists (ingest.md §"Re-checkpoint behavior"
   * → "Fact updated → Bi-temporal supersede prior fact"). A no-op
   * caller should compare attributes first — this method always writes.
   *
   * Returns the new (currently-valid) row, or `null` when `id` does not
   * resolve to a live row.
   */
  supersedeAttributes(
    actorUserId: string,
    id: string,
    patch: EntitySupersedePatch,
  ): Promise<EntityRecord | null>

  /**
   * Cross-primitive rollup (entity row + counts + embedded sections).
   */
  getEntity(
    ctx: AccessContext,
    idOrName: string,
    opts?: GetEntityOpts,
  ): Promise<EntityRollup | null>

  /**
   * Self-entity materialisation — Identity Phase 2 (see
   * docs/architecture/brain/corrections.md). Returns the
   * `kind='person'` entity row representing the user themselves;
   * creates it lazily on first call and stamps `users.entity_id`.
   *
   * Bypasses the Q24 CRM-specialization guard (self entities have
   * `attributes.self=true` and no `contacts` specialization row).
   * System-level — no AccessContext; caller validates auth.
   */
  getOrCreateSelf(params: {
    userId: string
    workspaceId: string
    displayName: string
  }): Promise<EntityRecord>

  /**
   * Merge `attributes` into the user's self entity. Creates the self
   * entity if it doesn't exist. JSONB concatenation — incoming keys
   * win over existing ones.
   */
  updateSelfProfile(params: {
    userId: string
    workspaceId: string
    displayName: string
    attributes: Record<string, unknown>
  }): Promise<EntityRecord>
}

export interface EntityLinksStore {
  create(params: EntityLinkCreateParams): Promise<EntityLinkRecord>

  getById(ctx: AccessContext, id: string): Promise<EntityLinkRecord | null>

  walkOutbound(
    ctx: AccessContext,
    sourceKind: LinkKind,
    sourceId: string,
    opts?: { edgeTypes?: readonly EdgeType[]; asOf?: Date; limit?: number },
  ): Promise<EntityLinkRecord[]>

  walkInbound(
    ctx: AccessContext,
    targetKind: LinkKind,
    targetId: string,
    opts?: { edgeTypes?: readonly EdgeType[]; asOf?: Date; limit?: number },
  ): Promise<EntityLinkRecord[]>

  countForEntity(
    ctx: AccessContext,
    entityId: string,
    opts?: { asOf?: Date },
  ): Promise<number>

  /**
   * List every active (non-retracted, non-expired) link in the
   * workspace, capped by `limit`. Powers the brain graph view —
   * walkOutbound / walkInbound are per-entity and would require one
   * round trip per node to assemble the full graph.
   *
   * Honors the access predicate (clearance ceiling + workspace
   * partition + visibility double) like the rest of the store.
   * `sourceKinds` / `targetKinds` default to `['entity']` since the
   * v1 graph view only renders entity nodes; pass an explicit filter
   * to widen to memory / file / etc. once those become node types.
   */
  listForWorkspace(
    ctx: AccessContext,
    opts?: {
      sourceKinds?: readonly LinkKind[]
      targetKinds?: readonly LinkKind[]
      asOf?: Date
      limit?: number
    },
  ): Promise<EntityLinkRecord[]>

  /**
   * Close an active edge by setting `valid_to`. Different from
   * `retract` — this is "the relationship ended" (real-world
   * supersession), not "we recorded the wrong thing" (data
   * correction). `retracted_at` stays NULL; the row remains in
   * history with a closed validity window.
   *
   * Returns the updated row, or null when the edge was already
   * closed/retracted or doesn't exist under the actor's RLS.
   */
  closeAt(
    actorUserId: string,
    id: string,
    validTo: Date,
  ): Promise<EntityLinkRecord | null>

  retract(
    actorUserId: string,
    id: string,
    reason: string,
  ): Promise<EntityLinkRecord | null>
}
