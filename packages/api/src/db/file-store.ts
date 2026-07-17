import type { AccessContext, FileStore } from '@use-brian/core'
import { query } from './client.js'
import { buildAccessPredicate } from './access-predicate.js'

const SELECT = `id, session_id as "sessionId", file_name as "fileName", mime_type as "mimeType", content, summary, size_bytes as "sizeBytes", artifact_file_id as "artifactFileId", artifact_segment_count as "artifactSegmentCount"`

type Row = { id: string; sessionId: string; fileName: string; mimeType: string; content: string; summary: string | null; sizeBytes: number; artifactFileId: string | null; artifactSegmentCount: number | null }

export function createDbFileStore(): FileStore {
  return {
    async cache(params) {
      const expiryDays = params.expiryDays ?? 7
      const result = await query<Row>(
        `INSERT INTO file_cache
           (session_id, file_name, mime_type, content, summary, size_bytes, expires_at,
            workspace_id, user_id, assistant_id, sensitivity)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7),
                 $8, $9, $10, COALESCE($11, 'internal'))
         RETURNING ${SELECT}`,
        [
          params.sessionId, params.fileName, params.mimeType, params.content,
          params.summary ?? null, params.sizeBytes, expiryDays,
          params.workspaceId ?? null, params.userId ?? null, params.assistantId ?? null,
          params.sensitivity ?? null,
        ],
      )
      return result.rows[0]
    },

    // 2026-06-02 audit #3: with `ctx`, gate the read through the universal
    // access predicate (workspace + visibility double + sensitivity ceiling),
    // exactly like memories/tasks/workspace_files — a file from another
    // workspace or above the viewer's clearance is never returned. Without
    // `ctx` it's the unscoped legacy read, reserved for the `/preview` route
    // until that moves to signed capability URLs (#3 part 2).
    async get(id, ctx?: AccessContext) {
      if (ctx) {
        const ap = buildAccessPredicate(ctx, { startIdx: 1 })
        const result = await query<Row>(
          `SELECT ${SELECT} FROM file_cache
           WHERE ${ap.sql} AND id = $${ap.nextIdx} AND expires_at > now()`,
          [...ap.params, id],
        )
        return result.rows[0] ?? null
      }
      const result = await query<Row>(
        `SELECT ${SELECT} FROM file_cache WHERE id = $1 AND expires_at > now()`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async getBySession(sessionId, ctx?: AccessContext) {
      if (ctx) {
        const ap = buildAccessPredicate(ctx, { startIdx: 1 })
        const result = await query<Row>(
          `SELECT ${SELECT} FROM file_cache
           WHERE ${ap.sql} AND session_id = $${ap.nextIdx} AND expires_at > now()
           ORDER BY created_at DESC`,
          [...ap.params, sessionId],
        )
        return result.rows
      }
      const result = await query<Row>(
        `SELECT ${SELECT} FROM file_cache WHERE session_id = $1 AND expires_at > now()
         ORDER BY created_at DESC`,
        [sessionId],
      )
      return result.rows
    },

    // Reads already filter `expires_at > now()`, so expired rows are invisible
    // the moment they lapse — this reclaims their storage. Called on a jittered
    // interval from open boot (`runWorkers`-gated). Returns rows deleted.
    async sweepExpired() {
      const result = await query(`DELETE FROM file_cache WHERE expires_at <= now()`)
      return result.rowCount ?? 0
    },

    // Stamp the durable-artifact link after silent promotion (migration 299).
    async linkArtifact(id, artifactFileId, segmentCount) {
      await query(
        `UPDATE file_cache SET artifact_file_id = $2, artifact_segment_count = $3 WHERE id = $1`,
        [id, artifactFileId, segmentCount],
      )
    },
  }
}
