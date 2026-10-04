import type { ResourceScope, Sensitivity, AccessContext } from '@use-brian/core'
import { assertExecutionResourceScope, buildCurrentMemberSourcePredicate, buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { queryWithRLS, getAppPool, applyRLSGucs, rollbackAndRelease } from './client.js'
import { beginBrainAdmission, admitBrainCreate } from '../workspace-access/brain-create-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

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

/** Canonical SQL tiers plus accepted legacy ingest aliases. Ready-mode creation
 * persists confidential for private/secret; visibility remains a separate axis. */
export type EpisodeSensitivity = 'public' | 'internal' | 'confidential' | 'private' | 'secret'

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
  compartments: string[]
  projectIds: string[]
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
  compartments?: string[]
  projectIds?: string[]
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
  compartments,
  project_ids          AS "projectIds",
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
  compartments: string[]
  projectIds: string[]
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
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
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

  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actorUserId)
    const ready = await beginBrainAdmission(client, input.workspaceId)
    if (ready) {
      if (actorUserId !== input.createdByUserId) throw new WorkspaceAccessError('context_not_available', 404)
      const normalize = (value: EpisodeSensitivity): Sensitivity => value === 'private' || value === 'secret' ? 'confidential' : value
      let inherited: ResourceScope | undefined
      if (input.parentEpisodeId) {
        const member = buildCurrentMemberSourcePredicate(actorUserId, { alias: 'e', startIdx: 3, operation: 'mutation' })
        const parent = (await client.query<EpisodeRow>(`SELECT e.*,e.workspace_id AS "workspaceId",e.user_id AS "userId",e.assistant_id AS "assistantId",e.project_ids AS "projectIds"
          FROM episodes e WHERE e.id=$1 AND e.workspace_id=$2 AND NOT e.scope_held AND NOT e.extraction_locked
          AND ${member.sql} FOR SHARE OF e`, [input.parentEpisodeId, input.workspaceId, ...member.params])).rows[0]
        if (!parent) throw new WorkspaceAccessError('context_not_available', 404)
        inherited = { workspaceId: parent.workspaceId, userId: parent.userId, assistantId: parent.assistantId,
          sensitivity: normalize(parent.sensitivity as EpisodeSensitivity), compartments: parent.compartments, projectIds: parent.projectIds }
        assertExecutionResourceScope(inherited, 'read')
        const owner = (requested: string | null, canonical: string | null) => {
          if (requested && canonical && requested !== canonical) throw new WorkspaceAccessError('context_not_available', 404)
          return canonical ?? requested
        }
        input = { ...input, userId: owner(input.userId, parent.userId), assistantId: owner(input.assistantId, parent.assistantId) }
      }
      const admitted = await admitBrainCreate(client, input.workspaceId, actorUserId, {
        ...input, sensitivity: normalize(input.sensitivity ?? 'internal'),
      }, inherited, false, 'episode')
      // Persist the same tier that was authorized. SQL sensitivity_rank and
      // canonical source evidence recognize confidential, not legacy aliases.
      // This does not change user/assistant visibility or relabel historical rows.
      input = { ...input, ...admitted, sensitivity: admitted.sensitivity }
      assertExecutionResourceScope({ ...input, sensitivity: admitted.sensitivity, compartments: admitted.compartments, projectIds: admitted.projectIds }, 'mutation')
    }
    const result = await client.query<EpisodeRow>(
    `INSERT INTO episodes (
       source_kind, source_ref,
       occurred_at,
       status, idle_threshold_secs,
       content_ref, summary_text, attachments,
       sensitivity,
       user_id, assistant_id, workspace_id,
       created_by_user_id, created_by_assistant_id,
       parent_episode_id, compartments, project_ids
     )
     VALUES (
       $1, $2::jsonb,
       $3,
       $4, $5,
       $6::jsonb, $7, $8::jsonb,
       $9,
       $10, $11, $12,
       $13, $14,
       $15,
       ARRAY(
         SELECT DISTINCT unnest(
           COALESCE((SELECT compartments FROM episodes WHERE id = $15), '{}'::text[])
           || $16::text[]
         ) ORDER BY 1
       ),
       ARRAY(
         SELECT DISTINCT unnest(
           COALESCE((SELECT project_ids FROM episodes WHERE id = $15), '{}'::uuid[])
           || $17::uuid[]
         ) ORDER BY 1
       )
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
      input.compartments ?? [],
      input.projectIds ?? [],
    ],
  )
    await client.query('COMMIT')
    return toEpisode(result.rows[0])
  } finally { await rollbackAndRelease(client) }
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

/**
 * Merge a patch into an Episode's `source_ref` JSONB. The recording pipeline
 * advances `sourceRef.status` ('processed' / 'failed') when the async worker
 * finishes — without this, a recording Episode reads its creation-time
 * 'awaiting_upload' forever, and anything rendering the Episode (the assistant
 * browsing the brain, a recordings view) reports a fully-transcribed recording
 * as still queued (2026-07-14 incident). Merge, not replace: gcsKey / fileName
 * / mime survive. Runs as the acting user — the recording's creator, a
 * workspace member, so the episodes RLS policy passes (same identity the
 * worker reads and bills as).
 */
export async function mergeEpisodeSourceRef(
  actorUserId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await queryWithRLS(
    actorUserId,
    `UPDATE episodes SET source_ref = source_ref || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(patch)],
  )
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
