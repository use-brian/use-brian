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
 * The ingest runner resolves the page owner. An owner-role transaction locks
 * the page and rechecks its version, owner and scope before publishing chunks
 * and the ingest stamp together. Each chunk carries the page owner's user ID.
 *
 * [COMP:api/doc-page-source-store]
 */

import { commitTransaction, getPool, rollbackAndRelease } from './client.js'

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
  version: number
  collaborative: boolean
  contentHash: string
  teamspaceId: string | null
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

export function createDbDocPageSourceStore(): DocPageSourceStore {
  return {
    async upsertPageChunks(input) {
      const { pageId, workspaceId, chunks, compartments = [], projectIds = [] } = input
      // Historical snapshots can contain a repeated block ID. Sequential upserts
      // used its last value; PostgreSQL cannot update one conflict key twice.
      const byBlock = new Map(chunks.map(chunk => [chunk.blockId, chunk]))
      const rows = Array.from(byBlock.values(), chunk => ({
        path: `${pageId}#${chunk.blockId}`,
        body: chunk.text,
        episode: chunk.sectionEpisodeId,
        hash: chunk.contentHash,
      }))

      const client = await getPool().connect()
      let committed = false
      try {
        await client.query('BEGIN')
        // Serialize publishers before opening the statement snapshot that checks
        // the version. A waiter must see the previous publisher's committed rows.
        await client.query('SELECT id FROM saved_views WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [pageId, workspaceId])
        const stamped = await client.query(
          `UPDATE saved_views sv SET brain_last_ingest_hash=$3, brain_last_ingest_at=now()
            WHERE sv.id=$1 AND sv.workspace_id=$2 AND sv.created_by=$4
              AND sv.clearance=$5 AND sv.teamspace_id IS NOT DISTINCT FROM $6::uuid
              AND sv.project_id IS NOT DISTINCT FROM ($7::uuid[])[1]
              AND ARRAY(SELECT g.compartment_key FROM teamspaces t JOIN workspace_groups g
                         ON g.id=t.workspace_group_id AND g.workspace_id=t.workspace_id
                         WHERE t.id=sv.teamspace_id AND t.workspace_id=sv.workspace_id)=$8::text[]
              AND CASE WHEN $9::boolean
                THEN EXISTS (SELECT 1 FROM documents d WHERE d.page_id=sv.id AND d.seq=$10)
                ELSE sv.version=$10 AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.page_id=sv.id)
              END`,
          [pageId, workspaceId, input.contentHash, input.ownerUserId, input.sensitivity,
            input.teamspaceId, projectIds, compartments, input.collaborative, input.version],
        )
        if (!stamped.rowCount) throw new Error('page_source_changed')

        await client.query(
          `INSERT INTO kb_chunks AS existing
             (chunk_text,source,source_path,source_episode_id,content_hash,title,
              sensitivity,workspace_id,user_id,created_by_user_id,compartments,project_ids)
           SELECT r.body,'doc_page',r.path,r.episode,r.hash,'doc page block',
                  $2,$3,$4,$4,$5::text[],$6::uuid[]
             FROM jsonb_to_recordset($1::jsonb) AS r(body text,path text,episode uuid,hash text)
           ON CONFLICT (source_path) WHERE source='doc_page' DO UPDATE SET
             chunk_text=EXCLUDED.chunk_text, source_episode_id=EXCLUDED.source_episode_id,
             content_hash=EXCLUDED.content_hash, sensitivity=EXCLUDED.sensitivity, updated_at=now(),
             compartments=ARRAY(SELECT DISTINCT value FROM unnest(existing.compartments || EXCLUDED.compartments) value ORDER BY value),
             project_ids=ARRAY(SELECT DISTINCT value FROM unnest(existing.project_ids || EXCLUDED.project_ids) value ORDER BY value),
             embedding=CASE WHEN existing.content_hash IS NOT DISTINCT FROM EXCLUDED.content_hash THEN existing.embedding END,
             embedding_failed_at=CASE WHEN existing.content_hash IS NOT DISTINCT FROM EXCLUDED.content_hash THEN existing.embedding_failed_at END
           WHERE existing.workspace_id=EXCLUDED.workspace_id AND (
             (existing.chunk_text,existing.source_episode_id,existing.content_hash,existing.sensitivity)
               IS DISTINCT FROM (EXCLUDED.chunk_text,EXCLUDED.source_episode_id,EXCLUDED.content_hash,EXCLUDED.sensitivity)
             OR NOT EXCLUDED.compartments <@ COALESCE(existing.compartments,'{}')
             OR NOT EXCLUDED.project_ids <@ COALESCE(existing.project_ids,'{}'))`,
          [JSON.stringify(rows), input.sensitivity, workspaceId, input.ownerUserId, compartments, projectIds],
        )
        await client.query(
          `DELETE FROM kb_chunks WHERE workspace_id=$1 AND source='doc_page'
              AND source_path LIKE $2 AND NOT (source_path=ANY($3::text[]))`,
          [workspaceId, `${pageId}#%`, rows.map(row => row.path)],
        )
        await commitTransaction(client)
        committed = true
      } finally {
        if (committed) client.release()
        else await rollbackAndRelease(client)
      }
    },
  }
}
