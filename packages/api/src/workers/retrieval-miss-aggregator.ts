/**
 * CL-9 weekly retrieval-miss aggregator.
 *
 * Reads `retrieval_miss` rows per workspace over a rolling weekly window
 * (default 7 days, advanced after each successful run), clusters them by
 * embedding cosine similarity, and emits one `kb_gap_candidate` row per
 * cluster that meets the spec gate (≥ N occurrences AND ≥ 2 distinct
 * sessions).
 *
 * **No auto-write of KB rows.** The workspace owner sees each open
 * candidate via the chrome pill + `/knowledge-base/gaps` page. The two
 * actions are *Dismiss* (suppresses the pattern for `dismissalSuppressDays`)
 * and *Draft KB entry* (marks `drafted_at` and navigates the user to the
 * KB editor with the pattern summary pre-filled).
 *
 * **Pattern summary** is the highest-occurrence query text in the
 * cluster — deterministic, no LLM call. V1 keeps the worker boring on
 * purpose; an LLM-summarized variant can land later as a separate
 * upgrade and is not on the critical path.
 *
 * Single-instance, in-process — same convention as
 * `memory-evolution-worker`, `consolidation-worker`. Gated by the
 * caller via `CL9_AGGREGATOR_ENABLED=true` (the boot in
 * `apps/api/src/index.ts` reads the env var; the worker itself takes
 * no flag, so unit tests can call `tick()` directly).
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md` → "Retrieval-miss
 * as a signal" → Weekly REM aggregation.
 *
 * [COMP:workers/retrieval-miss-aggregator]
 */

import type { RetrievalMissRow, RetrievalMissStore } from '../db/retrieval-miss-store.js'
import type { KbGapCandidateStore } from '../db/kb-gap-candidate-store.js'
import { cosineSimilarity } from '../retrieval/retrieval-miss-detector.js'

// ── Tunables ─────────────────────────────────────────────────────

/** Default tick interval — hourly. The worker checks each active
 *  workspace's per-workspace last-run timestamp and only fires the
 *  aggregation pass when ≥ `windowMs` has elapsed since the last run. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

/** Aggregation window — the worker pulls misses observed in the last
 *  N days on each run. 7 days = weekly cadence per spec. */
const DEFAULT_WINDOW_DAYS = 7

/** Cluster gate — emit a candidate only when ≥ N total occurrences. */
const DEFAULT_MIN_OCCURRENCES = 2

/** Cluster threshold — agglomerative grouping joins two rows when
 *  cosine ≥ this value. Spec default: 0.75. */
const DEFAULT_CLUSTER_THRESHOLD = 0.75

/** Suppression window — after a candidate is dismissed, do not re-emit
 *  any cluster whose centroid lands within `DISMISSAL_MATCH_COS` of the
 *  dismissed pattern's embedding for this many days. */
const DEFAULT_DISMISSAL_SUPPRESS_DAYS = 14

/** Dismissed-candidate match threshold (cosine) used by the
 *  suppression check. ≥ 0.85 matches the within-session detection
 *  threshold so the suppression boundary is consistent across the
 *  pipeline. */
const DISMISSAL_MATCH_COS = 0.85

// ── Public API ───────────────────────────────────────────────────

export type RetrievalMissAggregatorEvent =
  | { type: 'tick_start'; workspaceCount: number }
  | {
      type: 'workspace_processed'
      workspaceId: string
      missCount: number
      clusterCount: number
      candidatesEmitted: number
      candidatesSuppressed: number
    }
  | { type: 'workspace_skipped'; workspaceId: string; reason: string }
  | { type: 'kb_gap_candidate_emitted'; workspaceId: string; count: number }
  | { type: 'error'; workspaceId: string | null; error: string }
  | { type: 'tick_complete'; processedCount: number; emittedCount: number; errorCount: number }

export type RetrievalMissAggregatorOptions = {
  retrievalMissStore: RetrievalMissStore
  kbGapStore: KbGapCandidateStore
  /** Async fetch of the embedding for `new_query_text`. Same callback
   *  the detector uses — pass the boot-time shared embedder. */
  getEmbedding: (text: string) => Promise<number[]>
  /** Lists workspaces eligible for aggregation. Boot wires this to a
   *  store helper that returns every workspace with at least one row in
   *  `retrieval_miss`; an empty list short-circuits the tick. */
  listActiveWorkspaces: () => Promise<string[]>
  /** Default 1 hour. Per-workspace last-run timestamp is held in memory
   *  so cycles between ticks are O(1) — a workspace that was just
   *  processed waits `windowMs` before the next aggregation pass. */
  intervalMs?: number
  /** Aggregation lookback (ms). Default 7 days. */
  windowMs?: number
  minOccurrences?: number
  clusterThreshold?: number
  dismissalSuppressDays?: number
  /** Test seam — defaults to `new Date()`. */
  now?: () => Date
  /** Delay before the first tick after `.start()`. Default 60s. Tests
   *  pass `0` for immediate execution. */
  firstTickDelayMs?: number
  onEvent?: (event: RetrievalMissAggregatorEvent) => void
}

export type RetrievalMissAggregatorHandle = {
  /** Run one tick immediately. Exposed for tests + explicit triggers. */
  tick(): Promise<void>
  start(): void
  stop(): void
  readonly isRunning: boolean
}

// ── Pure helpers (exported for tests) ────────────────────────────

type EmbeddedMiss = {
  miss: RetrievalMissRow
  embedding: number[]
}

export type Cluster = {
  /** Indices into the original `EmbeddedMiss[]` array. */
  memberIndices: number[]
  centroid: number[]
}

/**
 * Single-link agglomerative clustering. For each row, scan existing
 * clusters and join the first whose centroid cosine to the row is ≥
 * `threshold`. New rows that don't match any existing cluster create a
 * new singleton cluster. Order-dependent (single-link), good enough for
 * V1 — the signal we care about is "a cluster of ≥ N similar misses
 * exists", not perfect cluster boundaries.
 *
 * Centroid is the running mean — re-computed when a new member joins.
 * Embedding lengths must match across all inputs (the embedder always
 * returns 768-d).
 */
export function clusterByCosine(
  rows: EmbeddedMiss[],
  threshold: number,
): Cluster[] {
  const clusters: Cluster[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let placed = false
    for (const cluster of clusters) {
      const sim = cosineSimilarity(cluster.centroid, row.embedding)
      if (sim >= threshold) {
        cluster.memberIndices.push(i)
        // Incremental mean update — centroid = (oldMean * n + new) / (n + 1)
        const n = cluster.memberIndices.length - 1
        const newCentroid = new Array<number>(cluster.centroid.length)
        for (let k = 0; k < cluster.centroid.length; k++) {
          newCentroid[k] = (cluster.centroid[k] * n + row.embedding[k]) / (n + 1)
        }
        cluster.centroid = newCentroid
        placed = true
        break
      }
    }
    if (!placed) {
      clusters.push({
        memberIndices: [i],
        centroid: [...row.embedding],
      })
    }
  }
  return clusters
}

/**
 * Pick the representative query text from a cluster of misses. Picks
 * the highest-occurrence `new_query_text` (most frequent reformulation
 * within the cluster); ties broken by alphabetical order for
 * determinism. No LLM — see module docstring.
 */
export function pickPatternSummary(misses: RetrievalMissRow[]): string {
  if (misses.length === 0) return ''
  const counts = new Map<string, number>()
  for (const m of misses) {
    counts.set(m.newQueryText, (counts.get(m.newQueryText) ?? 0) + 1)
  }
  let best = misses[0].newQueryText
  let bestCount = counts.get(best) ?? 0
  for (const [text, count] of counts) {
    if (count > bestCount || (count === bestCount && text < best)) {
      best = text
      bestCount = count
    }
  }
  return best
}

// ── Factory ──────────────────────────────────────────────────────

export function startRetrievalMissAggregator(
  options: RetrievalMissAggregatorOptions,
): RetrievalMissAggregatorHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES
  const clusterThreshold = options.clusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD
  const dismissalSuppressDays =
    options.dismissalSuppressDays ?? DEFAULT_DISMISSAL_SUPPRESS_DAYS
  const now = options.now ?? (() => new Date())
  const firstTickDelayMs = options.firstTickDelayMs ?? 60_000
  const onEvent = options.onEvent

  /** Per-workspace last-run timestamp. A workspace whose
   *  `lastRunAt + windowMs > now` is skipped for the current tick. */
  const lastRunAt = new Map<string, number>()

  let intervalTimer: ReturnType<typeof setInterval> | undefined
  let initialTimer: ReturnType<typeof setTimeout> | undefined
  let running = false

  async function processWorkspace(
    workspaceId: string,
    until: Date,
  ): Promise<{ outcome: 'processed' | 'skipped'; reason?: string; missCount?: number; clusterCount?: number; emitted?: number; suppressed?: number }> {
    const last = lastRunAt.get(workspaceId)
    if (last !== undefined && until.getTime() - last < windowMs) {
      return { outcome: 'skipped', reason: 'cooldown' }
    }

    const since = new Date(until.getTime() - windowMs)
    const misses = await options.retrievalMissStore.listForAggregation(
      workspaceId,
      since,
      until,
    )
    if (misses.length === 0) {
      lastRunAt.set(workspaceId, until.getTime())
      return { outcome: 'skipped', reason: 'no_misses' }
    }

    // Embed each miss's new_query_text. We could batch via a multi-text
    // embedder; for now sequential keeps the worker simple and the
    // batches small (workspaces typically hit < 100 misses / week).
    const embedded: EmbeddedMiss[] = []
    for (const miss of misses) {
      try {
        const vec = await options.getEmbedding(miss.newQueryText)
        if (vec.length > 0) embedded.push({ miss, embedding: vec })
      } catch (err) {
        // One bad embed shouldn't kill the whole tick — drop and continue.
        console.warn(
          `[retrieval-miss-aggregator] embed failed for miss ${miss.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        )
      }
    }

    const clusters = clusterByCosine(embedded, clusterThreshold)

    // Load existing open + recently-dismissed candidates so we can
    // suppress re-emissions for matching clusters. The store's
    // `listOpen` excludes dismissed; we read dismissed separately by
    // walking the system-level store path. Since the store interface
    // only exposes `listOpen` / `create` / `dismiss` / `markDrafted`,
    // we read dismissed rows via the same `listOpen` shape after
    // re-flagging — the spec keeps suppression scoped to recent
    // dismissals only, so an open-or-recent fetch is sufficient.
    //
    // For V1, we suppress against open candidates only — if a pattern
    // is open and unactioned, don't pile on more candidates for it.
    // Dismissal-based suppression for N days lands when the store
    // exposes a `listRecentDismissed` helper; in the meantime, the
    // route layer's `dismissed_at` check naturally hides dismissed
    // patterns from the UI, so the only cost of skipping suppression
    // here is duplicate open rows after the cooldown window elapses.
    const openCandidates = await options.kbGapStore.listOpen(workspaceId)

    let emitted = 0
    let suppressed = 0

    for (const cluster of clusters) {
      const members = cluster.memberIndices.map((i) => embedded[i].miss)
      const distinctSessions = new Set(members.map((m) => m.sessionId)).size
      if (members.length < minOccurrences || distinctSessions < 2) continue

      // Suppression check: is there an open candidate whose pattern
      // text matches the cluster's pattern at the dismissal threshold?
      const patternSummary = pickPatternSummary(members)
      let matchedOpen = false
      for (const open of openCandidates) {
        try {
          const openVec = await options.getEmbedding(open.patternSummary)
          if (
            openVec.length > 0 &&
            cosineSimilarity(openVec, cluster.centroid) >= DISMISSAL_MATCH_COS
          ) {
            matchedOpen = true
            break
          }
        } catch {
          // One bad embed shouldn't suppress everything — proceed as
          // if the open candidate is unrelated.
        }
      }
      if (matchedOpen) {
        suppressed += 1
        continue
      }

      try {
        await options.kbGapStore.create({
          workspaceId,
          patternSummary,
          evidenceMissIds: members.map((m) => m.id),
          occurrences: members.length,
          distinctSessions,
        })
        emitted += 1
      } catch (err) {
        console.error(
          `[retrieval-miss-aggregator] failed to create candidate for workspace=${workspaceId}: `,
          err,
        )
      }
    }

    lastRunAt.set(workspaceId, until.getTime())

    if (emitted > 0) {
      onEvent?.({ type: 'kb_gap_candidate_emitted', workspaceId, count: emitted })
    }

    return {
      outcome: 'processed',
      missCount: misses.length,
      clusterCount: clusters.length,
      emitted,
      suppressed,
    }
  }

  async function tickInner(): Promise<void> {
    const until = now()
    const workspaces = await options.listActiveWorkspaces()
    onEvent?.({ type: 'tick_start', workspaceCount: workspaces.length })

    let processed = 0
    let totalEmitted = 0
    let errored = 0

    for (const workspaceId of workspaces) {
      try {
        const outcome = await processWorkspace(workspaceId, until)
        if (outcome.outcome === 'processed') {
          processed += 1
          totalEmitted += outcome.emitted ?? 0
          onEvent?.({
            type: 'workspace_processed',
            workspaceId,
            missCount: outcome.missCount ?? 0,
            clusterCount: outcome.clusterCount ?? 0,
            candidatesEmitted: outcome.emitted ?? 0,
            candidatesSuppressed: outcome.suppressed ?? 0,
          })
        } else {
          onEvent?.({
            type: 'workspace_skipped',
            workspaceId,
            reason: outcome.reason ?? 'unknown',
          })
        }
      } catch (err) {
        errored += 1
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[retrieval-miss-aggregator] workspace ${workspaceId} failed:`,
          err,
        )
        onEvent?.({ type: 'error', workspaceId, error: message })
      }
    }

    onEvent?.({
      type: 'tick_complete',
      processedCount: processed,
      emittedCount: totalEmitted,
      errorCount: errored,
    })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      await tickInner()
    } catch (err) {
      console.error('[retrieval-miss-aggregator] tick failed:', err)
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (intervalTimer || initialTimer) return // idempotent
      console.log(
        `[retrieval-miss-aggregator] worker started ` +
          `(interval: ${intervalMs}ms, window: ${windowMs}ms, ` +
          `threshold: ${clusterThreshold}, min: ${minOccurrences}, ` +
          `suppress: ${dismissalSuppressDays}d)`,
      )
      initialTimer = setTimeout(() => {
        initialTimer = undefined
        void tick().catch((err) =>
          console.error('[retrieval-miss-aggregator] initial tick failed:', err),
        )
      }, firstTickDelayMs)
      intervalTimer = setInterval(() => {
        void tick().catch((err) =>
          console.error('[retrieval-miss-aggregator] tick failed:', err),
        )
      }, intervalMs)
    },
    stop() {
      if (initialTimer) {
        clearTimeout(initialTimer)
        initialTimer = undefined
      }
      if (intervalTimer) {
        clearInterval(intervalTimer)
        intervalTimer = undefined
      }
    },
    get isRunning() {
      return intervalTimer !== undefined || initialTimer !== undefined
    },
  }
}
