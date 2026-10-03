import * as Y from 'yjs'
import { collectArtifactText, yDocToSnapshot, type OfficeArtifactSnapshot } from '@use-brian/office-model'
import { query } from '../db/client.js'

type ProjectionRow = {
  id: string; generation: string; owner: string; version: string | null;
  ydoc: Buffer | null; revision: string; family: string; mode: string
}
export type OfficeSearchSnapshotReader = (userId: string, artifactId: string, versionId: string) => Promise<OfficeArtifactSnapshot | null>

/** Shared signature used by the writer and the authorized reader. */
export const OFFICE_SEARCH_REVISION = "coalesce(a.head_version_id::text,'') || ':' || coalesce(d.canonical_hash,'')"

/**
 * System projection only: reads canonical persisted snapshots, never answers a
 * user query. Search rejoins the current artifact and all source read policies.
 * A concurrent write leaves the queue generation in place for the next tick.
 */
export async function projectOfficeSearchBatch(readVersion: OfficeSearchSnapshotReader, limit = 20): Promise<number> {
  const rows = (await query<ProjectionRow>(`SELECT a.id,q.generation::text AS generation,
      coalesce(a.owner_user_id,a.creator_user_id) AS owner,a.head_version_id AS version,
      d.ydoc,${OFFICE_SEARCH_REVISION} AS revision,a.family,a.mode
    FROM workspace_search_office_queue q JOIN office_artifacts a ON a.id=q.artifact_id
    LEFT JOIN office_collab_documents d ON d.artifact_id=a.id
    ORDER BY q.queued_at,q.artifact_id LIMIT $1`, [Math.min(Math.max(limit,1),100)])).rows
  let projected = 0
  for (const row of rows) {
    try {
      let snapshot: OfficeArtifactSnapshot | null = null
      if (row.mode === 'artifact' && row.family !== 'pdf') {
        if (row.ydoc) {
          const doc = new Y.Doc()
          try { Y.applyUpdate(doc,row.ydoc); snapshot=yDocToSnapshot(doc) }
          finally { doc.destroy() }
        } else if (row.version) snapshot = await readVersion(row.owner,row.id,row.version)
        if (row.version && !snapshot) continue
        if (snapshot && snapshot.artifactId !== row.id) throw new Error('Office projection identity mismatch')
      }
      const body = snapshot ? collectArtifactText(snapshot).map(fragment => fragment.text).join('\n') : ''
      const result = await query(`WITH current AS (
          SELECT a.id FROM office_artifacts a LEFT JOIN office_collab_documents d ON d.artifact_id=a.id
          JOIN workspace_search_office_queue q ON q.artifact_id=a.id
          WHERE a.id=$1 AND q.generation=$2 AND (${OFFICE_SEARCH_REVISION})=$3
        ), projected AS (
          INSERT INTO workspace_search_office_text(artifact_id,revision,body)
          SELECT id,$3,$4 FROM current ON CONFLICT(artifact_id) DO UPDATE
          SET revision=EXCLUDED.revision,body=EXCLUDED.body,projected_at=now() RETURNING artifact_id
        ) DELETE FROM workspace_search_office_queue q USING projected p
          WHERE q.artifact_id=p.artifact_id AND q.generation=$2 RETURNING q.artifact_id`,
        [row.id,row.generation,row.revision,body])
      projected += result.rowCount ?? 0
    } catch {
      // No document text or query in diagnostic output. Keep work retryable,
      // moving a malformed artifact behind other queued work to avoid starvation.
      await query('UPDATE workspace_search_office_queue SET queued_at=now() WHERE artifact_id=$1 AND generation=$2', [row.id,row.generation])
    }
  }
  return projected
}

export function createOfficeSearchProjector(readVersion: OfficeSearchSnapshotReader) {
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<unknown> | undefined
  const tick = () => {
    if (!pending) pending = projectOfficeSearchBatch(readVersion).catch(() => {
      console.warn('[workspace-search] Office projection unavailable')
    }).finally(() => { pending=undefined })
  }
  return {
    start() { if (!timer) { tick(); timer=setInterval(tick,5000); timer.unref() } },
    async stop() { clearInterval(timer); timer=undefined; await pending },
  }
}
