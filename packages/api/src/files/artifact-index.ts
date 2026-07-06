// [COMP:files/artifact-index] — chunk a stored artifact's parsed text into
// file_segments (large-content-artifacts §Phase 2.1).
//
// The one writer seam every trigger converges on: web /upload promotion and
// the explicit /api/files/ingest route call it synchronously (parse already
// in-request; keyword/range retrieval is live the moment it returns), and the
// file_ingest_jobs worker calls it idempotently (insert is ON CONFLICT DO
// NOTHING on (file_id, segment_index)).
//
// Inheritance rule (file-artifacts.md): segments copy the parent
// workspace_files row's visibility double / sensitivity / compartments /
// tags / source VERBATIM at chunk time, so the two can never disagree at
// birth. Later parent changes propagate via the workspace-files store's
// lifecycle hooks (meta patch / supersede / retract); delete relies on the
// FK CASCADE.

import { getPool } from '../db/client.js'
import { chunkFileText, insertFileSegments } from '../db/file-segments-store.js'

export type IndexFileArtifactResult = {
  /** Rows actually inserted this call (0 on an idempotent re-run). */
  segmentsInserted: number
  /** Total segments the text chunks into (independent of idempotent skips). */
  segmentCount: number
  /** True when MAX_SEGMENTS_PER_FILE stopped chunking before the tail. */
  truncated: boolean
}

type ParentRow = {
  user_id: string | null
  assistant_id: string | null
  sensitivity: string
  compartments: string[]
  tags: string[] | null
  source: string
}

/**
 * Merge an `indexing` status object into `workspace_files.metadata` (system
 * pool — background/status writes carry no per-user RLS context). Shape:
 * `{ status: 'pending'|'ready'|'failed', segments?, truncated?, indexedAt?, error? }`.
 */
export async function setFileIndexing(fileId: string, indexing: Record<string, unknown>): Promise<void> {
  await getPool().query(
    `UPDATE workspace_files
        SET metadata = metadata || jsonb_build_object('indexing', $2::jsonb)
      WHERE id = $1`,
    [fileId, JSON.stringify(indexing)],
  )
}

/**
 * Chunk `text` (the artifact's canonical parsed text) into file_segments,
 * inheriting the parent row verbatim, and stamp `metadata.indexing` ready.
 * Throws when the parent row is missing/closed (caller marks the job failed);
 * on throw AFTER partial insert the idempotent re-run completes the set.
 */
export async function indexFileArtifact(input: {
  fileId: string
  workspaceId: string
  text: string
  /** Attribution for created_by_user_id on the segment rows (acting user). */
  actingUserId: string
}): Promise<IndexFileArtifactResult> {
  const parent = await getPool().query<ParentRow>(
    `SELECT user_id, assistant_id, sensitivity, compartments, tags, source
       FROM workspace_files
      WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL`,
    [input.fileId, input.workspaceId],
  )
  if (parent.rows.length === 0) {
    throw new Error(`indexFileArtifact: workspace file ${input.fileId} not found (or closed) in ${input.workspaceId}`)
  }
  const p = parent.rows[0]

  const { segments, truncatedAtChar } = chunkFileText(input.text)
  const segmentsInserted = await insertFileSegments({
    fileId: input.fileId,
    workspaceId: input.workspaceId,
    createdByUserId: input.actingUserId,
    visibility: { userId: p.user_id, assistantId: p.assistant_id },
    sensitivity: p.sensitivity,
    compartments: p.compartments ?? [],
    tags: p.tags,
    source: p.source,
    segments,
  })

  const truncated = truncatedAtChar !== null
  await setFileIndexing(input.fileId, {
    status: 'ready',
    segments: segments.length,
    truncated,
    ...(truncated ? { truncatedAtChar } : {}),
    indexedAt: new Date().toISOString(),
  })
  return { segmentsInserted, segmentCount: segments.length, truncated }
}
