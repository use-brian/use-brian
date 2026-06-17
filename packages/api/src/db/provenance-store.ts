import type {
  ProvenanceData,
  ProvenanceDerivedRef,
  ProvenanceInput,
  ProvenanceSourceEpisode,
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
  Sensitivity,
} from '@sidanclaw/core'
import { canRead } from '@sidanclaw/core'
import { queryWithRLS } from './client.js'

/**
 * `provenance-store.ts` — WS-5 / WU-5.5.
 *
 * Implements `RetrievalStore.provenance(actor, { row_id })`. Returns the
 * row's source Episode + authorship + supersession + derivation chain,
 * or `null` when the row is unknown or permission-redacted.
 *
 * Composition: spread alongside `createDbRetrievalStore() +
 * createDbEntitiesStore() + createDbAggregateStore() +
 * createDbRowHistoryStore()` to build the full `RetrievalStore` consumed
 * by `createRetrievalTools(...)`.
 *
 * v1 scope (per retrieval.md §`provenance(row_id)` output shape +
 * data-model.md §"Provenance pattern"):
 *   - `source_episode` resolves the row's `source_episode_id` against
 *     the `episodes` table, projecting the columns the LLM needs to
 *     reason about origin.
 *   - `authorship` returns the universal authorship triple.
 *   - `supersession` returns the bi-temporal window plus `preceded_by`
 *     (computed via reverse lookup on `superseded_by`).
 *   - `derived_from` is the derivation chain. v1 derives ONE link — the
 *     source Episode the fact was extracted from (`source_episode_id`),
 *     typed by the row's `source` column (`extracted` → `extracted_from`,
 *     `rem_connection` → `inferred_from`, etc.). Cross-row REM /
 *     consolidation / merge links require their own reverse-lookup
 *     tables (`entity_merges` etc.) and stay a follow-up — the array
 *     shape is stable, so adding them later is purely additive.
 *   - `re_extracted_at` walks the supersession chain backward: each
 *     prior version that carries its own `source_episode_id` is a
 *     re-extraction event (the fact was re-observed and a new row
 *     written). data-model.md §"Provenance pattern": "When a fact gets
 *     superseded, the new row points to the triggering Episode."
 *
 * P1-8 single untrusted projection: an inaccessible source Episode is
 * OMITTED from `derived_from` and `re_extracted_at` (not redacted to a
 * handle) — same silent-redaction rule as `source_episode: null`.
 *
 * Permission model: every probe goes through `queryWithRLS`, which
 * applies the workspace-partition + visibility-double policies. The
 * `clearance` projection is applied here for the source-episode read
 * so a low-clearance assistant cannot pull the Episode body of a row
 * whose origin event was classified higher than its clearance.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Order matters — first hit wins. Memories first because they're the
 * highest-volume row. `hasSupersededBy` flags whether the table carries
 * a `superseded_by` column: `entity_links` does NOT (edges supersede
 * implicitly by source+target+type uniqueness over time per mig 126),
 * so its supersession lookups are skipped rather than crashing on a
 * missing column.
 */
const PRIMITIVE_TABLES: ReadonlyArray<{ table: string; hasSupersededBy: boolean }> = [
  { table: 'memories', hasSupersededBy: true },
  { table: 'tasks', hasSupersededBy: true },
  { table: 'workspace_files', hasSupersededBy: true },
  { table: 'entities', hasSupersededBy: true },
  { table: 'contacts', hasSupersededBy: true },
  { table: 'companies', hasSupersededBy: true },
  { table: 'deals', hasSupersededBy: true },
  { table: 'kb_chunks', hasSupersededBy: true },
  { table: 'entity_links', hasSupersededBy: false },
]

type RawRow = {
  primitive: string
  hasSupersededBy: boolean
  source: string
  sourceEpisodeId: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
}

type EpisodeRow = {
  id: string
  sourceKind: string
  occurredAt: Date
  sensitivity: Sensitivity
  contentRef: unknown
}

/**
 * Map a row's `source` enum (docs/architecture/brain/trust-signals.md §"Source taxonomy") to the
 * derivation relationship for its `source_episode_id` link.
 */
function episodeRelationship(source: string): ProvenanceDerivedRef['relationship'] {
  switch (source) {
    case 'rem_connection':
      return 'inferred_from'
    // `extracted`, `kb_sync`, `model`, `user`, `community`,
    // `auto-generated`: when a `source_episode_id` is present the row
    // was produced from that Episode's content — extraction.
    default:
      return 'extracted_from'
  }
}

async function probePrimitive(
  actor: RetrievalActor,
  spec: { table: string; hasSupersededBy: boolean },
  rowId: string,
): Promise<RawRow | null> {
  const supersededByCol = spec.hasSupersededBy
    ? 'superseded_by AS "supersededBy"'
    : 'NULL::uuid AS "supersededBy"'
  const result = await queryWithRLS<{
    source: string
    sourceEpisodeId: string | null
    createdByUserId: string | null
    createdByAssistantId: string | null
    createdAt: Date
    validFrom: Date
    validTo: Date | null
    supersededBy: string | null
  }>(
    actor.userId,
    `SELECT source,
            source_episode_id        AS "sourceEpisodeId",
            created_by_user_id       AS "createdByUserId",
            created_by_assistant_id  AS "createdByAssistantId",
            created_at               AS "createdAt",
            valid_from               AS "validFrom",
            valid_to                 AS "validTo",
            ${supersededByCol}
       FROM ${spec.table}
      WHERE id = $1
      LIMIT 1`,
    [rowId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { primitive: spec.table, hasSupersededBy: spec.hasSupersededBy, ...row }
}

async function findRow(actor: RetrievalActor, rowId: string): Promise<RawRow | null> {
  for (const spec of PRIMITIVE_TABLES) {
    const row = await probePrimitive(actor, spec, rowId)
    if (row) return row
  }
  return null
}

/**
 * Doc v1 user-defined entity rows (`entity_instances`, migration 200)
 * are a non-bi-temporal leaf in the provenance graph — see
 * `docs/plans/doc-v1-execution.md` §5.2 ("provenance includes
 * `source_app`"). They carry no `source_episode_id`, no supersession
 * (`superseded_by` / `valid_to`), and no derivation chain, so the
 * standard `probePrimitive` column set doesn't apply; this dedicated
 * probe reads the columns that DO exist.
 *
 * Probed AFTER the bi-temporal tables (it's the lowest-volume,
 * doc-only primitive) so a UUID that belongs to a core primitive is
 * never shadowed. `valid_from` maps to `created_at`; `valid_to` is
 * always null (rows are mutated in place, never superseded). `source_app`
 * is surfaced on the envelope so the caller can attribute the row's
 * origin surface (doc / chat / import / api).
 */
async function probeEntityInstance(
  actor: RetrievalActor,
  rowId: string,
): Promise<RetrievalEnvelope<ProvenanceData> | null> {
  const result = await queryWithRLS<{
    sourceApp: 'doc' | 'chat' | 'import' | 'api'
    createdByUserId: string | null
    createdAt: Date
    lastEditedAt: Date
  }>(
    actor.userId,
    `SELECT source_app      AS "sourceApp",
            created_by      AS "createdByUserId",
            created_at      AS "createdAt",
            last_edited_at  AS "lastEditedAt"
       FROM entity_instances
      WHERE id = $1
      LIMIT 1`,
    [rowId],
  )
  const row = result.rows[0]
  if (!row) return null

  const data: ProvenanceData = {
    row_id: rowId,
    primitive: 'entity_instances',
    source_episode: null,
    source_app: row.sourceApp,
    authorship: {
      created_by_user_id: row.createdByUserId ?? '',
      created_by_assistant_id: null,
      created_at: row.createdAt.toISOString(),
    },
    derived_from: [],
    supersession: {
      preceded_by: null,
      superseded_by: null,
      valid_from: row.createdAt.toISOString(),
      valid_to: null,
    },
    re_extracted_at: [],
  }

  return {
    api_version: 'v1',
    data,
    meta: {
      retrieved_at: new Date().toISOString(),
      truncated: false,
    },
  }
}

async function findPrecededBy(
  actor: RetrievalActor,
  table: string,
  rowId: string,
): Promise<string | null> {
  const result = await queryWithRLS<{ id: string }>(
    actor.userId,
    `SELECT id FROM ${table} WHERE superseded_by = $1 LIMIT 1`,
    [rowId],
  )
  return result.rows[0]?.id ?? null
}

/**
 * Walk the supersession chain backward from `rowId`, collecting each
 * prior version's `(source_episode_id, valid_from)` — the re-extraction
 * history per data-model.md §"Provenance pattern". Bounded depth guards
 * against a malformed cycle. Inaccessible Episodes are omitted (P1-8).
 */
async function fetchReExtractionHistory(
  actor: RetrievalActor,
  table: string,
  rowId: string,
): Promise<Array<{ from_episode: string; at: string }>> {
  const out: Array<{ from_episode: string; at: string }> = []
  const seen = new Set<string>([rowId])
  let cursor: string | null = rowId
  const MAX_DEPTH = 100

  for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
    const result: { rows: Array<{ id: string; sourceEpisodeId: string | null; validFrom: Date }> } =
      await queryWithRLS<{ id: string; sourceEpisodeId: string | null; validFrom: Date }>(
        actor.userId,
        `SELECT id,
                source_episode_id AS "sourceEpisodeId",
                valid_from        AS "validFrom"
           FROM ${table}
          WHERE superseded_by = $1
          LIMIT 1`,
        [cursor],
      )
    const prior = result.rows[0]
    if (!prior || seen.has(prior.id)) break
    seen.add(prior.id)
    if (prior.sourceEpisodeId) {
      const accessible = await isEpisodeAccessible(actor, prior.sourceEpisodeId)
      if (accessible) {
        out.push({
          from_episode: prior.sourceEpisodeId,
          at: prior.validFrom.toISOString(),
        })
      }
    }
    cursor = prior.id
  }

  // Oldest → newest by re-extraction time.
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return out
}

async function fetchEpisode(
  actor: RetrievalActor,
  episodeId: string,
): Promise<ProvenanceSourceEpisode | null> {
  const result = await queryWithRLS<EpisodeRow>(
    actor.userId,
    `SELECT id,
            source_kind  AS "sourceKind",
            occurred_at  AS "occurredAt",
            sensitivity,
            content_ref  AS "contentRef"
       FROM episodes
      WHERE id = $1
      LIMIT 1`,
    [episodeId],
  )
  const row = result.rows[0]
  if (!row) return null

  // Sensitivity projection — silent redact (P1-8) when the assistant
  // cannot read the source Episode's classification.
  if (actor.clearance && !canRead(actor.clearance, row.sensitivity)) {
    return null
  }

  return {
    id: row.id,
    source_kind: row.sourceKind,
    occurred_at: row.occurredAt.toISOString(),
    sensitivity: row.sensitivity,
    content_ref: row.contentRef ?? undefined,
  }
}

/**
 * Cheap visibility + clearance probe for an Episode id — used by the
 * derivation walks where the full Episode body is not needed, only
 * whether the caller may know the Episode exists. Returns false when the
 * row is RLS-hidden OR above the actor's clearance ceiling.
 */
async function isEpisodeAccessible(actor: RetrievalActor, episodeId: string): Promise<boolean> {
  const result = await queryWithRLS<{ sensitivity: Sensitivity }>(
    actor.userId,
    `SELECT sensitivity FROM episodes WHERE id = $1 LIMIT 1`,
    [episodeId],
  )
  const row = result.rows[0]
  if (!row) return false
  if (actor.clearance && !canRead(actor.clearance, row.sensitivity)) return false
  return true
}

export function createDbProvenanceStore(): Pick<RetrievalStore, 'provenance'> {
  return {
    async provenance(
      actor: RetrievalActor,
      input: ProvenanceInput,
    ): Promise<RetrievalEnvelope<ProvenanceData> | null> {
      if (!UUID_RE.test(input.row_id)) return null

      const row = await findRow(actor, input.row_id)
      if (!row) {
        // Doc user-defined entity rows are probed last — they're the
        // lowest-volume, non-bi-temporal primitive (mig 200). A hit here
        // returns the leaf envelope directly (no episode / supersession /
        // derivation walk to run).
        return await probeEntityInstance(actor, input.row_id)
      }

      const sourceEpisode = row.sourceEpisodeId
        ? await fetchEpisode(actor, row.sourceEpisodeId)
        : null

      const precededBy = row.hasSupersededBy
        ? await findPrecededBy(actor, row.primitive, input.row_id)
        : null

      // Derivation chain — v1 derives the source-Episode link. P1-8:
      // when the caller cannot access the Episode the entry is omitted
      // entirely (not redacted to a handle). `sourceEpisode` is already
      // the clearance-projected read, so a non-null result means the
      // caller may know the Episode.
      const derivedFrom: ProvenanceDerivedRef[] = []
      if (row.sourceEpisodeId && sourceEpisode) {
        derivedFrom.push({
          primitive: 'episode',
          row_id: row.sourceEpisodeId,
          relationship: episodeRelationship(row.source),
        })
      }

      // Re-extraction history — supersession-chain backward walk. Skipped
      // for edge rows (no `superseded_by` column; edges supersede
      // implicitly).
      const reExtractedAt = row.hasSupersededBy
        ? await fetchReExtractionHistory(actor, row.primitive, input.row_id)
        : []

      const data: ProvenanceData = {
        row_id: input.row_id,
        primitive: row.primitive,
        source_episode: sourceEpisode,
        authorship: {
          // The contract types `created_by_user_id` as `string` (not
          // nullable) because authorship NOT NULL is the WS-4 invariant
          // (WU-4.5). For legacy rows that pre-date that enforcement we
          // emit empty string rather than violating the type — those
          // rows should be retroactively backfilled.
          created_by_user_id: row.createdByUserId ?? '',
          created_by_assistant_id: row.createdByAssistantId,
          created_at: row.createdAt.toISOString(),
        },
        derived_from: derivedFrom,
        supersession: {
          preceded_by: precededBy,
          superseded_by: row.supersededBy,
          valid_from: row.validFrom.toISOString(),
          valid_to: row.validTo?.toISOString() ?? null,
        },
        re_extracted_at: reExtractedAt,
      }

      return {
        api_version: 'v1',
        data,
        meta: {
          retrieved_at: new Date().toISOString(),
          truncated: false,
        },
      }
    },
  }
}
