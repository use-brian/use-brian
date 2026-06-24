/**
 * Async embedding worker (company-brain WU-8.3).
 *
 * Drains rows whose `embedding` column is NULL on each embedded primitive,
 * embeds them in batches via the injected `Embedder`, and writes the vector
 * back through the `EmbeddingStore`. Mirrors the lifecycle of
 * `createBatchWorker` in `../scheduling/poll-worker.ts` — same `running`
 * re-entry guard, same `start()`/`stop()`/`isRunning` contract — kept as a
 * sibling factory so the embedding queue stays independently startable.
 *
 * Lease semantics (`SELECT FOR UPDATE SKIP LOCKED` + `locked_until`) live
 * inside the store, not here. The worker is DB-agnostic and only orchestrates
 * batches; the store decides priority ordering (per
 * `docs/architecture/brain/embeddings.md` §"Worker priority queue"), lease
 * TTL, and per-row retry budget.
 *
 * Spec: `docs/architecture/brain/embeddings.md` §"When embeddings are
 * computed" + `workers.md` §"Per-worker tuning constants" (30s tick, 100
 * rows/batch, 5min lease — the timing constants in `workers.md` are the
 * store's concern; the worker exposes `intervalMs` + `batchLimit` knobs).
 */

import type { Embedder } from './embedder.js'

const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_BATCH_LIMIT = 100

/**
 * The set of primitives that carry embeddings per `embeddings.md` §"What
 * gets embedded". Kept narrow on purpose — `tasks`, `entity_links`, and
 * `workflows` are deliberately not embedded.
 *
 * The literal type is derived from the runtime tuple so admin surfaces
 * (embedding-health observability, drift detectors) can enumerate the set
 * without hardcoding a second copy. Never hardcode this list elsewhere.
 */
export const EMBEDDED_PRIMITIVES = [
  'memories',
  'entities',
  'kb_chunks',
  'workspace_files',
  'episodes',
  // Long-recording transcript segments (recording-to-brain). Carries a real
  // VECTOR(768) column; the worker drains it like kb_chunks via the
  // PRIMITIVE_CONFIGS entry in embedding-store.ts. See
  // docs/plans/recording-to-brain.md.
  'transcript_segment',
] as const

export type EmbeddingPrimitive = typeof EMBEDDED_PRIMITIVES[number]

/**
 * The primitives the worker actually DRAINS each tick (claim → embed → commit).
 * A strict subset of EMBEDDED_PRIMITIVES: `episodes` is in the registry for
 * enumeration / observability but has no `embedding` column of its own — its
 * summaries embed indirectly via `kb_chunks` materialized by Pipeline B. The
 * embedding store throws if asked to claim `episodes` rows (no vector column),
 * so the worker must skip it or it logs a drain failure every tick. Derived
 * from EMBEDDED_PRIMITIVES (not a second hardcoded list) so a newly-embedded
 * primitive flows through automatically; non-drainable kinds are excluded here.
 */
export const DRAINABLE_PRIMITIVES: readonly EmbeddingPrimitive[] =
  EMBEDDED_PRIMITIVES.filter((p) => p !== 'episodes')

const DEFAULT_PRIMITIVES: readonly EmbeddingPrimitive[] = DRAINABLE_PRIMITIVES

/**
 * One row handed back from `withClaimedRows`. The store has already taken
 * the lease on this row's id; the worker's job is to embed `text` and
 * report success or failure for the row.
 */
export type EmbeddingCandidate = {
  id: string
  primitive: EmbeddingPrimitive
  /** Source text per `embeddings.md` §"What gets embedded". */
  text: string
  /** sha256 of `text`; passed through to commit so the store can persist it. */
  contentHash: string
}

export type EmbeddingResult = {
  id: string
  embedding: number[]
  embeddingModelId: string
  contentHash: string
}

export type EmbeddingFailure = {
  id: string
  reason: string
}

/**
 * Store seam for the embedding worker. The `SELECT FOR UPDATE SKIP LOCKED`
 * + lease UPDATE + the per-row commit/fail UPDATE all share a transaction.
 * Exposing them separately would force callers to receive a tx handle.
 * The callback shape keeps the worker DB-agnostic — same separation as
 * `BatchStore.withClaimedBatches` in `../scheduling/types.ts`.
 *
 * Implementations open a transaction, claim up to `limit` rows from the
 * named primitive (`embedding IS NULL AND embedding_failed_at IS NULL` with
 * the priority ORDER BY from `embeddings.md`), invoke `handler`, then
 * COMMIT (or ROLLBACK on throw).
 */
export type EmbeddingStore = {
  withClaimedRows: <T>(
    primitive: EmbeddingPrimitive,
    limit: number,
    handler: (
      rows: EmbeddingCandidate[],
      apply: {
        commit: (results: EmbeddingResult[]) => Promise<void>
        fail: (failures: EmbeddingFailure[]) => Promise<void>
      },
    ) => Promise<T>,
  ) => Promise<T>
}

export type EmbeddingWorkerOptions = {
  store: EmbeddingStore
  embedder: Embedder
  /** Primitives drained each tick. Defaults to the full WS-8 embedded set. */
  primitives?: readonly EmbeddingPrimitive[]
  intervalMs?: number
  batchLimit?: number
}

export function createEmbeddingWorker(options: EmbeddingWorkerOptions) {
  const {
    store,
    embedder,
    primitives = DEFAULT_PRIMITIVES,
    intervalMs = DEFAULT_TICK_INTERVAL_MS,
    batchLimit = DEFAULT_BATCH_LIMIT,
  } = options
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function drainPrimitive(primitive: EmbeddingPrimitive) {
    try {
      await store.withClaimedRows(primitive, batchLimit, async (rows, apply) => {
        if (rows.length === 0) return
        const texts = rows.map((r) => r.text)
        let vectors: number[][]
        try {
          vectors = await embedder.embed(texts)
        } catch (err) {
          // Whole-batch failure: Gemini's batch endpoint is all-or-nothing,
          // so a thrown error invalidates the entire batch. Per-row retry
          // budget + permanent-failure transition belong to the store
          // (per `workers.md` §"Lease expiry + recovery"); the worker just
          // reports.
          const reason = errMessage(err)
          await apply.fail(rows.map((r) => ({ id: r.id, reason })))
          console.error(`[embedding-worker] batch (${primitive}) failed:`, err)
          return
        }
        const results: EmbeddingResult[] = rows.map((r, i) => ({
          id: r.id,
          embedding: vectors[i],
          embeddingModelId: embedder.model_id,
          contentHash: r.contentHash,
        }))
        await apply.commit(results)
      })
    } catch (err) {
      // Store-side failure (claim error, commit/fail throw). Log loudly and
      // continue to the next primitive — the lease will expire and the
      // claimed rows return to the queue on the next tick.
      console.error(`[embedding-worker] ${primitive} drain failed:`, err)
    }
  }

  async function tick() {
    if (running) return
    running = true
    try {
      for (const primitive of primitives) {
        await drainPrimitive(primitive)
      }
    } catch (err) {
      console.error('[embedding-worker] tick error:', err)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      console.log(`[embedding-worker] started (interval: ${intervalMs}ms)`)
      timer = setInterval(tick, intervalMs)
      tick()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[embedding-worker] stopped')
      }
    },

    get isRunning() {
      return timer !== undefined
    },
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'unknown embedding error'
}
