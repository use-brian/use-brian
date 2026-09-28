import type { AccessContext, FileStore } from '@use-brian/core'
import { query, queryWithRLS } from './client.js'
import { buildAccessPredicate } from './access-predicate.js'

const SELECT = `id, session_id as "sessionId", file_name as "fileName", mime_type as "mimeType", content, summary, size_bytes as "sizeBytes", artifact_file_id as "artifactFileId", artifact_segment_count as "artifactSegmentCount", sensitivity, compartments, project_ids as "projectIds"`

type Row = { id: string; sessionId: string; fileName: string; mimeType: string; content: string; summary: string | null; sizeBytes: number; artifactFileId: string | null; artifactSegmentCount: number | null; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }

export function createDbFileStore(): FileStore {
  return {
    async cache(params) {
      const expiryDays = params.expiryDays ?? 7
      const result = await query<Row>(
        `INSERT INTO file_cache
           (session_id, file_name, mime_type, content, summary, size_bytes, expires_at,
            workspace_id, user_id, assistant_id, sensitivity, compartments, project_ids,
            original_content)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7),
                 $8, $9, $10, COALESCE($11, 'internal'), $12::text[], $13::uuid[], $14)
         RETURNING ${SELECT}`,
        [
          params.sessionId, params.fileName, params.mimeType, params.content,
          params.summary ?? null, params.sizeBytes, expiryDays,
          params.workspaceId ?? null, params.userId ?? null, params.assistantId ?? null,
          params.sensitivity ?? null,
          params.compartments ?? [], params.projectIds ?? [],
          params.originalContent ?? null,
        ],
      )
      return result.rows[0]
    },

    // Caller-scoped reads use the universal access predicate. The unscoped
    // overload is trusted-internal only; authenticated previews use the
    // app-role current-source projection below.
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

    // Original bytes (data URL) kept beside the parsed text for structured
    // documents (migration 487). Cold path — deliberately NOT in the default
    // SELECT so chat turns never haul the multi-MB payload; the PDF-preview
    // route is the intended caller. Same access predicate as `get`.
    async getOriginalContent(id, ctx?: AccessContext) {
      if (ctx) {
        const ap = buildAccessPredicate(ctx, { startIdx: 1 })
        const result = await query<{ originalContent: string | null }>(
          `SELECT original_content as "originalContent" FROM file_cache
           WHERE ${ap.sql} AND id = $${ap.nextIdx} AND expires_at > now()`,
          [...ap.params, id],
        )
        return result.rows[0]?.originalContent ?? null
      }
      const result = await query<{ originalContent: string | null }>(
        `SELECT original_content as "originalContent" FROM file_cache WHERE id = $1 AND expires_at > now()`,
        [id],
      )
      return result.rows[0]?.originalContent ?? null
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


// [COMP:api/file-cache-preview]
// Preview bytes are read together, including original structured-document bytes.
// The row's MVCC revision is rechecked after conversion before any delivery.
export type FileCachePreviewProjection = {
  file: Row
  originalContent: string | null
  revision: string
  validForMs: number
}

export async function getFileCachePreviewProjection(ctx: AccessContext, id: string): Promise<FileCachePreviewProjection | null> {
  const ap = buildAccessPredicate(ctx)
  const result = await queryWithRLS<Row & {originalContent: string | null; revision: string; validForMs: number}>(ctx.userId,
    `SELECT ${SELECT}, original_content AS "originalContent", xmin::text AS revision,
       least(department_media_valid_for_ms(workspace_id),
         greatest(0,floor(extract(epoch FROM (expires_at-clock_timestamp()))*1000)))::integer AS "validForMs"
     FROM file_cache WHERE ${ap.sql} AND id=$${ap.nextIdx}
       AND workspace_id=$${ap.nextIdx+1} AND expires_at>now() AND NOT scope_held`,
    [...ap.params,id,ctx.workspaceId])
  const row = result.rows[0]
  if (!row) return null
  const {originalContent,revision,validForMs,...file} = row
  return {file,originalContent,revision,validForMs}
}
