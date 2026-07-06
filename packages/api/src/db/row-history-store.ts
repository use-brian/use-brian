import type {
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
  RowHistoryData,
  RowHistoryInput,
  RowHistoryPrimitive,
  RowHistoryVersion,
  RowStatus,
} from '@sidanclaw/core'
import { queryWithRLS } from './client.js'
import { getEntityHistory } from './entities-store.js'
import { getMemoryHistory } from './memories.js'
import { getWorkspaceFileHistory } from './workspace-files.js'

/**
 * `row-history-store.ts` — WS-6 / WU-6.9.
 *
 * Unified `getRowHistory({ primitive, row_id })` surface (D.7 supersession
 * audit + D.8 authorship). Spec:
 *   docs/architecture/brain/corrections.md §D.7 (lines 436-516)
 *   docs/architecture/brain/retrieval-layer.md §Bilingual surface (envelope)
 *
 * Composition: the route layer builds the full `RetrievalStore` by
 * spreading this factory's result alongside
 * `createDbRetrievalStore() + createDbEntitiesStore() +
 * createDbAggregateStore()` and the WU-5.5 provenance store (pending).
 *
 * Per-primitive walkers are the source of truth for chain traversal —
 * this file only orchestrates dispatch, status derivation,
 * `include_retracted` filtering, and `as_of` projection. Tasks runs an
 * inline recursive CTE because the existing `getTaskHistory` helper
 * projects only `TaskRecord` shape (no bi-temporal / authorship
 * columns); widening that helper would ripple into `TaskRecord`
 * consumers, which is out of WU-6.9's scope.
 *
 * Sensitivity-clearance projection is deferred to WS-4 (WU-4.2). Today
 * the walkers run through `queryWithRLS` for workspace partition +
 * visibility-double only.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KNOWN_PRIMITIVES: readonly RowHistoryPrimitive[] = [
  'memories',
  'tasks',
  'workspace_files',
  'entities',
  'companies',
  'contacts',
  'deals',
] as const

function isKnownPrimitive(value: string): value is RowHistoryPrimitive {
  return (KNOWN_PRIMITIVES as readonly string[]).includes(value)
}

type RawVersion = {
  id: string
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  display: Record<string, unknown>
}

// ── Per-primitive raw fetchers ──────────────────────────────────────

async function fetchMemoryVersions(actor: RetrievalActor, rowId: string): Promise<RawVersion[]> {
  void actor
  const { chain } = await getMemoryHistory(rowId)
  return chain.map((m) => ({
    id: m.id,
    validFrom: m.validFrom,
    validTo: m.validTo,
    supersededBy: m.supersededBy,
    retractedAt: m.retractedAt,
    retractedReason: m.retractedReason,
    createdByUserId: m.createdByUserId,
    createdByAssistantId: m.createdByAssistantId,
    createdAt: m.createdAt,
    display: {
      // Post-Phase-4 (retire-memory-type): no `type` / `category` —
      // the categorisation rides on tags only.
      summary: m.summary,
      tags: m.tags,
    },
  }))
}

async function fetchTaskVersions(actor: RetrievalActor, rowId: string): Promise<RawVersion[]> {
  type TaskHistoryRow = {
    id: string
    validFrom: Date
    validTo: Date | null
    supersededBy: string | null
    retractedAt: Date | null
    retractedReason: string | null
    createdByUserId: string | null
    createdByAssistantId: string | null
    createdAt: Date
    title: string
    status: string
    tags: string[]
  }
  const result = await queryWithRLS<TaskHistoryRow>(
    actor.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM tasks WHERE id = $1
       UNION
       SELECT t.id, t.superseded_by
         FROM tasks t, chain c
        WHERE t.id = c.superseded_by OR t.superseded_by = c.id
     )
     SELECT id,
            valid_from              AS "validFrom",
            valid_to                AS "validTo",
            superseded_by           AS "supersededBy",
            retracted_at            AS "retractedAt",
            retracted_reason        AS "retractedReason",
            created_by_user_id      AS "createdByUserId",
            created_by_assistant_id AS "createdByAssistantId",
            created_at              AS "createdAt",
            title, status, tags
       FROM tasks
      WHERE id IN (SELECT id FROM chain)
      ORDER BY valid_from ASC, created_at ASC`,
    [rowId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    validFrom: row.validFrom,
    validTo: row.validTo,
    supersededBy: row.supersededBy,
    retractedAt: row.retractedAt,
    retractedReason: row.retractedReason,
    createdByUserId: row.createdByUserId,
    createdByAssistantId: row.createdByAssistantId,
    createdAt: row.createdAt,
    display: {
      title: row.title,
      status: row.status,
      tags: row.tags,
    },
  }))
}

async function fetchWorkspaceFileVersions(
  actor: RetrievalActor,
  rowId: string,
): Promise<RawVersion[]> {
  // WU-4.2b: viewer-projected history walker — actor already carries
  // the viewer's (workspace + user + assistant + optional clearance).
  const rows = await getWorkspaceFileHistory(
    {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      assistantId: actor.assistantId,
      assistantKind: actor.assistantKind,
      clearance: actor.clearance,
    },
    rowId,
  )
  return rows.map((f) => ({
    id: f.id,
    validFrom: f.validFrom,
    validTo: f.validTo,
    supersededBy: f.supersededBy,
    retractedAt: f.retractedAt,
    retractedReason: f.retractedReason,
    createdByUserId: f.createdByUserId,
    createdByAssistantId: f.createdByAssistantId,
    createdAt: f.createdAt,
    display: {
      path: f.path,
      name: f.name,
      title: f.title,
      tags: f.tags,
    },
  }))
}

async function fetchEntityVersions(
  actor: RetrievalActor,
  rowId: string,
): Promise<RawVersion[]> {
  // WU-4.2b: viewer-projected history walker — RetrievalActor already
  // carries the viewer's (workspace + user + assistant + optional
  // clearance). The chain inherits the projection of its anchor row,
  // so a viewer who cannot see the head cannot reconstruct history.
  const rows = await getEntityHistory(
    {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      assistantId: actor.assistantId,
      assistantKind: actor.assistantKind,
      clearance: actor.clearance,
    },
    rowId,
  )
  return rows.map((e) => ({
    id: e.id,
    validFrom: e.validFrom,
    validTo: e.validTo,
    supersededBy: e.supersededBy,
    retractedAt: e.retractedAt,
    retractedReason: e.retractedReason,
    createdByUserId: e.createdByUserId,
    createdByAssistantId: e.createdByAssistantId,
    createdAt: e.createdAt,
    display: {
      kind: e.kind,
      displayName: e.displayName,
      canonicalId: e.canonicalId,
    },
  }))
}

const DISPATCH: Record<RowHistoryPrimitive, (actor: RetrievalActor, rowId: string) => Promise<RawVersion[]>> = {
  memories: fetchMemoryVersions,
  tasks: fetchTaskVersions,
  workspace_files: fetchWorkspaceFileVersions,
  entities: fetchEntityVersions,
  // CRM records are entities post-unification (crm-entity-unification.md) —
  // their history is the entity supersession chain.
  companies: fetchEntityVersions,
  contacts: fetchEntityVersions,
  deals: fetchEntityVersions,
}

// ── Status + projection helpers ─────────────────────────────────────

function deriveStatus(row: RawVersion): RowStatus {
  if (row.retractedAt !== null) return 'retracted'
  if (row.validTo !== null) return 'superseded'
  return 'active'
}

function parseAsOf(asOf: string | undefined): Date | null {
  if (!asOf) return null
  const d = new Date(asOf)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`getRowHistory: invalid as_of timestamp "${asOf}".`)
  }
  return d
}

function toVersion(primitive: RowHistoryPrimitive, raw: RawVersion): RowHistoryVersion {
  return {
    id: raw.id,
    primitive,
    status: deriveStatus(raw),
    valid_from: raw.validFrom.toISOString(),
    valid_to: raw.validTo === null ? null : raw.validTo.toISOString(),
    superseded_by: raw.supersededBy,
    retracted_at: raw.retractedAt === null ? null : raw.retractedAt.toISOString(),
    retracted_reason: raw.retractedReason,
    created_by_user_id: raw.createdByUserId,
    created_by_assistant_id: raw.createdByAssistantId,
    created_at: raw.createdAt.toISOString(),
    display: raw.display,
  }
}

// ── Public surface ──────────────────────────────────────────────────

export function createDbRowHistoryStore(): Pick<RetrievalStore, 'getRowHistory'> {
  return {
    async getRowHistory(
      actor: RetrievalActor,
      input: RowHistoryInput,
    ): Promise<RetrievalEnvelope<RowHistoryData> | null> {
      if (!isKnownPrimitive(input.primitive)) {
        throw new Error(`getRowHistory: unknown primitive "${input.primitive}".`)
      }
      if (!UUID_RE.test(input.row_id)) {
        throw new Error(`getRowHistory: row_id must be a UUID, got "${input.row_id}".`)
      }
      const asOf = parseAsOf(input.as_of)
      const includeRetracted = input.include_retracted ?? true

      const raw = await DISPATCH[input.primitive](actor, input.row_id)
      if (raw.length === 0) return null

      // `as_of` projection: drop versions that did not yet exist at the
      // pivot. The chain still represents history through `as_of`; the
      // head identification below picks the version active at that
      // instant. Pre-existing versions remain visible because the
      // caller is asking "what did the chain look like as of T?" — a
      // valid bi-temporal audit query.
      const visible = asOf === null
        ? raw
        : raw.filter((row) => row.validFrom.getTime() <= asOf.getTime())

      const filtered = includeRetracted
        ? visible
        : visible.filter((row) => row.retractedAt === null)

      const chain = filtered.map((row) => toVersion(input.primitive, row))

      // `current_id` per spec — the version active at the pivot. With
      // no `as_of`, that's the row with `valid_to IS NULL`. With an
      // `as_of`, that's the row whose `valid_from <= as_of` and either
      // unclosed or closed after the pivot. Falls back to null if
      // every version is tombstoned at the pivot.
      const pivot = asOf ?? new Date()
      const head = filtered.find((row) => {
        if (row.validFrom.getTime() > pivot.getTime()) return false
        if (row.validTo === null) return true
        return row.validTo.getTime() > pivot.getTime()
      })
      const current_id = head ? head.id : null

      return {
        api_version: 'v1',
        data: { chain, current_id },
        meta: {
          retrieved_at: new Date().toISOString(),
          truncated: false,
        },
      }
    },
  }
}
