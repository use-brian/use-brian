/**
 * `embedding-store.ts` — company-brain WU-8.3.
 *
 * Fulfils the `EmbeddingStore` interface from `@use-brian/core`
 * (`packages/core/src/embeddings/worker.ts`). The async embedding worker
 * calls `withClaimedRows(primitive, limit, handler)`; this store owns the
 * transaction, the `SELECT ... FOR UPDATE SKIP LOCKED` lease, the priority
 * ordering, and the commit / fail write-back.
 *
 * Lease model: **claim → commit → embed → write** (B2 —
 * docs/plans/corpus-substrate-hardening.md §4). Three phases, and the
 * embedder call happens in the gap between them with NO pooled connection
 * held:
 *
 *   1. Short transaction — `SELECT … FOR UPDATE SKIP LOCKED`, take the ids,
 *      `COMMIT`, release.
 *   2. `handler(rows, …)` — the embedder HTTP call. No connection held.
 *   3. Short transaction per write-back — the vectors, or the failures, as ONE
 *      `UPDATE … FROM (VALUES …)` rather than a row-at-a-time loop (B4). Up to
 *      100 round trips collapse into one, shortening exactly the transactions
 *      that pin a connection. Every id is bound as text and cast once
 *      (`v.id::uuid`) so the join still rides the primary key — casting the
 *      table side instead would seq-scan a 5.6 GB table.
 *
 * B4 deliberately lands AFTER B2 and B3: a faster drain against a lane that is
 * not yet isolated is the 2026-07-29 outage on the next unpause.
 *
 * The claim's row lock therefore lasts only for phase 1, not for the whole
 * drain. That is the point: the previous shape ran the embedder INSIDE the
 * open transaction, so provider latency was denominated in database slots.
 * At a 30s tick against ~415k unembedded `email_archive_segments` rows that
 * is roughly 4,150 ticks of continuous connection-holding, and it is how
 * both the 2026-07-28 and 2026-07-29 outages pinned every Cloud SQL slot.
 *
 * Releasing the lease early is safe because `brian-api-workers` runs at
 * `maxScale = 1` and the worker's tick guard (`if (running) return`)
 * serializes a primitive's drains — the two facts that make this
 * concurrency-safe without a lease column (D4). `FOR UPDATE SKIP LOCKED`
 * still earns its keep inside phase 1: it keeps two simultaneous claims from
 * taking the same ids. A crashed tick's rows simply return to the
 * `embedding IS NULL` queue, which is correct rather than a leak.
 *
 * **Going horizontal on workers requires a real lease column first**
 * (`embedding_leased_until`, one migration across the seven drainable
 * tables) — see deployment.md → "Scale runbook" item 4. Not now: it buys
 * nothing at `maxScale = 1` and costs a migration on a 5.6 GB table.
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
import type pg from 'pg'
import type {
  EmbeddingCandidate,
  EmbeddingFailure,
  EmbeddingPrimitive,
  EmbeddingResult,
  EmbeddingStore,
} from '@use-brian/core'
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
  // exactly like kb_chunks. See docs/architecture/media/transcription.md.
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
  // email archive segments — the mailbox corpus (mailbox-imap.md). Subject +
  // sender context is baked into segment 0's text at insert time (the store
  // prefixes the header line), so the single-table claim SQL stays flat.
  email_segment: {
    table: 'email_archive_segments',
    textExpr: 'segment_text',
  },
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

type ClaimedRow = {
  id: string
  embed_text: string | null
  workspace_id: string | null
  user_id: string | null
}

/**
 * Run `fn` inside a transaction on a freshly checked-out system-pool client,
 * and give the connection back before returning. Every phase of the drain that
 * touches the database goes through this, so no caller can accidentally hold a
 * pooled connection across an await that isn't SQL.
 *
 * The invariant this exists to make greppable: `handler` is never invoked from
 * inside one of these. Graded by `pnpm check` (`invariants/embed-claim-shape`).
 */
async function inShortTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

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

      // ── Phase 1: claim, commit, release ──────────────────────────
      // System worker — runs on the system pool (owner), which bypasses RLS,
      // for the cross-workspace drain.
      const claimedRows = await inShortTransaction(async (client) => {
        // Priority queue per embeddings.md §"Worker priority queue":
        // new writes (< 24h) first, then everything else, oldest-first
        // within each class. The content-hash-mismatch re-embed class is a
        // follow-up — it requires `embedding IS NOT NULL` rows and a
        // hash recheck pass; v1 drains only the never-embedded backlog.
        // `workspace_id` / `user_id` ride along for COGS attribution
        // (`overhead:embedding` — embeddings.md §"Cost model"). Every
        // embedded table carries both columns; user_id is NULL on
        // workspace-shared rows.
        //
        // Run as TWO bounded range scans rather than one CASE-ordered query.
        // The priority CASE contains now(), which is not IMMUTABLE and so
        // cannot be indexed — a single `ORDER BY CASE(...), created_at` can
        // therefore only ever plan as a full scan plus a sort of every
        // unembedded row, carrying the embed text, to take LIMIT rows off the
        // top. That planned fine at small table sizes and took down the API on
        // 2026-07-28: at 415k unembedded email_archive_segments rows (5.6 GB)
        // each claim ran 5-20 min, and because the claim holds this
        // transaction's connection for its whole duration, claims outlived the
        // 30s tick, stacked, and exhausted all 25 Cloud SQL slots. Splitting on
        // the 24h boundary is exactly equivalent — bucket 1 is `created_at >
        // cutoff` ordered created_at ASC, bucket 3 is the rest in the same
        // order — and both halves ride idx_<table>_embed_queue (migration 378)
        // as index scans bounded by LIMIT. Keep them separate statements:
        // UNION ALL is not allowed with FOR UPDATE.
        const claimSql = (bound: '>' | '<=') =>
          `SELECT id, (${textExpr}) AS embed_text, workspace_id, user_id
             FROM ${table}
            WHERE embedding IS NULL
              AND embedding_failed_at IS NULL
              AND created_at ${bound} now() - INTERVAL '24 hours'
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED`

        const recent = await client.query<ClaimedRow>(claimSql('>'), [limit])
        const claimed = [...recent.rows]
        // Only reach for the backlog when the priority class did not fill the
        // batch, so a busy write stream never pays for the second scan.
        if (claimed.length < limit) {
          const older = await client.query<ClaimedRow>(claimSql('<='), [
            limit - claimed.length,
          ])
          claimed.push(...older.rows)
        }
        return claimed
      })

      const rows: EmbeddingCandidate[] = claimedRows.map((r) => {
        const text = (r.embed_text ?? '').trim()
        return {
          id: r.id,
          primitive,
          text,
          contentHash: sha256(text),
          workspaceId: r.workspace_id,
          userId: r.user_id,
        }
      })

      // ── Phase 2: embed, holding NO connection ────────────────────
      // `handler` is the embedder HTTP call. It MUST NOT run inside a
      // transaction — that is the exact structural defect behind both
      // outages, and `pnpm check` grades it.
      return await handler(rows, {
        // ── Phase 3: write back, one short transaction each ─────────
        commit: async (results: EmbeddingResult[]) => {
          if (results.length === 0) return
          const values: unknown[] = []
          const tuples = results.map((res) => {
            values.push(
              res.id,
              JSON.stringify(res.embedding),
              res.embeddingModelId,
              res.contentHash,
            )
            const n = values.length
            return `($${n - 3}, $${n - 2}, $${n - 1}, $${n})`
          })
          await inShortTransaction(async (client) => {
            await client.query(
              `UPDATE ${table} AS t
                  SET embedding                = v.embedding::vector,
                      embedding_model_id       = v.model_id,
                      content_hash             = v.content_hash,
                      embedding_updated_at     = now(),
                      embedding_failed_at      = NULL,
                      embedding_failure_reason = NULL
                 FROM (VALUES ${tuples.join(', ')})
                      AS v(id, embedding, model_id, content_hash)
                WHERE t.id = v.id::uuid`,
              values,
            )
          })
        },
        fail: async (failures: EmbeddingFailure[]) => {
          if (failures.length === 0) return
          const values: unknown[] = []
          const tuples = failures.map((f) => {
            values.push(f.id, f.reason.slice(0, 1000))
            const n = values.length
            return `($${n - 1}, $${n})`
          })
          await inShortTransaction(async (client) => {
            await client.query(
              `UPDATE ${table} AS t
                  SET embedding_failed_at      = now(),
                      embedding_failure_reason = v.reason
                 FROM (VALUES ${tuples.join(', ')}) AS v(id, reason)
                WHERE t.id = v.id::uuid`,
              values,
            )
          })
        },
      })
    },
  }
}
