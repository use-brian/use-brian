import type { AccessContext } from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { queryWithRLS } from './client.js'

/**
 * `episodes` store. Schema spec:
 *   docs/plans/company-brain/data-model.md §Episodes.
 *   Migration: packages/api/migrations/129_episodes.sql.
 *
 * Episodes are the immutable observation log. The table deliberately
 * does NOT carry the universal column set added in migration 128 — no
 * `valid_from`/`valid_to`/`superseded_by`, no retraction columns, no
 * trust-signal columns, no embedding columns, no usage tracking. Rows
 * are append-only; only `status`, `last_checkpoint_at`,
 * `idle_threshold_secs`, `summary_text`, and `attachments` mutate
 * (driven by lifecycle / Pipeline B checkpoints).
 *
 * The `asOf` parameter exposed on reads keeps the surface uniform with
 * the retrieval-side tools (`retrieval.md` §Bi-temporal default). For
 * episodes it collapses to `ingested_at <= asOf` — "what the system
 * had observed by time T." The row itself never time-travels.
 *
 * `content_ref` is a discriminated-union JSONB tagged by `source_kind`.
 * The 14-variant Zod schema is WU-3.4's responsibility
 * (`packages/core/src/ingest/types.ts`); the store treats both
 * `source_ref` and `content_ref` as opaque `Record<string, unknown>`
 * at the DB seam. Adapters + Pipeline B own the typed contract.
 */

export type EpisodeStatus = 'open' | 'extracting' | 'archived'

export type EpisodeSensitivity = 'public' | 'internal' | 'private' | 'secret'

export type EpisodeRecord = {
  id: string
  sourceKind: string
  sourceRef: Record<string, unknown>
  occurredAt: Date
  ingestedAt: Date
  status: EpisodeStatus
  lastCheckpointAt: Date | null
  idleThresholdSecs: number | null
  contentRef: Record<string, unknown> | null
  summaryText: string | null
  attachments: unknown[]
  sensitivity: EpisodeSensitivity
  userId: string | null
  assistantId: string | null
  workspaceId: string
  createdByUserId: string
  createdByAssistantId: string | null
  parentEpisodeId: string | null
  extractionLocked: boolean
  createdAt: Date
}

export type CreateEpisodeInput = {
  sourceKind: string
  sourceRef: Record<string, unknown>
  occurredAt: Date
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string
  createdByAssistantId?: string | null
  sensitivity?: EpisodeSensitivity
  contentRef?: Record<string, unknown> | null
  summaryText?: string | null
  attachments?: unknown[]
  idleThresholdSecs?: number | null
  parentEpisodeId?: string | null
  status?: EpisodeStatus
}

/**
 * Filter shape for `listEpisodes`. WU-4.2b moved workspace + viewer
 * partitioning onto the `AccessContext` first arg; the remaining
 * filters narrow within the already-projected slice.
 *
 * `userId` / `assistantId` filters still apply: a workspace member can
 * explicitly narrow to their own rows (`userId = currentUser`) or to
 * workspace-shared rows (`userId = null`) regardless of what the
 * universal predicate would have surfaced.
 */
export type EpisodeFilters = {
  userId?: string | null
  assistantId?: string | null
  sourceKind?: string
  status?: EpisodeStatus | EpisodeStatus[]
  parentEpisodeId?: string
  occurredAfter?: Date
  occurredBefore?: Date
  asOf?: Date
}

export type ListEpisodesOpts = {
  limit?: number
  order?: 'occurred_at_desc' | 'occurred_at_asc' | 'ingested_at_desc'
}

export type UpdateStatusOpts = {
  /** Force-stamp `last_checkpoint_at = now()` even when the next status
   *  isn't `'extracting'`. Used by callers that drive checkpoint
   *  cadence independently of status transitions. */
  stampCheckpoint?: boolean
}

export type CheckpointPatch = {
  /** Defaults to `now()` when omitted. */
  at?: Date
  summaryText?: string | null
  attachments?: unknown[]
  idleThresholdSecs?: number | null
}

export interface DbEpisodesStore {
  createEpisode(actorUserId: string, input: CreateEpisodeInput): Promise<EpisodeRecord>
  getEpisodeById(
    ctx: AccessContext,
    id: string,
    opts?: { asOf?: Date },
  ): Promise<EpisodeRecord | null>
  /** System-level read — bypasses per-viewer projection. Reserved for
   *  ingest workers and the D.7 audit surface. */
  getEpisodeByIdSystem(
    actorUserId: string,
    id: string,
    opts?: { asOf?: Date },
  ): Promise<EpisodeRecord | null>
  listEpisodes(
    ctx: AccessContext,
    filters: EpisodeFilters,
    opts?: ListEpisodesOpts,
  ): Promise<EpisodeRecord[]>
  updateStatus(
    actorUserId: string,
    id: string,
    next: EpisodeStatus,
    opts?: UpdateStatusOpts,
  ): Promise<EpisodeRecord | null>
  updateCheckpoint(
    actorUserId: string,
    id: string,
    patch: CheckpointPatch,
  ): Promise<EpisodeRecord | null>
}

const FULL_SELECT = `
  id,
  source_kind         AS "sourceKind",
  source_ref          AS "sourceRef",
  occurred_at         AS "occurredAt",
  ingested_at         AS "ingestedAt",
  status,
  last_checkpoint_at  AS "lastCheckpointAt",
  idle_threshold_secs AS "idleThresholdSecs",
  content_ref         AS "contentRef",
  summary_text        AS "summaryText",
  attachments,
  sensitivity,
  user_id             AS "userId",
  assistant_id        AS "assistantId",
  workspace_id        AS "workspaceId",
  created_by_user_id      AS "createdByUserId",
  created_by_assistant_id AS "createdByAssistantId",
  parent_episode_id   AS "parentEpisodeId",
  extraction_locked   AS "extractionLocked",
  created_at          AS "createdAt"
`

type EpisodeRow = {
  id: string
  sourceKind: string
  sourceRef: Record<string, unknown> | null
  occurredAt: Date
  ingestedAt: Date
  status: string
  lastCheckpointAt: Date | null
  idleThresholdSecs: number | null
  contentRef: Record<string, unknown> | null
  summaryText: string | null
  attachments: unknown[] | null
  sensitivity: string
  userId: string | null
  assistantId: string | null
  workspaceId: string
  createdByUserId: string
  createdByAssistantId: string | null
  parentEpisodeId: string | null
  extractionLocked: boolean
  createdAt: Date
}

function toEpisode(row: EpisodeRow): EpisodeRecord {
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef ?? {},
    occurredAt: row.occurredAt,
    ingestedAt: row.ingestedAt,
    status: row.status as EpisodeStatus,
    lastCheckpointAt: row.lastCheckpointAt,
    idleThresholdSecs: row.idleThresholdSecs,
    contentRef: row.contentRef,
    summaryText: row.summaryText,
    attachments: row.attachments ?? [],
    sensitivity: row.sensitivity as EpisodeSensitivity,
    userId: row.userId,
    assistantId: row.assistantId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    createdByAssistantId: row.createdByAssistantId,
    parentEpisodeId: row.parentEpisodeId,
    extractionLocked: row.extractionLocked,
    createdAt: row.createdAt,
  }
}

// ── Status transition table ──────────────────────────────────────────
//
// open       → extracting | archived
// extracting → archived
// archived   → (terminal)
//
// Per L6.8 lock (2026-05-14): archived is immutable; continuations
// create a new episode with `parent_episode_id`, never reopen. The
// `open → archived` skip-extraction path lets adapters whose output
// is already-final (e.g. one-shot connector_action observations) bypass
// the extraction worker entirely.

const ALLOWED_TRANSITIONS: Record<EpisodeStatus, ReadonlySet<EpisodeStatus>> = {
  open: new Set<EpisodeStatus>(['extracting', 'archived']),
  extracting: new Set<EpisodeStatus>(['archived']),
  archived: new Set<EpisodeStatus>(),
}

function assertVisibilityDouble(input: CreateEpisodeInput): void {
  if (input.userId == null && input.assistantId == null) {
    throw new Error('episodes require user_id or assistant_id (visibility double)')
  }
}

function assertTransition(current: EpisodeStatus, next: EpisodeStatus): void {
  if (current === next) {
    throw new Error(`episode is already in status '${current}'`)
  }
  const allowed = ALLOWED_TRANSITIONS[current]
  if (!allowed.has(next)) {
    throw new Error(`invalid episode status transition: ${current} -> ${next}`)
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────

export async function createEpisode(
  actorUserId: string,
  input: CreateEpisodeInput,
): Promise<EpisodeRecord> {
  assertAuthorshipPresent('createEpisode', input.createdByUserId)
  assertVisibilityDouble(input)

  const result = await queryWithRLS<EpisodeRow>(
    actorUserId,
    `INSERT INTO episodes (
       source_kind, source_ref,
       occurred_at,
       status, idle_threshold_secs,
       content_ref, summary_text, attachments,
       sensitivity,
       user_id, assistant_id, workspace_id,
       created_by_user_id, created_by_assistant_id,
       parent_episode_id
     )
     VALUES (
       $1, $2::jsonb,
       $3,
       $4, $5,
       $6::jsonb, $7, $8::jsonb,
       $9,
       $10, $11, $12,
       $13, $14,
       $15
     )
     RETURNING ${FULL_SELECT}`,
    [
      input.sourceKind,
      JSON.stringify(input.sourceRef ?? {}),
      input.occurredAt,
      input.status ?? 'open',
      input.idleThresholdSecs ?? null,
      input.contentRef == null ? null : JSON.stringify(input.contentRef),
      input.summaryText ?? null,
      JSON.stringify(input.attachments ?? []),
      input.sensitivity ?? 'internal',
      input.userId,
      input.assistantId,
      input.workspaceId,
      input.createdByUserId,
      input.createdByAssistantId ?? null,
      input.parentEpisodeId ?? null,
    ],
  )
  return toEpisode(result.rows[0])
}

export async function getEpisodeById(
  ctx: AccessContext,
  id: string,
  opts: { asOf?: Date } = {},
): Promise<EpisodeRecord | null> {
  // Episodes are append-only: temporal predicate is just
  // `ingested_at <= asOf`. Universal projection still applies — mig
  // 129 gave the table the (workspace_id, user_id, assistant_id,
  // sensitivity) tuple.
  const ap = buildAccessPredicate(ctx, { startIdx: 3 })
  const result = await queryWithRLS<EpisodeRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT}
       FROM episodes
      WHERE id = $1
        AND ingested_at <= COALESCE($2::timestamptz, now())
        AND ${ap.sql}`,
    [id, opts.asOf ?? null, ...ap.params],
  )
  if (result.rows.length === 0) return null
  return toEpisode(result.rows[0])
}

export async function getEpisodeByIdSystem(
  actorUserId: string,
  id: string,
  opts: { asOf?: Date } = {},
): Promise<EpisodeRecord | null> {
  const result = await queryWithRLS<EpisodeRow>(
    actorUserId,
    `SELECT ${FULL_SELECT}
       FROM episodes
      WHERE id = $1
        AND ingested_at <= COALESCE($2::timestamptz, now())`,
    [id, opts.asOf ?? null],
  )
  if (result.rows.length === 0) return null
  return toEpisode(result.rows[0])
}

export async function listEpisodes(
  ctx: AccessContext,
  filters: EpisodeFilters,
  opts: ListEpisodesOpts = {},
): Promise<EpisodeRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const order = opts.order ?? 'occurred_at_desc'

  const ap = buildAccessPredicate(ctx, { startIdx: 2 })
  const values: unknown[] = [filters.asOf ?? null, ...ap.params]
  const where: string[] = [
    'ingested_at <= COALESCE($1::timestamptz, now())',
    ap.sql,
  ]

  if (filters.userId !== undefined) {
    if (filters.userId === null) {
      where.push('user_id IS NULL')
    } else {
      values.push(filters.userId)
      where.push(`user_id = $${values.length}`)
    }
  }
  if (filters.assistantId !== undefined) {
    if (filters.assistantId === null) {
      where.push('assistant_id IS NULL')
    } else {
      values.push(filters.assistantId)
      where.push(`assistant_id = $${values.length}`)
    }
  }
  if (filters.sourceKind !== undefined) {
    values.push(filters.sourceKind)
    where.push(`source_kind = $${values.length}`)
  }
  if (filters.status !== undefined) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
    if (statuses.length === 1) {
      values.push(statuses[0])
      where.push(`status = $${values.length}`)
    } else if (statuses.length > 1) {
      values.push(statuses)
      where.push(`status = ANY($${values.length}::text[])`)
    }
  }
  if (filters.parentEpisodeId !== undefined) {
    values.push(filters.parentEpisodeId)
    where.push(`parent_episode_id = $${values.length}`)
  }
  if (filters.occurredAfter !== undefined) {
    values.push(filters.occurredAfter)
    where.push(`occurred_at >= $${values.length}`)
  }
  if (filters.occurredBefore !== undefined) {
    values.push(filters.occurredBefore)
    where.push(`occurred_at <= $${values.length}`)
  }

  const orderClause =
    order === 'occurred_at_asc'
      ? 'occurred_at ASC, id ASC'
      : order === 'ingested_at_desc'
        ? 'ingested_at DESC, id DESC'
        : 'occurred_at DESC, id DESC'

  values.push(limit)

  const result = await queryWithRLS<EpisodeRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT}
       FROM episodes
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT $${values.length}`,
    values,
  )
  return result.rows.map(toEpisode)
}

export async function updateStatus(
  actorUserId: string,
  id: string,
  next: EpisodeStatus,
  opts: UpdateStatusOpts = {},
): Promise<EpisodeRecord | null> {
  const current = await queryWithRLS<{ status: string }>(
    actorUserId,
    `SELECT status FROM episodes WHERE id = $1`,
    [id],
  )
  if (current.rows.length === 0) return null
  assertTransition(current.rows[0].status as EpisodeStatus, next)

  const stamp = opts.stampCheckpoint || next === 'extracting'
  const result = await queryWithRLS<EpisodeRow>(
    actorUserId,
    `UPDATE episodes
        SET status = $2
            ${stamp ? ', last_checkpoint_at = now()' : ''}
      WHERE id = $1
      RETURNING ${FULL_SELECT}`,
    [id, next],
  )
  if (result.rows.length === 0) return null
  return toEpisode(result.rows[0])
}

export async function updateCheckpoint(
  actorUserId: string,
  id: string,
  patch: CheckpointPatch,
): Promise<EpisodeRecord | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  // last_checkpoint_at is always stamped — it's the "checkpoint" itself.
  if (patch.at !== undefined) {
    sets.push(`last_checkpoint_at = $${idx++}`)
    values.push(patch.at)
  } else {
    sets.push('last_checkpoint_at = now()')
  }

  if (patch.summaryText !== undefined) {
    sets.push(`summary_text = $${idx++}`)
    values.push(patch.summaryText)
  }
  if (patch.attachments !== undefined) {
    sets.push(`attachments = $${idx++}::jsonb`)
    values.push(JSON.stringify(patch.attachments))
  }
  if (patch.idleThresholdSecs !== undefined) {
    sets.push(`idle_threshold_secs = $${idx++}`)
    values.push(patch.idleThresholdSecs)
  }

  values.push(id)
  const result = await queryWithRLS<EpisodeRow>(
    actorUserId,
    `UPDATE episodes
        SET ${sets.join(', ')}
      WHERE id = $${idx}
      RETURNING ${FULL_SELECT}`,
    values,
  )
  if (result.rows.length === 0) return null
  return toEpisode(result.rows[0])
}

// ── Factory ──────────────────────────────────────────────────────────

export function createDbEpisodesStore(): DbEpisodesStore {
  return {
    createEpisode: (actorUserId, input) => createEpisode(actorUserId, input),
    getEpisodeById: (ctx, id, opts) => getEpisodeById(ctx, id, opts ?? {}),
    getEpisodeByIdSystem: (actorUserId, id, opts) =>
      getEpisodeByIdSystem(actorUserId, id, opts ?? {}),
    listEpisodes: (ctx, filters, opts) => listEpisodes(ctx, filters, opts ?? {}),
    updateStatus: (actorUserId, id, next, opts) => updateStatus(actorUserId, id, next, opts ?? {}),
    updateCheckpoint: (actorUserId, id, patch) => updateCheckpoint(actorUserId, id, patch),
  }
}
