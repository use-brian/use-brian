/**
 * Periodic cleanup for the `worker_runs` table.
 *
 * Each research turn produces 3-10 worker rows + per-turn history JSONB.
 * On its own that's small, but a busy workspace accumulates them
 * indefinitely. The FK CASCADE on `sessions` cleans up when a session is
 * deleted, but typical product UX keeps sessions around forever.
 *
 * This sweep deletes terminal-state rows (completed / failed / stopped)
 * older than `RETENTION_DAYS`. Running rows are never touched — a
 * "running" row past the retention window is a stuck-worker signal that
 * deserves human attention, not silent cleanup.
 *
 * Cadence: once per day, jittered. Cleanup is non-urgent; the table is
 * tiny by transactional-DB standards, and a 24h jitter randomises the
 * cleanup burst across Cloud Run replicas.
 *
 * Component tag: [COMP:api/worker-runs-cleanup].
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md →
 *       "What's still missing" → worker_runs cleanup.
 */

import type { WorkerRunsStore } from '@use-brian/core'

/**
 * How many days terminal worker_runs rows are retained. After this we
 * delete the row + its history_json snapshot. Chosen to keep two windows
 * of recent research available for debugging without unbounded growth.
 */
export const WORKER_RUNS_RETENTION_DAYS = 30

export async function sweepStaleWorkerRuns(
  store: WorkerRunsStore,
  opts: { retentionDays?: number } = {},
): Promise<number> {
  const days = opts.retentionDays ?? WORKER_RUNS_RETENTION_DAYS
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return store.deleteTerminalOlderThan(cutoff)
}
