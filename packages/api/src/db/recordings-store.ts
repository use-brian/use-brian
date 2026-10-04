/**
 * `recordings-store.ts` — the recording as a first-class row (migration 335).
 *
 * A recording USED to be an `episodes` row with everything in a JSONB
 * `source_ref`. It still HAS that anchor Episode — facts point at episodes, so a
 * recording-sourced fact stays uniform with a Slack-sourced one — but the
 * recording's own state (kind, status, duration, bytes, artifacts, retention)
 * now lives here, in CHECK'd columns that can be indexed, filtered, and swept.
 *
 * `recordings.id` IS the anchor Episode's id (the PK is the FK). So every
 * pre-existing reference — `transcript_segments.recording_id`,
 * `recording_jobs.recording_id`, `blueprint_records.source_id`, the
 * `recording-synthesis:<id>` anchor key — keeps resolving unchanged.
 *
 * Creation uses the canonical app-role intake transaction (migration 642).
 * Existing read/state-patch APIs retain their prior pools:
 *   - `query()` (owner pool, RLS-open) for the WORKER + route writes. The worker
 *     has no user context, and the route did its own membership check before
 *     writing. Mirrors `recording-jobs-store.ts`.
 *   - `queryWithRLS(userId, ...)` for member READS (the list/detail surface), so
 *     the `recordings_workspace_member` policy is what gates visibility rather
 *     than a hand-written WHERE the next caller might forget.
 *
 * [COMP:recordings/recordings-store]
 */

import type { AccessContext } from '@use-brian/core'
import { query, queryWithRLS } from './client.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { recordingIntakeTransaction, admitRecordingIntakeParent, type RecordingIntakeAuthority, type RecordingIntakeParent } from './recording-intake-admission.js'
import { buildAccessPredicate } from './access-predicate.js'

export type RecordingKind = 'memo' | 'meeting'
export type RecordingStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'processing'
  | 'processed'
  | 'failed'

/** A diarized speaker resolved (or not yet) to a person. */
export type RecordingParticipant = {
  speaker: string
  name?: string
  contactId?: string
  email?: string
}

export type Recording = {
  id: string
  workspaceId: string
  title: string | null
  kind: RecordingKind
  status: RecordingStatus
  fileName: string | null
  mime: string
  gcsKey: string
  storageUri: string | null
  bytes: number | null
  durationMs: number | null
  transcriptFileId: string | null
  mediaFileId: string | null
  participants: RecordingParticipant[]
  truncated: boolean
  lastError: string | null
  deleteAfter: Date | null
  userId: string | null
  assistantId: string | null
  sensitivity: string
  compartments: string[]
  projectIds: string[]
  createdByUserId: string
  createdAt: Date
  updatedAt: Date
}

const COLS = `
  id,
  workspace_id       AS "workspaceId",
  title,
  kind,
  status,
  file_name          AS "fileName",
  mime,
  gcs_key            AS "gcsKey",
  storage_uri        AS "storageUri",
  bytes,
  duration_ms        AS "durationMs",
  transcript_file_id AS "transcriptFileId",
  media_file_id      AS "mediaFileId",
  participants,
  truncated,
  last_error         AS "lastError",
  delete_after       AS "deleteAfter",
  user_id            AS "userId",
  assistant_id       AS "assistantId",
  sensitivity,
  compartments,
  project_ids         AS "projectIds",
  created_by_user_id AS "createdByUserId",
  created_at         AS "createdAt",
  updated_at         AS "updatedAt"
`

/** `bytes` / `duration_ms` are BIGINT — pg returns them as strings. */
function toRecording(row: Record<string, unknown>): Recording {
  return {
    ...(row as unknown as Recording),
    bytes: row.bytes == null ? null : Number(row.bytes),
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    participants: (row.participants ?? []) as RecordingParticipant[],
  }
}

/** Canonical file adoption: Episode, recording and exact lineage are committed
 * together on the app role. Per-call provenance is mandatory; upload/channel
 * callers without an admitted file parent fail closed pending their adapters.
 * The parent binding, not an unverified Episode JSON field, serializes retries.
 */
export async function createRecording(input: {
  id: string
  workspaceId: string
  mime: string
  gcsKey: string
  storageUri?: string | null
  fileName?: string | null
  bytes?: number | null
  title?: string | null
  kind?: RecordingKind
  status?: RecordingStatus
  assistantId: string | null
  userId?: string | null
  sensitivity?: string
  createdByUserId: string
}, provenance?: RecordingIntakeAuthority & { parent: RecordingIntakeParent }): Promise<Recording> {
  if (!provenance) throw new Error('recording_intake_provenance_required')
  return recordingIntakeTransaction(provenance, async client => {
    const scope = await admitRecordingIntakeParent(client, provenance, input.workspaceId, provenance.parent)
    if (input.createdByUserId !== provenance.actorUserId) throw new Error('recording_intake_actor_mismatch')
    const policy = await readAdmissionPolicy(client, input.workspaceId)
    if (policy?.setupState === 'ready') await admitWorkspaceResource(client, input.workspaceId, provenance.actorUserId, {
      writerKind: 'episode', rowVisibility: scope, visibility: scope.userId ? 'private' : 'workspace', sensitivity: scope.sensitivity,
      inherited: { ...scope, visibility: scope.userId ? 'private' : 'workspace' }, inheritedAuthority: 'read',
    })
    const result = await client.query(`SELECT ${COLS} FROM publish_file_recording($1::jsonb,$2::uuid,$3::text)`, [JSON.stringify(provenance.parent), input.id, input.kind ?? null])
    return toRecording(result.rows[0])
  })
}

/**
 * The recording that already OWNS a stored media file, if any.
 *
 * System-level (the caller has already gated the file). Exists so the
 * file → recording handoff is idempotent: a media row reached through the brain
 * drawer normally names its recording through `source_episode_id`, but a row
 * whose back-edge was never stamped would otherwise adopt a SECOND recording on
 * every click. Oldest first, mirroring the firing-row rule: if two ever exist,
 * the one the user already has transcripts and pages hanging off wins.
 */
export async function getRecordingByMediaFileSystem(
  workspaceId: string,
  mediaFileId: string,
): Promise<Recording | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COLS} FROM recordings
      WHERE workspace_id = $1 AND media_file_id = $2 AND valid_to IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [workspaceId, mediaFileId],
  )
  return rows[0] ? toRecording(rows[0]) : null
}

/** System read (worker path — no user context). */
export async function getRecordingSystem(id: string): Promise<Recording | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COLS} FROM recordings WHERE id = $1`,
    [id],
  )
  return rows[0] ? toRecording(rows[0]) : null
}

/** Member read — RLS decides visibility. */
export async function getRecording(ctx: AccessContext | string, id: string): Promise<Recording | null> {
  const actorUserId = typeof ctx === 'string' ? ctx : ctx.userId
  const ap = typeof ctx === 'string' ? null : buildAccessPredicate(ctx, { startIdx: 2 })
  const { rows } = await queryWithRLS<Record<string, unknown>>(
    actorUserId,
    `SELECT ${COLS} FROM recordings WHERE id = $1${ap ? ` AND ${ap.sql}` : ''}`,
    [id, ...(ap?.params ?? [])],
  )
  return rows[0] ? toRecording(rows[0]) : null
}

export type ListRecordingsFilters = {
  kind?: RecordingKind
  status?: RecordingStatus
  /** Inclusive lower bound on `created_at`. */
  since?: Date
  /** Exclusive upper bound on `created_at`. */
  until?: Date
  /** Case-insensitive substring over title / file name. */
  q?: string
}

export const LIST_RECORDINGS_LIMIT_DEFAULT = 20
export const LIST_RECORDINGS_LIMIT_MAX = 100

/**
 * The temporal/nominal lookup — "Tuesday's call". Semantic search structurally
 * cannot answer this, which is why it is a separate read from `searchRecording`.
 * Newest-first; rides `idx_recordings_ws_created`.
 */
export async function listRecordings(
  ctx: AccessContext | string,
  workspaceId: string,
  filters: ListRecordingsFilters = {},
  opts: { limit?: number } = {},
): Promise<Recording[]> {
  const ap = typeof ctx === 'string' ? null : buildAccessPredicate(ctx, { startIdx: 2 })
  const where: string[] = [
    'workspace_id = $1',
    'valid_to IS NULL',
    'retracted_at IS NULL',
  ]
  const values: unknown[] = [workspaceId]
  if (ap) {
    where.push(ap.sql)
    values.push(...ap.params)
  }

  if (filters.kind) {
    values.push(filters.kind)
    where.push(`kind = $${values.length}`)
  }
  if (filters.status) {
    values.push(filters.status)
    where.push(`status = $${values.length}`)
  }
  if (filters.since) {
    values.push(filters.since)
    where.push(`created_at >= $${values.length}`)
  }
  if (filters.until) {
    values.push(filters.until)
    where.push(`created_at < $${values.length}`)
  }
  if (filters.q?.trim()) {
    values.push(`%${filters.q.trim()}%`)
    where.push(`(title ILIKE $${values.length} OR file_name ILIKE $${values.length})`)
  }

  const limit = Math.min(
    Math.max(1, opts.limit ?? LIST_RECORDINGS_LIMIT_DEFAULT),
    LIST_RECORDINGS_LIMIT_MAX,
  )
  values.push(limit)

  const { rows } = await queryWithRLS<Record<string, unknown>>(
    typeof ctx === 'string' ? ctx : ctx.userId,
    `SELECT ${COLS} FROM recordings
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values,
  )
  return rows.map(toRecording)
}

/**
 * Patch recording state. System pool: every caller is the route (post-membership
 * check) or the worker (no user context). Only the named fields are touched, so a
 * concurrent transcript-file write and a status write cannot clobber each other.
 */
export async function updateRecording(
  id: string,
  patch: {
    status?: RecordingStatus
    kind?: RecordingKind
    title?: string | null
    bytes?: number | null
    durationMs?: number | null
    transcriptFileId?: string | null
    mediaFileId?: string | null
    participants?: RecordingParticipant[]
    truncated?: boolean
    lastError?: string | null
    deleteAfter?: Date | null
    /**
     * Transcription language observability (migration 354). Every field is
     * nullable and NULL means NOT MEASURED — in particular a null density is
     * not a zero one: null is "no CJK present, the ratio is undefined", zero
     * is "Chinese, carrying no Cantonese markers", which is precisely the
     * silent Mandarin-normalization the metric exists to surface. Recordings
     * processed before this shipped stay NULL, so a backfill gap can never be
     * read as a measurement.
     *
     * Spec: docs/architecture/media/transcription.md → "Language signal".
     */
    detectedLanguage?: string | null
    detectedLanguageConfidence?: number | null
    cantoDensityPerK?: number | null
    cantoMarkerCount?: number | null
    cjkCount?: number | null
    latinTokens?: number | null
    chineseVariant?: string | null
  },
): Promise<Recording | null> {
  const sets: string[] = []
  const values: unknown[] = []
  const put = (col: string, val: unknown) => {
    values.push(val)
    sets.push(`${col} = $${values.length}`)
  }

  if (patch.status !== undefined) put('status', patch.status)
  if (patch.kind !== undefined) put('kind', patch.kind)
  if (patch.title !== undefined) put('title', patch.title)
  if (patch.bytes !== undefined) put('bytes', patch.bytes)
  if (patch.durationMs !== undefined) put('duration_ms', patch.durationMs)
  if (patch.transcriptFileId !== undefined) put('transcript_file_id', patch.transcriptFileId)
  if (patch.mediaFileId !== undefined) put('media_file_id', patch.mediaFileId)
  if (patch.participants !== undefined) put('participants', JSON.stringify(patch.participants))
  if (patch.truncated !== undefined) put('truncated', patch.truncated)
  // Provider errors are machine-generated, never user content — safe to store
  // once bounded.
  if (patch.lastError !== undefined) put('last_error', patch.lastError?.slice(0, 2000) ?? null)
  if (patch.deleteAfter !== undefined) put('delete_after', patch.deleteAfter)
  // Language signal — `!== undefined` (not a truthiness check) because 0 is a
  // real reading for every one of these counts.
  if (patch.detectedLanguage !== undefined) put('detected_language', patch.detectedLanguage)
  if (patch.detectedLanguageConfidence !== undefined)
    put('detected_language_confidence', patch.detectedLanguageConfidence)
  if (patch.cantoDensityPerK !== undefined) put('canto_density_per_k', patch.cantoDensityPerK)
  if (patch.cantoMarkerCount !== undefined) put('canto_marker_count', patch.cantoMarkerCount)
  if (patch.cjkCount !== undefined) put('cjk_count', patch.cjkCount)
  if (patch.latinTokens !== undefined) put('latin_tokens', patch.latinTokens)
  if (patch.chineseVariant !== undefined) put('chinese_variant', patch.chineseVariant)

  if (sets.length === 0) return getRecordingSystem(id)

  sets.push('updated_at = now()')
  values.push(id)
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE recordings SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${COLS}`,
    values,
  )
  return rows[0] ? toRecording(rows[0]) : null
}
