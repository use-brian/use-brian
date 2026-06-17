/**
 * workspace_memory_evolution — aggregated correction signals per
 * workspace + the emitted Layer 2 prompt snippet (migration 166).
 *
 * One row per workspace. Written by the weekly
 * `memory-evolution-worker` (system-level — no per-user RLS); read by
 * the prompt builder on every chat turn for the workspace. Reads
 * bypass RLS via bare `query()` because the prompt builder runs in a
 * per-user request context but needs workspace-level data regardless
 * of which user is currently chatting.
 *
 * The corresponding *signal* table is `memory_verifications` (mig 165) —
 * one row per user-correction event. This store is the consumer of that
 * stream; the worker reads `memory_verifications`, computes rates over a
 * 30-day window, and writes the result here.
 *
 * Distinct from `domain_summaries` (per-(assistant, user) cached memory
 * dumps for the prompt) and from `consolidation_logs` (consolidation
 * worker state) — those describe *what the memory layer thinks*, this
 * describes *what the user keeps correcting the model on*.
 *
 * [COMP:api/workspace-memory-evolution-store]
 */

import { query } from './client.js'

export type WorkspaceMemoryEvolution = {
  workspaceId: string
  totalSaves30d: number
  totalVerifications30d: number
  scopeNarrowRate: number | null
  scopeWideRate: number | null
  sensitivityOverRate: number | null
  sensitivityUnderRate: number | null
  promptSnippet: string | null
  promptSnippetVersion: number
  lastRefreshedAt: Date | null
  updatedAt: Date
}

const EVOLUTION_SELECT = `
  workspace_id              as "workspaceId",
  total_saves_30d           as "totalSaves30d",
  total_verifications_30d   as "totalVerifications30d",
  scope_narrow_rate         as "scopeNarrowRate",
  scope_wide_rate           as "scopeWideRate",
  sensitivity_over_rate     as "sensitivityOverRate",
  sensitivity_under_rate    as "sensitivityUnderRate",
  prompt_snippet            as "promptSnippet",
  prompt_snippet_version    as "promptSnippetVersion",
  last_refreshed_at         as "lastRefreshedAt",
  updated_at                as "updatedAt"
`

/**
 * Read the current evolution row for a workspace.
 *
 * **System-bypass.** Called from the prompt builder, which is itself
 * inside a `queryWithRLS(userId, …)` request scope — but we explicitly
 * want workspace-level data here regardless of the acting user, and the
 * snippet text is not surfaced directly to the user, so a bare `query()`
 * is the right tool. Returns `null` when no row exists yet (workspace
 * has never crossed the worker's significance threshold).
 */
export async function getEvolution(workspaceId: string): Promise<WorkspaceMemoryEvolution | null> {
  const result = await query<WorkspaceMemoryEvolution>(
    `SELECT ${EVOLUTION_SELECT} FROM workspace_memory_evolution
     WHERE workspace_id = $1`,
    [workspaceId],
  )
  // pg returns NUMERIC as a string; coerce the four rate columns to
  // numbers (or null) before handing back to callers. The integer
  // counters arrive as numbers already.
  const row = result.rows[0]
  if (!row) return null
  return {
    ...row,
    scopeNarrowRate: row.scopeNarrowRate === null ? null : Number(row.scopeNarrowRate),
    scopeWideRate: row.scopeWideRate === null ? null : Number(row.scopeWideRate),
    sensitivityOverRate: row.sensitivityOverRate === null ? null : Number(row.sensitivityOverRate),
    sensitivityUnderRate: row.sensitivityUnderRate === null ? null : Number(row.sensitivityUnderRate),
  }
}

export type UpsertEvolutionParams = {
  workspaceId: string
  totalSaves30d: number
  totalVerifications30d: number
  scopeNarrowRate: number | null
  scopeWideRate: number | null
  sensitivityOverRate: number | null
  sensitivityUnderRate: number | null
  promptSnippet: string | null
}

/**
 * Idempotent upsert from the worker. Bumps `prompt_snippet_version`
 * only when the snippet *text* actually changes — refreshing the
 * metrics with the same snippet does not count as a version bump (so
 * the cached Layer 2 prefix stays stable when nothing meaningful
 * changed). `last_refreshed_at` and `updated_at` always advance.
 *
 * System-level write; RLS is bypassed via the bare `query()` helper.
 */
export async function upsertEvolution(params: UpsertEvolutionParams): Promise<void> {
  await query(
    `INSERT INTO workspace_memory_evolution (
       workspace_id,
       total_saves_30d, total_verifications_30d,
       scope_narrow_rate, scope_wide_rate,
       sensitivity_over_rate, sensitivity_under_rate,
       prompt_snippet, prompt_snippet_version,
       last_refreshed_at, updated_at
     )
     VALUES (
       $1,
       $2, $3,
       $4, $5,
       $6, $7,
       $8, CASE WHEN $8 IS NULL THEN 0 ELSE 1 END,
       now(), now()
     )
     ON CONFLICT (workspace_id) DO UPDATE SET
       total_saves_30d         = EXCLUDED.total_saves_30d,
       total_verifications_30d = EXCLUDED.total_verifications_30d,
       scope_narrow_rate       = EXCLUDED.scope_narrow_rate,
       scope_wide_rate         = EXCLUDED.scope_wide_rate,
       sensitivity_over_rate   = EXCLUDED.sensitivity_over_rate,
       sensitivity_under_rate  = EXCLUDED.sensitivity_under_rate,
       prompt_snippet          = EXCLUDED.prompt_snippet,
       prompt_snippet_version  =
         CASE
           WHEN workspace_memory_evolution.prompt_snippet IS NOT DISTINCT FROM EXCLUDED.prompt_snippet
             THEN workspace_memory_evolution.prompt_snippet_version
           ELSE workspace_memory_evolution.prompt_snippet_version + 1
         END,
       last_refreshed_at = now(),
       updated_at        = now()`,
    [
      params.workspaceId,
      params.totalSaves30d,
      params.totalVerifications30d,
      params.scopeNarrowRate,
      params.scopeWideRate,
      params.sensitivityOverRate,
      params.sensitivityUnderRate,
      params.promptSnippet,
    ],
  )
}
