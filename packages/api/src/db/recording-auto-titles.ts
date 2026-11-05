// [COMP:recordings/auto-title] - authority-preserving display-title publication.
import { resourceScopeKey, type ScopeSource } from '@use-brian/core'
import type { PoolClient } from 'pg'
import { query } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import {
  admitRecordingIntakeParent,
  captureRecordingSegmentProvenance,
  recordingIntakeTransaction,
  type RecordingSegmentProvenance,
} from './recording-intake-admission.js'

export type RecordingAutoTitleCandidate = { recordingId: string; workspaceId: string; userId: string; attempt: number }
type Segment = { id: string; version: string; text: string }
type CurrentSource = ScopeSource & { held?: boolean; validTo?: string | null; retractedAt?: string | null }
export type RecordingAutoTitleSnapshot = RecordingAutoTitleCandidate & {
  provenance: RecordingSegmentProvenance
  originalTitle: string | null
  fileName: string | null
  occurredAt: Date
  timezone: string
  segments: Segment[]
}

/** Owner pool claims identities only; all content/publication uses current RLS. */
export async function claimRecordingAutoTitle(): Promise<RecordingAutoTitleCandidate | null> {
  const result = await query<RecordingAutoTitleCandidate>(`WITH pending AS (
    SELECT id FROM recordings
    WHERE status='processed' AND NOT truncated AND generated_title IS NULL
      AND auto_title_attempts<3 AND (auto_title_retry_at IS NULL OR auto_title_retry_at<=now())
      AND (title IS NULL OR title=file_name) AND NOT scope_held AND valid_to IS NULL AND retracted_at IS NULL
    ORDER BY auto_title_retry_at NULLS FIRST,created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE recordings r SET auto_title_attempts=r.auto_title_attempts+1,
      auto_title_retry_at=now()+interval '5 minutes'
    FROM pending WHERE r.id=pending.id
    RETURNING r.id AS "recordingId",r.workspace_id AS "workspaceId",r.created_by_user_id AS "userId",
      r.auto_title_attempts AS attempt`)
  return result.rows[0] ?? null
}

function sameScope(source: CurrentSource | null, provenance: RecordingSegmentProvenance): source is CurrentSource {
  return !!source && !source.held && !source.validTo && !source.retractedAt
    && resourceScopeKey(source) === resourceScopeKey(provenance.parent)
}

async function assertSource(client: PoolClient, candidate: RecordingAutoTitleCandidate, provenance: RecordingSegmentProvenance) {
  if (provenance.recordingId !== candidate.recordingId || provenance.actorUserId !== candidate.userId
    || provenance.parent.workspaceId !== candidate.workspaceId) throw new Error('recording_auto_title_source_changed')
  await admitRecordingIntakeParent(client, provenance, candidate.workspaceId, provenance.parent)
  const result = await client.query<{ recording: ScopeSource | null; episode: ScopeSource | null }>(
    `SELECT read_entity_derivation_source($1,'recording',$2) AS recording,
       read_entity_derivation_source($1,'episode',$2) AS episode`, [candidate.workspaceId, candidate.recordingId])
  const sources = result.rows[0]
  if (!sameScope(sources?.recording ?? null, provenance) || !sameScope(sources?.episode ?? null, provenance)
    || sources.recording!.version !== provenance.recordingVersion || sources.episode!.version !== provenance.episodeVersion) {
    throw new Error('recording_auto_title_source_changed')
  }
}

export async function loadRecordingAutoTitle(candidate: RecordingAutoTitleCandidate): Promise<RecordingAutoTitleSnapshot | null> {
  const provenance = await captureRecordingSegmentProvenance({ actorUserId: candidate.userId }, candidate.workspaceId, candidate.recordingId)
  // Identity-only sampling avoids running recursive content RLS over every
  // segment in a long meeting. Payloads are fetched only in the admitted frame.
  const chosen = (await query<{ id: string }>(`WITH numbered AS (
      SELECT id,segment_index,ntile(23) OVER (ORDER BY segment_index) AS bucket,
        row_number() OVER (ORDER BY segment_index DESC) AS reverse_index
      FROM transcript_segments WHERE workspace_id=$1 AND recording_id=$2 AND kind='speech'
        AND NOT scope_held AND valid_to IS NULL AND retracted_at IS NULL
    ), chosen AS (
      (SELECT DISTINCT ON(bucket) id,segment_index FROM numbered ORDER BY bucket,segment_index)
      UNION SELECT id,segment_index FROM numbered WHERE reverse_index=1
    ) SELECT id FROM chosen ORDER BY segment_index`, [candidate.workspaceId, candidate.recordingId])).rows
  if (!chosen.length) return null
  return recordingIntakeTransaction(provenance, async client => {
    await assertSource(client, candidate, provenance)
    const recording = (await client.query<{ originalTitle: string | null; fileName: string | null; occurredAt: Date; timezone: string }>(
      `SELECT r.title AS "originalTitle",r.file_name AS "fileName",e.occurred_at AS "occurredAt",COALESCE(u.timezone,'UTC') AS timezone
       FROM recordings r JOIN episodes e ON e.id=r.id JOIN users u ON u.id=r.created_by_user_id
       WHERE r.id=$1 AND r.workspace_id=$2 AND r.generated_title IS NULL AND r.status='processed'
         AND NOT r.truncated AND (r.title IS NULL OR r.title=r.file_name) AND r.auto_title_attempts=$3`,
      [candidate.recordingId, candidate.workspaceId, candidate.attempt])).rows[0]
    if (!recording) return null
    const rows = (await client.query<{ id: string; text: string; source: ScopeSource | null }>(
      `SELECT id,segment_text AS text,read_recording_title_segment($1,$2,id) AS source
       FROM transcript_segments WHERE workspace_id=$1 AND recording_id=$2 AND id=ANY($3::uuid[])
         AND NOT scope_held AND valid_to IS NULL AND retracted_at IS NULL
         AND NOT scope_review_state_held('transcript_segment',id)
       ORDER BY segment_index`, [candidate.workspaceId, candidate.recordingId, chosen.map(row => row.id)])).rows
    if (rows.length !== chosen.length || rows.some(row => !sameScope(row.source, provenance))) return null
    return {
      ...candidate, ...recording, provenance,
      segments: rows.map(row => ({ id: row.id, text: row.text, version: row.source!.version })),
    }
  })
}

async function assertSnapshot(client: PoolClient, snapshot: RecordingAutoTitleSnapshot): Promise<void> {
  const { provenance, workspaceId } = snapshot
  await assertSource(client, snapshot, provenance)
  // The recording source can stay fixed while an individual transcript edit
  // changes. Every sampled semantic version must still be current after AI.
  const sources = (await client.query<{ id: string; source: ScopeSource | null }>(
      `SELECT id,read_recording_title_segment($1,$3,id) AS source FROM transcript_segments
       WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT scope_held AND valid_to IS NULL AND retracted_at IS NULL
         AND NOT scope_review_state_held('transcript_segment',id)`, [workspaceId, snapshot.segments.map(segment => segment.id), snapshot.recordingId])).rows
  if (sources.length !== snapshot.segments.length || sources.some(row =>
    !sameScope(row.source, provenance) || row.source!.version !== snapshot.segments.find(segment => segment.id === row.id)?.version)) {
    throw new Error('recording_auto_title_transcript_changed')
  }
}

/** Reused before provider input, physical retries and the final commit. */
export async function assertRecordingAutoTitleCurrent(snapshot: RecordingAutoTitleSnapshot): Promise<void> {
  await recordingIntakeTransaction(snapshot.provenance, client => assertSnapshot(client, snapshot))
}

export async function commitRecordingAutoTitle(snapshot: RecordingAutoTitleSnapshot, title: string): Promise<boolean> {
  const { provenance, workspaceId, recordingId } = snapshot
  const committed = await recordingIntakeTransaction(provenance, async client => {
    await assertSnapshot(client, snapshot)
    const updated = (await client.query<{ mediaFileId: string | null; transcriptFileId: string | null; fileName: string | null }>(
      `UPDATE recordings SET generated_title=$3,updated_at=now()
       WHERE id=$1 AND workspace_id=$2 AND generated_title IS NULL AND title IS NOT DISTINCT FROM $4
         AND auto_title_attempts=$5 AND status='processed' AND NOT truncated
       RETURNING media_file_id AS "mediaFileId",transcript_file_id AS "transcriptFileId",file_name AS "fileName"`,
      [recordingId, workspaceId, title, snapshot.originalTitle, snapshot.attempt])).rows[0]
    if (!updated) return false
    for (const [id, displayTitle, expectedTitle] of [
      [updated.mediaFileId, title, snapshot.originalTitle],
      [updated.transcriptFileId, `${title} · Transcript`, snapshot.originalTitle ? `Transcript - ${snapshot.originalTitle}` : 'Transcript'],
    ]) {
      if (!id) continue
      const file = (await client.query<{ title: string | null; source: ScopeSource | null }>(
        `SELECT title,read_entity_derivation_source(workspace_id,'workspace_file',id) AS source
         FROM workspace_files WHERE id=$1 AND workspace_id=$2`, [id, workspaceId])).rows[0]
      if (!file || !sameScope(file.source, provenance)
        || file.title !== null && file.title !== expectedTitle && file.title !== updated.fileName) continue
      await client.query(`UPDATE workspace_files SET generated_title=$3,updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND title IS NOT DISTINCT FROM $4`, [id, workspaceId, displayTitle, file.title])
    }
    // A linked page may have a different audience. Never copy the subject to
    // that broader page, and never change a user title (including legacy ones).
    const pages = (await client.query<{ id: string; name: string; source: ScopeSource | null }>(
      `SELECT id,name,read_entity_derivation_source(workspace_id,'page_event_changed',page_event_revision) AS source
       FROM saved_views WHERE workspace_id=$1 AND (linked_recording_id=$2 OR anchor_key=$3)
         AND name_origin IN ('placeholder','auto')`, [workspaceId, recordingId, `recording-synthesis:${recordingId}`])).rows
    for (const page of pages) {
      if (!sameScope(page.source, provenance)) continue
      await client.query(`UPDATE saved_views SET name=$3,name_origin='auto',updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND name=$4 AND name_origin IN ('placeholder','auto')`,
      [page.id, workspaceId, title, page.name])
    }
    return true
  })
  if (committed) notifyWorkspaceChange(workspaceId, 'file', 'update')
  return committed
}
