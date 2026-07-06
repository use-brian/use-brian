import type {
  Embedder,
  EntityInstanceSearchRow,
  EntityRollup,
  EntityStore,
  GetEntityData,
  GetEntityInput,
  RecentEpisodeRow,
  RecentEpisodesData,
  RecentEpisodesInput,
  RetrievalActor,
  RetrievalCursor,
  RetrievalEnvelope,
  RetrievalFilters,
  RetrievalStep,
  RetrievalStepCandidate,
  RetrievalStore,
  RrfRankedList,
  SearchData,
  SearchInput,
  SearchResultRow,
  VectorHit,
} from '@sidanclaw/core'
import {
  DEFAULT_MMR_LAMBDA,
  RRF_METHOD,
  SENSITIVITY_VALUES,
  isSensitivity,
  mmrRerank,
  rowTrustWeight,
  rrfFuse,
  vectorRankedList,
} from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { queryWithRLS } from './client.js'

/**
 * `retrieval-store.ts` — WS-5 / WU-5.3.
 *
 * Implements `search` and `recentEpisodes` of the `RetrievalStore`
 * interface (`packages/core/src/retrieval/types.ts`). The remaining four
 * methods land in sibling files (`entities-store.ts` for `getEntity`,
 * `aggregate-store.ts`, `provenance-store.ts`) and a `markUseful` store.
 * The factory exported here returns a `Pick<RetrievalStore, 'search' |
 * 'recentEpisodes'>`; the coordinator composes the full store at the
 * route layer.
 *
 * v1 design (per docs/architecture/brain/retrieval-layer.md):
 *   * Hybrid retrieval is FTS + ILIKE for candidate fetch. The Layer-3
 *     fuse-and-rerank pipeline (WU-5.7) runs in-process after fetch:
 *     `rrfFuse([fts, graph, recency])` → multiplicative `rowTrustWeight`
 *     → `mmrRerank` diversification. The vector ranked-list is a
 *     deliberately-empty slot — WS-8 / WU-8.5 embeds the query and slots
 *     `vectorRankedList(hits)` into the same `rrfFuse` call. RRF degrades
 *     gracefully: a method a row is absent from contributes 0, so the
 *     missing vector list (and the graph list at the search-tool level,
 *     which has no per-query anchor) costs nothing.
 *   * Permission projection is inline: workspace partition + visibility
 *     double + bi-temporal validity + `retracted_at IS NULL` +
 *     `sensitivity_rank()` clearance ceiling. WS-4 / WU-4.2 will extract
 *     this into a shared `access-predicate.ts`.
 *   * Flat filter language v1 — implicit operators, per-primitive
 *     allowlist. Unknown keys throw a plain `Error` (caught by the tool
 *     wrapper into `RetrievalErrorBody`).
 *   * Opaque base64url cursor, JSON-encoded `{ skip }`. Format is
 *     contractually opaque so the codec can grow without consumer break.
 *
 * Known gaps reported to coordinator:
 *   * No FTS columns on entities / kb_chunks / tasks / contacts /
 *     companies / deals (mig 125 + 132 headers anticipated a WU-5.3
 *     batch migration; this brief lists none and the registry reserves
 *     no number). ILIKE fallback works but lacks rank scoring and GIN
 *     index acceleration — rows from an ILIKE-only scope simply don't
 *     join the FTS ranked list and rank on the recency + trust signals.
 *   * `deals` has no `name` / `title` text column — text-query search
 *     skips deals entirely. Filters still apply via `scope='deal'`.
 */

// ── Constants ────────────────────────────────────────────────────────

const SEARCH_LIMIT_DEFAULT = 20
const SEARCH_LIMIT_MAX = 100

const RECENT_EPISODES_LIMIT_DEFAULT = 20
const RECENT_EPISODES_LIMIT_MAX = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KNOWN_SCOPES = [
  'memory',
  'task',
  'file',
  'entity',
  'contact',
  'company',
  'deal',
  'kb_chunk',
  // Doc v1 user-defined entity rows (`entity_instances`, migration 200).
  // Brain-anchor `entity` stays distinct — see EntityInstanceSearchRow in
  // packages/core/src/retrieval/types.ts. This primitive carries NO
  // bi-temporal / sensitivity / trust columns, so it takes a dedicated
  // scope handler instead of the shared `visibilityPredicate` path.
  'entity_instance',
  // Workspace-file body chunks (`file_segments`, migration 297 —
  // large-content-artifacts hybrid discoverability). UNLIKE
  // transcript_segments (deliberately out so recordings never flood), this
  // scope participates in unscoped search BUT is hard-capped per source
  // artifact: ROW_NUMBER ≤ FILE_SEGMENT_ARM_CAP per file inside each arm,
  // and ≤ FILE_SEGMENT_GROUP_CAP per file in the final fused page
  // (groupKey in fuseAndDiversifyTraced). Precision retrieval inside one
  // file is the dedicated searchFileSegments handler.
  'file_segment',
] as const
type Scope = (typeof KNOWN_SCOPES)[number]

function isScope(s: string): s is Scope {
  return (KNOWN_SCOPES as readonly string[]).includes(s)
}

/** Per-scope filter allowlist. `since` is universally accepted. */
const ALLOWED_FILTERS_BY_SCOPE: Record<Scope, ReadonlySet<string>> = {
  memory:   new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  task:     new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  file:     new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  entity:   new Set(['since', 'sensitivity', 'source']),
  contact:  new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  company:  new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  deal:     new Set(['since', 'sensitivity', 'source']),
  kb_chunk: new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  file_segment: new Set(['tag', 'tags', 'since', 'sensitivity', 'source']),
  // `entity_instances` has no bi-temporal / sensitivity / tags columns;
  // `since` filters on `created_at`, `entity_type_id` narrows the search
  // to one user-defined type, and `source_app` matches the provenance
  // surface (doc / chat / import / api).
  entity_instance: new Set(['since', 'entity_type_id', 'source_app']),
}

const ALLOWED_FILTERS_EPISODE = new Set(['since', 'source_kind', 'sensitivity']) as ReadonlySet<string>

// ── Cursor codec ─────────────────────────────────────────────────────

type CursorState = { skip: number }

function encodeCursor(state: CursorState): RetrievalCursor {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
}

function decodeCursor(cursor: RetrievalCursor): CursorState {
  let raw: string
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw new Error('invalid cursor')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid cursor')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { skip?: unknown }).skip !== 'number'
  ) {
    throw new Error('invalid cursor')
  }
  const skip = (parsed as { skip: number }).skip
  if (!Number.isFinite(skip) || skip < 0 || !Number.isInteger(skip)) {
    throw new Error('invalid cursor')
  }
  return { skip }
}

// ── Filter validation ────────────────────────────────────────────────

function validateFilters(filters: RetrievalFilters | undefined, allowed: ReadonlySet<string>): void {
  if (!filters) return
  for (const key of Object.keys(filters)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown filter key: ${key}`)
    }
  }
  if ('sensitivity' in filters) {
    const v = filters.sensitivity
    if (typeof v !== 'string' || !isSensitivity(v)) {
      throw new Error(`sensitivity filter must be one of: ${SENSITIVITY_VALUES.join(', ')}`)
    }
  }
  if ('since' in filters) {
    const v = filters.since
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      throw new Error('since filter must be an ISO timestamp string')
    }
  }
  if ('tag' in filters) {
    if (typeof filters.tag !== 'string') {
      throw new Error('tag filter must be a string')
    }
  }
  if ('tags' in filters) {
    if (
      !Array.isArray(filters.tags) ||
      filters.tags.some((t) => typeof t !== 'string')
    ) {
      throw new Error('tags filter must be a string array')
    }
  }
  if ('source' in filters && typeof filters.source !== 'string') {
    throw new Error('source filter must be a string')
  }
  if ('source_kind' in filters && typeof filters.source_kind !== 'string') {
    throw new Error('source_kind filter must be a string')
  }
  if ('entity_type_id' in filters) {
    const v = filters.entity_type_id
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      throw new Error('entity_type_id filter must be a UUID')
    }
  }
  if ('source_app' in filters) {
    const v = filters.source_app
    if (
      typeof v !== 'string' ||
      !['doc', 'chat', 'import', 'api'].includes(v)
    ) {
      throw new Error('source_app filter must be one of: doc, chat, import, api')
    }
  }
}

// ── FTS query builder ────────────────────────────────────────────────

/**
 * Tokenize `query` into a tsquery prefix form: `"hello world"` → `"hello:* & world:*"`.
 * Strips punctuation but preserves CJK ranges so non-ASCII queries still
 * tokenize. Returns null when no usable tokens remain — callers then fall
 * back to ILIKE.
 */
function tsqueryPrefix(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t: string) =>
      t.replace(
        /[^a-zA-Z0-9一-鿿぀-ゟ゠-ヿ가-힯]/g,
        '',
      ),
    )
    .filter(Boolean)
    .map((t: string) => `${t}:*`)
  if (terms.length === 0) return null
  return terms.join(' & ')
}

// ── Predicate fragment builder ───────────────────────────────────────

/**
 * Build the common projection predicate for a primitive that carries the
 * universal column set (workspace + visibility double + bi-temporal +
 * retracted + sensitivity ceiling). The caller assembles the parameter
 * list; this function appends bind values to `values` and returns SQL
 * fragments to splice into the WHERE clause.
 *
 * The first four axes (workspace + visibility-double + sensitivity) come
 * from the shared `buildAccessPredicate` helper (WU-4.1 / P1-12). The
 * bi-temporal + retraction clauses are orthogonal and composed here.
 *
 * `asOf` is treated as an inclusive lower bound on `valid_from` and an
 * exclusive upper bound on `valid_to` (per retrieval.md §Bi-temporal).
 *
 * When the actor has no clearance (system caller), the sensitivity
 * ceiling is omitted and only the workspace + visibility-double axes
 * apply.
 */
function visibilityPredicate(
  actor: RetrievalActor,
  asOf: string | undefined,
  values: unknown[],
  opts: { tableAlias?: string } = {},
): string {
  const t = opts.tableAlias ? `${opts.tableAlias}.` : ''
  const parts: string[] = []

  if (actor.clearance) {
    const ap = buildAccessPredicate(
      {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        assistantId: actor.assistantId,
        assistantKind: actor.assistantKind,
        clearance: actor.clearance,
        // Forwarded so the compartment clause gates every retrieval read once
        // wiring populates it (undefined today → universe → inert). The else
        // branch below is the system/no-clearance caller, universe by design.
        compartments: actor.compartments,
      },
      { alias: opts.tableAlias, startIdx: values.length + 1 },
    )
    values.push(...ap.params)
    parts.push(ap.sql)
  } else {
    // System caller path: same three projection axes minus the sensitivity
    // ceiling. Kept inline so buildAccessPredicate's required-clearance
    // contract stays narrow.
    values.push(actor.workspaceId)
    const wIdx = values.length
    values.push(actor.userId)
    const uIdx = values.length
    values.push(actor.assistantId)
    const aIdx = values.length
    parts.push(
      `${t}workspace_id = $${wIdx}`,
      `(${t}user_id IS NULL OR ${t}user_id = $${uIdx})`,
      `(${t}assistant_id IS NULL OR ${t}assistant_id = $${aIdx})`,
    )
  }

  values.push(asOf ?? null)
  const asOfIdx = values.length
  parts.push(
    `${t}retracted_at IS NULL`,
    `${t}valid_from <= COALESCE($${asOfIdx}::timestamptz, now())`,
    `(${t}valid_to IS NULL OR ${t}valid_to > COALESCE($${asOfIdx}::timestamptz, now()))`,
  )

  return parts.join(' AND ')
}

/**
 * Episodes use `ingested_at <= as_of` instead of bi-temporal valid_from/to
 * (episodes are append-only — no supersession, no retraction). Universal
 * projection still flows through `buildAccessPredicate`.
 */
function episodeVisibilityPredicate(
  actor: RetrievalActor,
  asOf: string | undefined,
  values: unknown[],
  opts: { tableAlias?: string } = {},
): string {
  const t = opts.tableAlias ? `${opts.tableAlias}.` : ''
  const parts: string[] = []

  if (actor.clearance) {
    const ap = buildAccessPredicate(
      {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        assistantId: actor.assistantId,
        assistantKind: actor.assistantKind,
        clearance: actor.clearance,
        // Forwarded so the compartment clause gates every retrieval read once
        // wiring populates it (undefined today → universe → inert). The else
        // branch below is the system/no-clearance caller, universe by design.
        compartments: actor.compartments,
      },
      { alias: opts.tableAlias, startIdx: values.length + 1 },
    )
    values.push(...ap.params)
    parts.push(ap.sql)
  } else {
    values.push(actor.workspaceId)
    const wIdx = values.length
    values.push(actor.userId)
    const uIdx = values.length
    values.push(actor.assistantId)
    const aIdx = values.length
    parts.push(
      `${t}workspace_id = $${wIdx}`,
      `(${t}user_id IS NULL OR ${t}user_id = $${uIdx})`,
      `(${t}assistant_id IS NULL OR ${t}assistant_id = $${aIdx})`,
    )
  }

  values.push(asOf ?? null)
  const asOfIdx = values.length
  parts.push(`${t}ingested_at <= COALESCE($${asOfIdx}::timestamptz, now())`)

  return parts.join(' AND ')
}

function applyFlatFilters(
  filters: RetrievalFilters | undefined,
  values: unknown[],
  spec: {
    sinceColumn: string
    /** Whether the target table has a `tags TEXT[]` column. */
    tagsColumn?: string
    sourceColumn?: string
    sensitivityColumn?: string
    /** Episode-only: `source_kind` predicate column. */
    sourceKindColumn?: string
  },
): string {
  if (!filters) return ''
  const parts: string[] = []

  if ('since' in filters && typeof filters.since === 'string') {
    values.push(filters.since)
    parts.push(`${spec.sinceColumn} >= $${values.length}::timestamptz`)
  }
  if ('tag' in filters && typeof filters.tag === 'string' && spec.tagsColumn) {
    values.push([filters.tag])
    parts.push(`${spec.tagsColumn} @> $${values.length}::text[]`)
  }
  if ('tags' in filters && Array.isArray(filters.tags) && spec.tagsColumn) {
    values.push(filters.tags)
    parts.push(`${spec.tagsColumn} @> $${values.length}::text[]`)
  }
  if ('sensitivity' in filters && typeof filters.sensitivity === 'string' && spec.sensitivityColumn) {
    values.push(filters.sensitivity)
    parts.push(`${spec.sensitivityColumn} = $${values.length}`)
  }
  if ('source' in filters && typeof filters.source === 'string' && spec.sourceColumn) {
    values.push(filters.source)
    parts.push(`${spec.sourceColumn} = $${values.length}`)
  }
  if ('source_kind' in filters && typeof filters.source_kind === 'string' && spec.sourceKindColumn) {
    values.push(filters.source_kind)
    parts.push(`${spec.sourceKindColumn} = $${values.length}`)
  }

  return parts.length === 0 ? '' : ' AND ' + parts.join(' AND ')
}

// ── Per-primitive search helpers ─────────────────────────────────────
//
// Each helper returns ScoredRow[] — the public SearchResultRow plus the
// Layer-3 ranking signals (`ftsRank`, `validFrom`, trust columns). The
// dispatcher fans out, fuses, trust-weights, and MMR-reranks; the codec
// is offset-based at v1 (opaque cursor encodes `{ skip }` only). Once
// score-based pagination matters we add `last_score`/`last_id`.

type FetchOpts = {
  query: string
  filters: RetrievalFilters | undefined
  asOf: string | undefined
  skip: number
  take: number
}

/**
 * Candidate carrying the Layer-3 ranking signals alongside the public
 * `SearchResultRow`. `ftsRank` is the per-scope FTS `ts_rank` score
 * where the scope ran a full-text query; `null` for ILIKE-only scopes
 * (those rows simply don't join the FTS ranked list — the
 * graceful-degradation path RRF is built for). `trust` feeds
 * `rowTrustWeight` after fusion.
 *
 * Exported for the `fuseAndDiversify` wired-path tests.
 */
export type ScoredRow = {
  row: SearchResultRow
  /** ISO 8601 — recency ranked-list key. */
  validFrom: string
  /** FTS `ts_rank` score, or null when the scope used ILIKE only. */
  ftsRank: number | null
  /**
   * pgvector cosine distance to the query embedding (WU-8.5), or null
   * when the row was not in the vector arm — the scope ran no vector
   * search, the row has a NULL `embedding`, or no embedder is wired.
   * `fuseAndDiversify` builds the RRF `vector` list from rows that
   * carry a non-null distance.
   */
  vectorDistance: number | null
  trust: { source: string; verified_by_user_id: string | null; retracted_at: string | null }
  /** Tags carried for the MMR diversity similarity. */
  tags: readonly string[]
  /**
   * Per-source-cap group for the fused page (large-content-artifacts): set
   * ONLY by the file_segment handlers (`file:{file_id}`) so one artifact's
   * chunks hold at most FILE_SEGMENT_GROUP_CAP slots in the final results.
   * Rows without a groupKey are never capped.
   */
  groupKey?: string
}

/**
 * Trust-column fragment selected by every scope so `rowTrustWeight` can
 * run. Shape matches the `pg` row — `retracted_at` arrives as a `Date`;
 * `scoredRow` normalises it to an ISO string for the `ScoredRow`.
 */
type TrustCols = {
  source: string
  verified_by_user_id: string | null
  retracted_at: Date | null
}

function scoredRow(args: {
  row: SearchResultRow
  validFrom: Date
  ftsRank: number | null
  trust: { source: string; verified_by_user_id: string | null; retracted_at: Date | null }
  tags?: readonly string[]
  /** Set only by the vector arm; omitted ⇒ null. */
  vectorDistance?: number | null
  /** Set only by the file_segment handlers (per-source fused-page cap). */
  groupKey?: string
}): ScoredRow {
  return {
    row: args.row,
    validFrom: args.validFrom.toISOString(),
    ftsRank: args.ftsRank,
    vectorDistance: args.vectorDistance ?? null,
    trust: {
      source: args.trust.source,
      verified_by_user_id: args.trust.verified_by_user_id,
      retracted_at: args.trust.retracted_at?.toISOString() ?? null,
    },
    tags: args.tags ?? [],
    ...(args.groupKey ? { groupKey: args.groupKey } : {}),
  }
}

async function searchMemoriesScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    tagsColumn: 'tags',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  // Snapshot the bind-array length so the ILIKE branch can rewind past the
  // FTS bindings on a zero-row fall-through. Without this, $tsq/$take/$skip
  // remain in `values` but the ILIKE SQL never references them — PostgreSQL
  // then raises "could not determine data type of parameter $6".
  const baseLen = values.length

  type Row = TrustCols & {
    row_id: string
    summary: string
    tags: string[]
    sensitivity: string
    valid_from: Date
    rank?: number
  }

  const tsq = tsqueryPrefix(opts.query)
  if (tsq) {
    values.push(tsq)
    const tsqIdx = values.length
    values.push(opts.take)
    const limIdx = values.length
    values.push(opts.skip)
    const offIdx = values.length
    const result = await queryWithRLS<Row>(
      actor.userId,
      `SELECT id AS row_id, summary, tags, sensitivity, valid_from,
              source, verified_by_user_id, retracted_at,
              ts_rank(search_vector, to_tsquery('simple', $${tsqIdx})) AS rank
         FROM memories
        WHERE ${visibility}${filters}
          AND search_vector @@ to_tsquery('simple', $${tsqIdx})
        ORDER BY rank DESC, valid_from DESC, id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      values,
    )
    if (result.rows.length > 0) {
      return result.rows.map((r) =>
        scoredRow({
          row: {
            primitive: 'memory',
            row_id: r.row_id,
            summary: r.summary,
            tags: r.tags,
            sensitivity: r.sensitivity,
            valid_from: r.valid_from.toISOString(),
          },
          validFrom: r.valid_from,
          ftsRank: r.rank ?? null,
          trust: r,
          tags: r.tags,
        }),
      )
    }
    values.length = baseLen
  }

  // ILIKE fallback (CJK / short queries / FTS miss) — no FTS rank.
  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<Row>(
    actor.userId,
    `SELECT id AS row_id, summary, tags, sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM memories
      WHERE ${visibility}${filters}
        AND (summary ILIKE $${likeIdx} OR detail ILIKE $${likeIdx})
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'memory',
        row_id: r.row_id,
        summary: r.summary,
        tags: r.tags,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: r.tags,
    }),
  )
}

async function searchFilesScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    tagsColumn: 'tags',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  // Snapshot the bind-array length so the ILIKE branch can rewind past the
  // FTS bindings on a fall-through (same pattern as searchMemoriesScope).
  const baseLen = values.length

  type Row = TrustCols & {
    row_id: string
    title: string | null
    name: string
    tags: string[]
    sensitivity: string
    valid_from: Date
    rank?: number
  }

  // FTS path — only when there's a real query. `plainto_tsquery('english','')`
  // yields an empty tsquery that matches ZERO rows, so an empty-query browse
  // (Files filter with no search) must NOT take the FTS branch — otherwise
  // every file vanishes from browse mode and the "All" list. Mirror every
  // other scope: an empty query falls straight through to the ILIKE branch
  // whose `'%%'` pattern matches all files in scope.
  if (opts.query.trim().length > 0) {
    values.push(opts.query)
    const qIdx = values.length
    values.push(opts.take)
    const limIdx = values.length
    values.push(opts.skip)
    const offIdx = values.length
    const result = await queryWithRLS<Row>(
      actor.userId,
      `SELECT id AS row_id, title, name, tags, sensitivity, valid_from,
              source, verified_by_user_id, retracted_at,
              ts_rank_cd(search_vector, plainto_tsquery('english', $${qIdx})) AS rank
         FROM workspace_files
        WHERE ${visibility}${filters}
          AND search_vector @@ plainto_tsquery('english', $${qIdx})
        ORDER BY rank DESC, valid_from DESC, id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      values,
    )
    if (result.rows.length > 0) {
      return result.rows.map((r) =>
        scoredRow({
          row: {
            primitive: 'file',
            row_id: r.row_id,
            title: r.title ?? r.name,
            tags: r.tags,
            sensitivity: r.sensitivity,
            valid_from: r.valid_from.toISOString(),
          },
          validFrom: r.valid_from,
          ftsRank: r.rank ?? null,
          trust: r,
          tags: r.tags,
        }),
      )
    }
    values.length = baseLen
  }

  // ILIKE fallback — empty-query browse (`'%%'` matches every file) and the
  // FTS-miss / CJK / short-query case. No FTS rank; rows rank on recency +
  // trust, exactly like the other ILIKE-only scopes.
  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<Row>(
    actor.userId,
    `SELECT id AS row_id, title, name, tags, sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM workspace_files
      WHERE ${visibility}${filters}
        AND (title ILIKE $${likeIdx} OR name ILIKE $${likeIdx})
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'file',
        row_id: r.row_id,
        title: r.title ?? r.name,
        tags: r.tags,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: r.tags,
    }),
  )
}

async function searchEntitiesScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      kind: string
      display_name: string
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    // Q24: person/company/deal entities are CRM-specialized — their
    // user-facing data lives in the contacts/companies/deals
    // specialization tables, surfaced via their own search scopes.
    // Returning them here too would double-list every CRM row in the
    // brain (once as an attribute-empty `entity` row, once as the
    // proper `contact`/`company`/`deal` row). Mirrors the inbox
    // listing's filter (`brain-inbox-store.ts` → entity branch).
    `SELECT id AS row_id, kind, display_name, sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM entities
      WHERE ${visibility}${filters}
        AND kind NOT IN ('person', 'company', 'deal')
        AND (display_name ILIKE $${likeIdx} OR canonical_id ILIKE $${likeIdx})
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'entity',
        row_id: r.row_id,
        kind: r.kind,
        display_name: r.display_name,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: [r.kind],
    }),
  )
}

async function searchContactsScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  // No tagsColumn: entity tags live in `attributes`, not a column.
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      name: string
      email: string | null
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    // Post CRM→entity unification: contacts are `entities` of kind=person;
    // typed fields live in `attributes`. Self entity excluded.
    `SELECT id AS row_id, display_name AS name,
            COALESCE(attributes->>'email', canonical_id) AS email,
            sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM entities
      WHERE ${visibility}${filters}
        AND kind = 'person'
        AND NOT COALESCE((attributes->>'self')::boolean, false)
        AND (display_name ILIKE $${likeIdx} OR attributes->>'email' ILIKE $${likeIdx} OR attributes->>'phone' ILIKE $${likeIdx})
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'contact',
        row_id: r.row_id,
        name: r.name,
        email: r.email,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: ['contact'],
    }),
  )
}

async function searchCompaniesScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  // No tagsColumn: entity tags live in `attributes`, not a column.
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      name: string
      domain: string | null
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    // Companies are `entities` of kind=company; domain in attributes.
    `SELECT id AS row_id, display_name AS name,
            COALESCE(attributes->>'domain', canonical_id) AS domain,
            sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM entities
      WHERE ${visibility}${filters}
        AND kind = 'company'
        AND (display_name ILIKE $${likeIdx} OR attributes->>'domain' ILIKE $${likeIdx})
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'company',
        row_id: r.row_id,
        name: r.name,
        domain: r.domain,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: ['company'],
    }),
  )
}

async function searchDealsScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  // Deals carry no `name`/`title`/`description` column — text-query
  // search returns no rows. Filters (`since`, `sensitivity`, `source`)
  // still apply via `scope='deal'`, but a query string is a no-op.
  if (opts.query.trim().length > 0) return []

  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      stage: string
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    // Deals are `entities` of kind=deal; stage in attributes.
    `SELECT id AS row_id, COALESCE(attributes->>'stage', 'lead') AS stage,
            sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM entities
      WHERE ${visibility}${filters}
        AND kind = 'deal'
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'deal',
        row_id: r.row_id,
        stage: r.stage,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: ['deal', r.stage],
    }),
  )
}

async function searchTasksScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    tagsColumn: 'tags',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      title: string
      status: string
      tags: string[]
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    `SELECT id AS row_id, title, status, tags, sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM tasks
      WHERE ${visibility}${filters}
        AND title ILIKE $${likeIdx}
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'task',
        row_id: r.row_id,
        title: r.title,
        status: r.status,
        tags: r.tags,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: r.tags,
    }),
  )
}

async function searchKbChunksScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'valid_from',
    tagsColumn: 'tags',
    sourceColumn: 'source',
    sensitivityColumn: 'sensitivity',
  })

  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      title: string | null
      source_path: string | null
      tags: string[]
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    `SELECT id AS row_id, title, source_path, tags, sensitivity, valid_from,
            source, verified_by_user_id, retracted_at
       FROM kb_chunks
      WHERE ${visibility}${filters}
        AND (chunk_text ILIKE $${likeIdx} OR title ILIKE $${likeIdx})
      ORDER BY valid_from DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'kb_chunk',
        row_id: r.row_id,
        title: r.title,
        source_path: r.source_path,
        tags: r.tags,
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: r.tags,
    }),
  )
}

/** How many segments of ONE file each ARM may contribute as candidates
 *  (candidate hygiene — one artifact must not consume the fetch depth). */
const FILE_SEGMENT_ARM_CAP = 4
/** How many segments of ONE file survive into the final fused page. */
export const FILE_SEGMENT_GROUP_CAP = 2

/**
 * Workspace-file body chunks (`file_segments`, migration 297) — the
 * large-content-artifacts hybrid-discoverability arm. ILIKE over segment
 * content + the heading breadcrumb, LEFT JOIN to workspace_files for the
 * display name, window-capped at FILE_SEGMENT_ARM_CAP rows per file so a
 * 40-chunk document cannot monopolize the candidate fetch. Hits carry
 * `file_id` + `segment_index` so the model can hand off to the per-file
 * searchFileContent tool; the fused-page guarantee is the groupKey cap in
 * fuseAndDiversifyTraced.
 */
async function searchFileSegmentsScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values, { tableAlias: 'fs' })
  const filters = applyFlatFilters(opts.filters, values, {
    sinceColumn: 'fs.valid_from',
    tagsColumn: 'fs.tags',
    sourceColumn: 'fs.source',
    sensitivityColumn: 'fs.sensitivity',
  })

  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length
  const result = await queryWithRLS<
    TrustCols & {
      row_id: string
      file_id: string
      file_name: string | null
      segment_index: number
      heading_path: string[] | null
      snippet: string
      tags: string[] | null
      sensitivity: string
      valid_from: Date
    }
  >(
    actor.userId,
    `SELECT * FROM (
       SELECT fs.id AS row_id, fs.file_id, fs.segment_index, fs.heading_path,
              left(fs.content, 240) AS snippet, fs.tags, fs.sensitivity, fs.valid_from,
              fs.source, fs.verified_by_user_id, fs.retracted_at,
              (SELECT coalesce(wf.title, wf.name) FROM workspace_files wf WHERE wf.id = fs.file_id) AS file_name,
              ROW_NUMBER() OVER (PARTITION BY fs.file_id ORDER BY fs.segment_index) AS grp_rn
         FROM file_segments fs
        WHERE ${visibility}${filters}
          AND (fs.content ILIKE $${likeIdx} OR array_to_string(fs.heading_path, ' > ') ILIKE $${likeIdx})
     ) sub
      WHERE sub.grp_rn <= ${FILE_SEGMENT_ARM_CAP}
      ORDER BY sub.valid_from DESC, sub.row_id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )
  return result.rows.map((r) =>
    scoredRow({
      row: {
        primitive: 'file_segment',
        row_id: r.row_id,
        file_id: r.file_id,
        file_name: r.file_name,
        segment_index: Number(r.segment_index),
        heading_path: r.heading_path ?? [],
        snippet: r.snippet,
        tags: r.tags ?? [],
        sensitivity: r.sensitivity,
        valid_from: r.valid_from.toISOString(),
      },
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags: r.tags ?? [],
      groupKey: `file:${r.file_id}`,
    }),
  )
}

/**
 * Doc v1 user-defined entity rows (`entity_instances`, migration 200) —
 * title-only text index per `docs/plans/doc-v1-execution.md` §5.2 open
 * items ("v1 ships title-only text index; Phase 6+ adds embeddings").
 *
 * The displayable title is derived from the entity TYPE's first declared
 * property (the title-column convention the doc renderer follows —
 * Gallery uses `columns[0]`, the row drawer derives its title from the
 * first column). Cells live in `data` JSONB keyed by `PropertyDef.name`
 * as `{ kind, value }` objects, so the title text is
 * `data -> (et.properties->0->>'name') ->> 'value'`. The join to
 * `entity_types` resolves that property name per row; the `->> 'value'`
 * unwraps the cell so plain-string text values match the ILIKE.
 *
 * Permission model differs from the bi-temporal primitives:
 * `entity_instances` carries NO visibility-double / sensitivity / trust /
 * bi-temporal columns (migration 200). Access is the workspace-member RLS
 * policy `entity_instances_workspace_member`, enforced because every read
 * goes through `queryWithRLS(actor.userId, ...)`. We additionally pin
 * `workspace_id = $1` so the actor's active workspace is the only one
 * surfaced even when the user belongs to several. Rows fuse into the
 * cross-primitive ranked list with neutral trust (`source` mirrors
 * `source_app`, never retracted) and `created_at` as the recency key;
 * `ftsRank` is null (ILIKE-only, like the other JSONB-free scopes).
 */
async function searchEntityInstancesScope(
  actor: RetrievalActor,
  opts: FetchOpts,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  values.push(actor.workspaceId)
  const wsIdx = values.length
  const clauses = [`ei.workspace_id = $${wsIdx}`]

  const entityTypeId = opts.filters?.entity_type_id
  if (typeof entityTypeId === 'string') {
    values.push(entityTypeId)
    clauses.push(`ei.entity_type_id = $${values.length}`)
  }
  const sourceApp = opts.filters?.source_app
  if (typeof sourceApp === 'string') {
    values.push(sourceApp)
    clauses.push(`ei.source_app = $${values.length}`)
  }
  const since = opts.filters?.since
  if (typeof since === 'string') {
    values.push(since)
    clauses.push(`ei.created_at >= $${values.length}::timestamptz`)
  }

  // Title-only ILIKE. An empty query matches every row in scope (the
  // `%%` pattern) — that's the right behaviour for a scope-narrowed
  // browse (`scope='entity_instance'` + `entity_type_id`) with no text.
  values.push(`%${opts.query}%`)
  const likeIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  values.push(opts.skip)
  const offIdx = values.length

  // `data -> (titleProp) ->> 'value'` unwraps the first property's cell.
  // `et.properties->0->>'name'` is the title-column name. NULL-safe: a
  // type with no properties (shouldn't happen — createEntityType requires
  // ≥1) yields a NULL title that the ILIKE simply won't match.
  const titleExpr = `(ei.data -> (et.properties->0->>'name') ->> 'value')`
  const result = await queryWithRLS<{
    row_id: string
    entity_type_id: string
    workspace_id: string
    title: string | null
    created_at: Date
    source_app: EntityInstanceSearchRow['source_app']
  }>(
    actor.userId,
    `SELECT ei.id            AS row_id,
            ei.entity_type_id AS entity_type_id,
            ei.workspace_id   AS workspace_id,
            ${titleExpr}      AS title,
            ei.created_at     AS created_at,
            ei.source_app     AS source_app
       FROM entity_instances ei
       JOIN entity_types et ON et.id = ei.entity_type_id
      WHERE ${clauses.join(' AND ')}
        AND ${titleExpr} ILIKE $${likeIdx}
      ORDER BY ei.created_at DESC, ei.id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )

  return result.rows.map((r) => {
    const row: EntityInstanceSearchRow = {
      primitive: 'entity_instance',
      row_id: r.row_id,
      entity_type_id: r.entity_type_id,
      workspace_id: r.workspace_id,
      ...(r.title != null ? { title: r.title } : {}),
      created_at: r.created_at.toISOString(),
      source_app: r.source_app,
    }
    return scoredRow({
      row,
      validFrom: r.created_at,
      ftsRank: null,
      // Neutral trust — no trust columns on this primitive. `source`
      // mirrors `source_app` so MMR / trust-weight have a stable token;
      // never retracted.
      trust: { source: r.source_app, verified_by_user_id: null, retracted_at: null },
      tags: ['entity_instance', r.source_app],
    })
  })
}

const SCOPE_DISPATCH: Record<
  Scope,
  (actor: RetrievalActor, opts: FetchOpts) => Promise<ScoredRow[]>
> = {
  memory: searchMemoriesScope,
  task: searchTasksScope,
  file: searchFilesScope,
  entity: searchEntitiesScope,
  contact: searchContactsScope,
  company: searchCompaniesScope,
  deal: searchDealsScope,
  kb_chunk: searchKbChunksScope,
  entity_instance: searchEntityInstancesScope,
  file_segment: searchFileSegmentsScope,
}

// ── Vector arm (WU-8.5) ──────────────────────────────────────────────
//
// retrieval.md §"Hybrid retrieval shape (RRF)" + embeddings.md §"Hybrid
// retrieval (RRF)": the `vector` ranked list is one of the four fused in
// `fuseAndDiversify`. `search()` embeds the query once and runs a
// pgvector `embedding <=> $q` nearest-neighbour scan over each
// embedding-bearing primitive (HNSW indexes, migration 139). The hits
// merge into the candidate set so the vector list surfaces rows FTS
// missed — and a row found by both arms carries both signals into RRF.
//
// `memories` / `entities` / `workspace_files` / `kb_chunks` /
// `file_segments` carry an `embedding` column; `tasks` and the CRM
// tables do not.

/**
 * Optional deps for `createDbRetrievalStore`. The embedder powers the
 * RRF vector arm (WU-8.5); omit it and `search` fuses the FTS / graph /
 * recency arms only.
 */
export type RetrievalStoreDeps = {
  embedder?: Pick<Embedder, 'embed'>
}

/** Render a query embedding as a pgvector literal for `$n::vector`. */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`
}

type VectorRow = TrustCols & {
  row_id: string
  sensitivity: string
  valid_from: Date
  distance: number
}

type VectorScopeConfig = {
  /** The `Scope` this vector arm covers — must match a `SCOPE_DISPATCH`
   *  key so a scoped `search()` can gate the vector arm to the SAME
   *  primitive as the FTS arm. Without this gate a `scope='file'` search
   *  would still return memory / entity / kb_chunk vector hits, leaking
   *  every primitive into a single-primitive filter (the Brain "Files"
   *  filter showing people / memories / knowledge while a query is
   *  active). */
  scope: Scope
  table: string
  /** Projection columns besides the common `id` / trust / sensitivity / valid_from. */
  projection: string
  filterCols: Parameters<typeof applyFlatFilters>[2]
  /** Extra WHERE clause fragment appended to the per-scope query.
   *  Used by the `entities` scope to exclude CRM-specialized kinds (Q24)
   *  so the same row isn't surfaced via both the `entity` branch and its
   *  proper `contact` / `company` / `deal` branch. */
  extraWhere?: string
  /**
   * Candidate hygiene for chunked primitives (file_segment only today): keep
   * at most `cap` nearest rows per `column` value inside this arm, via a
   * ROW_NUMBER window wrap, so one source can't consume the whole `take`.
   * Undefined for every row-level scope — zero behavior change there.
   */
  perGroupCap?: { column: string; cap: number }
  toRow: (r: Record<string, unknown>) => { row: SearchResultRow; tags: readonly string[]; groupKey?: string }
}

const VECTOR_SCOPES: readonly VectorScopeConfig[] = [
  {
    scope: 'memory',
    table: 'memories',
    projection: 'summary, tags',
    filterCols: { sinceColumn: 'valid_from', tagsColumn: 'tags', sourceColumn: 'source', sensitivityColumn: 'sensitivity' },
    toRow: (r) => ({
      row: {
        primitive: 'memory',
        row_id: r.row_id as string,
        summary: r.summary as string,
        tags: (r.tags as string[]) ?? [],
        sensitivity: r.sensitivity as string,
        valid_from: (r.valid_from as Date).toISOString(),
      },
      tags: (r.tags as string[]) ?? [],
    }),
  },
  {
    scope: 'entity',
    table: 'entities',
    projection: 'kind, display_name',
    filterCols: { sinceColumn: 'valid_from', sourceColumn: 'source', sensitivityColumn: 'sensitivity' },
    extraWhere: "kind NOT IN ('person', 'company', 'deal')",
    toRow: (r) => ({
      row: {
        primitive: 'entity',
        row_id: r.row_id as string,
        kind: r.kind as string,
        display_name: r.display_name as string,
        sensitivity: r.sensitivity as string,
        valid_from: (r.valid_from as Date).toISOString(),
      },
      tags: [r.kind as string],
    }),
  },
  {
    scope: 'file',
    table: 'workspace_files',
    projection: 'title, name, tags',
    filterCols: { sinceColumn: 'valid_from', tagsColumn: 'tags', sourceColumn: 'source', sensitivityColumn: 'sensitivity' },
    toRow: (r) => ({
      row: {
        primitive: 'file',
        row_id: r.row_id as string,
        title: (r.title as string | null) ?? (r.name as string),
        tags: (r.tags as string[]) ?? [],
        sensitivity: r.sensitivity as string,
        valid_from: (r.valid_from as Date).toISOString(),
      },
      tags: (r.tags as string[]) ?? [],
    }),
  },
  {
    scope: 'kb_chunk',
    table: 'kb_chunks',
    projection: 'title, source_path, tags',
    filterCols: { sinceColumn: 'valid_from', tagsColumn: 'tags', sourceColumn: 'source', sensitivityColumn: 'sensitivity' },
    toRow: (r) => ({
      row: {
        primitive: 'kb_chunk',
        row_id: r.row_id as string,
        title: (r.title as string | null) ?? null,
        source_path: (r.source_path as string | null) ?? null,
        tags: (r.tags as string[]) ?? [],
        sensitivity: r.sensitivity as string,
        valid_from: (r.valid_from as Date).toISOString(),
      },
      tags: (r.tags as string[]) ?? [],
    }),
  },
  {
    scope: 'file_segment',
    table: 'file_segments',
    projection:
      "file_id, segment_index, heading_path, left(content, 240) AS snippet, tags, (SELECT coalesce(wf.title, wf.name) FROM workspace_files wf WHERE wf.id = file_id) AS file_name",
    filterCols: { sinceColumn: 'valid_from', tagsColumn: 'tags', sourceColumn: 'source', sensitivityColumn: 'sensitivity' },
    // Candidate hygiene: at most FILE_SEGMENT_ARM_CAP nearest segments per
    // file inside the vector arm, so one artifact can't consume `take`.
    perGroupCap: { column: 'file_id', cap: FILE_SEGMENT_ARM_CAP },
    toRow: (r) => ({
      row: {
        primitive: 'file_segment',
        row_id: r.row_id as string,
        file_id: r.file_id as string,
        file_name: (r.file_name as string | null) ?? null,
        segment_index: Number(r.segment_index),
        heading_path: (r.heading_path as string[]) ?? [],
        snippet: r.snippet as string,
        tags: (r.tags as string[]) ?? [],
        sensitivity: r.sensitivity as string,
        valid_from: (r.valid_from as Date).toISOString(),
      },
      tags: (r.tags as string[]) ?? [],
      groupKey: `file:${r.file_id as string}`,
    }),
  },
]

/**
 * The vector arm runs over the embedding-bearing primitives. When the
 * caller scoped the search to one primitive (`scope='file'`, the Brain
 * "Files" filter), the vector arm must scan ONLY that primitive's table —
 * otherwise the nearest-neighbour scan over memories / entities /
 * kb_chunks leaks those primitives back into a single-primitive filter
 * even though the FTS arm correctly returned files only. `requested`
 * mirrors the FTS fan-out's `scopes` set; an unscoped search (`undefined`)
 * keeps every vector scope. Exported for the scope-gating regression test.
 */
export function vectorScopesFor(
  requested: ReadonlySet<Scope> | undefined,
): readonly VectorScopeConfig[] {
  if (requested === undefined) return VECTOR_SCOPES
  return VECTOR_SCOPES.filter((c) => requested.has(c.scope))
}

async function runVectorScope(
  actor: RetrievalActor,
  opts: FetchOpts,
  queryVector: string,
  config: VectorScopeConfig,
): Promise<ScoredRow[]> {
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, opts.asOf, values)
  const filters = applyFlatFilters(opts.filters, values, config.filterCols)
  values.push(queryVector)
  const vecIdx = values.length
  values.push(opts.take)
  const limIdx = values.length
  const extra = config.extraWhere ? ` AND ${config.extraWhere}` : ''
  // Chunked primitives wrap in a ROW_NUMBER window so one source (e.g. one
  // file's 40 segments) keeps at most `cap` nearest candidates in this arm.
  const sql = config.perGroupCap
    ? `SELECT * FROM (
         SELECT id AS row_id, ${config.projection}, sensitivity, valid_from,
                source, verified_by_user_id, retracted_at,
                embedding <=> $${vecIdx}::vector AS distance,
                ROW_NUMBER() OVER (
                  PARTITION BY ${config.perGroupCap.column}
                  ORDER BY embedding <=> $${vecIdx}::vector
                ) AS grp_rn
           FROM ${config.table}
          WHERE ${visibility}${filters}${extra}
            AND embedding IS NOT NULL
       ) sub
        WHERE sub.grp_rn <= ${config.perGroupCap.cap}
        ORDER BY sub.distance
        LIMIT $${limIdx}`
    : `SELECT id AS row_id, ${config.projection}, sensitivity, valid_from,
            source, verified_by_user_id, retracted_at,
            embedding <=> $${vecIdx}::vector AS distance
       FROM ${config.table}
      WHERE ${visibility}${filters}${extra}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $${vecIdx}::vector
      LIMIT $${limIdx}`
  const result = await queryWithRLS<VectorRow>(actor.userId, sql, values)
  return result.rows.map((r) => {
    const { row, tags, groupKey } = config.toRow(r as unknown as Record<string, unknown>)
    return scoredRow({
      row,
      validFrom: r.valid_from,
      ftsRank: null,
      trust: r,
      tags,
      vectorDistance: r.distance,
      ...(groupKey ? { groupKey } : {}),
    })
  })
}

/**
 * Vector nearest-neighbour scan across every embedding-bearing primitive.
 * Returns the hits as `ScoredRow`s carrying `vectorDistance`.
 */
async function searchVectorCandidates(
  actor: RetrievalActor,
  opts: FetchOpts,
  embedding: readonly number[],
  scopes: ReadonlySet<Scope> | undefined,
): Promise<ScoredRow[]> {
  const queryVector = toVectorLiteral(embedding)
  const perScope = await Promise.all(
    vectorScopesFor(scopes).map((c) => runVectorScope(actor, opts, queryVector, c)),
  )
  return perScope.flat()
}

/**
 * Embed the query and run the vector scan. Soft-fails: a missing
 * embedder, an empty query, or an embedding-API error all yield `[]` —
 * RRF then degrades gracefully to the FTS / graph / recency arms.
 */
async function embedAndSearchVector(
  actor: RetrievalActor,
  opts: FetchOpts,
  query: string,
  deps: RetrievalStoreDeps | undefined,
  scopes: ReadonlySet<Scope> | undefined,
): Promise<ScoredRow[]> {
  if (!deps?.embedder || query.trim().length === 0) return []
  try {
    const [embedding] = await deps.embedder.embed([query])
    if (!embedding || embedding.length === 0) return []
    return await searchVectorCandidates(actor, opts, embedding, scopes)
  } catch (err) {
    console.warn(
      '[retrieval] query embedding / vector scan failed; vector arm skipped:',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

/**
 * Union FTS and vector candidates, keyed by `primitive:row_id`. A row
 * surfaced by both arms keeps one `ScoredRow` carrying *both* signals
 * (`ftsRank` from FTS, `vectorDistance` from vector) so RRF fuses it
 * across both methods.
 */
function mergeCandidates(
  ftsRows: readonly ScoredRow[],
  vectorRows: readonly ScoredRow[],
): ScoredRow[] {
  const byKey = new Map<string, ScoredRow>()
  for (const r of ftsRows) {
    if (!byKey.has(rowKey(r))) byKey.set(rowKey(r), r)
  }
  for (const v of vectorRows) {
    const key = rowKey(v)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, v)
    } else if (existing.vectorDistance === null) {
      // Keep the FTS row's ftsRank; adopt the vector distance.
      byKey.set(key, { ...existing, vectorDistance: v.vectorDistance })
    }
  }
  return [...byKey.values()]
}

// ── Layer-3 fuse + trust + diversify ─────────────────────────────────
//
// retrieval.md §"Layer 3 — Diversification + trust primitives": every
// `search` internally applies, in order — RRF fusion, trust-weight
// multiplier, MMR diversification rerank.

/**
 * Stable composite id for the fused-list keying — fan-out can surface
 * two primitives that share a UUID only by coincidence, so the key
 * namespaces the row id by primitive.
 */
function rowKey(r: ScoredRow): string {
  return `${r.row.primitive}:${r.row.row_id}`
}

/**
 * Layer-3 fuse + trust-weight + MMR. Pure over the fetched candidate
 * set — no SQL. Builds the FTS, graph, and recency ranked lists, fuses
 * with RRF (k=60), multiplies each fused score by `rowTrustWeight`, then
 * runs MMR diversification.
 *
 * `vector` is populated (WU-8.5) from rows the vector arm scored —
 * `search()` runs the embedding scan and `mergeCandidates` folds the
 * hits in, so candidates carry a `vectorDistance`. `graph` is empty at
 * the search-tool level (no per-query graph anchor; entity walks happen
 * in `getEntity`). RRF degrades gracefully — a method a row is absent
 * from contributes 0 to the fused score.
 *
 * Exported for the `[COMP:retrieval/rrf]` / `[COMP:retrieval/mmr]`
 * wired-path tests — this is the exact Layer-3 pipeline `search()`
 * runs, so testing it directly exercises the real composition without
 * needing a database.
 */
/**
 * Human-readable one-liner for a heterogeneous `SearchResultRow` — used by the
 * neural-search audit trace candidate list. Picks the first present string
 * field from a priority list, whitespace-collapsed and truncated; falls back
 * to `primitive:row_id`.
 */
function summarizeRow(row: SearchResultRow): string {
  const fields = ['summary', 'display_name', 'title', 'name', 'text', 'content', 'body']
  for (const f of fields) {
    const v = row[f]
    if (typeof v === 'string' && v.trim().length > 0) {
      const s = v.trim().replace(/\s+/g, ' ')
      return s.length > 140 ? s.slice(0, 139) + '…' : s
    }
  }
  return `${row.primitive}:${row.row_id}`
}

/**
 * Layer-3 fusion with an audited step trace. Returns the SAME ranked rows as
 * the legacy `fuseAndDiversify` (which now thinly wraps this) PLUS the ordered
 * `RetrievalStep[]` the neural-search audit surfaces — the per-stage candidate
 * funnel and the final selected set. The fusion math is unchanged; the trace is
 * built only from values the pipeline already computes. The head steps
 * (`kb_core_index` / `kb_fts_search` / `vector_search`) are prepended by the
 * search tool; `permission_projection` ran upstream in SQL. See
 * docs/architecture/brain/neural-search-process.md.
 */
export function fuseAndDiversifyTraced(
  candidates: readonly ScoredRow[],
  k: number,
): { rows: SearchResultRow[]; steps: RetrievalStep[] } {
  if (candidates.length === 0) return { rows: [], steps: [] }

  const byKey = new Map<string, ScoredRow>()
  for (const c of candidates) {
    // Fan-out can hand the same logical row from two scopes only if a
    // primitive surfaces under multiple scope keys; dedupe defensively,
    // keeping the first (the per-scope SQL already ordered each list).
    if (!byKey.has(rowKey(c))) byKey.set(rowKey(c), c)
  }
  const rows = [...byKey.values()]

  // FTS ranked list — rows the scope scored with `ts_rank`, best first.
  // ILIKE-only rows have `ftsRank === null` and are simply absent here.
  const ftsRanked = rows
    .filter((r) => r.ftsRank !== null)
    .sort((a, b) => (b.ftsRank ?? 0) - (a.ftsRank ?? 0))
    .map(rowKey)

  // Recency ranked list — every row, newest `valid_from` first.
  const recencyRanked = [...rows]
    .sort((a, b) => {
      if (a.validFrom === b.validFrom) return rowKey(a).localeCompare(rowKey(b))
      return a.validFrom < b.validFrom ? 1 : -1
    })
    .map(rowKey)

  // Vector ranked list (WU-8.5) — rows the vector arm scored, nearest
  // first. `vectorRankedList` sorts ASC by cosine distance and dedupes.
  const vectorHits: VectorHit[] = rows
    .filter((r) => r.vectorDistance !== null)
    .map((r) => ({ id: rowKey(r), distance: r.vectorDistance as number }))

  const vectorList = vectorRankedList(vectorHits)
  const lists: RrfRankedList[] = [
    { method: RRF_METHOD.fts, ranked: ftsRanked },
    // graph: empty at the search-tool level — slot kept for symmetry.
    { method: RRF_METHOD.graph, ranked: [] },
    { method: RRF_METHOD.recency, ranked: recencyRanked },
    vectorList,
  ]

  const fused = rrfFuse(lists)
  const fusedById = new Map(fused.map((f) => [f.id, f]))

  // Trust-weight multiplier (Approach W) — `rrfScore × rowTrustWeight`.
  // A retracted row weights to 0; it is also excluded in SQL, so this is
  // defense in depth.
  const weighted = fused.map((f) => {
    const cand = byKey.get(f.id)!
    return {
      id: f.id,
      relevance: f.score * rowTrustWeight(cand.trust),
      cand,
    }
  })
  weighted.sort((a, b) => b.relevance - a.relevance)

  // Per-source group cap (large-content-artifacts hybrid discoverability):
  // rows carrying a groupKey (file_segment handlers only) keep at most
  // FILE_SEGMENT_GROUP_CAP slots per group. Applied after trust-weighting
  // (each artifact's BEST segments survive) and before MMR so the diversity
  // rerank can never resurrect capped rows. Rows without a groupKey are
  // untouched by construction.
  const groupCounts = new Map<string, number>()
  const groupCapped = weighted.filter((w) => {
    const g = w.cand.groupKey
    if (!g) return true
    const n = (groupCounts.get(g) ?? 0) + 1
    groupCounts.set(g, n)
    return n <= FILE_SEGMENT_GROUP_CAP
  })

  // MMR diversification rerank — λ default 0.6. Similarity is tag /
  // primitive Jaccard overlap (embedding cosine is WS-8); diversifying
  // on tags still prevents the top-N from collapsing to one cluster.
  const reranked = mmrRerank(groupCapped, {
    k,
    lambda: DEFAULT_MMR_LAMBDA,
    sim: (a, b) => {
      const ta = new Set([a.cand.row.primitive, ...a.cand.tags])
      const tb = new Set([b.cand.row.primitive, ...b.cand.tags])
      if (ta.size === 0 && tb.size === 0) return 0
      let shared = 0
      for (const t of tb) if (ta.has(t)) shared++
      const union = new Set([...ta, ...tb]).size
      return union === 0 ? 0 : shared / union
    },
  })

  // ── Audit trace — the three Layer-3 steps this function owns.
  const fusionTouched: string[] = []
  if (ftsRanked.length) fusionTouched.push('fts')
  fusionTouched.push('recency')
  if (vectorHits.length) fusionTouched.push('vector')

  const finalCandidates: RetrievalStepCandidate[] = reranked.map((w) => {
    const fusedRanks = fusedById.get(w.id)?.ranks ?? {}
    const ranks: NonNullable<RetrievalStepCandidate['ranks']> = {}
    if (fusedRanks[RRF_METHOD.fts] !== undefined) ranks.fts = fusedRanks[RRF_METHOD.fts]
    if (fusedRanks[RRF_METHOD.recency] !== undefined) ranks.recency = fusedRanks[RRF_METHOD.recency]
    if (fusedRanks[RRF_METHOD.graph] !== undefined) ranks.graph = fusedRanks[RRF_METHOD.graph]
    if (fusedRanks[vectorList.method] !== undefined) ranks.vector = fusedRanks[vectorList.method]
    return {
      rowId: w.cand.row.row_id,
      primitive: w.cand.row.primitive,
      summary: summarizeRow(w.cand.row),
      score: w.relevance,
      ranks: Object.keys(ranks).length ? ranks : undefined,
      trustWeight: rowTrustWeight(w.cand.trust),
      selectedByMmr: true,
    }
  })

  const steps: RetrievalStep[] = [
    {
      stepNumber: 1,
      name: 'rrf_fusion',
      model: 'inference',
      touched: fusionTouched,
      metrics: { candidatesBefore: rows.length, candidatesAfter: fused.length },
    },
    {
      stepNumber: 2,
      name: 'trust_rerank',
      model: 'inference',
      touched: [],
      metrics: { candidatesBefore: fused.length, candidatesAfter: weighted.length },
    },
    {
      stepNumber: 3,
      name: 'mmr_diversify',
      model: 'inference',
      touched: [],
      metrics: { candidatesBefore: weighted.length, candidatesAfter: reranked.length },
      candidates: finalCandidates,
    },
  ]

  return { rows: reranked.map((w) => w.cand.row), steps }
}

/**
 * Legacy contract — the exact ranked rows the Layer-3 pipeline produces.
 * Kept byte-identical for the `[COMP:retrieval/rrf]` / `[COMP:retrieval/mmr]`
 * wired-path tests; it now delegates to `fuseAndDiversifyTraced` and drops the
 * trace.
 */
export function fuseAndDiversify(
  candidates: readonly ScoredRow[],
  k: number,
): SearchResultRow[] {
  return fuseAndDiversifyTraced(candidates, k).rows
}

// ── search() ─────────────────────────────────────────────────────────

export async function search(
  actor: RetrievalActor,
  input: SearchInput,
  deps?: RetrievalStoreDeps,
): Promise<RetrievalEnvelope<SearchData>> {
  const limit = Math.min(Math.max(input.limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX)
  const skip = input.cursor ? decodeCursor(input.cursor).skip : 0

  let scopes: readonly Scope[]
  if (input.scope === undefined) {
    scopes = KNOWN_SCOPES
  } else if (isScope(input.scope)) {
    scopes = [input.scope]
  } else {
    throw new Error(`unknown scope: ${input.scope}`)
  }

  // Per-scope filter validation. When fanning out, the filter set must
  // be valid for *every* scope it might run against — keep things simple
  // by intersecting the allowlists.
  if (scopes.length === 1) {
    validateFilters(input.filters, ALLOWED_FILTERS_BY_SCOPE[scopes[0]])
  } else {
    const intersection = new Set<string>(['since', 'sensitivity', 'source'])
    validateFilters(input.filters, intersection)
  }

  // Over-fetch by 1 past the page window so the fused-and-reranked list
  // is long enough both to slice `[skip, skip + limit]` and to detect
  // truncation. The Layer-3 pipeline (RRF → trust → MMR) defines a
  // single ranked axis; `skip` is applied to that axis, never pushed
  // into per-scope SQL OFFSET. So every scope fetches `skip + take` rows
  // at OFFSET 0. `O((skip + take) * N_scopes)` worst case — fine for the
  // v1 chat-tool surface where `skip` rarely exceeds 100.
  const take = limit + 1
  const fetchDepth = skip + take

  const fetchOpts: FetchOpts = {
    query: input.query,
    filters: input.filters,
    asOf: input.as_of,
    skip: 0,
    take: fetchDepth,
  }

  // FTS / ILIKE fan-out and the vector arm run concurrently. Both fetch
  // at OFFSET 0 — the Layer-3 pipeline owns `skip`. `mergeCandidates`
  // unions them so a row found by both arms carries both RRF signals.
  //
  // The vector arm is gated to the SAME scope set as the FTS fan-out: an
  // unscoped search (`input.scope === undefined`) scans every vector
  // scope; a single-primitive search (`scope='file'`) scans only that
  // primitive's vector table. Without this gate the vector scan leaked
  // memory / entity / kb_chunk hits into a single-primitive filter — the
  // Brain "Files" filter surfacing people / memories / knowledge while a
  // query was active.
  const vectorScopeSet =
    input.scope === undefined ? undefined : new Set<Scope>(scopes)
  // `semantic: false` (the Brain page's filter box) drops the vector arm
  // entirely: a filter must only return rows that literally match (FTS /
  // ILIKE). Default (chat-grade recall) keeps it.
  const [perScope, vectorRows] = await Promise.all([
    Promise.all(scopes.map((s) => SCOPE_DISPATCH[s](actor, fetchOpts))),
    input.semantic === false
      ? Promise.resolve([])
      : embedAndSearchVector(actor, fetchOpts, input.query, deps, vectorScopeSet),
  ])
  const candidates = mergeCandidates(perScope.flat(), vectorRows)

  // Layer-3 fuse + trust-weight + MMR diversification (retrieval.md §"Layer
  // 3"). MMR is asked for `fetchDepth` so the reranked list covers the
  // page window plus the +1 truncation probe.
  const ranked = fuseAndDiversify(candidates, fetchDepth)
  const rows = ranked.slice(skip, skip + take)

  const truncated = rows.length > limit
  const data = truncated ? rows.slice(0, limit) : rows
  const cursor = truncated ? encodeCursor({ skip: skip + limit }) : null

  return {
    api_version: 'v1',
    data,
    meta: {
      retrieved_at: new Date().toISOString(),
      truncated,
      cursor,
    },
  }
}

// ── searchRecording() — dedicated single-recording scoped retrieval ──
//
// A long recording's transcript lives in `transcript_segments` (migration 280)
// and is retrieved ONLY through this dedicated handler — never via
// search()/KNOWN_SCOPES, so an unscoped searchBrain never floods on a
// recording's 70-110 segments. Vector + ILIKE arms fused, scoped to ONE
// recording_id, through queryWithRLS + the shared visibility/access predicate
// (so the sensitivity ladder + visibility double are enforced, not just
// workspace RLS). MMR is disabled — for a single recording, ordered coverage
// beats diversity. See docs/plans/recording-to-brain.md §"Segmentation & Indexing".

export type RecordingSegmentHit = {
  segment_index: number
  start_ms: number
  end_ms: number
  speaker: string | null
  segment_text: string
}

const RECORDING_TOPK_DEFAULT = 8
const RECORDING_TOPK_MAX = 20

type RecordingRow = {
  segment_index: number
  start_ms: string | number
  end_ms: string | number
  speaker: string | null
  segment_text: string
  distance?: number | null
}

function toRecordingHit(r: RecordingRow): RecordingSegmentHit {
  return {
    segment_index: Number(r.segment_index),
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    speaker: r.speaker,
    segment_text: r.segment_text,
  }
}

export async function searchRecording(
  actor: RetrievalActor,
  input: { recordingId: string; query: string; topK?: number },
  deps?: RetrievalStoreDeps,
): Promise<RecordingSegmentHit[]> {
  const topK = Math.min(Math.max(input.topK ?? RECORDING_TOPK_DEFAULT, 1), RECORDING_TOPK_MAX)
  const query = input.query.trim()

  // Vector arm — soft-fails to [] (no embedder, empty query, embed error) so we
  // degrade to the ILIKE arm; works before embeddings land or if the embedder
  // is down (mirrors embedAndSearchVector).
  const vectorHits: Array<RecordingSegmentHit & { distance: number }> = []
  if (deps?.embedder && query.length > 0) {
    try {
      const [embedding] = await deps.embedder.embed([query])
      if (embedding && embedding.length > 0) {
        const values: unknown[] = []
        const visibility = visibilityPredicate(actor, undefined, values, { tableAlias: 'ts' })
        values.push(input.recordingId)
        const ridIdx = values.length
        values.push(toVectorLiteral(embedding))
        const vecIdx = values.length
        values.push(topK)
        const limIdx = values.length
        const res = await queryWithRLS<RecordingRow>(
          actor.userId,
          `SELECT ts.segment_index, ts.start_ms, ts.end_ms, ts.speaker, ts.segment_text,
                  ts.embedding <=> $${vecIdx}::vector AS distance
             FROM transcript_segments ts
            WHERE ${visibility}
              AND ts.recording_id = $${ridIdx}
              AND ts.embedding IS NOT NULL
            ORDER BY ts.embedding <=> $${vecIdx}::vector
            LIMIT $${limIdx}`,
          values,
        )
        for (const r of res.rows) {
          vectorHits.push({ ...toRecordingHit(r), distance: Number(r.distance ?? Infinity) })
        }
      }
    } catch (err) {
      console.warn(
        '[searchRecording] vector arm failed; ILIKE-only:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ILIKE arm — immediate (no embeddings needed). Empty query matches every
  // segment in the recording (ordered browse).
  const ftsValues: unknown[] = []
  const ftsVisibility = visibilityPredicate(actor, undefined, ftsValues, { tableAlias: 'ts' })
  ftsValues.push(input.recordingId)
  const fRidIdx = ftsValues.length
  ftsValues.push(`%${query}%`)
  const likeIdx = ftsValues.length
  ftsValues.push(topK)
  const fLimIdx = ftsValues.length
  const ftsRes = await queryWithRLS<RecordingRow>(
    actor.userId,
    `SELECT ts.segment_index, ts.start_ms, ts.end_ms, ts.speaker, ts.segment_text
       FROM transcript_segments ts
      WHERE ${ftsVisibility}
        AND ts.recording_id = $${fRidIdx}
        AND ts.segment_text ILIKE $${likeIdx}
      ORDER BY ts.segment_index
      LIMIT $${fLimIdx}`,
    ftsValues,
  )

  // Fuse: dedupe by segment_index; vector hits (ordered by distance) first,
  // then ILIKE-only hits by segment_index (distance = Infinity). MMR disabled.
  const byIndex = new Map<number, RecordingSegmentHit & { distance: number }>()
  for (const v of vectorHits) byIndex.set(v.segment_index, v)
  for (const r of ftsRes.rows) {
    const hit = toRecordingHit(r)
    if (!byIndex.has(hit.segment_index)) byIndex.set(hit.segment_index, { ...hit, distance: Infinity })
  }
  return [...byIndex.values()]
    .sort((a, b) => a.distance - b.distance || a.segment_index - b.segment_index)
    .slice(0, topK)
    .map(({ distance: _distance, ...hit }) => hit)
}

/**
 * Non-vector ordered read of a `segment_index` range, for whole-section recall
 * (summarize/overview intents page sequential windows rather than rely on
 * top-K). Each call is independently bounded by the caller's tool-result cap.
 */
export async function readRecordingRange(
  actor: RetrievalActor,
  input: { recordingId: string; fromIndex: number; toIndex: number },
): Promise<RecordingSegmentHit[]> {
  const from = Math.max(0, Math.floor(input.fromIndex))
  const to = Math.max(from, Math.floor(input.toIndex))
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, undefined, values, { tableAlias: 'ts' })
  values.push(input.recordingId)
  const ridIdx = values.length
  values.push(from)
  const fromIdx = values.length
  values.push(to)
  const toIdx = values.length
  const res = await queryWithRLS<RecordingRow>(
    actor.userId,
    `SELECT ts.segment_index, ts.start_ms, ts.end_ms, ts.speaker, ts.segment_text
       FROM transcript_segments ts
      WHERE ${visibility}
        AND ts.recording_id = $${ridIdx}
        AND ts.segment_index BETWEEN $${fromIdx} AND $${toIdx}
      ORDER BY ts.segment_index`,
    values,
  )
  return res.rows.map(toRecordingHit)
}

// ── searchFileSegments() — dedicated single-file scoped retrieval ──
//
// The file twin of searchRecording (large-content-artifacts §Phase 1.3): a
// large document's chunked body lives in `file_segments` (migration 297).
// Vector + ILIKE arms fused, scoped to ONE file_id, through queryWithRLS + the
// shared visibility/access predicate. MMR disabled — inside one document,
// ordered coverage beats diversity. UNLIKE transcript_segments, file_segment
// ALSO participates in general search() via a capped scope (hybrid
// discoverability); this handler is the precision surface behind the
// searchFileContent tool.

export type FileSegmentHit = {
  segment_index: number
  char_start: number
  char_end: number
  heading_path: string[]
  content: string
}

const FILE_SEGMENT_TOPK_DEFAULT = 8
const FILE_SEGMENT_TOPK_MAX = 20

type FileSegmentRow = {
  segment_index: number
  char_start: string | number
  char_end: string | number
  heading_path: string[] | null
  content: string
  distance?: number | null
}

function toFileSegmentHit(r: FileSegmentRow): FileSegmentHit {
  return {
    segment_index: Number(r.segment_index),
    char_start: Number(r.char_start),
    char_end: Number(r.char_end),
    heading_path: r.heading_path ?? [],
    content: r.content,
  }
}

export async function searchFileSegments(
  actor: RetrievalActor,
  input: { fileId: string; query: string; topK?: number },
  deps?: RetrievalStoreDeps,
): Promise<FileSegmentHit[]> {
  const topK = Math.min(Math.max(input.topK ?? FILE_SEGMENT_TOPK_DEFAULT, 1), FILE_SEGMENT_TOPK_MAX)
  const query = input.query.trim()

  // Vector arm — soft-fails to [] (no embedder, empty query, embed error) so we
  // degrade to the ILIKE arm; works before embeddings land.
  const vectorHits: Array<FileSegmentHit & { distance: number }> = []
  if (deps?.embedder && query.length > 0) {
    try {
      const [embedding] = await deps.embedder.embed([query])
      if (embedding && embedding.length > 0) {
        const values: unknown[] = []
        const visibility = visibilityPredicate(actor, undefined, values, { tableAlias: 'fs' })
        values.push(input.fileId)
        const fidIdx = values.length
        values.push(toVectorLiteral(embedding))
        const vecIdx = values.length
        values.push(topK)
        const limIdx = values.length
        const res = await queryWithRLS<FileSegmentRow>(
          actor.userId,
          `SELECT fs.segment_index, fs.char_start, fs.char_end, fs.heading_path, fs.content,
                  fs.embedding <=> $${vecIdx}::vector AS distance
             FROM file_segments fs
            WHERE ${visibility}
              AND fs.file_id = $${fidIdx}
              AND fs.embedding IS NOT NULL
            ORDER BY fs.embedding <=> $${vecIdx}::vector
            LIMIT $${limIdx}`,
          values,
        )
        for (const r of res.rows) {
          vectorHits.push({ ...toFileSegmentHit(r), distance: Number(r.distance ?? Infinity) })
        }
      }
    } catch (err) {
      console.warn(
        '[searchFileSegments] vector arm failed; ILIKE-only:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ILIKE arm — immediate (no embeddings needed). Empty query matches every
  // segment in the file (ordered browse).
  const ftsValues: unknown[] = []
  const ftsVisibility = visibilityPredicate(actor, undefined, ftsValues, { tableAlias: 'fs' })
  ftsValues.push(input.fileId)
  const fFidIdx = ftsValues.length
  ftsValues.push(`%${query}%`)
  const likeIdx = ftsValues.length
  ftsValues.push(topK)
  const fLimIdx = ftsValues.length
  const ftsRes = await queryWithRLS<FileSegmentRow>(
    actor.userId,
    `SELECT fs.segment_index, fs.char_start, fs.char_end, fs.heading_path, fs.content
       FROM file_segments fs
      WHERE ${ftsVisibility}
        AND fs.file_id = $${fFidIdx}
        AND fs.content ILIKE $${likeIdx}
      ORDER BY fs.segment_index
      LIMIT $${fLimIdx}`,
    ftsValues,
  )

  // Fuse: dedupe by segment_index; vector hits (by distance) first, then
  // ILIKE-only hits by segment_index (distance = Infinity). MMR disabled.
  const byIndex = new Map<number, FileSegmentHit & { distance: number }>()
  for (const v of vectorHits) byIndex.set(v.segment_index, v)
  for (const r of ftsRes.rows) {
    const hit = toFileSegmentHit(r)
    if (!byIndex.has(hit.segment_index)) byIndex.set(hit.segment_index, { ...hit, distance: Infinity })
  }
  return [...byIndex.values()]
    .sort((a, b) => a.distance - b.distance || a.segment_index - b.segment_index)
    .slice(0, topK)
    .map(({ distance: _distance, ...hit }) => hit)
}

/**
 * Non-vector ordered read of a `segment_index` range — whole-section recall
 * for summarize/overview intents (page sequential windows rather than top-K).
 * Each call is independently bounded by the caller's tool-result cap.
 */
export async function readFileSegmentRange(
  actor: RetrievalActor,
  input: { fileId: string; fromIndex: number; toIndex: number },
): Promise<FileSegmentHit[]> {
  const from = Math.max(0, Math.floor(input.fromIndex))
  const to = Math.max(from, Math.floor(input.toIndex))
  const values: unknown[] = []
  const visibility = visibilityPredicate(actor, undefined, values, { tableAlias: 'fs' })
  values.push(input.fileId)
  const fidIdx = values.length
  values.push(from)
  const fromIdx = values.length
  values.push(to)
  const toIdx = values.length
  const res = await queryWithRLS<FileSegmentRow>(
    actor.userId,
    `SELECT fs.segment_index, fs.char_start, fs.char_end, fs.heading_path, fs.content
       FROM file_segments fs
      WHERE ${visibility}
        AND fs.file_id = $${fidIdx}
        AND fs.segment_index BETWEEN $${fromIdx} AND $${toIdx}
      ORDER BY fs.segment_index`,
    values,
  )
  return res.rows.map(toFileSegmentHit)
}

// ── recentEpisodes() ────────────────────────────────────────────────

export async function recentEpisodes(
  actor: RetrievalActor,
  input: RecentEpisodesInput,
): Promise<RetrievalEnvelope<RecentEpisodesData>> {
  const limit = Math.min(
    Math.max(input.limit ?? RECENT_EPISODES_LIMIT_DEFAULT, 1),
    RECENT_EPISODES_LIMIT_MAX,
  )
  const skip = input.cursor ? decodeCursor(input.cursor).skip : 0

  if (input.entity !== undefined && !UUID_RE.test(input.entity)) {
    throw new Error('entity must be a UUID')
  }

  validateFilters(input.filters, ALLOWED_FILTERS_EPISODE)

  const values: unknown[] = []
  const visibility = episodeVisibilityPredicate(actor, input.as_of, values, { tableAlias: 'e' })

  // The flat filters builder needs episode-flavored column targets.
  const filterClauses = applyFlatFilters(input.filters, values, {
    sinceColumn: 'e.occurred_at',
    sourceKindColumn: 'e.source_kind',
    sensitivityColumn: 'e.sensitivity',
  })

  let joinClause = ''
  let entityFilter = ''
  if (input.entity !== undefined) {
    values.push(input.entity)
    const eIdx = values.length
    joinClause = `
      JOIN entity_links el ON (
        (el.source_kind = 'episode' AND el.source_id = e.id
           AND el.target_kind = 'entity' AND el.target_id = $${eIdx})
        OR (el.target_kind = 'episode' AND el.target_id = e.id
           AND el.source_kind = 'entity' AND el.source_id = $${eIdx})
      )`
    entityFilter = ''
  }

  values.push(limit + 1)
  const limIdx = values.length
  values.push(skip)
  const offIdx = values.length

  const result = await queryWithRLS<{
    id: string
    source_kind: string
    occurred_at: Date
    sensitivity: string
    source_ref: Record<string, unknown> | null
    summary_text: string | null
  }>(
    actor.userId,
    `SELECT DISTINCT e.id, e.source_kind, e.occurred_at, e.sensitivity,
            e.source_ref, e.summary_text
       FROM episodes e
       ${joinClause}
      WHERE ${visibility}${filterClauses}${entityFilter}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  )

  const truncated = result.rows.length > limit
  const rows = (truncated ? result.rows.slice(0, limit) : result.rows).map<RecentEpisodeRow>((r) => ({
    id: r.id,
    source_kind: r.source_kind,
    occurred_at: r.occurred_at.toISOString(),
    sensitivity: r.sensitivity as RecentEpisodeRow['sensitivity'],
    source_ref: r.source_ref ?? {},
    summary_text: r.summary_text,
  }))
  const cursor = truncated ? encodeCursor({ skip: skip + limit }) : null

  return {
    api_version: 'v1',
    data: rows,
    meta: {
      retrieved_at: new Date().toISOString(),
      truncated,
      cursor,
    },
  }
}

// ── Factories ────────────────────────────────────────────────────────

export function createDbRetrievalStore(
  deps: RetrievalStoreDeps = {},
): Pick<RetrievalStore, 'search' | 'recentEpisodes'> {
  return {
    search: (actor, input) => search(actor, input, deps),
    recentEpisodes,
  }
}

// ── getEntity adapter ────────────────────────────────────────────────
//
// `EntityStore.getEntity` returns the raw `EntityRollup`; the retrieval
// surface wraps it in a `RetrievalEnvelope<GetEntityData>`. The actor →
// AccessContext map is structural (identical shape, distinct nominal
// types in the spec). `followed_supersession` is the only field that
// moves from data to envelope meta — and it changes casing along the
// way.

function parseAsOf(asOf: string | undefined): Date | undefined {
  if (!asOf) return undefined
  const d = new Date(asOf)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`getEntity: invalid as_of timestamp "${asOf}".`)
  }
  return d
}

function rollupToEnvelope(rollup: EntityRollup): RetrievalEnvelope<GetEntityData> {
  return {
    api_version: 'v1',
    data: {
      entity: rollup.entity,
      summary: rollup.summary,
      embedded: rollup.embedded,
    },
    meta: {
      retrieved_at: new Date().toISOString(),
      truncated: false,
      ...(rollup.followedSupersession
        ? {
            followed_supersession: {
              from_id: rollup.followedSupersession.fromId,
              to_id: rollup.followedSupersession.toId,
              superseded_at:
                rollup.followedSupersession.supersededAt?.toISOString() ??
                new Date(0).toISOString(),
            },
          }
        : {}),
    },
  }
}

/**
 * Compose the full `RetrievalStore` from the per-method stores.
 *
 * Lives here (not at the route layer) so apps/api + apps/api-admin +
 * tests can share one composer. Each `Pick<RetrievalStore, K>` slice
 * is constructed in its own file — that pattern is load-bearing for
 * test seams. This factory just stitches them together and bridges
 * `EntityStore.getEntity` to the retrieval envelope.
 */
export function composeRetrievalStore(deps: {
  entityStore: EntityStore
  searchEpisodes: Pick<RetrievalStore, 'search' | 'recentEpisodes'>
  provenance: Pick<RetrievalStore, 'provenance'>
  aggregate: Pick<RetrievalStore, 'aggregate'>
  markUseful: Pick<RetrievalStore, 'markUseful'>
  rowHistory: Pick<RetrievalStore, 'getRowHistory'>
}): RetrievalStore {
  const {
    entityStore,
    searchEpisodes,
    provenance,
    aggregate,
    markUseful,
    rowHistory,
  } = deps
  return {
    async getEntity(actor: RetrievalActor, input: GetEntityInput) {
      const rollup = await entityStore.getEntity(actor, input.id_or_name, {
        asOf: parseAsOf(input.as_of),
        ...(input.limits?.edges !== undefined ? { edgeLimit: input.limits.edges } : {}),
      })
      return rollup === null ? null : rollupToEnvelope(rollup)
    },
    search: searchEpisodes.search,
    recentEpisodes: searchEpisodes.recentEpisodes,
    provenance: provenance.provenance,
    aggregate: aggregate.aggregate,
    markUseful: markUseful.markUseful,
    getRowHistory: rowHistory.getRowHistory,
  }
}
