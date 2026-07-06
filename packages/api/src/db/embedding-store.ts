/**
 * `embedding-store.ts` — company-brain WU-8.3.
 *
 * Fulfils the `EmbeddingStore` interface from `@sidanclaw/core`
 * (`packages/core/src/embeddings/worker.ts`). The async embedding worker
 * calls `withClaimedRows(primitive, limit, handler)`; this store owns the
 * transaction, the `SELECT ... FOR UPDATE SKIP LOCKED` lease, the priority
 * ordering, and the commit / fail write-back.
 *
 * Lease model: transaction-scoped row locks. A single worker instance
 * (same single-instance assumption as the scheduled-jobs poll worker)
 * `BEGIN`s, claims rows with `FOR UPDATE SKIP LOCKED`, embeds them via the
 * Gemini batch API inside the open transaction, writes the vectors back,
 * then `COMMIT`s. No `locked_until` column is needed — the row locks are
 * held for the transaction's lifetime. `embeddings.md` references a
 * `locked_until` lease only for the multi-instance future; single-instance
 * v1 does not need it.
 *
 * System-level access: the worker embeds rows across every workspace and
 * user, so the transaction runs with `app.system_bypass = 'true'` (the
 * pool default) — RLS is bypassed exactly like other system workers.
 *
 * Primitive support: only the four primitives that carry a real
 * `embedding VECTOR(768)` column (`memories`, `entities`, `kb_chunks`,
 * `workspace_files`). `episodes` is in `EMBEDDED_PRIMITIVES` for the
 * worker registry but has no vector column — its summaries embed
 * indirectly via `kb_chunks` materialized by Pipeline B (see
 * `139_hnsw_indexes.sql`). Calling this store with `episodes` throws.
 *
 * Spec: `docs/architecture/brain/embeddings.md` §"What gets embedded",
 * §"Worker priority queue".
 *
 * [COMP:brain/embedding-store]
 */

import { createHash } from 'node:crypto'
import type {
  EmbeddingCandidate,
  EmbeddingFailure,
  EmbeddingPrimitive,
  EmbeddingResult,
  EmbeddingStore,
} from '@sidanclaw/core'
import { getPool } from './client.js'

type PrimitiveConfig = {
  table: string
  /**
   * SQL expression that assembles the embed text from the row's columns.
   * Per `embeddings.md` §"What gets embedded". All referenced columns are
   * either NOT NULL or coalesced, so the result is never empty.
   */
  textExpr: string
}

const PRIMITIVE_CONFIGS: Partial<Record<EmbeddingPrimitive, PrimitiveConfig>> = {
  // memory rows — `summary + detail` concatenated.
  memories: {
    table: 'memories',
    textExpr: "summary || coalesce(E'\\n' || detail, '')",
  },
  // entities — `display_name` only. The spec's `canonical_summary` was
  // never built as a column, and `entities` carries no alias/summary
  // surface text (see migration 125 + the `EntityRecord` type). The
  // display name is the row-level short text per embeddings.md.
  entities: {
    table: 'entities',
    textExpr: 'display_name',
  },
  // KB chunks — chunk content, optional section title for context.
  kb_chunks: {
    table: 'kb_chunks',
    textExpr: "coalesce(title || E'\\n', '') || chunk_text",
  },
  // workspace files — title (or name) + summary. Parsed-text chunking is a
  // follow-up; v1 embeds the row-level descriptor.
  workspace_files: {
    table: 'workspace_files',
    textExpr: "coalesce(title, name) || coalesce(E'\\n' || summary, '')",
  },
  // recording transcript segments — the packed segment text is the embed unit.
  // The store stamps embedding=NULL on insert; the worker drains these rows
  // exactly like kb_chunks. See docs/plans/recording-to-brain.md.
  transcript_segment: {
    table: 'transcript_segments',
    textExpr: 'segment_text',
  },
  // workspace-file text segments — heading breadcrumb prefixed into the embed
  // text (kb_chunks' title-prefix precedent) so "Report > Finance > Revenue"
  // context rides the vector. The artifact-level descriptor embedding on
  // workspace_files above still covers title-level matching; no cross-table
  // join here (the claim SQL is single-table by design).
  file_segment: {
    table: 'file_segments',
    textExpr:
      "(CASE WHEN heading_path <> '{}' THEN array_to_string(heading_path, ' > ') || E'\\n' ELSE '' END) || content",
  },
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

type ClaimedRow = { id: string; embed_text: string | null }

export function createDbEmbeddingStore(): EmbeddingStore {
  return {
    async withClaimedRows<T>(
      primitive: EmbeddingPrimitive,
      limit: number,
      handler: (
        rows: EmbeddingCandidate[],
        apply: {
          commit: (results: EmbeddingResult[]) => Promise<void>
          fail: (failures: EmbeddingFailure[]) => Promise<void>
        },
      ) => Promise<T>,
    ): Promise<T> {
      const config = PRIMITIVE_CONFIGS[primitive]
      if (!config) {
        throw new Error(
          `embedding-store: "${primitive}" has no embedding column — ` +
            `supported primitives: ${Object.keys(PRIMITIVE_CONFIGS).join(', ')}`,
        )
      }
      const { table, textExpr } = config

      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        // System worker — runs on the system pool (owner), which bypasses RLS,
        // for the cross-workspace drain.

        // Priority queue per embeddings.md §"Worker priority queue":
        // new writes (< 24h) first, then everything else, oldest-first
        // within each class. The content-hash-mismatch re-embed class is a
        // follow-up — it requires `embedding IS NOT NULL` rows and a
        // hash recheck pass; v1 drains only the never-embedded backlog.
        const claimed = await client.query<ClaimedRow>(
          `SELECT id, (${textExpr}) AS embed_text
             FROM ${table}
            WHERE embedding IS NULL
              AND embedding_failed_at IS NULL
            ORDER BY
              CASE WHEN created_at > now() - INTERVAL '24 hours' THEN 1 ELSE 3 END,
              created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [limit],
        )

        const rows: EmbeddingCandidate[] = claimed.rows.map((r) => {
          const text = (r.embed_text ?? '').trim()
          return { id: r.id, primitive, text, contentHash: sha256(text) }
        })

        const result = await handler(rows, {
          commit: async (results: EmbeddingResult[]) => {
            for (const res of results) {
              await client.query(
                `UPDATE ${table}
                    SET embedding                = $1::vector,
                        embedding_model_id       = $2,
                        content_hash             = $3,
                        embedding_updated_at     = now(),
                        embedding_failed_at      = NULL,
                        embedding_failure_reason = NULL
                  WHERE id = $4`,
                [
                  JSON.stringify(res.embedding),
                  res.embeddingModelId,
                  res.contentHash,
                  res.id,
                ],
              )
            }
          },
          fail: async (failures: EmbeddingFailure[]) => {
            for (const f of failures) {
              await client.query(
                `UPDATE ${table}
                    SET embedding_failed_at      = now(),
                        embedding_failure_reason = $1
                  WHERE id = $2`,
                [f.reason.slice(0, 1000), f.id],
              )
            }
          },
        })

        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}
