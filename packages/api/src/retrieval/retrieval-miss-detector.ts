/**
 * CL-9 retrieval-miss inline detector.
 *
 * At query time, compares the new query embedding to prior queries in
 * the same session. When `cosine ≥ 0.85` AND `top-K overlap < 50 %`,
 * logs a `retrieval_miss` row. Capped at N misses per session (default
 * 5) to bound storage.
 *
 * **Stateless per call** — session state lives in an in-memory `Map`
 * keyed by `session_id`. On worker restart the in-flight per-session
 * state is lost; the persisted miss rows survive. Acceptable for V1 —
 * the signal is the *aggregate* of misses across a week, not the
 * detection of any single miss.
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md` → "Retrieval-miss
 * as a signal (CL-9 lock)" → Within-session reformulation detection.
 *
 * Wired by the chat route via the search tool's
 * `onAfterSearch` hook in `packages/core/src/retrieval/tools.ts` (see
 * the search tool's `execute()`). The detector is constructed once at
 * API boot and shared across all turns.
 *
 * [COMP:retrieval/retrieval-miss-detector]
 */

import { createHash } from 'node:crypto'
import type { RetrievalMissStore } from '../db/retrieval-miss-store.js'

// ── Tunables ─────────────────────────────────────────────────────────

/** Cosine threshold above which two queries are considered semantic
 *  duplicates. Spec: 0.85. */
const DEFAULT_COSINE_THRESHOLD = 0.85

/** Top-K overlap percentage (0..1) below which we consider the second
 *  retrieval to have surfaced a meaningfully different result set. Spec:
 *  50 %. */
const DEFAULT_OVERLAP_THRESHOLD = 0.5

/** Per-session miss cap. Bounds DB writes for chatty / pathological
 *  sessions. Above the cap the detector still tracks in-memory state
 *  (so the next genuine miss isn't missed) but suppresses the DB write. */
const DEFAULT_MAX_MISSES_PER_SESSION = 5

/** Hash prefix length stored in `retrieval_miss.{prior,new}_query_hash`. */
const HASH_PREFIX_LEN = 16

// ── Types ────────────────────────────────────────────────────────────

export type RetrievalMissDetectorObserveInput = {
  sessionId: string
  workspaceId: string
  userId: string
  queryText: string
  resultIds: string[]
}

export type RetrievalMissDetector = {
  /**
   * Called once per retrieval call in a session. Returns void; the
   * detector logs misses to the store as a side-effect.
   *
   * The detector resolves the query embedding lazily via the injected
   * `getEmbedding` callback — only when a prior query exists. The
   * first call in a session is a no-op (no priors to compare against)
   * and skips the embedding lookup entirely.
   */
  observe(input: RetrievalMissDetectorObserveInput): Promise<void>

  /** Drop per-session in-memory state when a session ends. */
  forgetSession(sessionId: string): void

  /** Test helper — returns the number of priors tracked for a session. */
  _stateSize(sessionId: string): number
}

export type RetrievalMissDetectorOptions = {
  retrievalMissStore: RetrievalMissStore
  /** Async fetch of the 768-d embedding for a query string. The detector
   *  calls this only when a prior exists in the session. */
  getEmbedding: (text: string) => Promise<number[]>
  cosineThreshold?: number
  overlapThresholdPercent?: number
  maxMissesPerSession?: number
  /** Test seam — defaults to console.error. */
  onError?: (err: unknown, context: { sessionId: string }) => void
}

type PriorQuery = {
  queryText: string
  embedding: number[]
  resultIds: string[]
}

// ── Pure helpers (exported for tests) ────────────────────────────────

/**
 * Cosine similarity for two equal-length vectors. Returns 0 when either
 * vector is zero-length or norms are zero — the detector treats `0` as
 * "definitely not a match", which is the safe fail-closed default.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Top-K overlap percentage (0..1). Defined as the size of the
 * intersection over the size of the larger ID set so a partial result
 * (smaller K) does not artificially inflate the overlap. Empty
 * result sets on both sides count as full overlap (1.0) to avoid
 * spurious miss logging on result-less retrievals.
 */
export function topKOverlap(prior: string[], next: string[]): number {
  if (prior.length === 0 && next.length === 0) return 1
  const denom = Math.max(prior.length, next.length)
  if (denom === 0) return 1
  const set = new Set(prior)
  let hits = 0
  for (const id of next) {
    if (set.has(id)) hits += 1
  }
  return hits / denom
}

/**
 * SHA-256 hash of the query text, truncated to the first
 * `HASH_PREFIX_LEN` hex characters. Deterministic; matches the
 * `prior_query_hash` / `new_query_hash` columns the WS-A store
 * declares. The truncation is fine for the analytics use case — the
 * full text is also stored on the row, so the hash is a stable
 * dedupe key, not a security primitive.
 */
export function hashQueryText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_PREFIX_LEN)
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Build a detector. The returned instance owns an in-memory per-session
 * `Map`. Callers should invoke `forgetSession` when a session ends to
 * release memory, but the detector is also bounded by the per-session
 * cap so unreleased sessions cannot grow unbounded.
 */
export function createRetrievalMissDetector(
  opts: RetrievalMissDetectorOptions,
): RetrievalMissDetector {
  const cosineThreshold = opts.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD
  const overlapThreshold = opts.overlapThresholdPercent ?? DEFAULT_OVERLAP_THRESHOLD
  const maxMissesPerSession = opts.maxMissesPerSession ?? DEFAULT_MAX_MISSES_PER_SESSION
  const onError =
    opts.onError ??
    ((err, ctx) => {
      console.error(`[retrieval-miss-detector] session=${ctx.sessionId}`, err)
    })

  // Per-session prior queries. Keyed by sessionId, value is the ordered
  // list of priors observed this session. The detector never inserts
  // its own entries for the *first* call in a session — only subsequent
  // calls.
  const sessionState = new Map<string, PriorQuery[]>()

  return {
    async observe(input) {
      try {
        const priors = sessionState.get(input.sessionId)

        // First retrieval in this session — nothing to compare to.
        // Skip the embedding lookup and record the state for next time.
        if (!priors || priors.length === 0) {
          // We still need *some* embedding to compare against on the
          // next call. Pull it now so subsequent calls only pay one
          // embedding round-trip each.
          const embedding = await opts.getEmbedding(input.queryText)
          sessionState.set(input.sessionId, [
            { queryText: input.queryText, embedding, resultIds: input.resultIds },
          ])
          return
        }

        // Otherwise: fetch our embedding and compare against each prior.
        const newEmbedding = await opts.getEmbedding(input.queryText)

        // Find the *best* prior — the one with the highest cosine that
        // also satisfies the overlap-below-threshold condition. If
        // multiple priors qualify, we log against the strongest signal.
        let bestPrior: PriorQuery | null = null
        let bestCosine = 0
        let bestOverlap = 1
        for (const prior of priors) {
          const cos = cosineSimilarity(prior.embedding, newEmbedding)
          if (cos < cosineThreshold) continue
          const overlap = topKOverlap(prior.resultIds, input.resultIds)
          if (overlap >= overlapThreshold) continue
          // Candidate. Prefer the strongest cosine match.
          if (cos > bestCosine) {
            bestPrior = prior
            bestCosine = cos
            bestOverlap = overlap
          }
        }

        if (bestPrior) {
          // Cap check happens *after* qualification so the cap counts
          // only real misses, not noise. Going over the cap suppresses
          // the DB write but still updates in-memory state below.
          const recorded = await opts.retrievalMissStore.countForSession(input.sessionId)
          if (recorded < maxMissesPerSession) {
            await opts.retrievalMissStore.record({
              sessionId: input.sessionId,
              workspaceId: input.workspaceId,
              userId: input.userId,
              priorQueryText: bestPrior.queryText,
              newQueryText: input.queryText,
              priorQueryHash: hashQueryText(bestPrior.queryText),
              newQueryHash: hashQueryText(input.queryText),
              topKOverlap: bestOverlap,
              cosineSimilarity: bestCosine,
            })
          }
        }

        // Always append to in-memory state — even misses-over-cap are
        // tracked so future genuinely-novel reformulations can still
        // be compared against the full session history.
        priors.push({
          queryText: input.queryText,
          embedding: newEmbedding,
          resultIds: input.resultIds,
        })
      } catch (err) {
        // Fail-closed: a detector exception must never bubble into the
        // chat path. Log and move on.
        onError(err, { sessionId: input.sessionId })
      }
    },

    forgetSession(sessionId) {
      sessionState.delete(sessionId)
    },

    _stateSize(sessionId) {
      return sessionState.get(sessionId)?.length ?? 0
    },
  }
}
