/**
 * Retrieval tool surface — canonical typed contract for the 6 read tools
 * that expose the company brain: getEntity, search, recentEpisodes,
 * provenance, markUseful, aggregate.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md (envelope, cursor model,
 * launch-plain error body, per-tool input/output shapes, flat-filter v1,
 * JSONB-path measure for aggregate).
 *
 * WU-5.1 scaffolds the contract only. WU-5.2–5.7 fulfil the
 * `RetrievalStore` interface inside packages/api/src/db/.
 */

import type {
  EntityRecord,
  EntityRollupEmbedded,
  EntityRollupSummary,
} from '../entities/types.js'
import type { Sensitivity } from '../security/sensitivity.js'
import type { AssistantKind } from '../security/access-context.js'

// ── Envelope ─────────────────────────────────────────────────────────

export type ApiVersion = 'v1'

/** Opaque base64 cursor — format is server-internal and may change between versions. */
export type RetrievalCursor = string

export type FollowedSupersession = {
  from_id: string
  to_id: string
  superseded_at: string
}

export type RetrievalMeta = {
  /** ISO 8601 UTC with milliseconds. Set by the tool on every successful return. */
  retrieved_at: string
  /** Sole indicator of limit-based truncation. Never set due to projection redactions (P1-8). */
  truncated: boolean
  /** Opaque pagination cursor — null when there are no further pages. */
  cursor?: RetrievalCursor | null
  /** Optional capability flags surfaced to the caller. */
  capability_flags?: string[]
  /** Populated when getEntity auto-followed a merged-entity supersession. */
  followed_supersession?: FollowedSupersession
  /**
   * Per-turn neural-search audit trace. Populated only when the caller sets
   * `captureTrace` (the chat path); absent on browse / list / facets. Ordered
   * retrieval steps with per-step model attribution + candidate funnel.
   * See docs/architecture/brain/neural-search-process.md.
   */
  search_trace?: RetrievalStep[]
}

export type RetrievalEnvelope<T> = {
  api_version: ApiVersion
  data: T
  meta: RetrievalMeta
}

/** Launch-plain error body. Structured error codes are deferred (retrieval.md §5.6). */
export type RetrievalErrorBody = {
  error: string
}

/** Discriminated union — the tool's `ToolResult.data` carries this. */
export type RetrievalResult<T> = RetrievalEnvelope<T> | RetrievalErrorBody

// ── Actor ────────────────────────────────────────────────────────────

/**
 * Permission-predicate inputs derived from `ToolContext`. The store layer
 * only needs the projection fields, not the full chat context.
 *
 * `assistantKind` drives the primary widen in the universal access
 * predicate — `'primary'` drops the assistant_id partition so the
 * workspace reflector sees every assistant's rows.
 */
export type RetrievalActor = {
  workspaceId: string
  userId: string
  assistantId: string
  assistantKind: AssistantKind
  /** Maximum sensitivity the assistant may read. Undefined = passthrough (system callers). */
  clearance?: Sensitivity
  /**
   * Effective compartment grant (MLS category axis — `member ∩ assistant`).
   * `undefined`/`null` = universe (clause dropped). Not yet populated by
   * `actorFromContext` — the read-gate ships inert until wiring lands, but the
   * field lives here so every retrieval read path (search, aggregate, episodes)
   * forwards it through one chokepoint rather than silently omitting it. See
   * docs/plans/compartment-axis.md.
   */
  compartments?: string[] | null
}

// ── Shared input fragments ───────────────────────────────────────────

/**
 * Flat key-value filter dict. v1 — implicit operators, no tree syntax,
 * server-side per-primitive allowlist enforces accepted keys.
 */
export type RetrievalFilters = Record<string, unknown>

// ── getEntity ────────────────────────────────────────────────────────

export type GetEntityLimits = {
  recent_episodes?: number
  recent_memory?: number
  open_tasks?: number
  edges?: number
  files?: number
  kb_chunks?: number
}

export type GetEntityInput = {
  id_or_name: string
  as_of?: string
  walk_depth?: number
  walk_edge_types?: string[]
  include?: string[]
  exclude?: string[]
  limits?: GetEntityLimits
}

export type EntitySummaryCounts = EntityRollupSummary

export type GetEntityData = {
  entity: EntityRecord
  summary: EntitySummaryCounts
  embedded: EntityRollupEmbedded
}

// ── search ───────────────────────────────────────────────────────────

export type SearchInput = {
  query: string
  as_of?: string
  scope?: string
  filters?: RetrievalFilters
  limit?: number
  cursor?: RetrievalCursor
  /**
   * Include the semantic vector arm (default true). Chat-grade recall wants
   * it; FILTER surfaces (the Brain page's search box) set `false` so a query
   * only matches literally (FTS/ILIKE) — otherwise an embedded query like
   * "sidan" surfaces every row semantically near the workspace's own topic
   * and the filter looks broken (it returns rows that don't contain the
   * text). See retrieval.md → "Layer 2 — candidate fetch".
   */
  semantic?: boolean
}

/** Heterogeneous result row — primitive discriminator plus the row body. */
export type SearchResultRow = {
  primitive: string
  row_id: string
  [k: string]: unknown
}

export type SearchData = SearchResultRow[]

/**
 * Doc brain-first user-defined entity instance row, surfaced through
 * `search` when `primitive === 'entity_instance'`. The discriminator is kept
 * distinct from the brain-anchor `'entity'` primitive to avoid collision in
 * unscoped search results. See `packages/api/src/db/retrieval-store.ts` →
 * `searchEntityInstancesScope`. Phase 1 P1E.
 */
export type EntityInstanceSearchRow = SearchResultRow & {
  primitive: 'entity_instance'
  entity_type_id: string
  workspace_id: string
  title?: string
  created_at: string
  source_app: 'doc' | 'chat' | 'import' | 'api'
}

// ── Neural search process trace (audit) ─────────────────────────────

/**
 * Ordered retrieval-step vocabulary for the per-chat neural search audit.
 * Frozen union — the UI localizes each label; the string is stable and stored.
 * See docs/architecture/brain/neural-search-process.md.
 */
export type RetrievalStepName =
  | 'kb_core_index'
  | 'kb_fts_search'
  | 'vector_search'
  | 'rrf_fusion'
  | 'trust_rerank'
  | 'mmr_diversify'
  | 'permission_projection'

/** One retrieved candidate surfaced in a step — drives the scored list + per-row feedback. */
export type RetrievalStepCandidate = {
  rowId: string
  primitive: string
  summary: string
  /** Step-relevant score (RRF score or final relevance). */
  score: number
  ranks?: { fts?: number; vector?: number; recency?: number; graph?: number }
  trustWeight?: number
  selectedByMmr?: boolean
}

/**
 * One step in the ordered retrieval sequence the brain ran for a turn.
 * `metrics` is the candidate funnel (before → after); `candidates` is present
 * on the steps that carry a result set (today the `mmr_diversify` step).
 */
export type RetrievalStep = {
  stepNumber: number
  name: RetrievalStepName
  /**
   * Model / attribution label per neural-search-process.md — e.g. `inference`
   * (no LLM), `fts+ilike`, an embedding model id, or `gemini-3.1-flash-lite`
   * for the Layer-1 topic step.
   */
  model: string
  /** Human-facing scopes / methods this step touched. */
  touched: string[]
  metrics?: { candidatesBefore: number; candidatesAfter: number }
  candidates?: RetrievalStepCandidate[]
}

// ── recentEpisodes ───────────────────────────────────────────────────

export type RecentEpisodesInput = {
  entity?: string
  as_of?: string
  limit?: number
  cursor?: RetrievalCursor
  filters?: RetrievalFilters
}

/**
 * Structurally-typed Episode row to keep retrieval's contract self-contained.
 * The store-side concrete shape (packages/core/src/ingest/types.ts) is broader;
 * the retrieval surface only commits to the discriminating fields callers depend on.
 */
export type RecentEpisodeRow = {
  id: string
  source_kind: string
  occurred_at: string
  sensitivity: Sensitivity
  [k: string]: unknown
}

export type RecentEpisodesData = RecentEpisodeRow[]

// ── provenance ───────────────────────────────────────────────────────

export type ProvenanceInput = {
  row_id: string
}

export type ProvenanceSourceEpisode = {
  id: string
  source_kind: string
  occurred_at: string
  sensitivity: Sensitivity
  /** Spec lists actors + content_ref here; kept open-shape until WU-5.5 nails the contract. */
  content_ref?: unknown
  actors?: unknown[]
}

export type ProvenanceDerivedRef = {
  primitive: string
  row_id: string
  relationship: 'extracted_from' | 'consolidated_from' | 'inferred_from' | 'merged_from'
}

export type ProvenanceData = {
  row_id: string
  primitive: string
  /** null = no Episode source, OR caller cannot access the source (silent redaction per P1-8). */
  source_episode: ProvenanceSourceEpisode | null
  /**
   * Origin surface for Doc user-defined entity rows (`entity_instances`,
   * migration 200) — `doc` | `chat` | `import` | `api`. Present only for
   * the `entity_instances` primitive; omitted for every bi-temporal
   * primitive (those carry origin via `source_episode` + the `source`
   * column instead). Doc v1 §5.2.
   */
  source_app?: 'doc' | 'chat' | 'import' | 'api'
  authorship: {
    created_by_user_id: string
    created_by_assistant_id: string | null
    created_at: string
  }
  /** Inaccessible entries are omitted entirely (silent redaction per P1-8). */
  derived_from: ProvenanceDerivedRef[]
  supersession: {
    preceded_by: string | null
    superseded_by: string | null
    valid_from: string
    valid_to: string | null
  }
  re_extracted_at: Array<{ from_episode: string; at: string }>
}

// ── markUseful ───────────────────────────────────────────────────────

export type MarkUsefulPrimitive = 'memory' | 'entity' | 'edge' | 'task' | 'kb_chunk'

export type MarkUsefulInput = {
  row_id: string
  primitive: MarkUsefulPrimitive
}

export type MarkUsefulData = {
  success: boolean
}

// ── aggregate ────────────────────────────────────────────────────────

export type AggregateMeasure =
  | { fn: 'count' }
  | { fn: 'sum' | 'max' | 'min' | 'avg'; path: string }

export type AggregateInput = {
  measure: AggregateMeasure
  dimensions: string[]
  filters?: RetrievalFilters
  as_of?: string
}

/** Grouped result rows — dimensions present as own keys, plus `measure_value`. */
export type AggregateResultRow = Record<string, unknown> & {
  measure_value: number | string
}

export type AggregateData = AggregateResultRow[]

// ── getRowHistory (D.7 supersession audit + D.8 authorship) ─────────

/**
 * Cross-primitive row status derived from the universal bi-temporal +
 * retraction columns per `corrections.md` §D.7. Per-primitive narrowed
 * types (e.g. `WorkspaceFileRowStatus`) continue to exist; this is the
 * cross-primitive view emitted by `getRowHistory`.
 *
 * `archived` is reserved for primitive-specific terminal states (e.g.
 * hard-closed Episodes) and is not emitted today — `getRowHistory`
 * covers the six bi-temporal primitives only.
 */
export type RowStatus = 'active' | 'superseded' | 'retracted' | 'archived'

export type RowHistoryPrimitive =
  | 'memories'
  | 'tasks'
  | 'workspace_files'
  | 'entities'
  | 'companies'
  | 'contacts'
  | 'deals'

export type RowHistoryInput = {
  primitive: RowHistoryPrimitive
  row_id: string
  /** Default `true` per `corrections.md` §D.7. */
  include_retracted?: boolean
  /** ISO 8601 UTC timestamp. Clamps the chain to versions visible at the timestamp. */
  as_of?: string
}

/**
 * One version in a supersession chain. Authorship fields are present on
 * every version per `corrections.md` §D.8 authorship modifier — the
 * model needs them to evaluate elevated rights ("can the author delete
 * this") without a second round-trip.
 */
export type RowHistoryVersion = {
  id: string
  primitive: RowHistoryPrimitive
  status: RowStatus
  valid_from: string
  valid_to: string | null
  superseded_by: string | null
  retracted_at: string | null
  retracted_reason: string | null
  created_by_user_id: string | null
  created_by_assistant_id: string | null
  created_at: string
  /** Compact identity (display name, summary, title) — primitive picks one or two human-readable fields. */
  display: Record<string, unknown>
}

export type RowHistoryData = {
  /** Oldest → newest by `valid_from`. */
  chain: RowHistoryVersion[]
  /** Id of the version active at the resolved `as_of`, or `null` if every version is tombstoned. */
  current_id: string | null
}

// ── Store interface (fulfilled by WU-5.2–5.7) ───────────────────────

export interface RetrievalStore {
  getEntity(
    actor: RetrievalActor,
    input: GetEntityInput,
  ): Promise<RetrievalEnvelope<GetEntityData> | null>

  search(
    actor: RetrievalActor,
    input: SearchInput,
  ): Promise<RetrievalEnvelope<SearchData>>

  recentEpisodes(
    actor: RetrievalActor,
    input: RecentEpisodesInput,
  ): Promise<RetrievalEnvelope<RecentEpisodesData>>

  provenance(
    actor: RetrievalActor,
    input: ProvenanceInput,
  ): Promise<RetrievalEnvelope<ProvenanceData> | null>

  markUseful(
    actor: RetrievalActor,
    input: MarkUsefulInput,
  ): Promise<RetrievalEnvelope<MarkUsefulData>>

  aggregate(
    actor: RetrievalActor,
    input: AggregateInput,
  ): Promise<RetrievalEnvelope<AggregateData>>

  /**
   * D.7 supersession audit. Returns the full version chain for `row_id`
   * across the primitive's bi-temporal columns. `null` when the id is
   * unknown / RLS-hidden.
   */
  getRowHistory(
    actor: RetrievalActor,
    input: RowHistoryInput,
  ): Promise<RetrievalEnvelope<RowHistoryData> | null>
}

// ── Tool-level event surface (analytics callback) ───────────────────

export type RetrievalToolEvent =
  | { type: 'entity_retrieved'; idOrName: string; found: boolean }
  | { type: 'search_executed'; query: string; resultCount: number }
  | { type: 'recent_episodes_listed'; resultCount: number; entity?: string }
  | { type: 'provenance_walked'; rowId: string; found: boolean }
  | { type: 'mark_useful_recorded'; rowId: string; primitive: MarkUsefulPrimitive }
  | { type: 'aggregate_computed'; resultCount: number; fn: AggregateMeasure['fn'] }
  | { type: 'row_history_walked'; primitive: RowHistoryPrimitive; rowId: string; chainLength: number }
