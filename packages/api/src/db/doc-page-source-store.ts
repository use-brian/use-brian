/**
 * Doc page-as-source store — registers an ingested page's authored blocks as
 * retrievable `kb_chunks` rows (canvas-brain-distillation.md step 4, "Page as
 * retrievable source"). One row per authored block, keyed by `(page_id,
 * block_id)` so a re-ingest UPDATES in place and a removed block is pruned.
 *
 * `source = 'doc_page'`; `source_path = '<pageId>#<blockId>'` is the stable
 * page+block key (the `idx_kb_chunks_source_path` index covers the upsert
 * lookup). `content_hash` is the per-block hash so an unchanged block skips the
 * re-embed (the async embedding worker only drains `embedding IS NULL` rows;
 * setting `embedding = NULL` on a real content change re-queues it).
 *
 * The embedding itself is NOT computed here — `embedding-store.ts`'s worker
 * embeds `kb_chunks` rows with `embedding IS NULL` on its own cadence, exactly
 * like every other primitive. So this store does a plain content upsert.
 *
 * System-level: the doc-page ingest runner already resolved + authorised the
 * page owner (`created_by_user_id`), so writes use the bare `query()` (owner
 * role, RLS-bypass) like other ingest-side writers. `user_id` is set to the
 * page owner so the `kb_chunks_visibility_check` (user_id OR assistant_id) is
 * satisfied and RLS scopes reads to the owner's workspace.
 *
 * [COMP:api/doc-page-source-store]
 */

import { query } from './client.js'

export type DocPageSourceChunk = {
  pageId: string
  blockId: string
  sectionEpisodeId: string | null
  text: string
  contentHash: string
}

export type DocPageSourceUpsertInput = {
  pageId: string
  workspaceId: string
  /** The page owner — `kb_chunks.user_id` + `created_by_user_id`. */
  ownerUserId: string
  /** Page-level clearance mapped to a `kb_chunks.sensitivity` value. */
  sensitivity: string
  /** Trusted scope inherited from the page root. */
  compartments?: string[]
  projectIds?: string[]
  chunks: DocPageSourceChunk[]
}

export type DocPageSourceStore = {
  /**
   * Upsert the page's authored blocks as `doc_page` `kb_chunks` rows, and prune
   * any rows for this page whose block no longer survives the authored-layer
   * filter (a deleted / now-trivial block). One transaction.
   */
  upsertPageChunks(input: DocPageSourceUpsertInput): Promise<void>
}

/** The stable `(page, block)` key stored in `kb_chunks.source_path`. */
function sourcePath(pageId: string, blockId: string): string {
  return `${pageId}#${blockId}`
}

export function createDbDocPageSourceStore(): DocPageSourceStore {
  return {
    async upsertPageChunks(input) {
      const {
        pageId,
        workspaceId,
        ownerUserId,
        sensitivity,
        compartments = [],
        projectIds = [],
        chunks,
      } = input
      const keptPaths = chunks.map((c) => sourcePath(pageId, c.blockId))
      const pagePrefix = `${pageId}#%`

      // Upsert each chunk by its (page, block) source_path. On a content change
      // we reset `embedding = NULL` so the worker re-embeds; an unchanged
      // content_hash leaves the existing embedding intact (cheap re-ingest).
      for (const chunk of chunks) {
        await query(
          `INSERT INTO kb_chunks
             (chunk_text, source, source_path, source_episode_id, content_hash,
              title, sensitivity, workspace_id, user_id, created_by_user_id,
              compartments, project_ids)
           VALUES ($1, 'doc_page', $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)
           ON CONFLICT (source_path) WHERE source = 'doc_page'
           DO UPDATE SET
             chunk_text        = EXCLUDED.chunk_text,
             source_episode_id = EXCLUDED.source_episode_id,
             sensitivity       = EXCLUDED.sensitivity,
             compartments      = ARRAY(
               SELECT DISTINCT value
                 FROM unnest(COALESCE(kb_chunks.compartments, '{}') ||
                             COALESCE(EXCLUDED.compartments, '{}')) AS u(value)
                ORDER BY value
             ),
             project_ids       = ARRAY(
               SELECT DISTINCT value
                 FROM unnest(COALESCE(kb_chunks.project_ids, '{}') ||
                             COALESCE(EXCLUDED.project_ids, '{}')) AS u(value)
                ORDER BY value
             ),
             updated_at        = now(),
             embedding         = CASE
               WHEN kb_chunks.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                 THEN NULL ELSE kb_chunks.embedding END,
             embedding_failed_at = CASE
               WHEN kb_chunks.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                 THEN NULL ELSE kb_chunks.embedding_failed_at END,
             content_hash      = EXCLUDED.content_hash`,
          [
            chunk.text,
            sourcePath(pageId, chunk.blockId),
            chunk.sectionEpisodeId,
            chunk.contentHash,
            // A short title aids retrieval ranking (embedding worker prefixes it).
            `doc page block`,
            sensitivity,
            workspaceId,
            ownerUserId,
            compartments,
            projectIds,
          ],
        )
      }

      // Prune rows for this page whose block no longer survives (deleted /
      // now-trivial). `keptPaths` may be empty (a page emptied of prose) — the
      // `<> ALL ('{}')` form keeps the predicate valid and prunes everything.
      await query(
        `DELETE FROM kb_chunks
          WHERE source = 'doc_page'
            AND source_path LIKE $1
            AND NOT (source_path = ANY($2::text[]))`,
        [pagePrefix, keptPaths],
      )
    },
  }
}
